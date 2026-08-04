package notify

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// Sender is the send side of the digest, one method wide. It exists so the
// pipeline's only outbound email can be swapped for a recording fake in tests
// and for a no-op in a dry run: nothing about assembling a digest should require
// the ability to actually mail it.
type Sender interface {
	Send(ctx context.Context, from string, to []string, m Message) error
}

// implicitTLSPort is the "SMTPS" submission port: TLS is negotiated by the
// connection itself, before a single SMTP verb is spoken. Every other
// submission port (587, 2525, 25) starts in the clear and is upgraded with
// STARTTLS.
const implicitTLSPort = 465

// sendTimeout bounds the whole submission — dial, TLS, AUTH, DATA, QUIT. The
// digest is the LAST step of the nightly pipeline, so an unbounded send turns
// one stalled relay into a workflow that hangs until its own multi-hour job
// timeout kills it, long after the catalog work it is reporting on finished.
// net/smtp has no timeout of its own, which is why this is enforced here with a
// dial timeout and a connection deadline rather than by the client.
const sendTimeout = 30 * time.Second

// SMTPSender submits one email to an SMTP relay (smtp.com, for Fine Vines) with
// AUTH over TLS. It speaks submission directly rather than through a provider's
// REST API, so the same code works against any relay the client moves to; the
// price is that the MIME message is assembled here instead of by the provider.
type SMTPSender struct {
	// Host and Port are the relay's submission endpoint — no defaults, because a
	// guessed relay is a digest that silently never arrives.
	Host string
	Port int
	// Username and Password authenticate the submission (AUTH PLAIN). Sent only
	// after TLS is up; see Send.
	Username string
	Password string

	// Timeout bounds the entire send. Zero means sendTimeout.
	Timeout time.Duration

	// ImplicitTLS forces TLS-on-connect regardless of Port. Production leaves it
	// false and lets the port decide (465 implicit, everything else STARTTLS);
	// it exists for a relay offering implicit TLS on a non-standard port, and for
	// the tests, whose loopback listener never gets port 465.
	ImplicitTLS bool

	// TLSConfig overrides the TLS settings for both the implicit handshake and
	// STARTTLS. Nil — always, in production — means verify the relay's
	// certificate against Host.
	TLSConfig *tls.Config
}

// NewSMTPSender builds a bounded sender for a relay's submission endpoint.
func NewSMTPSender(host string, port int, username, password string) *SMTPSender {
	return &SMTPSender{Host: host, Port: port, Username: username, Password: password, Timeout: sendTimeout}
}

// usesImplicitTLS reports whether the connection must be wrapped in TLS before
// the greeting, rather than upgraded with STARTTLS afterwards.
func (s *SMTPSender) usesImplicitTLS() bool {
	return s.ImplicitTLS || s.Port == implicitTLSPort
}

func (s *SMTPSender) timeout() time.Duration {
	if s.Timeout <= 0 {
		return sendTimeout
	}
	return s.Timeout
}

func (s *SMTPSender) tlsConfig() *tls.Config {
	if s.TLSConfig != nil {
		return s.TLSConfig
	}
	return &tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12}
}

// Send submits the digest.
//
// The credentials never travel in the clear: on an implicit-TLS port the socket
// is wrapped before the greeting, and on every other port STARTTLS is REQUIRED —
// a relay that does not advertise it fails the send rather than downgrading.
func (s *SMTPSender) Send(ctx context.Context, from string, to []string, m Message) error {
	if len(to) == 0 {
		return fmt.Errorf("smtp: no recipients — set FINEVINES_NOTIFY_TO")
	}
	if s.Host == "" {
		return fmt.Errorf("smtp: no relay host — set FINEVINES_SMTP_HOST")
	}
	if s.Port <= 0 {
		return fmt.Errorf("smtp: no relay port — set FINEVINES_SMTP_PORT")
	}

	// Checked before anything is assembled or dialled: an address carrying a line
	// break would otherwise become an injected header (Bcc, Reply-To) in a message
	// the operator never wrote. net/smtp refuses such an envelope too, but only
	// later and with an error that names no setting.
	for _, addr := range append([]string{from}, to...) {
		if strings.ContainsAny(addr, "\r\n") {
			return fmt.Errorf("smtp: the address %q contains a line break — check FINEVINES_NOTIFY_FROM and FINEVINES_NOTIFY_TO", addr)
		}
	}

	msg, err := composeMessage(from, to, m, time.Now())
	if err != nil {
		return fmt.Errorf("smtp: %w", err)
	}

	// One deadline for the whole conversation, not per-operation: net/smtp
	// exposes no timeouts, so the bound has to live on the socket.
	deadline := time.Now().Add(s.timeout())
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}

	addr := net.JoinHostPort(s.Host, strconv.Itoa(s.Port))
	conn, err := net.DialTimeout("tcp", addr, time.Until(deadline))
	if err != nil {
		return fmt.Errorf("smtp: dialling %s: %w", addr, err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(deadline); err != nil {
		return fmt.Errorf("smtp: setting deadline: %w", err)
	}

	if s.usesImplicitTLS() {
		tc := tls.Client(conn, s.tlsConfig())
		if err := tc.HandshakeContext(ctx); err != nil {
			return fmt.Errorf("smtp: TLS handshake with %s: %w", addr, err)
		}
		conn = tc
	}

	c, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		return fmt.Errorf("smtp: greeting from %s: %w", addr, err)
	}

	if !s.usesImplicitTLS() {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return fmt.Errorf("smtp: %s does not offer STARTTLS — refusing to submit the digest, "+
				"and the relay password, in the clear (use port 465 if the relay wants implicit TLS)", addr)
		}
		if err := c.StartTLS(s.tlsConfig()); err != nil {
			return fmt.Errorf("smtp: STARTTLS with %s: %w", addr, err)
		}
	}

	if s.Username != "" {
		if ok, _ := c.Extension("AUTH"); !ok {
			return fmt.Errorf("smtp: %s offers no AUTH after TLS, but FINEVINES_SMTP_USER is set", addr)
		}
		if err := c.Auth(smtp.PlainAuth("", s.Username, s.Password, s.Host)); err != nil {
			return fmt.Errorf("smtp: authenticating to %s as %s: %w", addr, s.Username, err)
		}
	}

	if err := c.Mail(envelopeAddress(from)); err != nil {
		return fmt.Errorf("smtp: MAIL FROM %s: %w", envelopeAddress(from), err)
	}
	// One RCPT per recipient, each checked: a relay that refuses one address
	// accepts the rest, and "digest sent" over a half-delivered send is exactly
	// the silent failure this whole email exists to prevent.
	for _, rcpt := range to {
		if err := c.Rcpt(envelopeAddress(rcpt)); err != nil {
			return fmt.Errorf("smtp: recipient %s rejected: %w", envelopeAddress(rcpt), err)
		}
	}

	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp: DATA: %w", err)
	}
	// The stdlib's DATA writer does the dot-stuffing and terminates the payload;
	// a line of the digest that happens to start with "." must not truncate it.
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("smtp: writing the message: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp: the relay rejected the message: %w", err)
	}
	if err := c.Quit(); err != nil {
		return fmt.Errorf("smtp: QUIT: %w", err)
	}
	return nil
}

// composeMessage renders the digest as a multipart/alternative RFC 5322 message
// with CRLF line endings. Submitting to a relay rather than to a provider's API
// means the message is assembled here rather than from a JSON payload.
//
// Both bodies are quoted-printable: it keeps every line inside SMTP's 998-octet
// limit without rewrapping the prose, and carries the accented producer and
// appellation names the catalog is full of.
func composeMessage(from string, to []string, m Message, now time.Time) ([]byte, error) {
	boundary, err := randomToken()
	if err != nil {
		return nil, err
	}
	msgID, err := messageID(from, now)
	if err != nil {
		return nil, err
	}

	var b bytes.Buffer
	header := func(name, value string) {
		fmt.Fprintf(&b, "%s: %s\r\n", name, value)
	}
	header("From", from)
	header("To", strings.Join(to, ", "))
	// Encode leaves a plain-ASCII subject untouched and emits an RFC 2047
	// encoded-word only when the subject actually needs one.
	header("Subject", mime.QEncoding.Encode("utf-8", m.Subject))
	header("Date", now.Format(time.RFC1123Z))
	header("Message-ID", msgID)
	header("MIME-Version", "1.0")
	header("Content-Type", `multipart/alternative; boundary="`+boundary+`"`)
	b.WriteString("\r\n")

	// Plain text first: multipart/alternative is ordered least- to
	// most-preferred, so a client that can render HTML picks the HTML.
	for _, part := range []struct{ mediaType, body string }{
		{"text/plain", m.TextBody},
		{"text/html", m.HTMLBody},
	} {
		fmt.Fprintf(&b, "--%s\r\n", boundary)
		fmt.Fprintf(&b, "Content-Type: %s; charset=UTF-8\r\n", part.mediaType)
		b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
		qp := quotedprintable.NewWriter(&b)
		if _, err := qp.Write([]byte(part.body)); err != nil {
			return nil, err
		}
		if err := qp.Close(); err != nil {
			return nil, err
		}
		// The CRLF belongs to the boundary delimiter, so it is unconditional:
		// a body that already ends in a newline is not a reason to omit it.
		b.WriteString("\r\n")
	}
	fmt.Fprintf(&b, "--%s--\r\n", boundary)
	return b.Bytes(), nil
}

// envelopeAddress reduces "Fine Vines <catalog@finevines.biz>" to the bare
// address the SMTP envelope takes. A value that will not parse is passed through
// untouched: the relay's own rejection is a better error than a guess here.
func envelopeAddress(addr string) string {
	if parsed, err := mail.ParseAddress(strings.TrimSpace(addr)); err == nil {
		return parsed.Address
	}
	return strings.TrimSpace(addr)
}

// messageID mints an addr-spec unique to this send, in the sending address's
// domain. Without one the receiving MTA invents its own, which costs threading
// and reads as unusual to spam filters.
func messageID(from string, now time.Time) (string, error) {
	domain := "finevines.biz"
	if _, d, ok := strings.Cut(envelopeAddress(from), "@"); ok && d != "" {
		domain = d
	}
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("<%d.%s@%s>", now.UnixNano(), token, domain), nil
}

// randomToken returns hex suitable for a MIME boundary or a Message-ID. Random
// rather than derived from the content: a boundary that appears inside a body
// silently corrupts the message, and 128 bits makes that impossible by accident.
func randomToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("generating a random token: %w", err)
	}
	return hex.EncodeToString(buf[:]), nil
}

// Recipients splits FINEVINES_NOTIFY_TO's comma-separated list, trimming each
// address and dropping blanks so a trailing comma in the secret is harmless.
func Recipients(csv string) []string {
	var out []string
	for _, part := range strings.Split(csv, ",") {
		if addr := strings.TrimSpace(part); addr != "" {
			out = append(out, addr)
		}
	}
	return out
}

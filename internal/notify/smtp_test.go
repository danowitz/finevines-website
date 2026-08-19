package notify

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"io"
	"math/big"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/textproto"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRecipients_SplitsTrimsAndDropsBlanks(t *testing.T) {
	got := Recipients(" george@example.com, barbara@example.com ,,joel@example.com ")
	want := []string{"george@example.com", "barbara@example.com", "joel@example.com"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Recipients = %v, want %v", got, want)
	}
	if n := len(Recipients("  ")); n != 0 {
		t.Errorf("Recipients of blank = %d entries, want 0", n)
	}
}

func TestMessageID_FallbackUsesProductionDomain(t *testing.T) {
	id, err := messageID("local-sender", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(id, "@finevines.com>") {
		t.Errorf("messageID fallback = %q, want finevines.com domain", id)
	}
}

// Submission ports carry TLS two different ways, and getting it wrong is not a
// graceful failure: implicit TLS on 587 hangs the handshake, STARTTLS on 465
// sends "EHLO" into a server waiting for a ClientHello. The rule is fixed by
// convention (RFC 8314), so it is a pure function of the port and needs no
// network to test.
func TestUsesImplicitTLS_465Only(t *testing.T) {
	for _, tc := range []struct {
		port int
		want bool
	}{
		{465, true},  // implicit TLS ("SMTPS")
		{587, false}, // submission — STARTTLS
		{2525, false},
		{25, false},
	} {
		s := &SMTPSender{Host: "smtp.example.com", Port: tc.port}
		if got := s.usesImplicitTLS(); got != tc.want {
			t.Errorf("port %d: usesImplicitTLS = %v, want %v", tc.port, got, tc.want)
		}
	}
}

// The whole submission, against a real (if minimal) SMTP server: STARTTLS,
// AUTH PLAIN, one MAIL FROM, one RCPT per recipient, and a DATA payload we then
// parse back with the standard library as any receiving MTA would.
func TestSMTPSender_SubmitsTheDigestOverSTARTTLS(t *testing.T) {
	srv := newFakeSMTP(t, smtpBehavior{offerSTARTTLS: true})

	s := newTestSender(srv, "fv-user", "fv-pass")
	msg := Message{
		Subject: "FineVines catalog: 1 new wine",
		// A line starting with a dot is the classic wire hazard: unstuffed, the
		// server reads it as the end of DATA and the rest of the digest vanishes.
		TextBody: "One wine joined the list.\n.leading dot survives\nReply if a bottle looks wrong.\n",
		HTMLBody: "<p>One wine joined the list.</p>",
	}
	if err := s.Send(context.Background(), "FineVines <catalog@finevines.biz>",
		[]string{"george@example.com", "barbara@example.com"}, msg); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}

	// The relay only accepts authenticated submission; sending unauthenticated
	// would be rejected in production, so the credentials must actually go.
	if want := "\x00fv-user\x00fv-pass"; srv.auth() != want {
		t.Errorf("AUTH PLAIN payload = %q, want %q", srv.auth(), want)
	}
	if from := srv.envelopeFrom(); from != "catalog@finevines.biz" {
		t.Errorf("MAIL FROM = %q, want the bare address without the display name", from)
	}
	wantRcpts := []string{"george@example.com", "barbara@example.com"}
	if got := srv.recipients(); !reflect.DeepEqual(got, wantRcpts) {
		t.Errorf("RCPT TO = %v, want one per recipient: %v", got, wantRcpts)
	}

	raw := srv.payload()
	m, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("the DATA payload is not a parseable message: %v\n%s", err, raw)
	}
	if got := m.Header.Get("Subject"); got != msg.Subject {
		t.Errorf("Subject header = %q, want %q", got, msg.Subject)
	}
	if got := m.Header.Get("To"); !strings.Contains(got, "george@example.com") || !strings.Contains(got, "barbara@example.com") {
		t.Errorf("To header = %q, want both recipients", got)
	}
	if got := m.Header.Get("From"); got != "FineVines <catalog@finevines.biz>" {
		t.Errorf("From header = %q", got)
	}
	if m.Header.Get("MIME-Version") != "1.0" {
		t.Errorf("MIME-Version = %q, want 1.0", m.Header.Get("MIME-Version"))
	}
	if _, err := m.Header.Date(); err != nil {
		t.Errorf("Date header = %q, which does not parse: %v", m.Header.Get("Date"), err)
	}
	// Without a Message-ID the receiving MTA invents one, and threading and
	// several spam heuristics both suffer for it.
	if id := m.Header.Get("Message-ID"); !strings.HasPrefix(id, "<") || !strings.Contains(id, "@") || !strings.HasSuffix(id, ">") {
		t.Errorf("Message-ID = %q, want an addr-spec in angle brackets", id)
	}

	parts := multipartAlternative(t, m)
	if got := parts["text/plain"]; !strings.Contains(got, "One wine joined the list.") {
		t.Errorf("text/plain part = %q", got)
	}
	if got := parts["text/plain"]; !strings.Contains(got, "\n.leading dot survives") {
		t.Errorf("the dot-stuffed line did not survive the round trip; text part = %q", got)
	}
	if got := parts["text/html"]; !strings.Contains(got, "<p>One wine joined the list.</p>") {
		t.Errorf("text/html part = %q", got)
	}
}

// A non-ASCII subject has to leave as an RFC 2047 encoded-word: raw UTF-8 in a
// header is not legal mail, and relays that do not silently fix it up mangle the
// producer's name in the client's inbox.
func TestSMTPSender_EncodesANonASCIISubject(t *testing.T) {
	srv := newFakeSMTP(t, smtpBehavior{offerSTARTTLS: true})
	s := newTestSender(srv, "u", "p")

	subject := "FineVines catalog: Château Margaux, Côtes du Rhône"
	if err := s.Send(context.Background(), "catalog@finevines.biz", []string{"g@example.com"},
		Message{Subject: subject, TextBody: "x", HTMLBody: "<p>x</p>"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}

	raw := srv.payload()
	for _, line := range strings.Split(raw, "\r\n") {
		if !strings.HasPrefix(line, "Subject:") {
			continue
		}
		for _, r := range line {
			if r > 127 {
				t.Fatalf("Subject header carries raw non-ASCII: %q", line)
			}
		}
	}
	m, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("payload does not parse: %v", err)
	}
	decoded, err := (&mime.WordDecoder{}).DecodeHeader(m.Header.Get("Subject"))
	if err != nil {
		t.Fatalf("Subject does not decode: %v", err)
	}
	if decoded != subject {
		t.Errorf("decoded Subject = %q, want %q", decoded, subject)
	}
}

// The relay is reached over the public internet with a username and password.
// A server that does not offer STARTTLS is either misconfigured or not the
// server we think we are talking to, and sending anyway hands the credentials
// to whoever is listening.
func TestSMTPSender_RefusesAServerThatDoesNotOfferSTARTTLS(t *testing.T) {
	srv := newFakeSMTP(t, smtpBehavior{offerSTARTTLS: false})
	s := newTestSender(srv, "fv-user", "fv-pass")

	err := s.Send(context.Background(), "catalog@finevines.biz", []string{"g@example.com"}, Message{})
	if err == nil {
		t.Fatal("Send submitted over a cleartext connection")
	}
	if !strings.Contains(strings.ToUpper(err.Error()), "STARTTLS") {
		t.Errorf("error = %v, want it to name the missing STARTTLS", err)
	}
	if srv.auth() != "" {
		t.Errorf("the password was sent in the clear before the connection failed: %q", srv.auth())
	}
}

// Port 465 (and any relay configured for it) expects TLS from the first byte:
// no greeting is spoken in the clear at all.
func TestSMTPSender_ImplicitTLSNegotiatesBeforeTheGreeting(t *testing.T) {
	srv := newFakeSMTP(t, smtpBehavior{implicitTLS: true})
	s := newTestSender(srv, "fv-user", "fv-pass")
	s.ImplicitTLS = true

	if err := s.Send(context.Background(), "catalog@finevines.biz", []string{"g@example.com"},
		Message{Subject: "s", TextBody: "t", HTMLBody: "<p>t</p>"}); err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if !strings.Contains(srv.payload(), "Subject: s") {
		t.Errorf("payload = %q", srv.payload())
	}
	if srv.auth() == "" {
		t.Error("no AUTH was performed over the implicit-TLS connection")
	}
}

// A rejected recipient means that person is not getting the digest. Returning
// nil would log "digest sent" over a delivery that never happened.
func TestSMTPSender_RejectedRecipientIsAnError(t *testing.T) {
	srv := newFakeSMTP(t, smtpBehavior{offerSTARTTLS: true, rejectRcpt: true})
	s := newTestSender(srv, "u", "p")

	err := s.Send(context.Background(), "catalog@finevines.biz", []string{"nobody@example.com"}, Message{})
	if err == nil {
		t.Fatal("Send accepted a rejected RCPT TO")
	}
	if !strings.Contains(err.Error(), "nobody@example.com") {
		t.Errorf("error = %v, want it to name the rejected address", err)
	}
	if srv.payload() != "" {
		t.Error("the message was transmitted despite the rejection")
	}
}

// notify is the LAST step of the nightly pipeline. net/smtp has no timeout of
// its own, so a relay that accepts the connection and then says nothing would
// hold the whole job open until the workflow's multi-hour timeout kills it.
func TestSMTPSender_SilentServerIsBoundedByTheTimeout(t *testing.T) {
	srv := newFakeSMTP(t, smtpBehavior{silent: true})
	s := newTestSender(srv, "u", "p")
	s.Timeout = 250 * time.Millisecond

	start := time.Now()
	err := s.Send(context.Background(), "catalog@finevines.biz", []string{"g@example.com"}, Message{})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("Send returned nil against a server that never spoke")
	}
	if elapsed > 5*time.Second {
		t.Errorf("Send took %v against a silent server — the deadline is not being applied", elapsed)
	}
}

// The message is assembled here now, so the headers are ours to keep well
// formed. A stray CRLF in FINEVINES_NOTIFY_FROM or _TO — a fat-fingered secret,
// most likely — would otherwise inject whatever follows it as its own header.
func TestSMTPSender_RefusesAnAddressCarryingALineBreak(t *testing.T) {
	srv := newFakeSMTP(t, smtpBehavior{offerSTARTTLS: true})
	s := newTestSender(srv, "u", "p")

	// The error has to name the problem: net/smtp would eventually refuse the
	// envelope too, but only after a header-injected message had been assembled,
	// and with a message ("A line must not contain CR or LF") that tells the
	// operator nothing about which setting is wrong.
	err := s.Send(context.Background(), "catalog@finevines.biz\r\nBcc: sneak@example.com",
		[]string{"g@example.com"}, Message{})
	if err == nil {
		t.Fatal("Send accepted a From address containing a line break")
	}
	if !strings.Contains(err.Error(), "line break") {
		t.Errorf("From error = %v, want it to name the line break", err)
	}
	err = s.Send(context.Background(), "catalog@finevines.biz",
		[]string{"g@example.com\nBcc: sneak@example.com"}, Message{})
	if err == nil {
		t.Fatal("Send accepted a recipient containing a line break")
	}
	if !strings.Contains(err.Error(), "line break") {
		t.Errorf("recipient error = %v, want it to name the line break", err)
	}
	if srv.payload() != "" {
		t.Error("a message was transmitted despite the malformed address")
	}
}

func TestSMTPSender_NoRecipientsIsAnError(t *testing.T) {
	s := NewSMTPSender("smtp.example.com", 587, "u", "p")
	if err := s.Send(context.Background(), "a@example.com", nil, Message{}); err == nil {
		t.Fatal("Send accepted an empty recipient list")
	}
}

func TestNewSMTPSender_DefaultsToABoundedTimeout(t *testing.T) {
	s := NewSMTPSender("smtp.example.com", 587, "u", "p")
	if s.Timeout <= 0 {
		t.Error("the constructed sender has no Timeout — a stalled relay would hang the nightly run")
	}
	// A zero-value sender (built by a caller filling fields directly) must still
	// be bounded rather than dialling with no deadline at all.
	if (&SMTPSender{}).timeout() <= 0 {
		t.Error("the zero-value sender falls back to an unbounded send")
	}
}

var _ Sender = (*SMTPSender)(nil)

// --- test SMTP server -------------------------------------------------------

// fakeSMTP is a minimal submission server: enough of RFC 5321 to exercise the
// real net/smtp client — greeting, EHLO with extensions, STARTTLS, AUTH PLAIN,
// MAIL/RCPT/DATA — and nothing more. Configure the zero value's knobs, then
// hand it to newFakeSMTP.
type fakeSMTP struct {
	smtpBehavior

	ln     net.Listener
	tlsCfg *tls.Config

	mu       sync.Mutex
	authPlan string
	from     string
	rcpts    []string
	data     string
}

// smtpBehavior is the knobs, kept apart from the server's own state so it can be
// passed by value.
type smtpBehavior struct {
	offerSTARTTLS bool
	implicitTLS   bool
	rejectRcpt    bool
	silent        bool // accept the connection and never speak: the stalled relay
}

func newFakeSMTP(t *testing.T, behavior smtpBehavior) *fakeSMTP {
	t.Helper()
	s := &fakeSMTP{smtpBehavior: behavior}
	s.tlsCfg = &tls.Config{Certificates: []tls.Certificate{selfSignedCert(t)}}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s.ln = ln
	if s.implicitTLS {
		s.ln = tls.NewListener(ln, s.tlsCfg)
	}
	t.Cleanup(func() { s.ln.Close() })

	go func() {
		for {
			c, err := s.ln.Accept()
			if err != nil {
				return
			}
			go s.serve(c)
		}
	}()
	return s
}

func (s *fakeSMTP) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

func (s *fakeSMTP) serve(c net.Conn) {
	defer c.Close()
	if s.silent {
		io.Copy(io.Discard, c) // hold it open, say nothing
		return
	}
	secure := s.implicitTLS
	tc := textproto.NewConn(c)
	tc.PrintfLine("220 fake.local ESMTP ready")
	for {
		line, err := tc.ReadLine()
		if err != nil {
			return
		}
		upper := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(upper, "EHLO"):
			ext := []string{"250-fake.local"}
			if s.offerSTARTTLS && !secure {
				ext = append(ext, "250-STARTTLS")
			}
			ext = append(ext, "250 AUTH PLAIN")
			tc.PrintfLine("%s", strings.Join(ext, "\r\n"))
		case strings.HasPrefix(upper, "HELO"):
			tc.PrintfLine("250 fake.local")
		case strings.HasPrefix(upper, "STARTTLS"):
			tc.PrintfLine("220 2.0.0 ready to start TLS")
			tconn := tls.Server(c, s.tlsCfg)
			if err := tconn.Handshake(); err != nil {
				return
			}
			tc, secure = textproto.NewConn(tconn), true
		case strings.HasPrefix(upper, "AUTH PLAIN"):
			raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(line[len("AUTH PLAIN"):]))
			if err != nil {
				tc.PrintfLine("501 5.5.2 cannot decode")
				continue
			}
			s.set(func() { s.authPlan = string(raw) })
			tc.PrintfLine("235 2.7.0 authentication succeeded")
		case strings.HasPrefix(upper, "MAIL FROM"):
			s.set(func() { s.from = angleAddr(line) })
			tc.PrintfLine("250 2.1.0 ok")
		case strings.HasPrefix(upper, "RCPT TO"):
			if s.rejectRcpt {
				tc.PrintfLine("550 5.1.1 no such user here")
				continue
			}
			s.set(func() { s.rcpts = append(s.rcpts, angleAddr(line)) })
			tc.PrintfLine("250 2.1.5 ok")
		case strings.HasPrefix(upper, "DATA"):
			tc.PrintfLine("354 end data with <CR><LF>.<CR><LF>")
			// DotReader un-stuffs, exactly as a real MTA does — so what the test
			// inspects is the message as the recipient's server would see it.
			body, err := io.ReadAll(tc.DotReader())
			if err != nil {
				return
			}
			s.set(func() { s.data = string(body) })
			tc.PrintfLine("250 2.0.0 queued")
		case strings.HasPrefix(upper, "QUIT"):
			tc.PrintfLine("221 2.0.0 bye")
			return
		default:
			tc.PrintfLine("250 2.0.0 ok")
		}
	}
}

func (s *fakeSMTP) set(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn()
}

func (s *fakeSMTP) auth() string         { s.mu.Lock(); defer s.mu.Unlock(); return s.authPlan }
func (s *fakeSMTP) envelopeFrom() string { s.mu.Lock(); defer s.mu.Unlock(); return s.from }
func (s *fakeSMTP) payload() string      { s.mu.Lock(); defer s.mu.Unlock(); return s.data }
func (s *fakeSMTP) recipients() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.rcpts...)
}

// angleAddr pulls the address out of "MAIL FROM:<a@b>" / "RCPT TO:<a@b>".
func angleAddr(line string) string {
	open := strings.Index(line, "<")
	closing := strings.LastIndex(line, ">")
	if open < 0 || closing < open {
		_, rest, _ := strings.Cut(line, ":")
		return strings.TrimSpace(rest)
	}
	return line[open+1 : closing]
}

// newTestSender points a sender at the fake server and tells it to trust the
// throwaway certificate. InsecureSkipVerify is acceptable HERE ONLY: the cert is
// generated by this test, for a loopback listener, and never leaves the process.
// Production leaves TLSConfig nil and verifies against the real host.
func newTestSender(srv *fakeSMTP, user, pass string) *SMTPSender {
	s := NewSMTPSender("127.0.0.1", srv.port(), user, pass)
	s.TLSConfig = &tls.Config{InsecureSkipVerify: true}
	return s
}

// multipartAlternative decodes the message's parts, keyed by media type, the way
// a receiving client would: honouring the per-part transfer encoding.
func multipartAlternative(t *testing.T, m *mail.Message) map[string]string {
	t.Helper()
	mt, params, err := mime.ParseMediaType(m.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("Content-Type %q: %v", m.Header.Get("Content-Type"), err)
	}
	if mt != "multipart/alternative" {
		t.Fatalf("Content-Type = %q, want multipart/alternative", mt)
	}
	out := map[string]string{}
	mr := multipart.NewReader(m.Body, params["boundary"])
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("reading part: %v", err)
		}
		pt, _, err := mime.ParseMediaType(p.Header.Get("Content-Type"))
		if err != nil {
			t.Fatalf("part Content-Type %q: %v", p.Header.Get("Content-Type"), err)
		}
		var r io.Reader = p
		if strings.EqualFold(p.Header.Get("Content-Transfer-Encoding"), "quoted-printable") {
			r = quotedprintable.NewReader(p)
		}
		body, err := io.ReadAll(r)
		if err != nil {
			t.Fatalf("decoding %s part: %v", pt, err)
		}
		out[pt] = string(body)
	}
	if len(out) != 2 {
		t.Fatalf("got %d parts (%v), want text/plain and text/html", len(out), out)
	}
	return out
}

// selfSignedCert mints a throwaway certificate for the loopback listener, so the
// tests exercise a real TLS handshake rather than a plaintext stand-in.
func selfSignedCert(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generating key: %v", err)
	}
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "fake.local"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:              []string{"localhost", "fake.local"},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("creating certificate: %v", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// defaultPostmarkBaseURL is Postmark's API host. Stored on the sender rather
// than hardcoded into Send so tests can point it at an httptest server — the
// same arrangement deploy.BunnyClient.PurgeBaseURL uses.
const defaultPostmarkBaseURL = "https://api.postmarkapp.com"

// Sender is the send side of the digest, one method wide. It exists so the
// pipeline's only outbound email can be swapped for a recording fake in tests
// and for a no-op in a dry run: nothing about assembling a digest should require
// the ability to actually mail it.
type Sender interface {
	Send(ctx context.Context, from string, to []string, m Message) error
}

// PostmarkSender posts one email to Postmark's REST API. Talks to the endpoint
// directly rather than through an SDK, matching every other outbound client in
// this repo (Bunny, Salesforce, OpenAI).
type PostmarkSender struct {
	// Token is the Postmark SERVER token (POSTMARK_TOKEN), not an account token.
	Token string
	// BaseURL defaults to Postmark's public API via NewPostmarkSender.
	BaseURL string
	HTTP    *http.Client
}

// sendTimeout bounds the single outbound call this package makes. The digest is
// the LAST step of the nightly pipeline, so an unbounded client turns one
// stalled connection into a workflow that hangs until its own multi-hour job
// timeout kills it — long after the catalog work it is reporting on finished.
// Thirty seconds is generous for one small JSON POST.
const sendTimeout = 30 * time.Second

// NewPostmarkSender builds a sender. hc may be nil, in which case a bounded
// client is used.
//
// The nil fallback is deliberately NOT http.DefaultClient: that client has no
// Timeout, and giving it one here would silently impose this package's deadline
// on every other caller sharing it.
func NewPostmarkSender(token string, hc *http.Client) *PostmarkSender {
	if hc == nil {
		hc = &http.Client{Timeout: sendTimeout}
	}
	return &PostmarkSender{Token: token, BaseURL: defaultPostmarkBaseURL, HTTP: hc}
}

// postmarkResponse is the subset of Postmark's reply that matters. Postmark
// reports APPLICATION errors with HTTP 200 and a non-zero ErrorCode — an
// unconfirmed sender signature being the likely one here — so the status code
// alone is not enough to know the mail was accepted.
type postmarkResponse struct {
	ErrorCode int    `json:"ErrorCode"`
	Message   string `json:"Message"`
}

// Send posts the digest. Recipients are comma-joined into Postmark's single "To"
// field, which is how its API takes multiple addresses.
func (s *PostmarkSender) Send(ctx context.Context, from string, to []string, m Message) error {
	if len(to) == 0 {
		return fmt.Errorf("postmark: no recipients — set FINEVINES_NOTIFY_TO")
	}
	payload, err := json.Marshal(map[string]string{
		"From":          from,
		"To":            strings.Join(to, ","),
		"Subject":       m.Subject,
		"HtmlBody":      m.HTMLBody,
		"TextBody":      m.TextBody,
		"MessageStream": "outbound",
	})
	if err != nil {
		return err
	}

	url := strings.TrimRight(s.BaseURL, "/") + "/email"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("postmark: building request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Postmark-Server-Token", s.Token)

	resp, err := s.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("postmark: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var parsed postmarkResponse
	unmarshalErr := json.Unmarshal(body, &parsed)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("postmark: status %d: %s", resp.StatusCode, bodyPrefix(body))
	}
	// A 2xx we cannot parse is NOT a success. An empty body, a corporate proxy's
	// interception page or a Postmark incident page all leave ErrorCode at its
	// zero value, and returning nil here would log "digest sent" while nobody
	// was mailed — the same silent non-delivery the ErrorCode check below exists
	// to catch.
	if unmarshalErr != nil {
		return fmt.Errorf("postmark: status %d but the response was not the documented JSON (%v): %s",
			resp.StatusCode, unmarshalErr, bodyPrefix(body))
	}
	if parsed.ErrorCode != 0 {
		return fmt.Errorf("postmark: error %d: %s", parsed.ErrorCode, parsed.Message)
	}
	return nil
}

// maxBodyPrefix bounds how much of an unexpected response reaches the error, and
// through it the workflow log: enough to recognise a proxy notice or an incident
// page, not so much that a full HTML document is pasted into the run output.
const maxBodyPrefix = 200

// bodyPrefix renders an unexpected response body for an error message.
func bodyPrefix(body []byte) string {
	s := strings.TrimSpace(string(body))
	if s == "" {
		return "(empty body)"
	}
	if len(s) <= maxBodyPrefix {
		return s
	}
	// Trim back to a rune boundary so a split multi-byte character does not turn
	// the error into mojibake.
	cut := s[:maxBodyPrefix]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut + "…"
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

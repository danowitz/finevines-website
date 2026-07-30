package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
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

// NewPostmarkSender builds a sender. hc may be nil, in which case
// http.DefaultClient is used.
func NewPostmarkSender(token string, hc *http.Client) *PostmarkSender {
	if hc == nil {
		hc = http.DefaultClient
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
	_ = json.Unmarshal(body, &parsed)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("postmark: status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if parsed.ErrorCode != 0 {
		return fmt.Errorf("postmark: error %d: %s", parsed.ErrorCode, parsed.Message)
	}
	return nil
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

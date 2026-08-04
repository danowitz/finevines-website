package notify

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
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

func TestPostmarkSender_PostsTheDocumentedShape(t *testing.T) {
	var gotToken, gotPath string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken, gotPath = r.Header.Get("X-Postmark-Server-Token"), r.URL.Path
		json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ErrorCode":0,"Message":"OK"}`))
	}))
	defer srv.Close()

	s := NewPostmarkSender("pm-token", srv.Client())
	s.BaseURL = srv.URL
	err := s.Send(context.Background(), "catalog@finevines.biz",
		[]string{"george@example.com", "barbara@example.com"},
		Message{Subject: "Fine Vines catalog: 1 new wine", HTMLBody: "<p>hi</p>", TextBody: "hi"})
	if err != nil {
		t.Fatalf("Send returned error: %v", err)
	}

	if gotPath != "/email" {
		t.Errorf("path = %q, want /email", gotPath)
	}
	if gotToken != "pm-token" {
		t.Errorf("token header = %q", gotToken)
	}
	if body["From"] != "catalog@finevines.biz" {
		t.Errorf("From = %v", body["From"])
	}
	if body["To"] != "george@example.com,barbara@example.com" {
		t.Errorf("To = %v, want the comma-joined list Postmark expects", body["To"])
	}
	if body["Subject"] != "Fine Vines catalog: 1 new wine" || body["HtmlBody"] != "<p>hi</p>" || body["TextBody"] != "hi" {
		t.Errorf("body = %+v", body)
	}
	if body["MessageStream"] != "outbound" {
		t.Errorf("MessageStream = %v, want outbound", body["MessageStream"])
	}
}

// Postmark reports application errors with HTTP 200 and a non-zero ErrorCode —
// an unverified sender signature, most likely. Treating that as success would
// mean silently never delivering the digest.
func TestPostmarkSender_NonZeroErrorCodeIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ErrorCode":400,"Message":"Sender signature not confirmed"}`))
	}))
	defer srv.Close()

	s := NewPostmarkSender("pm-token", srv.Client())
	s.BaseURL = srv.URL
	err := s.Send(context.Background(), "nope@example.com", []string{"a@example.com"}, Message{})
	if err == nil {
		t.Fatal("Send accepted a non-zero ErrorCode")
	}
	if !strings.Contains(err.Error(), "Sender signature not confirmed") {
		t.Errorf("error = %v, want Postmark's own message", err)
	}
}

func TestPostmarkSender_HTTPFailureIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"ErrorCode":10,"Message":"Bad token"}`))
	}))
	defer srv.Close()

	s := NewPostmarkSender("wrong", srv.Client())
	s.BaseURL = srv.URL
	if err := s.Send(context.Background(), "a@example.com", []string{"b@example.com"}, Message{}); err == nil {
		t.Fatal("Send accepted a 401")
	}
}

// A 2xx whose body is not the documented JSON must NOT be read as success. An
// empty body, a corporate proxy's interception page or a Postmark incident page
// all leave ErrorCode at its zero value, and treating that as "sent" is exactly
// the silent non-delivery the ErrorCode guard exists to prevent.
func TestPostmarkSender_UnparseableSuccessBodyIsAnError(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"an HTML interception page", "<html><body>Blocked by proxy</body></html>"},
		{"an empty body", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(tc.body))
			}))
			defer srv.Close()

			s := NewPostmarkSender("pm-token", srv.Client())
			s.BaseURL = srv.URL
			err := s.Send(context.Background(), "a@example.com", []string{"b@example.com"}, Message{})
			if err == nil {
				t.Fatalf("Send accepted a 200 carrying %s — the digest would silently never arrive", tc.name)
			}
		})
	}
}

// The unparseable-body error has to carry enough of the response to recognise
// what intercepted the call, but not a whole HTML page.
func TestPostmarkSender_UnparseableBodyErrorQuotesABoundedPrefix(t *testing.T) {
	long := "<html><body>" + strings.Repeat("x", 5000) + "</body></html>"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(long))
	}))
	defer srv.Close()

	s := NewPostmarkSender("pm-token", srv.Client())
	s.BaseURL = srv.URL
	err := s.Send(context.Background(), "a@example.com", []string{"b@example.com"}, Message{})
	if err == nil {
		t.Fatal("Send accepted a 200 with a non-JSON body")
	}
	if !strings.Contains(err.Error(), "<html><body>") {
		t.Errorf("error = %v, want it to quote the start of the offending body", err)
	}
	if len(err.Error()) > 500 {
		t.Errorf("error is %d chars — the whole page leaked into the log", len(err.Error()))
	}
}

// notify makes exactly one outbound call, as the LAST step of the nightly
// pipeline. An unbounded client turns a stalled connection into a job that hangs
// until the workflow's own multi-hour timeout kills it.
func TestNewPostmarkSender_NilClientFallbackIsBounded(t *testing.T) {
	s := NewPostmarkSender("pm-token", nil)
	if s.HTTP == nil {
		t.Fatal("NewPostmarkSender(nil) left HTTP nil")
	}
	if s.HTTP.Timeout == 0 {
		t.Error("the fallback client has no Timeout — a stalled connection would hang the nightly run")
	}
	// The fallback must be its own client: mutating the shared http.DefaultClient
	// would silently impose this timeout on every other caller in the binary.
	if s.HTTP == http.DefaultClient {
		t.Error("the fallback is http.DefaultClient itself — bounding it would leak into every other client")
	}
}

func TestPostmarkSender_NoRecipientsIsAnError(t *testing.T) {
	s := NewPostmarkSender("pm-token", http.DefaultClient)
	if err := s.Send(context.Background(), "a@example.com", nil, Message{}); err == nil {
		t.Fatal("Send accepted an empty recipient list")
	}
}

var _ Sender = (*PostmarkSender)(nil)

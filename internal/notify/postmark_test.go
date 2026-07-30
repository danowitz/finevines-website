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

func TestPostmarkSender_NoRecipientsIsAnError(t *testing.T) {
	s := NewPostmarkSender("pm-token", http.DefaultClient)
	if err := s.Send(context.Background(), "a@example.com", nil, Message{}); err == nil {
		t.Fatal("Send accepted an empty recipient list")
	}
}

var _ Sender = (*PostmarkSender)(nil)

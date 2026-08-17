package openairesponses

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientCallsResponsesWithWebSearch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer key" {
			t.Fatalf("unexpected request %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		tools, ok := body["tools"].([]any)
		if !ok || len(tools) != 1 {
			t.Fatalf("tools = %#v", body["tools"])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"output_text":"researched"}`))
	}))
	defer server.Close()

	client := New("key", "gpt-test", server.URL, server.Client())
	got, err := client.Call(context.Background(), Request{Instructions: "rules", Input: "brief", WebSearch: true})
	if err != nil {
		t.Fatal(err)
	}
	if got != "researched" {
		t.Fatalf("output = %q", got)
	}
}

func TestClientRejectsEmptyOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"output":[]}`))
	}))
	defer server.Close()
	_, err := New("key", "gpt-test", server.URL, server.Client()).Call(context.Background(), Request{})
	if err == nil {
		t.Fatal("expected empty output error")
	}
}

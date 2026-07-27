package enrich

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anthropics/anthropic-sdk-go/option"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func testWine() salesforce.WineRaw {
	return salesforce.WineRaw{
		ID:          "SF-1",
		SKU:         "AB1234",
		Producer:    "Domaine Hubert Lamy",
		Name:        "Saint-Aubin 1er Cru",
		Vintage:     "2021",
		Varietal:    "Chardonnay",
		Region:      "Burgundy",
		Appellation: "Saint-Aubin",
		Style:       "White, dry",
		StockQty:    12,
	}
}

// messagesResponseJSON builds a minimal-but-valid Anthropic Messages API
// response whose sole text content block is textBody.
func messagesResponseJSON(textBody string) string {
	resp := map[string]any{
		"id":    "msg_test123",
		"type":  "message",
		"role":  "assistant",
		"model": "claude-opus-4-8",
		"content": []map[string]any{
			{"type": "text", "text": textBody},
		},
		"stop_reason":   "end_turn",
		"stop_sequence": nil,
		"usage": map[string]any{
			"input_tokens":  100,
			"output_tokens": 50,
		},
	}
	b, err := json.Marshal(resp)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func TestEnrichGroundedRoundTrip(t *testing.T) {
	const wantDescription = "A bright, mineral Chardonnay with citrus and orchard-fruit lift."
	const wantNotes = "Serve chilled alongside roast chicken or shellfish."
	const wantImagePrompt = "Photorealistic studio product photograph of a tall, pale-green Burgundy bottle with a classic white-Burgundy label."

	textJSON, err := json.Marshal(EnrichResult{
		Description:    wantDescription,
		SommelierNotes: wantNotes,
		ImagePrompt:    wantImagePrompt,
	})
	if err != nil {
		t.Fatal(err)
	}

	var gotBody map[string]any
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if r.URL.Path != "/v1/messages" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(messagesResponseJSON(string(textJSON))))
	}))
	defer server.Close()

	enricher := NewSearchEnricher("test-key", option.WithBaseURL(server.URL))
	got, err := enricher.Enrich(t.Context(), testWine())
	if err != nil {
		t.Fatalf("Enrich returned error: %v", err)
	}

	if callCount != 1 {
		t.Fatalf("want 1 call to the Messages endpoint, got %d", callCount)
	}

	// Grounding: model string is exactly the pinned Opus 4.8 id.
	if model, _ := gotBody["model"].(string); model != "claude-opus-4-8" {
		t.Errorf("want model claude-opus-4-8, got %q", model)
	}

	// Grounding: the user prompt must contain the real Salesforce facts —
	// never invented ones.
	prompt := extractUserPromptText(t, gotBody)
	for _, want := range []string{"Domaine Hubert Lamy", "Burgundy", "Chardonnay", "2021"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("user prompt missing grounding fact %q; prompt was:\n%s", want, prompt)
		}
	}

	// Round-trip.
	if got.Description != wantDescription {
		t.Errorf("Description = %q, want %q", got.Description, wantDescription)
	}
	if got.SommelierNotes != wantNotes {
		t.Errorf("SommelierNotes = %q, want %q", got.SommelierNotes, wantNotes)
	}
	if got.ImagePrompt != wantImagePrompt {
		t.Errorf("ImagePrompt = %q, want %q", got.ImagePrompt, wantImagePrompt)
	}
}

func TestEnrichRetriesOnceThenErrorsOnMalformedJSON(t *testing.T) {
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(messagesResponseJSON("this is not JSON at all {{{")))
	}))
	defer server.Close()

	enricher := NewSearchEnricher("test-key", option.WithBaseURL(server.URL))
	_, err := enricher.Enrich(t.Context(), testWine())
	if err == nil {
		t.Fatal("want error for malformed JSON after retry, got nil")
	}
	if callCount != 2 {
		t.Fatalf("want exactly 2 calls (1 original + 1 retry), got %d", callCount)
	}
}

// extractUserPromptText digs the concatenated text of the first user
// message out of the decoded request body sent to the fake Messages
// endpoint, tolerating either the string-shorthand or content-block-array
// message shape.
func extractUserPromptText(t *testing.T, body map[string]any) string {
	t.Helper()
	msgs, _ := body["messages"].([]any)
	if len(msgs) == 0 {
		t.Fatal("request body had no messages")
	}
	var sb strings.Builder
	for _, m := range msgs {
		msg, _ := m.(map[string]any)
		if msg["role"] != "user" {
			continue
		}
		switch content := msg["content"].(type) {
		case string:
			sb.WriteString(content)
		case []any:
			for _, blk := range content {
				b, _ := blk.(map[string]any)
				if txt, ok := b["text"].(string); ok {
					sb.WriteString(txt)
				}
			}
		}
	}
	return sb.String()
}

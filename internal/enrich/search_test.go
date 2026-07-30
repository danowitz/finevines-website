package enrich

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

// responsesJSON builds a minimal-but-valid OpenAI Responses API reply whose
// single message block's output_text is textBody.
func responsesJSON(textBody string) string {
	resp := map[string]any{
		"id":     "resp_test123",
		"object": "response",
		"model":  "gpt-4.1",
		"output": []map[string]any{
			{
				"type": "message",
				"role": "assistant",
				"content": []map[string]any{
					{"type": "output_text", "text": textBody},
				},
			},
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
	const wantImagePrompt = "Photorealistic studio product photograph of a tall, pale-green Burgundy bottle."

	resultJSON, err := json.Marshal(EnrichResult{
		Description:     wantDescription,
		SommelierNotes:  wantNotes,
		Country:         "France",
		MatchConfidence: 92,
		Sources:         map[string]string{"description": "found", "country": "found"},
		ImagePrompt:     wantImagePrompt,
	})
	if err != nil {
		t.Fatal(err)
	}

	var gotBody map[string]any
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if r.URL.Path != "/v1/responses" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization = %q, want %q", got, "Bearer test-key")
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(responsesJSON(string(resultJSON))))
	}))
	defer server.Close()

	enricher := NewOpenAIEnricher("test-key", "gpt-4.1", server.URL, server.Client())
	got, err := enricher.Enrich(t.Context(), testWine())
	if err != nil {
		t.Fatalf("Enrich returned error: %v", err)
	}
	if callCount != 1 {
		t.Fatalf("want 1 call to the Responses endpoint, got %d", callCount)
	}

	// The request must carry the web_search tool and the configured model.
	if model, _ := gotBody["model"].(string); model != "gpt-4.1" {
		t.Errorf("want model gpt-4.1, got %q", model)
	}
	tools, _ := gotBody["tools"].([]any)
	if len(tools) == 0 {
		t.Error("request missing tools (web_search)")
	} else if tool, _ := tools[0].(map[string]any); tool["type"] != "web_search" {
		t.Errorf("first tool = %v, want type web_search", tool)
	}

	// Grounding: the input must contain the real Salesforce facts.
	input, _ := gotBody["input"].(string)
	for _, want := range []string{"Domaine Hubert Lamy", "Burgundy", "Chardonnay", "2021"} {
		if !strings.Contains(input, want) {
			t.Errorf("input missing grounding fact %q; input was:\n%s", want, input)
		}
	}

	// Round-trip of the parsed result.
	if got.Description != wantDescription || got.Country != "France" || got.MatchConfidence != 92 {
		t.Errorf("round-trip mismatch: %+v", got)
	}
	if got.Sources["country"] != "found" {
		t.Errorf("sources not parsed: %v", got.Sources)
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
		w.Write([]byte(responsesJSON("this is not JSON at all {{{")))
	}))
	defer server.Close()

	enricher := NewOpenAIEnricher("test-key", "gpt-4.1", server.URL, server.Client())
	_, err := enricher.Enrich(t.Context(), testWine())
	if err == nil {
		t.Fatal("want error for malformed JSON after retry, got nil")
	}
	if callCount != 2 {
		t.Fatalf("want exactly 2 calls (1 original + 1 retry), got %d", callCount)
	}
}

func TestEnrichSurfacesHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":{"message":"bad key"}}`))
	}))
	defer server.Close()

	enricher := NewOpenAIEnricher("test-key", "gpt-4.1", server.URL, server.Client())
	if _, err := enricher.Enrich(t.Context(), testWine()); err == nil {
		t.Fatal("want error on HTTP 401, got nil")
	}
}

// EnrichWithNote must put the reviewer's correction in the prompt VERBATIM and
// AFTER the wine's facts, so the model reads it as a correction to them rather
// than as another fact. The note is the whole value of the text-feedback
// action: "says oaked; this wine is unoaked" has to survive to the model
// unparaphrased.
func TestEnrichWithNote_AppendsTheReviewerNoteAfterTheFacts(t *testing.T) {
	var gotInput string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		gotInput, _ = req["input"].(string)
		// Via responsesJSON, not a hand-rolled body: the reply has to be a real
		// Responses-API shape (an output item of type "message"), which is what
		// responsesOutputText looks for.
		w.Write([]byte(responsesJSON(`{"description":"Unoaked and precise.","sommelierNotes":"Serve cool.",` +
			`"sources":{"description":"found"},"matchConfidence":88}`)))
	}))
	defer srv.Close()

	e := NewOpenAIEnricher("key", "gpt-4.1", srv.URL, srv.Client())
	res, err := e.EnrichWithNote(context.Background(),
		salesforce.WineRaw{SKU: "MB5110", Producer: "Brezza", Name: "Langhe Chardonnay"},
		"says oaked; this wine is unoaked")
	if err != nil {
		t.Fatalf("EnrichWithNote returned error: %v", err)
	}
	if res.Description != "Unoaked and precise." {
		t.Errorf("Description = %q", res.Description)
	}
	if !strings.Contains(gotInput, "says oaked; this wine is unoaked") {
		t.Errorf("the reviewer note is not in the prompt:\n%s", gotInput)
	}
	if i, j := strings.Index(gotInput, "Brezza"), strings.Index(gotInput, "says oaked"); i < 0 || j < i {
		t.Errorf("the note does not follow the wine's facts (producer at %d, note at %d):\n%s", i, j, gotInput)
	}
}

// Enrich must keep behaving exactly as before: it is EnrichWithNote with an
// empty note, and an empty note must add nothing at all to the prompt.
func TestEnrich_AddsNoCorrectionSection(t *testing.T) {
	var gotInput string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		gotInput, _ = req["input"].(string)
		w.Write([]byte(responsesJSON(
			`{"description":"d","sommelierNotes":"s","sources":{},"matchConfidence":50}`)))
	}))
	defer srv.Close()

	e := NewOpenAIEnricher("key", "gpt-4.1", srv.URL, srv.Client())
	if _, err := e.Enrich(context.Background(), salesforce.WineRaw{SKU: "AB1201"}); err != nil {
		t.Fatalf("Enrich returned error: %v", err)
	}
	if strings.Contains(strings.ToLower(gotInput), "correction") {
		t.Errorf("Enrich added a correction section with no note:\n%s", gotInput)
	}
}

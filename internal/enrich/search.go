package enrich

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// EnrichResult is everything one search-and-extract call produces for a single
// wine: the descriptive/tasting fields, per-field provenance (so we know what
// was really sourced versus inferred), a match-confidence score, an optional
// real image URL, and an image-generation prompt for the fallback. The JSON
// tags are the contract the model is asked to return.
type EnrichResult struct {
	Description    string   `json:"description"`
	SommelierNotes string   `json:"sommelierNotes"`
	Aroma          string   `json:"aroma"`
	Palate         string   `json:"palate"`
	Finish         string   `json:"finish"`
	FoodPairings   []string `json:"foodPairings"`
	Appellation    string   `json:"appellation"`
	Country        string   `json:"country"`
	Color          string   `json:"color"`
	ABV            string   `json:"abv"`
	BottleSize     string   `json:"bottleSize"`
	DrinkWindow    string   `json:"drinkWindow"`

	// Sources maps each descriptive field name to "found" (from a real web
	// source), "derived" (inferred from varietal/region/style), or "missing".
	Sources map[string]string `json:"sources"`

	// MatchConfidence (0–100) is how sure the model is that the sourced facts
	// are about this exact wine (producer + name + vintage), not a lookalike.
	MatchConfidence int `json:"matchConfidence"`

	// ImageURL is a real bottle/label image found on the web (empty if none);
	// the image chain tries it before generating. ImagePrompt drives the
	// AI-generated fallback when no real image is usable.
	ImageURL    string `json:"imageUrl"`
	ImagePrompt string `json:"imagePrompt"`
}

// defaultEnrichModel is the OpenAI model used for enrichment when none is
// configured. It must be a model that supports the web_search tool.
const defaultEnrichModel = "gpt-4.1"

// OpenAIEnricher enriches one wine at a time via OpenAI's Responses API with
// the web_search tool: the model searches the web for the wine, extracts
// structured facts, writes original tasting prose, and reports where each
// field came from. It talks to the REST API directly (no SDK) so tests can
// point baseURL at an httptest.Server, matching the ImagenClient/Salesforce
// pattern in this package.
type OpenAIEnricher struct {
	apiKey  string
	model   string
	baseURL string
	http    *http.Client
}

// NewOpenAIEnricher builds an enricher. model defaults to defaultEnrichModel;
// baseURL defaults to the public API and has any trailing slash trimmed so a
// test server URL doesn't produce a doubled slash.
func NewOpenAIEnricher(apiKey, model, baseURL string, hc *http.Client) *OpenAIEnricher {
	if model == "" {
		model = defaultEnrichModel
	}
	if baseURL == "" {
		baseURL = "https://api.openai.com"
	}
	return &OpenAIEnricher{apiKey: apiKey, model: model, baseURL: strings.TrimSuffix(baseURL, "/"), http: hc}
}

var _ Enricher = (*OpenAIEnricher)(nil)

// searchSystem fixes FineVines' editorial voice, directs the web search, and —
// critically — pins the copyright and grounding guardrails: scrape structured
// FACTS, write ORIGINAL prose (never lift copyrighted tasting notes or critic
// text verbatim), and never invent scores/prices/awards. Every field's
// provenance must be reported honestly so the coverage score is meaningful.
const searchSystem = `You research and write catalog copy for FineVines, a licensed
Illinois wholesale wine distributor. Voice: elegant, editorial, old-world wine
trade, never corporate-tech. Never use em dashes or en dashes anywhere in the
copy; use commas, colons, or periods instead.

Use web search to find authoritative information about the EXACT wine described
(match producer, wine name, and vintage). Prefer the producer/importer site and
reputable references. Then return a single JSON object with these keys:

- "description": 2–3 original sentences of trade tasting copy.
- "sommelierNotes": 1–2 sentences of service/pairing guidance.
- "aroma","palate","finish": a short original phrase each (may be "").
- "foodPairings": array of 2–5 short pairing strings (may be []).
- "appellation","country","color","abv","bottleSize","drinkWindow": factual
  fields as strings (e.g. abv "13.5%", bottleSize "750ml"); "" if unknown.
- "sources": an object mapping EACH of description, sommelierNotes, aroma,
  palate, finish, foodPairings, appellation, country, color, abv, bottleSize,
  drinkWindow to one of "found" (established from a real search result),
  "derived" (inferred from grape/region/style with no wine-specific source),
  or "missing".
- "matchConfidence": integer 0–100, your confidence the facts are about THIS
  exact wine and vintage.
- "imageUrl": URL of a real bottle or label image you found, else "".
- "imagePrompt": a prompt for a photorealistic studio product photo of this
  bottle (region/style-appropriate bottle and label, neutral warm-grey
  backdrop, soft light; no people, scenery, or non-label logos).

RULES: Write ORIGINAL prose; never copy tasting notes, reviews, or other
copyrighted text verbatim. Never invent critic scores, prices, awards, or
provenance; if unsure, mark the field "derived" or "missing" and keep the copy
general. Respond with ONLY the JSON object, no prose around it.`

// Enrich runs one web-search-grounded enrichment for w. See EnrichWithNote: this
// is that call with no human correction attached, so there is one request shape
// and one retry policy for both paths.
func (e *OpenAIEnricher) Enrich(ctx context.Context, w salesforce.WineRaw) (EnrichResult, error) {
	return e.EnrichWithNote(ctx, w, "")
}

// EnrichWithNote is Enrich with a reviewer's correction attached.
//
// The note is fed VERBATIM and placed AFTER the wine's facts, under an explicit
// heading, so the model reads it as a correction TO those facts rather than as
// another one of them. That ordering is the whole value of the text-feedback
// action: "says oaked; this wine is unoaked" is a human overruling the web, and
// paraphrasing or burying it would lose the override.
//
// If the response can't be parsed into a usable EnrichResult, the call is
// retried once before giving up (LLM output occasionally drifts from the
// requested shape, and a same-call retry is cheap insurance without masking a
// persistently broken prompt or endpoint).
func (e *OpenAIEnricher) EnrichWithNote(ctx context.Context, w salesforce.WineRaw, note string) (EnrichResult, error) {
	prompt := fmt.Sprintf(
		"Producer: %s\nWine: %s\nVintage: %s\nVarietal: %s\nRegion: %s\nAppellation: %s\nStyle: %s\nSKU: %s",
		w.Producer, w.Name, w.Vintage, w.Varietal, w.Region, w.Appellation, w.Style, w.SKU)
	if strings.TrimSpace(note) != "" {
		prompt += "\n\nCORRECTION FROM THE FINEVINES TEAM (authoritative, overrides anything you find on the web):\n" + note
	}

	reqObj := map[string]any{
		"model":             e.model,
		"instructions":      searchSystem,
		"input":             prompt,
		"tools":             []map[string]string{{"type": "web_search"}},
		"max_output_tokens": 2000,
	}

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		text, err := e.call(ctx, reqObj)
		if err != nil {
			return EnrichResult{}, err // transport/HTTP error: caller logs & retries next run
		}
		out, perr := parseEnrichResult([]byte(text))
		if perr == nil {
			return out, nil
		}
		lastErr = fmt.Errorf("unparseable enrichment for %s (attempt %d): %w", w.SKU, attempt+1, perr)
	}
	return EnrichResult{}, lastErr
}

// call POSTs one Responses API request and returns the assistant's aggregated
// output text.
func (e *OpenAIEnricher) call(ctx context.Context, reqObj map[string]any) (string, error) {
	body, err := json.Marshal(reqObj)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.baseURL+"/v1/responses", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+e.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("openai responses: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("openai responses: read body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("openai responses: HTTP %d: %s", resp.StatusCode, snippet(data))
	}
	return responsesOutputText(data)
}

// responsesOutputText pulls the assistant's text out of a Responses API reply,
// tolerating either the convenience top-level "output_text" or the structured
// "output[].content[]" array of output_text blocks.
func responsesOutputText(data []byte) (string, error) {
	var parsed struct {
		OutputText string `json:"output_text"`
		Output     []struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return "", fmt.Errorf("openai responses: decode: %w", err)
	}
	if strings.TrimSpace(parsed.OutputText) != "" {
		return parsed.OutputText, nil
	}
	var sb strings.Builder
	for _, o := range parsed.Output {
		if o.Type != "message" {
			continue
		}
		for _, c := range o.Content {
			if c.Type == "output_text" {
				sb.WriteString(c.Text)
			}
		}
	}
	return sb.String(), nil
}

func snippet(b []byte) string {
	const max = 300
	if len(b) > max {
		return string(b[:max]) + "…"
	}
	return string(b)
}

// parseEnrichResult extracts the JSON object from a model text response
// (tolerating a ```json fence or surrounding prose) and validates the minimum
// usable shape: a non-empty description. It is separated from the API call so
// the parsing contract can be unit-tested without a live endpoint.
func parseEnrichResult(raw []byte) (EnrichResult, error) {
	s := strings.TrimSpace(string(raw))
	s = strings.TrimPrefix(s, "```json")
	s = strings.Trim(s, "` \n")
	// Be forgiving of leading/trailing prose: slice to the outermost braces.
	if i, j := strings.IndexByte(s, '{'), strings.LastIndexByte(s, '}'); i >= 0 && j > i {
		s = s[i : j+1]
	}
	// Models slip non-breaking spaces (U+00A0, narrow U+202F) into text
	// fields; fold them to plain spaces once here so every field is covered.
	s = strings.NewReplacer("\u00a0", " ", "\u202f", " ").Replace(s)
	var out EnrichResult
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return EnrichResult{}, err
	}
	if strings.TrimSpace(out.Description) == "" {
		return EnrichResult{}, fmt.Errorf("enrichment JSON missing required description")
	}
	return out, nil
}

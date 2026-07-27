package enrich

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// EnrichResult is everything one search-and-extract call produces for a single
// wine: the descriptive/tasting fields, per-field provenance (so we know what
// was really sourced versus inferred), a match-confidence score, an optional
// real image URL, and an image-generation prompt for the fallback. The JSON
// tags are the contract Claude is asked to return.
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

	// MatchConfidence (0–100) is how sure Claude is that the sourced facts are
	// about this exact wine (producer + name + vintage), not a lookalike.
	MatchConfidence int `json:"matchConfidence"`

	// ImageURL is a real bottle/label image found on the web (empty if none);
	// the image chain tries it before generating. ImagePrompt drives the
	// AI-generated fallback when no real image is usable.
	ImageURL    string `json:"imageUrl"`
	ImagePrompt string `json:"imagePrompt"`
}

// SearchEnricher enriches one wine at a time via the Anthropic Messages API
// with the server-side web_search tool: Claude searches the web for the wine,
// extracts structured facts, writes original tasting prose, and reports where
// each field came from.
type SearchEnricher struct {
	client anthropic.Client
}

// NewSearchEnricher builds a SearchEnricher against the given API key. Extra
// opts are forwarded to SDK client construction — production callers need
// none; tests pass option.WithBaseURL to point at an httptest.Server.
func NewSearchEnricher(apiKey string, opts ...option.RequestOption) *SearchEnricher {
	return &SearchEnricher{client: anthropic.NewClient(append([]option.RequestOption{option.WithAPIKey(apiKey)}, opts...)...)}
}

// searchSystem fixes FineVines' editorial voice, directs the web search, and —
// critically — pins the copyright and grounding guardrails: scrape structured
// FACTS, write ORIGINAL prose (never lift copyrighted tasting notes or critic
// text verbatim), and never invent scores/prices/awards. Every field's
// provenance must be reported honestly so the coverage score is meaningful.
const searchSystem = `You research and write catalog copy for FineVines, a licensed
Illinois wholesale wine distributor. Voice: elegant, editorial, old-world wine
trade — never corporate-tech.

Use the web_search tool to find authoritative information about the EXACT wine
described (match producer, wine name, and vintage). Prefer the producer/importer
site and reputable references. Then return a single JSON object with these keys:

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

RULES: Write ORIGINAL prose — never copy tasting notes, reviews, or other
copyrighted text verbatim. Never invent critic scores, prices, awards, or
provenance; if unsure, mark the field "derived" or "missing" and keep the copy
general. Respond with ONLY the JSON object, no prose around it.`

// Enrich runs one web-search-grounded enrichment for w. Claude is asked for a
// bare JSON object; if the response can't be parsed into a usable EnrichResult,
// Enrich retries once before giving up (LLM output occasionally drifts from the
// requested shape, and a same-call retry is cheap insurance without masking a
// persistently broken prompt or endpoint).
func (t *SearchEnricher) Enrich(ctx context.Context, w salesforce.WineRaw) (EnrichResult, error) {
	prompt := fmt.Sprintf(
		"Producer: %s\nWine: %s\nVintage: %s\nVarietal: %s\nRegion: %s\nAppellation: %s\nStyle: %s\nSKU: %s",
		w.Producer, w.Name, w.Vintage, w.Varietal, w.Region, w.Appellation, w.Style, w.SKU)

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		resp, err := t.client.Beta.Messages.New(ctx, anthropic.BetaMessageNewParams{
			Model:     anthropic.ModelClaudeOpus4_8,
			MaxTokens: 2000,
			System:    []anthropic.BetaTextBlockParam{{Text: searchSystem}},
			Messages: []anthropic.BetaMessageParam{
				anthropic.NewBetaUserMessage(anthropic.NewBetaTextBlock(prompt)),
			},
			Tools: []anthropic.BetaToolUnionParam{
				{OfWebSearchTool20250305: &anthropic.BetaWebSearchTool20250305Param{MaxUses: anthropic.Int(5)}},
			},
		})
		if err != nil {
			return EnrichResult{}, err // SDK already retried 429/5xx
		}

		var text strings.Builder
		for _, block := range resp.Content {
			if b, ok := block.AsAny().(anthropic.BetaTextBlock); ok {
				text.WriteString(b.Text)
			}
		}

		out, err := parseEnrichResult([]byte(text.String()))
		if err == nil {
			return out, nil
		}
		lastErr = fmt.Errorf("unparseable enrichment for %s (attempt %d): %w", w.SKU, attempt+1, err)
	}
	return EnrichResult{}, lastErr
}

// parseEnrichResult extracts the JSON object from a model text response
// (tolerating a ```json fence) and validates the minimum usable shape: a
// non-empty description. It is separated from the API call so the parsing
// contract can be unit-tested without a live endpoint.
func parseEnrichResult(raw []byte) (EnrichResult, error) {
	s := strings.TrimSpace(string(raw))
	s = strings.TrimPrefix(s, "```json")
	s = strings.Trim(s, "` \n")
	// Be forgiving of leading/trailing prose: slice to the outermost braces.
	if i, j := strings.IndexByte(s, '{'), strings.LastIndexByte(s, '}'); i >= 0 && j > i {
		s = s[i : j+1]
	}
	var out EnrichResult
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return EnrichResult{}, err
	}
	if strings.TrimSpace(out.Description) == "" {
		return EnrichResult{}, fmt.Errorf("enrichment JSON missing required description")
	}
	return out, nil
}

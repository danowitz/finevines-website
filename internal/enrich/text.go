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

// TextResult is everything one Claude call produces for a single wine: the
// trade-facing tasting description, sommelier service/pairing notes, and a
// prompt for the bottle-photo image pipeline. Bundling the image prompt into
// the same call means it rides along free instead of costing a second
// round-trip to Claude.
type TextResult struct {
	Description    string `json:"description"`
	SommelierNotes string `json:"sommelierNotes"`
	ImagePrompt    string `json:"imagePrompt"`
}

// TextEnricher generates catalog copy for one wine at a time via the
// Anthropic Messages API.
type TextEnricher struct {
	client anthropic.Client
}

// NewTextEnricher builds a TextEnricher against the given API key. Extra
// opts are forwarded to the SDK client construction — production callers
// need none, tests pass option.WithBaseURL to point the client at an
// httptest.Server instead of the real Anthropic API.
func NewTextEnricher(apiKey string, opts ...option.RequestOption) *TextEnricher {
	return &TextEnricher{client: anthropic.NewClient(append([]option.RequestOption{option.WithAPIKey(apiKey)}, opts...)...)}
}

// textSystem is the grounded system prompt: it fixes FineVines' editorial
// voice and, just as important, forbids Claude from inventing any fact not
// present in the per-wine prompt (scores, prices, vintages, awards,
// provenance). The catalog only ever states what Salesforce actually knows.
const textSystem = `You write catalog copy for FineVines, a licensed Illinois
wholesale wine distributor. Voice: elegant, editorial, old-world wine trade —
never corporate-tech. You will receive the known facts about one wine. Write:
1. "description": a 2–3 sentence tasting description for the trade.
2. "sommelierNotes": 1–2 sentences of service/pairing guidance.
3. "imagePrompt": a prompt for a photorealistic studio product photograph of
   this bottle — describe bottle shape and glass color typical for the region
   and style, a classic label consistent with the producer and appellation,
   neutral warm-grey studio backdrop, soft key light. Never include people,
   scenery, or brand logos other than plausible label text.
STRICT GROUNDING: use only the provided facts. Never invent scores, prices,
vintages, awards, or provenance. If a field is empty, omit that aspect.
Respond with a single JSON object with exactly those three string keys and
nothing else.`

// Enrich asks Claude for the tasting description, sommelier notes, and
// image prompt for w in a single call. Claude is instructed to respond with
// a bare JSON object; if the response can't be parsed into a usable
// TextResult (malformed JSON, or missing the two required fields), Enrich
// retries once before giving up — LLM output occasionally drifts from the
// requested shape, and a same-call retry is cheap insurance against that
// without masking a persistently broken prompt or endpoint.
func (t *TextEnricher) Enrich(ctx context.Context, w salesforce.WineRaw) (TextResult, error) {
	prompt := fmt.Sprintf(
		"Producer: %s\nWine: %s\nVintage: %s\nVarietal: %s\nRegion: %s\nAppellation: %s\nStyle: %s",
		w.Producer, w.Name, w.Vintage, w.Varietal, w.Region, w.Appellation, w.Style)

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		resp, err := t.client.Messages.New(ctx, anthropic.MessageNewParams{
			Model:     anthropic.ModelClaudeOpus4_8,
			MaxTokens: 1024,
			System:    []anthropic.TextBlockParam{{Text: textSystem}},
			Messages: []anthropic.MessageParam{
				anthropic.NewUserMessage(anthropic.NewTextBlock(prompt)),
			},
		})
		if err != nil {
			return TextResult{}, err // SDK already retried 429/5xx
		}

		var text strings.Builder
		for _, block := range resp.Content {
			if b, ok := block.AsAny().(anthropic.TextBlock); ok {
				text.WriteString(b.Text)
			}
		}

		var out TextResult
		raw := strings.TrimSpace(text.String())
		raw = strings.TrimPrefix(raw, "```json")
		raw = strings.Trim(raw, "` \n")
		if err := json.Unmarshal([]byte(raw), &out); err == nil &&
			out.Description != "" && out.ImagePrompt != "" {
			return out, nil
		} else {
			lastErr = fmt.Errorf("unparseable enrichment for %s (attempt %d): %w", w.SKU, attempt+1, err)
		}
	}
	return TextResult{}, lastErr
}

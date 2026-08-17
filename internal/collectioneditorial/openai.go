package collectioneditorial

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gritautomation/finevines-website/internal/openairesponses"
)

const defaultResearchModel = "gpt-4.1"

const researchInstructions = `You research and write collection-page editorial for FineVines, an Illinois wholesale wine distributor.

The page must help a wine buyer understand the named region, producer, or varietal and then explore the actual FineVines selection. Use web search. Prefer primary, authoritative sources: an official producer or importer for a producer, an official wine board or recognized institutional reference for a region, and an educational or official wine reference for a varietal.

Return one JSON object with exactly these keys:
- "publishable": boolean. False when the identity is ambiguous or authoritative facts cannot be established.
- "changed": boolean. For a scheduled review, false when the existing copy remains accurate and useful. For a new page or material catalog change, true.
- "eyebrow": short reader-facing label.
- "heading": specific, natural heading.
- "paragraphs": two original paragraphs, 120 to 190 words total.
- "sources": array of {"label":"...","url":"https://..."} for the authoritative sources used.

Writing rules: elegant and editorial, but plain enough to read quickly. Sound like an experienced wine professional, not a model. Never mention AI. Never use em dashes or en dashes. Avoid empty superlatives, generic luxury language, critic scores, prices, awards, and facts you cannot support. Do not copy source prose. Do not name individual wines, vintages, inventory quantities, or catalog counts because those details change independently of this article. The catalog brief is authoritative for the regions, producers, and varietals FineVines currently carries. Web sources are authoritative for external facts. If publishable is false, leave the copy fields empty. Respond with JSON only.`

type OpenAIResearcher struct {
	client *openairesponses.Client
}

func NewOpenAIResearcher(apiKey, model, baseURL string, hc *http.Client) *OpenAIResearcher {
	if model == "" {
		model = defaultResearchModel
	}
	return &OpenAIResearcher{client: openairesponses.New(apiKey, model, baseURL, hc)}
}

func (r *OpenAIResearcher) Research(ctx context.Context, assignment Assignment) (Draft, error) {
	brief := struct {
		Reason    Reason    `json:"reason"`
		Candidate Candidate `json:"catalogBrief"`
		Previous  *Entry    `json:"existingEditorial,omitempty"`
	}{Reason: assignment.Reason, Candidate: assignment.Candidate, Previous: assignment.Previous}
	input, err := json.MarshalIndent(brief, "", "  ")
	if err != nil {
		return Draft{}, err
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		text, err := r.client.Call(ctx, openairesponses.Request{
			Instructions: researchInstructions, Input: string(input), MaxOutputTokens: 1800, WebSearch: true,
		})
		if err != nil {
			return Draft{}, err
		}
		draft, err := parseDraft(text)
		if err == nil {
			return draft, nil
		}
		lastErr = err
	}
	return Draft{}, lastErr
}

func parseDraft(raw string) (Draft, error) {
	text := strings.TrimSpace(raw)
	text = strings.TrimPrefix(text, "```json")
	text = strings.Trim(text, "` \n\r\t")
	if start, end := strings.IndexByte(text, '{'), strings.LastIndexByte(text, '}'); start >= 0 && end > start {
		text = text[start : end+1]
	}
	var draft Draft
	if err := json.Unmarshal([]byte(text), &draft); err != nil {
		return Draft{}, err
	}
	if !draft.Publishable {
		return draft, nil
	}
	if strings.TrimSpace(draft.Heading) == "" || len(trimStrings(draft.Paragraphs)) == 0 || len(draft.Sources) == 0 {
		return Draft{}, fmt.Errorf("research JSON is missing heading, paragraphs, or sources")
	}
	paragraphs := trimStrings(draft.Paragraphs)
	if len(paragraphs) != 2 {
		return Draft{}, fmt.Errorf("research JSON must contain exactly two paragraphs")
	}
	wordCount := len(strings.Fields(strings.Join(paragraphs, " ")))
	if wordCount < 120 || wordCount > 190 {
		return Draft{}, fmt.Errorf("research JSON has %d words; expected 120 to 190", wordCount)
	}
	return draft, nil
}

var _ Researcher = (*OpenAIResearcher)(nil)

package enrich

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func TestParseEnrichResult(t *testing.T) {
	full := `{"description":"A taut, saline Chardonnay.","sommelierNotes":"Serve chilled.",
	  "aroma":"citrus","palate":"mineral","finish":"long","foodPairings":["oysters","chicken"],
	  "appellation":"Saint-Aubin","country":"France","color":"White","abv":"13%","bottleSize":"750ml",
	  "drinkWindow":"2024-2030","sources":{"description":"found","country":"found","aroma":"derived"},
	  "matchConfidence":88,"imageUrl":"https://example.com/b.jpg","imagePrompt":"a bottle"}`

	got, err := parseEnrichResult([]byte(full))
	if err != nil {
		t.Fatalf("parse full: %v", err)
	}
	if got.Country != "France" || got.MatchConfidence != 88 || len(got.FoodPairings) != 2 {
		t.Errorf("round-trip lost fields: %+v", got)
	}
	if got.Sources["country"] != "found" || got.Sources["aroma"] != "derived" {
		t.Errorf("sources not parsed: %v", got.Sources)
	}

	// Tolerates a ```json fence and surrounding prose.
	fenced := "Here you go:\n```json\n{\"description\":\"x\",\"matchConfidence\":50}\n```\nthanks"
	if _, err := parseEnrichResult([]byte(fenced)); err != nil {
		t.Errorf("fenced+prose should parse: %v", err)
	}

	// Missing description is a hard error (nothing usable to show).
	if _, err := parseEnrichResult([]byte(`{"sommelierNotes":"x"}`)); err == nil {
		t.Error("empty description must error")
	}
	if _, err := parseEnrichResult([]byte(`not json`)); err == nil {
		t.Error("non-JSON must error")
	}
}

// stubEnricher returns a fixed EnrichResult, for exercising enrichOne's mapping.
type stubEnricher struct{ res EnrichResult }

func (s stubEnricher) Enrich(context.Context, salesforce.WineRaw) (EnrichResult, error) {
	return s.res, nil
}

func TestEnrichOneMapsProvenanceAndScore(t *testing.T) {
	// Pin the clock so EnrichedAt is deterministic.
	fixed := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	orig := nowUTC
	nowUTC = func() time.Time { return fixed }
	defer func() { nowUTC = orig }()

	enr := stubEnricher{res: EnrichResult{
		Description:    "Original prose.",
		SommelierNotes: "Serve cool.",
		Aroma:          "citrus",
		Country:        "France",
		Color:          "White",
		FoodPairings:   []string{"oysters"},
		Sources: map[string]string{
			"description": "found", "sommelierNotes": "found", "country": "found",
			"color": "found", "aroma": "derived", "foodPairings": "found",
		},
		MatchConfidence: 88,
		ImagePrompt:     "a bottle",
	}}

	// Force the image to the SVG-label fallback so no real JPEG is needed:
	// ErrImageRejected makes ResolveImage skip generation and use the label.
	imgs := &fakeImageProvider{fn: func(context.Context, string) ([]byte, error) {
		return nil, ErrImageRejected
	}}

	raw := salesforce.WineRaw{ID: "SF-1", SKU: "AB1201", Producer: "Hubert Lamy", Name: "Saint-Aubin", Vintage: "2021"}
	w, err := enrichOne(context.Background(), enr, imgs, raw, map[string]model.Wine{}, nil, t.TempDir(), nil)
	if err != nil {
		t.Fatalf("enrichOne: %v", err)
	}

	if w.Country != "France" || w.Color != "White" || w.MatchConfidence != 88 {
		t.Errorf("scalar fields not mapped: %+v", w)
	}
	if w.EnrichedAt != "2026-07-27T12:00:00Z" {
		t.Errorf("EnrichedAt = %q, want pinned RFC3339", w.EnrichedAt)
	}
	// image resolved to the label fallback → derived provenance for "image".
	if w.ImageSource != model.ImageGeneratedLabel {
		t.Errorf("ImageSource = %q, want generated-label", w.ImageSource)
	}
	if w.Sources["image"] != model.SourceDerived {
		t.Errorf("image provenance = %q, want derived", w.Sources["image"])
	}
	if w.Sources["description"] != model.SourceFound || w.Sources["aroma"] != model.SourceDerived {
		t.Errorf("field provenance not mapped: %v", w.Sources)
	}
	// 5 found (description, sommelierNotes, country, color, foodPairings) of 13 → 38.
	if want := model.MetadataScore(w.Sources); w.MetadataScore != want || w.MetadataScore != 38 {
		t.Errorf("MetadataScore = %d, want %d (=38)", w.MetadataScore, want)
	}
	// Sanity: the label really was written where ImagePath points.
	if w.ImagePath == "" || filepath.Ext(w.ImagePath) != ".svg" {
		t.Errorf("expected an SVG label image path, got %q", w.ImagePath)
	}
}

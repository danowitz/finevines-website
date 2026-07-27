package enrich

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func TestManualEnricherReadsAuthoredFile(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "AB1234.json"), []byte(
		`{"description":"Real sourced copy.","country":"France","sources":{"description":"found","country":"found"},"matchConfidence":90}`), 0o644)

	res, err := NewManualEnricher(dir).Enrich(context.Background(), salesforce.WineRaw{SKU: "AB1234"})
	if err != nil {
		t.Fatalf("Enrich authored: %v", err)
	}
	if res.Description != "Real sourced copy." || res.Country != "France" || res.Sources["country"] != "found" {
		t.Errorf("authored result not parsed: %+v", res)
	}
}

func TestManualEnricherDerivesWhenMissing(t *testing.T) {
	// No file for this SKU → a derived placeholder so the wine still appears,
	// with honestly "derived" provenance (never "found").
	w := salesforce.WineRaw{SKU: "ZZ9999", Varietal: "Nebbiolo", Region: "Piedmont", Style: "Red · Still"}
	res, err := NewManualEnricher(t.TempDir()).Enrich(context.Background(), w)
	if err != nil {
		t.Fatalf("Enrich missing: %v", err)
	}
	if res.Description == "" {
		t.Error("derived result must still have a description")
	}
	if res.Color != "Red" {
		t.Errorf("derived color = %q, want Red (from style)", res.Color)
	}
	for f, src := range res.Sources {
		if src == "found" || src == "salesforce" {
			t.Errorf("derived result must not mark %q as real (%q)", f, src)
		}
	}
}

func TestLabelOnlyProviderAlwaysDeclines(t *testing.T) {
	_, err := LabelOnlyProvider{}.GenerateJPEG(context.Background(), "prompt")
	if !errors.Is(err, ErrImageRejected) {
		t.Errorf("LabelOnlyProvider must return ErrImageRejected, got %v", err)
	}
}

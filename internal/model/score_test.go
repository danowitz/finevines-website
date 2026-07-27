package model

import "testing"

func TestMetadataScore(t *testing.T) {
	// All 13 scored fields real → 100.
	all := map[string]FieldSource{}
	for _, f := range ScoredFields {
		all[f] = SourceFound
	}
	if got := MetadataScore(all); got != 100 {
		t.Errorf("all-found should score 100, got %d", got)
	}

	// Empty map → every field missing → 0.
	if got := MetadataScore(nil); got != 0 {
		t.Errorf("empty sources should score 0, got %d", got)
	}

	// salesforce counts as real, derived/missing do not.
	mixed := map[string]FieldSource{
		"description":    SourceFound,      // real
		"sommelierNotes": SourceDerived,    // inferred
		"appellation":    SourceSalesforce, // real
		"country":        SourceSalesforce, // real
		"color":          SourceMissing,    // absent
		// remaining 8 fields absent → missing
	}
	// 3 real of 13 → round(100*3/13) = 23.
	if got := MetadataScore(mixed); got != 23 {
		t.Errorf("mixed sources: got %d, want 23", got)
	}

	// A key not in ScoredFields must not inflate the score.
	stray := map[string]FieldSource{"notAField": SourceFound}
	if got := MetadataScore(stray); got != 0 {
		t.Errorf("unscored keys must not count, got %d", got)
	}
}

func TestImageFieldSource(t *testing.T) {
	cases := map[string]FieldSource{
		ImageProducerSupplied: SourceFound,
		ImageScrapedWeb:       SourceFound,
		ImageScrapedGoogle:    SourceFound,
		ImageGeneratedPhoto:   SourceDerived,
		ImageGeneratedLabel:   SourceDerived,
		"":                    SourceMissing,
	}
	for in, want := range cases {
		if got := ImageFieldSource(in); got != want {
			t.Errorf("ImageFieldSource(%q) = %q, want %q", in, got, want)
		}
	}
}

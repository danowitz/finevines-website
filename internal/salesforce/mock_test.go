package salesforce

import (
	"context"
	"strings"
	"testing"
)

func TestMockSourceRoster(t *testing.T) {
	src, err := NewMockSource()
	if err != nil {
		t.Fatalf("NewMockSource: %v", err)
	}

	roster, err := src.Roster(context.Background())
	if err != nil {
		t.Fatalf("Roster: %v", err)
	}
	if len(roster) < 20 {
		t.Fatalf("sample roster too small to be representative: got %d rows, want >= 20", len(roster))
	}

	// Every row must carry the identity fields the downstream pipeline keys
	// on — a blank ID/SKU/Name would be an authoring mistake in the JSON that
	// silently produces a broken catalog entry.
	seenID := map[string]bool{}
	for i, w := range roster {
		if w.ID == "" || w.SKU == "" || w.Name == "" || w.Producer == "" {
			t.Errorf("row %d has an empty identity field: %+v", i, w)
		}
		if seenID[w.ID] {
			t.Errorf("row %d has duplicate Salesforce ID %q", i, w.ID)
		}
		seenID[w.ID] = true
	}

	// The sample deliberately includes web-ineligible rows (SKU starting "9"
	// and stock 0) so the eligibility filter has something to exclude. Assert
	// both kinds are present, otherwise the fixture has drifted and no longer
	// exercises the filter.
	var sku9, zeroStock int
	for _, w := range roster {
		if strings.HasPrefix(w.SKU, "9") {
			sku9++
		}
		if w.StockQty == 0 {
			zeroStock++
		}
	}
	if sku9 == 0 {
		t.Error("expected at least one SKU beginning with 9 (ineligible) in the sample roster")
	}
	if zeroStock == 0 {
		t.Error("expected at least one stock-0 row (ineligible) in the sample roster")
	}
}

// TestMockSourceRosterIsCopy guards the defensive copy in Roster: mutating a
// returned slice must not corrupt a subsequent call's data.
func TestMockSourceRosterIsCopy(t *testing.T) {
	src, err := NewMockSource()
	if err != nil {
		t.Fatalf("NewMockSource: %v", err)
	}
	first, _ := src.Roster(context.Background())
	if len(first) == 0 {
		t.Fatal("empty roster")
	}
	first[0].Name = "MUTATED"

	second, _ := src.Roster(context.Background())
	if second[0].Name == "MUTATED" {
		t.Error("Roster returned a shared slice: mutation leaked into a later call")
	}
}

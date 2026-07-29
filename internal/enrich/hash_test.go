package enrich

import (
	"testing"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func TestSourceHashIsDeterministicAndSensitive(t *testing.T) {
	a := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy", Vintage: "2019", StockQty: 14}
	b := a
	if SourceHash(a) != SourceHash(b) {
		t.Fatal("same input must hash identically")
	}
	b.Vintage = "2020"
	if SourceHash(a) == SourceHash(b) {
		t.Fatal("changed descriptive field must change hash")
	}
	if len(SourceHash(a)) != 64 {
		t.Fatalf("want hex sha256 (64 chars), got %d", len(SourceHash(a)))
	}
}

func TestSourceHashIgnoresVolatileFields(t *testing.T) {
	// StockQty moves with every sale and ReadyToSell is an eligibility gate;
	// neither feeds enrichment, so neither may invalidate the hash — otherwise
	// routine stock movement re-enriches (and re-bills) the whole catalog.
	a := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy", Vintage: "2019", StockQty: 14, ReadyToSell: true}
	b := a
	b.StockQty = 3
	if SourceHash(a) != SourceHash(b) {
		t.Fatal("a stock-only change must not change the hash")
	}
	b.ReadyToSell = false
	if SourceHash(a) != SourceHash(b) {
		t.Fatal("a ready-to-sell flip must not change the hash")
	}
}

func TestSourceHashCoversEveryDescriptiveField(t *testing.T) {
	// Every descriptive/identity field of WineRaw must participate in the
	// hash, so a change in any of them triggers re-enrichment.
	base := salesforce.WineRaw{
		ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy", Name: "Puligny-Montrachet",
		Vintage: "2019", Varietal: "Chardonnay", Region: "Burgundy", Country: "France",
		Appellation: "Puligny-Montrachet AOC", Style: "Still White",
	}
	mutations := map[string]func(*salesforce.WineRaw){
		"ID":          func(w *salesforce.WineRaw) { w.ID = "x" },
		"SKU":         func(w *salesforce.WineRaw) { w.SKU = "x" },
		"Producer":    func(w *salesforce.WineRaw) { w.Producer = "x" },
		"Name":        func(w *salesforce.WineRaw) { w.Name = "x" },
		"Vintage":     func(w *salesforce.WineRaw) { w.Vintage = "x" },
		"Varietal":    func(w *salesforce.WineRaw) { w.Varietal = "x" },
		"Region":      func(w *salesforce.WineRaw) { w.Region = "x" },
		"Country":     func(w *salesforce.WineRaw) { w.Country = "x" },
		"Appellation": func(w *salesforce.WineRaw) { w.Appellation = "x" },
		"Style":       func(w *salesforce.WineRaw) { w.Style = "x" },
	}
	for field, mutate := range mutations {
		w := base
		mutate(&w)
		if SourceHash(w) == SourceHash(base) {
			t.Errorf("changing %s must change the hash", field)
		}
	}
}

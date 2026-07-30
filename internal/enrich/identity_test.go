package enrich

import (
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/normalize"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// identityWine builds the stored Wine a prior enrich run would have written
// for raw — the same normalization enrichOne applies.
func identityWine(raw salesforce.WineRaw) model.Wine {
	return model.Wine{
		ID:       raw.ID,
		SKU:      raw.SKU,
		Producer: normalize.Producer(raw.Producer),
		Name:     normalize.WineName(raw.Name, raw.Producer),
		Vintage:  normalize.Vintage(raw.Vintage),
		Varietal: normalize.Text(raw.Varietal),
		Region:   normalize.Text(raw.Region),
	}
}

func TestIdentityMatches_TrueForUnchangedRawEvenWithStockDrift(t *testing.T) {
	raw := salesforce.WineRaw{
		ID: "SF-1", SKU: "411945", Producer: "LAMY, HUBERT", Name: "PULIGNY MONTRACHET",
		Vintage: "19", Varietal: "CHARDONNAY", Region: "BURGUNDY", StockQty: 14, ReadyToSell: true,
	}
	w := identityWine(raw)

	if !IdentityMatches(raw, w) {
		t.Fatal("stored wine derived from the same raw row must match")
	}

	raw.StockQty = 2
	raw.ReadyToSell = false
	if !IdentityMatches(raw, w) {
		t.Fatal("stock/ready-to-sell drift must not break the identity match")
	}
}

func TestIdentityMatches_FalseWhenDescriptiveFieldChanged(t *testing.T) {
	base := salesforce.WineRaw{
		ID: "SF-1", SKU: "411945", Producer: "LAMY, HUBERT", Name: "PULIGNY MONTRACHET",
		Vintage: "19", Varietal: "CHARDONNAY", Region: "BURGUNDY",
	}
	w := identityWine(base)

	for field, mutate := range map[string]func(*salesforce.WineRaw){
		"SKU":      func(r *salesforce.WineRaw) { r.SKU = "999999" },
		"Producer": func(r *salesforce.WineRaw) { r.Producer = "SOMEONE, ELSE" },
		"Name":     func(r *salesforce.WineRaw) { r.Name = "MEURSAULT" },
		"Vintage":  func(r *salesforce.WineRaw) { r.Vintage = "20" },
		"Varietal": func(r *salesforce.WineRaw) { r.Varietal = "PINOT NOIR" },
		"Region":   func(r *salesforce.WineRaw) { r.Region = "LOIRE" },
	} {
		raw := base
		mutate(&raw)
		if IdentityMatches(raw, w) {
			t.Errorf("changed %s must break the identity match", field)
		}
	}
}

// RawFromWine is what lets something OTHER than a roster pull trigger
// enrichment — a reviewer's text-feedback note, where the only record of the
// wine is the catalog row.
func TestRawFromWine_CarriesEveryEnrichmentInput(t *testing.T) {
	w := model.Wine{
		ID: "01t000000000001", SKU: "AB1201", Producer: "Domaine Bart",
		Name: "Marsannay La Montagne", Vintage: "2019", Varietal: "Pinot Noir",
		Region: "Burgundy", Country: "France", Appellation: "Marsannay",
		Style: "Red", StockQty: 4, StockCases: 3.5, CasePack: 12,
	}
	got := RawFromWine(w)
	want := salesforce.WineRaw{
		ID: "01t000000000001", SKU: "AB1201", Producer: "Domaine Bart",
		Name: "Marsannay La Montagne", Vintage: "2019", Varietal: "Pinot Noir",
		Region: "Burgundy", Country: "France", Appellation: "Marsannay",
		Style: "Red", StockQty: 4, StockCases: 3.5, CasePack: 12, ReadyToSell: true,
	}
	if got != want {
		t.Errorf("RawFromWine mismatch:\n got %+v\nwant %+v", got, want)
	}
}

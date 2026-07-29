package enrich

import (
	"reflect"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func TestDiffRoster_NewWineGoesToEnrich(t *testing.T) {
	raw := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy", StockQty: 14}
	d := DiffRoster([]salesforce.WineRaw{raw}, nil)

	if len(d.Enrich) != 1 || d.Enrich[0].ID != "SF-1" {
		t.Fatalf("want new wine SF-1 in Enrich, got Enrich=%+v", d.Enrich)
	}
	if len(d.Keep) != 0 {
		t.Fatalf("want empty Keep, got %+v", d.Keep)
	}
}

func TestDiffRoster_ChangedHashGoesToEnrich(t *testing.T) {
	raw := salesforce.WineRaw{ID: "SF-2", SKU: "CD5678", Producer: "Domaine X", StockQty: 6}
	existing := []model.Wine{
		{
			ID:          "SF-2",
			SourceHash:  "stale-hash-does-not-match",
			SKU:         "CD5678",
			Producer:    "Domaine X",
			Description: "old description",
			Slug:        "domaine-x-cd5678",
		},
	}

	d := DiffRoster([]salesforce.WineRaw{raw}, existing)

	if len(d.Enrich) != 1 || d.Enrich[0].ID != "SF-2" {
		t.Fatalf("want changed wine SF-2 in Enrich, got Enrich=%+v", d.Enrich)
	}
	if len(d.Keep) != 0 {
		t.Fatalf("want empty Keep, got %+v", d.Keep)
	}
}

func TestDiffRoster_UnchangedGoesToKeepWithEnrichmentFieldsIntact(t *testing.T) {
	raw := salesforce.WineRaw{ID: "SF-3", SKU: "EF9012", Producer: "Chateau Y", StockQty: 20}
	prev := model.Wine{
		ID:             "SF-3",
		SourceHash:     SourceHash(raw),
		SKU:            "EF9012",
		Producer:       "Chateau Y",
		StockQty:       20,
		Description:    "a beautifully balanced wine",
		SommelierNotes: "notes of cherry and oak",
		ImagePath:      "images/wines/chateau-y-ef9012.jpg",
		ImageSource:    model.ImageGeneratedPhoto,
		Slug:           "chateau-y-ef9012",
	}

	d := DiffRoster([]salesforce.WineRaw{raw}, []model.Wine{prev})

	if len(d.Enrich) != 0 {
		t.Fatalf("want empty Enrich, got %+v", d.Enrich)
	}
	if len(d.Keep) != 1 {
		t.Fatalf("want 1 wine in Keep, got %+v", d.Keep)
	}
	if !reflect.DeepEqual(d.Keep[0], prev) {
		t.Fatalf("Keep must carry over the existing wine verbatim, got %+v, want %+v", d.Keep[0], prev)
	}
}

func TestDiffRoster_StockOnlyChangeGoesToKeepWithRefreshedQty(t *testing.T) {
	// Stock movement is excluded from SourceHash, so a stock-only change must
	// NOT re-enrich — but the kept wine must carry the CURRENT quantity, not
	// the stale one, since wines.json stores it.
	raw := salesforce.WineRaw{ID: "SF-8", SKU: "QR5566", Producer: "Chateau Y", Vintage: "2019", StockQty: 3}
	prev := model.Wine{
		ID:          "SF-8",
		SourceHash:  SourceHash(raw),
		SKU:         "QR5566",
		Producer:    "Chateau Y",
		Vintage:     "2019",
		StockQty:    20, // stale: sold down to 3 since the last run
		Description: "a beautifully balanced wine",
		Slug:        "chateau-y-qr5566",
	}

	d := DiffRoster([]salesforce.WineRaw{raw}, []model.Wine{prev})

	if len(d.Enrich) != 0 {
		t.Fatalf("stock-only change must not re-enrich, got Enrich=%+v", d.Enrich)
	}
	if len(d.Keep) != 1 {
		t.Fatalf("want 1 wine in Keep, got %+v", d.Keep)
	}
	if d.Keep[0].StockQty != 3 {
		t.Errorf("kept wine must carry the roster's current stock (3), got %d", d.Keep[0].StockQty)
	}
	if d.Keep[0].Description != "a beautifully balanced wine" {
		t.Errorf("kept wine must retain its enrichment fields, got %+v", d.Keep[0])
	}
}

func TestDiffRoster_RemovedWineIsDroppedEntirely(t *testing.T) {
	// Existing wine SF-4 is not present in the eligible roster (sold out or
	// delisted). It must not appear in Enrich or Keep — removal falls out
	// for free.
	existing := []model.Wine{
		{ID: "SF-4", SourceHash: "whatever", SKU: "GH3456", Producer: "Old Winery"},
	}

	d := DiffRoster(nil, existing)

	if len(d.Enrich) != 0 {
		t.Fatalf("want empty Enrich, got %+v", d.Enrich)
	}
	if len(d.Keep) != 0 {
		t.Fatalf("want empty Keep, got %+v", d.Keep)
	}
}

func TestDiffRoster_ProducerSuppliedWithChangedHashGoesToEnrich(t *testing.T) {
	// A producer-supplied image wine still needs a text refresh when the
	// Salesforce fields change; image preservation across that refresh is
	// asserted separately in Task 15, not here.
	raw := salesforce.WineRaw{ID: "SF-5", SKU: "IJ7890", Producer: "Estate Z", Vintage: "2021", StockQty: 8}
	prev := model.Wine{
		ID:          "SF-5",
		SourceHash:  "stale-hash-does-not-match",
		SKU:         "IJ7890",
		Producer:    "Estate Z",
		Vintage:     "2020", // changed vs. raw -> hash mismatch
		ImagePath:   "images/wines/estate-z-ij7890.jpg",
		ImageSource: model.ImageProducerSupplied,
		Slug:        "estate-z-ij7890",
	}

	d := DiffRoster([]salesforce.WineRaw{raw}, []model.Wine{prev})

	if len(d.Enrich) != 1 || d.Enrich[0].ID != "SF-5" {
		t.Fatalf("want producer-supplied wine SF-5 in Enrich on text change, got Enrich=%+v", d.Enrich)
	}
	if len(d.Keep) != 0 {
		t.Fatalf("want empty Keep, got %+v", d.Keep)
	}
}

func TestDiffRoster_DoesNotMutateInputs(t *testing.T) {
	raw := salesforce.WineRaw{ID: "SF-6", SKU: "KL1122", Producer: "Clos A", StockQty: 3}
	prev := model.Wine{ID: "SF-7", SourceHash: SourceHash(salesforce.WineRaw{ID: "SF-7"}), SKU: "MN3344"}
	eligible := []salesforce.WineRaw{raw}
	existing := []model.Wine{prev}

	_ = DiffRoster(eligible, existing)

	if eligible[0] != raw {
		t.Fatalf("DiffRoster must not mutate its eligible input, got %+v", eligible[0])
	}
	if !reflect.DeepEqual(existing[0], prev) {
		t.Fatalf("DiffRoster must not mutate its existing input, got %+v", existing[0])
	}
	if len(eligible) != 1 || len(existing) != 1 {
		t.Fatalf("DiffRoster must not resize caller slices, got len(eligible)=%d len(existing)=%d", len(eligible), len(existing))
	}
}

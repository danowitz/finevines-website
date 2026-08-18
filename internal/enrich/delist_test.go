package enrich

import (
	"testing"
	"time"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

var delistNow = time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)

func TestDelist_OutOfStockIsRetainedUnavailable(t *testing.T) {
	// In the roster, would be eligible if it had stock -> retain, stamped.
	raw := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Name: "Alpha Reserve", StockQty: 0, ReadyToSell: true}
	w := model.Wine{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve", StockQty: 14, StockCases: 2.5}

	unavailable, drops := Delist([]model.Wine{w}, []salesforce.WineRaw{raw}, map[string]bool{}, delistNow)

	if len(drops) != 0 {
		t.Errorf("no drops expected, got %v", drops)
	}
	if len(unavailable) != 1 {
		t.Fatalf("want 1 retained wine, got %d", len(unavailable))
	}
	got := unavailable[0]
	if got.Status != model.StatusUnavailable || got.DelistedAt != "2026-07-29T12:00:00Z" {
		t.Errorf("not stamped unavailable: status=%q delistedAt=%q", got.Status, got.DelistedAt)
	}
	if got.StockQty != 0 || got.StockCases != 0 {
		t.Errorf("stock must be zeroed, got qty=%d cases=%v", got.StockQty, got.StockCases)
	}
}

func TestDelist_FailsOnlyTheStockClauseIsRetainedNotDropped(t *testing.T) {
	// Merge regression guard (2026-07-29): eligibility's stock clause became
	// whole-bottle math (QuickBooks rounding dust like 0.00001 cases is not
	// stock). A row failing ONLY that clause is out of stock, never
	// "withheld" — it must be retained unavailable. If Delist's probe ever
	// drifts from the real rule again, this is the test that catches every
	// out-of-stock wine being silently dropped and 301'd on the first run.
	raw := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Name: "Alpha Reserve",
		StockQty: 1, StockCases: 0.00001, CasePack: 12, ReadyToSell: true}
	if Eligible(raw) {
		t.Fatal("fixture broken: this row must fail Eligible on stock alone")
	}
	if !Merchandisable(raw) {
		t.Fatal("fixture broken: this row must pass every non-stock clause")
	}
	w := model.Wine{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve"}

	unavailable, drops := Delist([]model.Wine{w}, []salesforce.WineRaw{raw}, map[string]bool{}, delistNow)

	if len(drops) != 0 {
		t.Errorf("dust-stock wine must not be dropped, got %v", drops)
	}
	if len(unavailable) != 1 || unavailable[0].Status != model.StatusUnavailable {
		t.Fatalf("dust-stock wine must be retained unavailable, got %+v", unavailable)
	}
}

func TestDelist_AlreadyUnavailableKeepsOriginalStamp(t *testing.T) {
	raw := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Name: "Alpha Reserve", ReadyToSell: true}
	w := model.Wine{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve",
		Status: model.StatusUnavailable, DelistedAt: "2026-06-01T00:00:00Z"}

	unavailable, drops := Delist([]model.Wine{w}, []salesforce.WineRaw{raw}, map[string]bool{}, delistNow)

	if len(drops) != 0 || len(unavailable) != 1 {
		t.Fatalf("want 1 retained / 0 drops, got %d / %d", len(unavailable), len(drops))
	}
	if unavailable[0].DelistedAt != "2026-06-01T00:00:00Z" {
		t.Errorf("DelistedAt must not be re-stamped, got %q", unavailable[0].DelistedAt)
	}
}

func TestDelist_GraceExpiryDropsWithRedirect(t *testing.T) {
	raw := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Name: "Alpha Reserve", ReadyToSell: true}
	w := model.Wine{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve",
		Status: model.StatusUnavailable, DelistedAt: "2026-01-01T00:00:00Z"} // 209 days ago

	unavailable, drops := Delist([]model.Wine{w}, []salesforce.WineRaw{raw}, map[string]bool{}, delistNow)

	if len(unavailable) != 0 {
		t.Errorf("expired wine must not be retained: %+v", unavailable)
	}
	if drops["/wines/alpha-reserve/"] != "/portfolio/" {
		t.Errorf("expired wine must redirect to /portfolio/, got %v", drops)
	}
}

func TestDelist_WithheldAndGoneDropImmediately(t *testing.T) {
	// ready-to-sell = false -> deliberate withholding, no unavailable page.
	withheld := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Name: "Alpha Reserve", StockQty: 5, ReadyToSell: false}
	// SF-2 has no roster row at all (deleted from the org).
	existing := []model.Wine{
		{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve"},
		{ID: "SF-2", SKU: "CD5678", Slug: "beta-blanc"},
	}

	unavailable, drops := Delist(existing, []salesforce.WineRaw{withheld}, map[string]bool{}, delistNow)

	if len(unavailable) != 0 {
		t.Errorf("withheld/gone wines must not be retained: %+v", unavailable)
	}
	if drops["/wines/alpha-reserve/"] != "/portfolio/" || drops["/wines/beta-blanc/"] != "/portfolio/" {
		t.Errorf("both must redirect, got %v", drops)
	}
}

func TestDelist_ExcludedTradeNameDropsImmediately(t *testing.T) {
	raw := salesforce.WineRaw{
		ID: "SF-1", SKU: "660905", Name: "Domaine Bruno Colin Bourgogne Chardonnay",
		StockQty: 5, ReadyToSell: true,
	}
	existing := []model.Wine{{ID: "SF-1", SKU: "660905", Slug: "domaine-bruno-colin-bourgogne-chardonnay-2021"}}

	unavailable, drops := Delist(existing, []salesforce.WineRaw{raw}, map[string]bool{}, delistNow)

	if len(unavailable) != 0 {
		t.Errorf("hard-excluded trade name must not retain an unavailable page: %+v", unavailable)
	}
	if drops["/wines/domaine-bruno-colin-bourgogne-chardonnay-2021/"] != "/portfolio/" {
		t.Errorf("hard-excluded wine must redirect to /portfolio/, got %v", drops)
	}
}

func TestDelist_EligibleWinesAreUntouched(t *testing.T) {
	w := model.Wine{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve"}
	unavailable, drops := Delist([]model.Wine{w}, nil, map[string]bool{"SF-1": true}, delistNow)
	if len(unavailable) != 0 || len(drops) != 0 {
		t.Errorf("eligible wine must pass through Delist untouched, got %v / %v", unavailable, drops)
	}
}

func TestDelist_UnparseableStampIsRestamped(t *testing.T) {
	// A corrupt DelistedAt must not crash or silently drop the page — treat
	// the wine as freshly delisted so the grace clock restarts.
	raw := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Name: "Alpha Reserve", ReadyToSell: true}
	w := model.Wine{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve",
		Status: model.StatusUnavailable, DelistedAt: "not-a-time"}

	unavailable, _ := Delist([]model.Wine{w}, []salesforce.WineRaw{raw}, map[string]bool{}, delistNow)
	if len(unavailable) != 1 || unavailable[0].DelistedAt != "2026-07-29T12:00:00Z" {
		t.Fatalf("corrupt stamp must be re-stamped to now, got %+v", unavailable)
	}
}

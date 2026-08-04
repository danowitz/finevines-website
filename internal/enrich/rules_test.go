package enrich

import (
	"testing"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func TestEligible(t *testing.T) {
	// wine builds an eligible baseline row; each case mutates one aspect.
	wine := func(mut func(*salesforce.WineRaw)) salesforce.WineRaw {
		w := salesforce.WineRaw{
			SKU: "AB1234", Name: "Alpha Reserve", StockQty: 14, StockCases: 14,
			CasePack: 12, ReadyToSell: true,
		}
		if mut != nil {
			mut(&w)
		}
		return w
	}
	cases := []struct {
		label string
		row   salesforce.WineRaw
		want  bool
	}{
		{"baseline in-stock wine", wine(nil), true},
		{"out of stock", wine(func(w *salesforce.WineRaw) { w.StockQty, w.StockCases = 0, 0 }), false},
		{"negative stock", wine(func(w *salesforce.WineRaw) { w.StockQty, w.StockCases = -2, -2 }), false},
		{"SKU starts with 9 → never on the web", wine(func(w *salesforce.WineRaw) { w.SKU = "9X1234" }), false},
		{"9 elsewhere in the SKU is fine", wine(func(w *salesforce.WineRaw) { w.SKU = "A91234" }), true},
		{"empty SKU doesn't start with 9", wine(func(w *salesforce.WineRaw) { w.SKU = "" }), true},
		{"not ready to sell", wine(func(w *salesforce.WineRaw) { w.ReadyToSell = false }), false},
		{"QuickBooks-sync placeholder (client: never show it)", wine(func(w *salesforce.WineRaw) { w.SKU = "SBTL" }), false},
		{"only the exact placeholder SKU is excluded", wine(func(w *salesforce.WineRaw) { w.SKU = "SBTL2" }), true},
		// Non-wine fee rows (2026-07-29): word-SKU freight items sail past the
		// 9-prefix rule; the name/producer guard catches them.
		{"freight surcharge by name", wine(func(w *salesforce.WineRaw) {
			w.SKU, w.Name = "SIX/PK SURCHARGE", "MIDSTATE SIX PACK FREIGHT SURCHARGE"
		}), false},
		{"sample row by name", wine(func(w *salesforce.WineRaw) { w.Name = "TASTING SAMPLE DO NOT SELL" }), false},
		{"fee row by producer", wine(func(w *salesforce.WineRaw) { w.Producer = "FREIGHT MISC" }), false},
		{"remittance-address memo row (no addresses on the site)", wine(func(w *salesforce.WineRaw) {
			w.SKU, w.Name = "REMIT TO", "PLEASE NOTE OUR REMITTANCE ADDRESS:\nP.O. BOX 1649\nMELROSE PARK, IL 60161-1649"
		}), false},
		{"guarded word only as a substring stays eligible", wine(func(w *salesforce.WineRaw) {
			w.Name = "Chateau Sampleton Rouge"
		}), true},
		// Nameless rows (2026-08-03): a Salesforce bookkeeping row (SKU
		// 513001, 10,000 "cases") published with an empty name/producer/slug,
		// rendering a broken catalog page and appearing in the client digest
		// as ", (513001)". A nameless product is never publishable, no matter
		// how much stock it claims.
		{"empty name is never publishable", wine(func(w *salesforce.WineRaw) { w.Name = "" }), false},
		{"whitespace-only name is never publishable", wine(func(w *salesforce.WineRaw) { w.Name = "   " }), false},
		// Whole-bottles floor (2026-07-29): QuickBooks rounding dust must not
		// list effectively-empty wines, but a single real bottle still counts.
		{"QB rounding dust (0.00001 cases) is not stock", wine(func(w *salesforce.WineRaw) {
			w.StockQty, w.StockCases = 1, 0.00001 // StockQty=1 is the ceiled shadow
		}), false},
		{"one bottle of a 12-pack is stock", wine(func(w *salesforce.WineRaw) {
			w.StockQty, w.StockCases = 1, 0.08333
		}), true},
		{"mock/legacy rows without fractional cases still pass on StockQty", wine(func(w *salesforce.WineRaw) {
			w.StockQty, w.StockCases = 3, 0
		}), true},
		{"raw trade name supplies the pack when the org field is empty", wine(func(w *salesforce.WineRaw) {
			w.Name, w.CasePack = "17 ALPHA RESERVE 6/750", 0
			w.StockQty, w.StockCases = 1, 0.16667 // one bottle of a six-pack
		}), true},
	}
	for _, c := range cases {
		if got := Eligible(c.row); got != c.want {
			t.Errorf("%s: Eligible(%+v) = %v, want %v", c.label, c.row, got, c.want)
		}
	}
}

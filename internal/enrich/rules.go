package enrich

import (
	"regexp"
	"strings"

	"github.com/gritautomation/finevines-website/internal/catalog"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// nonWine matches catalog rows that are really logistics/fee items riding the
// product ledger — freight surcharges, deposits, samples. The 9-prefix SKU
// rule was meant to catch these, but the org has fee rows with word SKUs
// ("SIX/PK SURCHARGE") that sail past it, and one was the site's #4 seller by
// volume when the hot-sellers ranking first ran live (2026-07-29).
var nonWine = regexp.MustCompile(`(?i)\b(freight|surcharge|shipping|deposit|sample|samples|display|misc)\b`)

// Eligible implements the confirmed web-eligibility rule (compiled constant):
// a wine is shown on the site when at least one actual bottle is on hand, its
// SKU does not start with "9", it is flagged ready to sell, AND it is actually
// a wine, not a fee row.
//
//   - stock + SKU rule: decision 2026-07-24.
//   - readyToSell (Product2.FV_Ready_To_Sell__c): added 2026-07-27 — a wine
//     marked not-ready-to-sell is withheld even if it is in stock, so
//     allocated/embargoed/not-yet-launched inventory never leaks onto the
//     public catalog.
//   - SBTL: excluded 2026-07-29 (client-confirmed) — the QuickBooks-sync
//     placeholder row ("This is a placeholder for syncing with QuickBooks")
//     passes every other clause in the live org, so it is denied by SKU.
//   - non-wine exclusion (see nonWine): added 2026-07-29 after freight
//     surcharges were found on the public catalog.
//   - whole bottles, not "cases > 0": added 2026-07-29. FV_OnHand_Qty__c is
//     fractional CASES and the live org carries QuickBooks rounding dust
//     (0.00001-case rows) that a plain >0 test — or its ceiled StockQty
//     shadow — reads as in-stock, listing effectively-empty wines. A wine is
//     in stock when its cases round to at least one real bottle.
func Eligible(w salesforce.WineRaw) bool {
	return BottlesOnHand(w) >= 1 && !strings.HasPrefix(w.SKU, "9") && w.ReadyToSell &&
		w.SKU != "SBTL" && !nonWine.MatchString(w.Name) && !nonWine.MatchString(w.Producer)
}

// BottlesOnHand converts a roster row's on-hand cases to whole bottles, using
// the org's explicit bottles-per-case when present and otherwise the pack the
// RAW trade name encodes ("12/750" — raw names still carry it; only enriched
// display names have it stripped). Rows from sources without fractional cases
// (the embedded mock roster) fall back to StockQty, which is ceiled cases.
func BottlesOnHand(w salesforce.WineRaw) int {
	cases := w.StockCases
	if cases <= 0 {
		if w.StockQty <= 0 {
			return 0
		}
		cases = float64(w.StockQty)
	}
	pack := catalog.PackOf(model.Wine{Name: w.Name, CasePack: w.CasePack})
	return int(cases*float64(pack) + 0.5)
}

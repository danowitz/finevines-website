package enrich

import "strings"

// Eligible implements the confirmed web-eligibility rule (compiled constant):
// a wine is shown on the site when it is in stock, its SKU does not start with
// "9", AND it is flagged ready to sell.
//
//   - stock + SKU rule: decision 2026-07-24.
//   - readyToSell (Product2.FV_Ready_To_Sell__c): added 2026-07-27 — a wine
//     marked not-ready-to-sell is withheld even if it is in stock, so
//     allocated/embargoed/not-yet-launched inventory never leaks onto the
//     public catalog.
func Eligible(stockQty int, sku string, readyToSell bool) bool {
	return stockQty > 0 && !strings.HasPrefix(sku, "9") && readyToSell
}

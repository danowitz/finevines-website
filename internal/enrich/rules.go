package enrich

import "strings"

// Eligible implements the confirmed web-eligibility rule (compiled constant
// by decision 2026-07-24): a wine is shown on the site when it is in stock
// and its SKU does not start with "9".
func Eligible(stockQty int, sku string) bool {
	return stockQty > 0 && !strings.HasPrefix(sku, "9")
}

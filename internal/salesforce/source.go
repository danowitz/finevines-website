// Package salesforce reads the wine roster from the Salesforce org that
// mirrors QuickBooks. Source is an interface so a future QuickBooks-direct
// implementation can replace it without touching enrich orchestration.
package salesforce

import "context"

type WineRaw struct {
	ID          string
	SKU         string
	Producer    string
	Name        string
	Vintage     string
	Varietal    string
	Region      string
	Country     string
	Appellation string
	Style       string
	// StockQty is FV_OnHand_Qty__c rounded UP: that field is fractional (cases,
	// e.g. 0.66), and a plain truncation to int would turn a genuinely in-stock
	// 0.66 into 0 and wrongly drop the wine. Ceil preserves the ">0" test.
	StockQty int
	// StockCases is FV_OnHand_Qty__c verbatim: on-hand quantity in CASES, where
	// the fractional part is a broken case in twelfths/sixths of the pack
	// (verified live 2026-07-29: 17.08334 with a 12-pack = 17 cases + 1 bottle).
	// This is what the site's availability line renders from; StockQty above is
	// its ceiled shadow kept for the eligibility test.
	StockCases float64
	// CasePack is FV_Bottles_Per_Case__c: the authoritative bottles-per-case
	// (12, 6, 3 …). 0 when the org row doesn't say; consumers fall back to
	// parsing the raw name, then to the trade-standard 12 (catalog.PackOf).
	CasePack int
	// ReadyToSell mirrors Product2.FV_Ready_To_Sell__c and gates
	// web-eligibility alongside stock/SKU (confirmed 2026-07-27) — see
	// enrich.Eligible.
	ReadyToSell bool
}

// TeamUser is the small, public-safe projection of a Salesforce User used to
// build the About-page roster. The selection rule lives in Client.TeamRoster;
// callers never need the rest of the User record.
type TeamUser struct {
	ID    string
	Name  string
	Email string
	Role  string
}

type Source interface {
	// Roster returns raw rows for every candidate wine (eligibility is
	// applied by the caller via enrich.Eligible).
	Roster(ctx context.Context) ([]WineRaw, error)
}

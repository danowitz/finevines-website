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
	// 0.66 into 0 and wrongly drop the wine. Ceil preserves the ">0" test; the
	// exact count isn't shown publicly, only used for eligibility.
	StockQty int
	// ReadyToSell mirrors Product2.FV_Ready_To_Sell__c and gates
	// web-eligibility alongside stock/SKU (confirmed 2026-07-27) — see
	// enrich.Eligible.
	ReadyToSell bool
}

type Source interface {
	// Roster returns raw rows for every candidate wine (eligibility is
	// applied by the caller via enrich.Eligible).
	Roster(ctx context.Context) ([]WineRaw, error)
}

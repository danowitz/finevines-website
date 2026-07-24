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
	Appellation string
	Style       string
	StockQty    int
}

type Source interface {
	// Roster returns raw rows for every candidate wine (eligibility is
	// applied by the caller via enrich.Eligible).
	Roster(ctx context.Context) ([]WineRaw, error)
}

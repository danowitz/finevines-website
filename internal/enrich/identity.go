package enrich

import (
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/normalize"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// IdentityMatches reports whether the stored wine w was plausibly produced
// from the live raw row — i.e. every descriptive field a prior enrich run
// stored faithfully (SKU raw; producer/name/vintage/varietal/region through
// the same normalization enrichOne applies) still matches. Volatile fields
// (StockQty, ReadyToSell) are ignored by construction.
//
// Its purpose is hash migration (tools/rehash): stored SourceHash values
// predating a hash-scheme change can be re-stamped without re-enriching, but
// only for wines whose descriptive data provably hasn't drifted — anything
// else keeps its stale hash and re-enriches honestly on the next run.
//
// Country is deliberately not compared: the stored value prefers the
// enrichment's answer over FV_Country__c, so a faithful raw row can still
// differ from the stored field. Appellation and Style aren't compared for the
// same reason (no Salesforce field feeds them today; the stored values are
// search-scraped).
func IdentityMatches(raw salesforce.WineRaw, w model.Wine) bool {
	return raw.SKU == w.SKU &&
		normalize.Producer(raw.Producer) == w.Producer &&
		normalize.WineName(raw.Name, raw.Producer) == w.Name &&
		normalize.Vintage(raw.Vintage) == w.Vintage &&
		normalize.Text(raw.Varietal) == w.Varietal &&
		normalize.Text(raw.Region) == w.Region
}

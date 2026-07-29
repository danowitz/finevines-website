package enrich

import (
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// Diff is the output of DiffRoster: the eligible Salesforce roster split
// into wines that need (re-)enrichment and wines that can be carried over
// untouched.
type Diff struct {
	Enrich []salesforce.WineRaw // new or changed — needs text + image work
	Keep   []model.Wine         // unchanged — carried over verbatim, no cost
}

// DiffRoster compares the eligible Salesforce roster against the current
// wines.json. The caller is expected to have already applied Eligible —
// DiffRoster itself performs no filtering, only keying and hashing.
//
// A raw row with an ID not present in existing, or whose SourceHash differs
// from the stored value, needs enrichment. A raw row whose hash matches the
// stored value is carried over at zero API cost — except StockQty, which is
// refreshed from the roster: stock is excluded from SourceHash (see
// sourceHashInput) so movement alone never re-enriches, but wines.json stores
// the quantity and must not go stale. A wine present in existing but absent
// from eligible simply doesn't appear in the result — sold-out and delisted
// wines drop off the site on the next build, and "new product" and "sold out"
// fall out of the same pass.
//
// DiffRoster is pure: it performs no I/O and does not mutate either input.
func DiffRoster(eligible []salesforce.WineRaw, existing []model.Wine) Diff {
	byID := make(map[string]model.Wine, len(existing))
	for _, w := range existing {
		byID[w.ID] = w
	}
	var d Diff
	for _, raw := range eligible {
		if prev, ok := byID[raw.ID]; ok && prev.SourceHash == SourceHash(raw) {
			prev.StockQty = raw.StockQty // prev is a map-value copy; inputs stay unmutated
			d.Keep = append(d.Keep, prev)
		} else {
			d.Enrich = append(d.Enrich, raw)
		}
	}
	return d
}

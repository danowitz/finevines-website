package enrich

import (
	"time"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// delistGraceDays is how long an out-of-stock wine keeps its published
// (but hidden) page before it is dropped and 301-redirected. Wholesale
// stock oscillates — most zero-stock wines are reordered within weeks, and
// deleting the page each time would throw away its search ranking. Half a
// year of silence means the vintage is realistically gone.
const delistGraceDays = 180

// delistRedirectTarget is where a dropped wine's URL points. The portfolio
// landing page is the safest generic target: it always exists and carries
// the visitor to the browsable catalog.
const delistRedirectTarget = "/portfolio/"

// Delist classifies every stored wine that is NOT in the eligible roster.
// Three outcomes:
//
//   - retained unavailable: the roster row exists and would be eligible if
//     it had stock (fails ONLY the stock clause). The wine keeps its page —
//     Status/DelistedAt stamped, stock zeroed — and build hides it from
//     browse surfaces. First seen now → stamped now; already stamped →
//     stamp preserved.
//   - dropped after grace: already unavailable for more than delistGraceDays
//     → removed, and its URL added to drops for a 301.
//   - dropped now: everything else (ready-to-sell = false, non-wine row,
//     deleted from the org). Deliberate withholding must not leave even an
//     "unavailable" breadcrumb, so no page survives.
//
// Wines whose ID is in eligibleIDs are skipped entirely — they flow through
// DiffRoster as usual. Delist is pure: no I/O, inputs unmutated.
func Delist(existing []model.Wine, roster []salesforce.WineRaw, eligibleIDs map[string]bool, now time.Time) (unavailable []model.Wine, drops map[string]string) {
	rosterByID := make(map[string]salesforce.WineRaw, len(roster))
	for _, r := range roster {
		rosterByID[r.ID] = r
	}
	drops = make(map[string]string)

	drop := func(w model.Wine) {
		if w.Slug != "" {
			drops["/wines/"+w.Slug+"/"] = delistRedirectTarget
		}
	}

	for _, w := range existing {
		if eligibleIDs[w.ID] {
			continue
		}
		raw, inRoster := rosterByID[w.ID]
		// Would this row be eligible if stock were the only problem?
		stockOnly := inRoster && Eligible(1, raw.SKU, raw.ReadyToSell)
		if !stockOnly {
			drop(w)
			continue
		}

		if w.Status == model.StatusUnavailable {
			since, err := time.Parse(time.RFC3339, w.DelistedAt)
			if err == nil && now.Sub(since) > delistGraceDays*24*time.Hour {
				drop(w)
				continue
			}
			if err != nil {
				w.DelistedAt = now.Format(time.RFC3339) // corrupt stamp: restart the clock
			}
		} else {
			w.Status = model.StatusUnavailable
			w.DelistedAt = now.Format(time.RFC3339)
		}
		w.StockQty = 0
		w.StockCases = 0
		unavailable = append(unavailable, w)
	}
	return unavailable, drops
}

package enrich

import (
	"regexp"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
)

// nonWine matches catalog rows that are really logistics/fee items riding the
// product ledger (live 2026-07-29: "MIDSTATE SIX PACK FREIGHT SURCHARGE" was
// the org's #4 mover). The eligibility rule SHOULD exclude these upstream —
// this is defense-in-depth for the one section where a mistake is a homepage
// headline, not a page-40 catalog row.
var nonWine = regexp.MustCompile(`(?i)\b(freight|surcharge|shipping|deposit|sample|samples|display|misc)\b`)

// producerKey is the one-slot-per-producer dedupe key. The producer field
// when present; otherwise (FV_Brand__c is blank on a long tail of rows) the
// name's first four tokens, which reliably capture an estate prefix like
// "Domaine de la Villaudiere" without merging distinct "Domaine de la …"
// estates.
func producerKey(w model.Wine) string {
	if w.Producer != "" {
		return strings.ToLower(w.Producer)
	}
	tokens := strings.Fields(strings.ToLower(w.Name))
	if len(tokens) > 4 {
		tokens = tokens[:4]
	}
	return strings.Join(tokens, " ")
}

// RankHotSellers turns the org's raw sales totals (net cases per Product2 Id,
// from salesforce.SalesTotals) into the homepage's hot-sellers ranking.
//
// The candidate pool is wines.json — the already web-eligible, enriched
// catalog — which is what keeps 9-prefix SKUs, not-ready-to-sell rows, and
// anything else the eligibility rule excludes from ever ranking, no matter how
// fast they sell (live probe 2026-07-29: the raw org-wide top sellers are ALL
// excluded 9-prefix items, so this join is load-bearing, not hygiene).
//
// Rules, in order:
//   - a wine must have net-positive movement (credits net off), be in stock
//     NOW (a hot seller you cannot buy is an ad for a competitor), and carry a
//     slug + image so its card can render;
//   - one wine per producer, best first — the section is curation ("what the
//     trade is pouring"), not a leaderboard, and a single hot brand must not
//     fill every slot;
//   - net cases descending, slug ascending on ties, so the ranking is total
//     and deterministic;
//   - at most limit entries.
func RankHotSellers(wines []model.Wine, netCases map[string]float64, limit int) []model.HotSeller {
	if limit <= 0 {
		return nil
	}
	type cand struct {
		wine  model.Wine
		cases float64
	}
	cands := make([]cand, 0, len(wines))
	for _, w := range wines {
		cases := netCases[w.ID]
		if cases <= 0 || w.StockQty <= 0 || w.Slug == "" || w.ImagePath == "" {
			continue
		}
		if nonWine.MatchString(w.Name) || nonWine.MatchString(w.Producer) {
			continue
		}
		cands = append(cands, cand{wine: w, cases: cases})
	}
	sort.Slice(cands, func(i, j int) bool {
		if cands[i].cases != cands[j].cases {
			return cands[i].cases > cands[j].cases
		}
		return cands[i].wine.Slug < cands[j].wine.Slug
	})

	out := make([]model.HotSeller, 0, limit)
	seenProducer := make(map[string]bool, limit)
	for _, c := range cands {
		if len(out) == limit {
			break
		}
		if key := producerKey(c.wine); key != "" {
			if seenProducer[key] {
				continue
			}
			seenProducer[key] = true
		}
		out = append(out, model.HotSeller{Slug: c.wine.Slug, Cases: c.cases})
	}
	return out
}

package enrich

import (
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/catalog"
	"github.com/gritautomation/finevines-website/internal/model"
)

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
//   - a wine must have net-positive movement (credits net off), have at least
//     a FULL CASE on hand NOW (a hot seller you cannot actually order is an ad
//     for a competitor, and "2 bottles left" reads as a markdown bin), and
//     carry a slug + image so its card can render;
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
		if cases <= 0 || catalog.OnHandCases(w) < 1 || w.Slug == "" || w.ImagePath == "" {
			continue
		}
		// Belt-and-braces: Eligible now excludes fee rows upstream, but this
		// ranking may run against a wines.json written before that rule.
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

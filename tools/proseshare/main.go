// Command proseshare copies real enrichment prose from an enriched wine to
// its vintage siblings that still carry the manual-stopgap boilerplate.
//
// The client's consolidation decision (2026-08-04): descriptive prose barely
// changes across vintages of one cuvée, so enrichment runs once per wine
// (tools/reenrich -consolidate) and this tool fans the result out. Only
// CANNED siblings are written — a sibling with its own real enrichment is
// never touched — and identity/commercial fields (vintage, stock, image,
// slug) stay untouched.
//
//	go run ./tools/proseshare            # report what would be shared
//	go run ./tools/proseshare -apply     # write it
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
)

const cannedMarker = "temperature typical for its style"

func identity(w *model.Wine) string {
	s := strings.ToLower(strings.TrimSpace(w.Producer) + " " + strings.TrimSpace(w.Name))
	return strings.Join(strings.FieldsFunc(s, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	}), "-")
}

func main() {
	apply := flag.Bool("apply", false, "write the shared prose")
	flag.Parse()

	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		fmt.Fprintln(os.Stderr, "proseshare:", err)
		os.Exit(1)
	}

	// Donor: a wine with real (non-canned) prose. Newest vintage wins so every
	// sibling shares the same description the group's tile leads with.
	donor := map[string]int{}
	for i := range wines {
		w := &wines[i]
		if strings.Contains(w.SommelierNotes, cannedMarker) || strings.TrimSpace(w.Description) == "" {
			continue
		}
		k := identity(w)
		if j, seen := donor[k]; !seen || w.Vintage > wines[j].Vintage {
			donor[k] = i
		}
	}

	shared := 0
	for i := range wines {
		w := &wines[i]
		if !strings.Contains(w.SommelierNotes, cannedMarker) {
			continue
		}
		j, ok := donor[identity(w)]
		if !ok || i == j {
			continue
		}
		d := wines[j]
		shared++
		if !*apply {
			continue
		}
		w.Description = d.Description
		w.SommelierNotes = d.SommelierNotes
		w.Aroma = d.Aroma
		w.Palate = d.Palate
		w.Finish = d.Finish
		w.FoodPairings = append([]string(nil), d.FoodPairings...)
		w.Appellation = d.Appellation
		w.Country = d.Country
		w.Color = d.Color
		w.ABV = d.ABV
		w.BottleSize = d.BottleSize
		w.DrinkWindow = d.DrinkWindow
		w.MatchConfidence = d.MatchConfidence
		w.EnrichedAt = d.EnrichedAt
		if d.Sources != nil {
			w.Sources = map[string]model.FieldSource{}
			for k, v := range d.Sources {
				w.Sources[k] = v
			}
			// The image provenance is this wine's own, not the donor's.
			w.Sources["image"] = model.ImageFieldSource(w.ImageSource)
			w.MetadataScore = model.MetadataScore(w.Sources)
		}
	}

	if *apply {
		if err := model.SaveWines("data/wines.json", wines); err != nil {
			fmt.Fprintln(os.Stderr, "proseshare:", err)
			os.Exit(1)
		}
	}
	fmt.Printf("proseshare: %d canned siblings %s prose from their wine's enriched vintage\n",
		shared, map[bool]string{true: "received", false: "would receive"}[*apply])
}

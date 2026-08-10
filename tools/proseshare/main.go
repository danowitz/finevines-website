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
	"github.com/gritautomation/finevines-website/internal/normalize"
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
	repair := flag.Bool("repair-vintages", false,
		"clean stored prose — donor years and leftover source links — then exit (use with -apply)")
	flag.Parse()

	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		fmt.Fprintln(os.Stderr, "proseshare:", err)
		os.Exit(1)
	}

	// -repair-vintages cleans up prose ALREADY shared before the year-stripping
	// above existed. 58 wines name a year that is not their own — 53 of them
	// exactly one year out, which is the donor being the newest sibling.
	if *repair {
		repairForeignVintages(wines, *apply)
		if *apply {
			if err := model.SaveWines("data/wines.json", wines); err != nil {
				fmt.Fprintln(os.Stderr, "proseshare:", err)
				os.Exit(1)
			}
		}
		return
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
		// The donor's YEAR must not travel with its prose. Sharing tasting
		// character across vintages is the client's decision; telling a
		// customer the 2023 is the 2024 is not, and the copied sentence
		// otherwise opens "This Moscato d'Asti 'Centive' 2024…" on the 2023's
		// page. normalize.StripForeignVintage removes a year that is not this
		// wine's, leaving drink windows and estate history alone.
		clean := func(s string) string {
			return normalize.StripCitations(normalize.StripForeignVintage(s, w.Vintage))
		}
		w.Description = clean(d.Description)
		w.SommelierNotes = clean(d.SommelierNotes)
		w.Aroma = clean(d.Aroma)
		w.Palate = clean(d.Palate)
		w.Finish = clean(d.Finish)
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

// repairForeignVintages strips a donor's year out of prose that was already
// shared, reporting each change. Separate from the sharing pass because it
// touches wines whose prose is long since written — it corrects stored text
// rather than copying new text in.
func repairForeignVintages(wines []model.Wine, apply bool) {
	fields := []struct {
		name string
		get  func(*model.Wine) *string
	}{
		{"description", func(w *model.Wine) *string { return &w.Description }},
		{"sommelierNotes", func(w *model.Wine) *string { return &w.SommelierNotes }},
		{"aroma", func(w *model.Wine) *string { return &w.Aroma }},
		{"palate", func(w *model.Wine) *string { return &w.Palate }},
		{"finish", func(w *model.Wine) *string { return &w.Finish }},
	}
	touched := 0
	for i := range wines {
		w := &wines[i]
		changed := false
		for _, f := range fields {
			p := f.get(w)
			fixed := normalize.StripCitations(normalize.StripForeignVintage(*p, w.Vintage))
			if fixed == *p {
				continue
			}
			if !changed {
				fmt.Printf("%s (vintage %s)\n", w.Slug, w.Vintage)
			}
			fmt.Printf("  %-15s %s\n               -> %s\n", f.name, excerpt(*p), excerpt(fixed))
			changed = true
			if apply {
				*p = fixed
			}
		}
		if changed {
			touched++
		}
	}
	fmt.Printf("\nproseshare: %d wines %s a year that was not theirs\n",
		touched, map[bool]string{true: "no longer name", false: "would stop naming"}[apply])
	if !apply {
		fmt.Println("dry run — re-run with -apply to write")
	}
}

// excerpt trims stored prose to something readable in a terminal report.
func excerpt(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 78 {
		return s[:78] + "…"
	}
	return s
}

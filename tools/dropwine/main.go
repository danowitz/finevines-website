// Command dropwine removes wines from data/wines.json by slug, along with
// each dropped wine's generated SVG label (a real photo is never deleted —
// only assets/img/wines/<slug>.svg). First use (2026-07-29): purging the
// "REMIT TO" remittance-address memo row after the no-addresses-on-the-site
// directive; enrich.Eligible's nonWine guard keeps it from re-entering on
// the next enrich, this tool clears the copy already persisted.
//
//	go run ./tools/dropwine <slug> [slug...]
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/gritautomation/finevines-website/internal/model"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: dropwine <slug> [slug...]")
		os.Exit(2)
	}
	drop := make(map[string]bool, len(os.Args)-1)
	for _, slug := range os.Args[1:] {
		drop[slug] = true
	}

	const winesPath = "data/wines.json"
	wines, err := model.LoadWines(winesPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load:", err)
		os.Exit(1)
	}

	kept := wines[:0]
	for _, w := range wines {
		if !drop[w.Slug] {
			kept = append(kept, w)
			continue
		}
		delete(drop, w.Slug)
		fmt.Printf("dropped %s (%s)\n", w.Slug, w.SKU)
		if svg := filepath.Join("assets", "img", "wines", w.Slug+".svg"); w.ImagePath == filepath.ToSlash(svg) {
			if err := os.Remove(svg); err != nil && !os.IsNotExist(err) {
				fmt.Fprintln(os.Stderr, "remove label:", err)
				os.Exit(1)
			}
			fmt.Printf("removed %s\n", svg)
		}
	}
	for slug := range drop {
		fmt.Fprintf(os.Stderr, "not found: %s\n", slug)
	}
	if len(kept) == len(wines) {
		fmt.Println("nothing to do")
		return
	}
	if err := model.SaveWines(winesPath, kept); err != nil {
		fmt.Fprintln(os.Stderr, "save:", err)
		os.Exit(1)
	}
	fmt.Printf("%d wines remain\n", len(kept))
}

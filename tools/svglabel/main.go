// Command svglabel writes the deterministic château-style label SVG for one
// wine, by slug, so it can be rasterised and composited onto a bottle exactly
// like a scanned label. Without this the generated labels stay flat vector
// rectangles while photographed wines get curved bottles — the very split the
// catalog is trying to close.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/gritautomation/finevines-website/internal/label"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func main() {
	slug := flag.String("slug", "", "wine slug from data/wines.json")
	out := flag.String("out", "label.svg", "output SVG path")
	data := flag.String("data", "data/wines.json", "wines.json path")
	flag.Parse()

	wines, err := model.LoadWines(*data)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, w := range wines {
		if w.Slug != *slug {
			continue
		}
		svg := label.Generate(salesforce.WineRaw{
			SKU: w.SKU, Producer: w.Producer, Name: w.Name, Vintage: w.Vintage,
			Varietal: w.Varietal, Region: w.Region, Country: w.Country,
			Appellation: w.Appellation, Style: w.Style,
		})
		if err := os.WriteFile(*out, svg, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("wrote %s for %s — %s %s\n", *out, w.Slug, w.Producer, w.Name)
		return
	}
	fmt.Fprintf(os.Stderr, "no wine with slug %q\n", *slug)
	os.Exit(1)
}

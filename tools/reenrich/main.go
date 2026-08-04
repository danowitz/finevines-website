// Command reenrich marks manual-stopgap wines for real enrichment by
// clearing their SourceHash, so the next `finevines enrich` re-processes
// them through the OpenAI search pipeline.
//
// Exists because the 2026-07-27 catalog build ran in the billing-stopgap
// MANUAL mode: only ~28 SKUs had hand-imported enrichment files, and every
// other wine got manual.go's generic fallback prose ("Serve at the
// temperature typical for its style.") — 2,455 wines carried it, unnoticed
// until the client read a sommelier note (2026-08-04). The canned sentence
// is the marker of that era.
//
//	go run ./tools/reenrich -n 25          # mark a bounded slice
//	go run ./tools/reenrich -n 0           # mark every canned wine
//	go run ./tools/reenrich -n 25 -skip-generated
//	   skip wines wearing a gpt-image-1 photo: re-enrichment currently
//	   regenerates their image as the SVG label (generated photos are not
//	   preserved by ResolveImage), so they wait until that is fixed.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
)

func main() {
	n := flag.Int("n", 25, "how many wines to mark (0 = all)")
	skipGenerated := flag.Bool("skip-generated", true, "leave generated-photo wines for after the image-preservation fix")
	flag.Parse()

	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		fmt.Fprintln(os.Stderr, "reenrich:", err)
		os.Exit(1)
	}

	marked := 0
	for i := range wines {
		w := &wines[i]
		if !strings.Contains(w.SommelierNotes, "temperature typical for its style") {
			continue
		}
		if *skipGenerated && w.ImageSource == model.ImageGeneratedPhoto {
			continue
		}
		if *n > 0 && marked >= *n {
			break
		}
		w.SourceHash = ""
		marked++
	}

	if err := model.SaveWines("data/wines.json", wines); err != nil {
		fmt.Fprintln(os.Stderr, "reenrich:", err)
		os.Exit(1)
	}
	fmt.Printf("reenrich: cleared SourceHash on %d manual-stopgap wines — run `finevines enrich` to re-process them\n", marked)
}

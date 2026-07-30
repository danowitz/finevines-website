// Command vintageshare measures (and with -apply, performs) real-image
// sharing across vintages of the same wine.
//
// The portfolio grid already treats vintages of one cuvée as a single wine
// (catalog.Build groups by producer+cuvée), but images resolve per catalog
// row, so the 2019 can wear a real photograph while the 2022 sits on the SVG
// placeholder. Bottle artwork rarely changes by vintage; the client-facing
// choice to show a sibling vintage's photo is standard retail practice and
// far better than a generated label. Provenance records the borrowed slug.
//
//	go run ./tools/vintageshare            # report the opportunity
//	go run ./tools/vintageshare -apply     # copy sibling images + update wines.json
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gritautomation/finevines-website/internal/catalog"
	"github.com/gritautomation/finevines-website/internal/model"
)

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

// identity mirrors catalog.key: what decides two rows are the same wine.
func identity(w model.Wine) string {
	p := strings.ToLower(strings.TrimSpace(w.Producer))
	c := strings.ToLower(catalog.CuveeName(w))
	return strings.Trim(nonAlnum.ReplaceAllString(p+" "+c, "-"), "-")
}

func isReal(w model.Wine) bool {
	return model.ImageFieldSource(w.ImageSource) == model.SourceFound
}

func main() {
	apply := flag.Bool("apply", false, "copy sibling images and update data/wines.json")
	flag.Parse()

	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		fmt.Fprintln(os.Stderr, "vintageshare:", err)
		os.Exit(1)
	}

	groups := map[string][]int{}
	for i, w := range wines {
		groups[identity(w)] = append(groups[identity(w)], i)
	}

	shared := 0
	groupsHelped := 0
	for _, idxs := range groups {
		// Donor: the newest-vintage real image in the group, matching the
		// grid's newest-first ordering so every vintage page shows the same
		// bottle the group tile shows.
		donor := -1
		for _, i := range idxs {
			if isReal(wines[i]) && (donor == -1 || wines[i].Vintage > wines[donor].Vintage) {
				donor = i
			}
		}
		if donor == -1 {
			continue
		}
		helped := false
		for _, i := range idxs {
			w := &wines[i]
			// Only the SVG-label placeholder is upgraded. A real image is
			// kept (never overwritten), and a generated photo — if any ever
			// ships — is its own pipeline's business.
			if w.ImageSource != model.ImageGeneratedLabel {
				continue
			}
			shared++
			helped = true
			if !*apply {
				continue
			}
			src := wines[donor].ImagePath
			dst := filepath.Join("assets", "img", "wines", w.Slug+".jpg")
			if err := copyFile(src, dst); err != nil {
				fmt.Fprintf(os.Stderr, "vintageshare: %s: %v\n", w.Slug, err)
				os.Exit(1)
			}
			if w.ImagePath != "" {
				os.Remove(w.ImagePath) // the stale SVG placeholder
			}
			w.ImagePath = filepath.ToSlash(dst)
			w.ImageSource = wines[donor].ImageSource
			w.ImageSourceURL = wines[donor].ImageSourceURL
			if w.Sources != nil {
				w.Sources["image"] = model.SourceFound
				w.MetadataScore = model.MetadataScore(w.Sources)
			}
		}
		if helped {
			groupsHelped++
		}
	}

	if *apply {
		if err := model.SaveWines("data/wines.json", wines); err != nil {
			fmt.Fprintln(os.Stderr, "vintageshare:", err)
			os.Exit(1)
		}
		fmt.Printf("vintageshare: shared %d sibling images across %d wine groups; wines.json updated\n", shared, groupsHelped)
	} else {
		fmt.Printf("vintageshare: %d placeholder rows could wear a sibling vintage's real image (%d wine groups). Re-run with -apply.\n", shared, groupsHelped)
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

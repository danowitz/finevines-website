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

// shareOp names one candidate image share: wines[recipient]'s SVG placeholder
// could be upgraded to wines[donor]'s real photo.
type shareOp struct {
	recipient int
	donor     int
}

// planShares groups wines by identity and, for each group with a real donor
// image, decides which SVG-placeholder rows would be upgraded. It is pure
// (no file I/O) so the counting/grouping decision can be tested independent
// of copyFile.
//
// Genuine opportunities land in toShare. A pair whose recipient dst already
// resolves to the donor's own file (a duplicate slug — see issue #3 — makes
// two catalog rows compute the same image path) lands in skipped instead:
// there is nothing to copy and nothing to count. groupsHelped counts only
// groups with at least one genuine (non-skipped) share, matching the
// original "wine groups" semantics.
func planShares(wines []model.Wine) (toShare, skipped []shareOp, groupsHelped int) {
	groups := map[string][]int{}
	for i, w := range wines {
		groups[identity(w)] = append(groups[identity(w)], i)
	}
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
			w := wines[i]
			// Only the SVG-label placeholder is upgraded. A real image is
			// kept (never overwritten), and a generated photo — if any ever
			// ships — is its own pipeline's business.
			if w.ImageSource != model.ImageGeneratedLabel {
				continue
			}
			dst := filepath.Join("assets", "img", "wines", w.Slug+".jpg")
			if samePath(wines[donor].ImagePath, dst) {
				skipped = append(skipped, shareOp{recipient: i, donor: donor})
				continue
			}
			toShare = append(toShare, shareOp{recipient: i, donor: donor})
			helped = true
		}
		if helped {
			groupsHelped++
		}
	}
	return toShare, skipped, groupsHelped
}

func main() {
	apply := flag.Bool("apply", false, "copy sibling images and update data/wines.json")
	flag.Parse()

	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		fmt.Fprintln(os.Stderr, "vintageshare:", err)
		os.Exit(1)
	}

	toShare, skipped, groupsHelped := planShares(wines)

	for _, s := range skipped {
		w := wines[s.recipient]
		dst := filepath.Join("assets", "img", "wines", w.Slug+".jpg")
		// A duplicate-slug pair (donor and recipient computing the same
		// image path) is surfaced here rather than silently dropped, so it
		// stays visible until issue #3 resolves the underlying duplicate.
		fmt.Fprintf(os.Stderr, "vintageshare: skipping %s: donor SKU %s and recipient SKU %s already share one image file (%s)\n",
			w.Slug, wines[s.donor].SKU, w.SKU, dst)
	}

	if *apply {
		for _, s := range toShare {
			w := &wines[s.recipient]
			src := wines[s.donor].ImagePath
			dst := filepath.Join("assets", "img", "wines", w.Slug+".jpg")
			if err := copyFile(src, dst); err != nil {
				fmt.Fprintf(os.Stderr, "vintageshare: %s: %v\n", w.Slug, err)
				os.Exit(1)
			}
			if w.ImagePath != "" {
				os.Remove(w.ImagePath) // the stale SVG placeholder
			}
			w.ImagePath = filepath.ToSlash(dst)
			w.ImageSource = wines[s.donor].ImageSource
			w.ImageSourceURL = wines[s.donor].ImageSourceURL
			if w.Sources != nil {
				w.Sources["image"] = model.SourceFound
				w.MetadataScore = model.MetadataScore(w.Sources)
			}
		}
		if err := model.SaveWines("data/wines.json", wines); err != nil {
			fmt.Fprintln(os.Stderr, "vintageshare:", err)
			os.Exit(1)
		}
		fmt.Printf("vintageshare: shared %d sibling images across %d wine groups; wines.json updated\n", len(toShare), groupsHelped)
	} else {
		fmt.Printf("vintageshare: %d placeholder rows could wear a sibling vintage's real image (%d wine groups). Re-run with -apply.\n", len(toShare), groupsHelped)
	}
}

// samePath reports whether a and b resolve to the same file on disk. It
// compares cleaned absolute paths rather than the raw strings: callers pass a
// site-relative, forward-slash ImagePath straight out of wines.json alongside
// a dst built with filepath.Join (native separators, no leading "./"), so the
// two can name one identical file while looking different as strings.
func samePath(a, b string) bool {
	aAbs, errA := filepath.Abs(filepath.FromSlash(a))
	bAbs, errB := filepath.Abs(filepath.FromSlash(b))
	if errA != nil || errB != nil || aAbs == "" || bAbs == "" {
		return false
	}
	return aAbs == bAbs
}

func copyFile(src, dst string) error {
	if samePath(src, dst) {
		// os.Create truncates dst before io.Copy ever reads from src. When
		// src and dst are the same file, that truncation destroys the
		// source before a single byte is copied. This is not hypothetical:
		// it happened to SKUs 711547/711545, which share a slug and
		// therefore an ImagePath. Guard here too (not just in the caller)
		// so no future caller of copyFile can repeat the mistake.
		return nil
	}
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

// Command bottlecomp composites a flat wine-label scan onto a real bottle
// photograph, so the catalog can show a product shot instead of a rectangle of
// paper — while keeping the label's ACTUAL pixels rather than regenerating
// them (see internal/bottle for why that distinction matters).
//
// Usage:
//
//	go run ./tools/bottlecomp -base <bottle.jpg> -label <label.jpg> -out <out.jpg>
//	go run ./tools/bottlecomp -base <bottle.jpg> -labels <dir> -outdir <dir> -n 5
//
// -inspect prints the detected label area and highlight position without
// writing anything, which is the fast way to check a candidate base.
package main

import (
	"flag"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/bottle"
)

func main() {
	var (
		basePath  = flag.String("base", "", "bottle photograph to composite onto (required)")
		labelPath = flag.String("label", "", "single label image")
		labelsDir = flag.String("labels", "", "directory of label images (batch mode)")
		outPath   = flag.String("out", "", "output file for -label")
		outDir    = flag.String("outdir", "", "output directory for -labels")
		limit     = flag.Int("n", 0, "in batch mode, stop after n labels (0 = all)")
		inspect   = flag.Bool("inspect", false, "report the detected label area and exit")
		quality   = flag.Int("quality", 88, "output JPEG quality")
		arc       = flag.Float64("arc", 0, "override the wrap arc in radians")
	)
	flag.Parse()

	if *basePath == "" {
		fail("need -base")
	}
	base, err := load(*basePath)
	if err != nil {
		fail("base: %v", err)
	}

	area, err := bottle.DetectLabelArea(base)
	if err != nil {
		fail("%v — pick a base whose label is a bright block against dark glass", err)
	}
	opts := bottle.Defaults()
	opts.SpecularAt = bottle.DetectHighlight(base, area)
	if *arc > 0 {
		opts.Arc = *arc
	}

	if *inspect {
		b := base.Bounds()
		fmt.Printf("base      %dx%d\n", b.Dx(), b.Dy())
		fmt.Printf("label area x=%d..%d y=%d..%d  (%dx%d, %.0f%% of width)\n",
			area.Min.X, area.Max.X, area.Min.Y, area.Max.Y,
			area.Dx(), area.Dy(), 100*float64(area.Dx())/float64(b.Dx()))
		fmt.Printf("highlight  %.2f across the label\n", opts.SpecularAt)
		return
	}

	switch {
	case *labelPath != "":
		if *outPath == "" {
			fail("need -out with -label")
		}
		if err := one(base, area, opts, *labelPath, *outPath, *quality); err != nil {
			fail("%v", err)
		}
		fmt.Println("wrote", *outPath)

	case *labelsDir != "":
		if *outDir == "" {
			fail("need -outdir with -labels")
		}
		names, err := filepath.Glob(filepath.Join(*labelsDir, "*.jpg"))
		if err != nil {
			fail("%v", err)
		}
		sort.Strings(names) // deterministic selection when -n truncates
		if *limit > 0 && len(names) > *limit {
			names = names[:*limit]
		}
		if err := os.MkdirAll(*outDir, 0o755); err != nil {
			fail("%v", err)
		}
		var ok, skipped int
		for _, n := range names {
			dst := filepath.Join(*outDir, strings.TrimSuffix(filepath.Base(n), ".jpg")+".jpg")
			if err := one(base, area, opts, n, dst, *quality); err != nil {
				fmt.Fprintf(os.Stderr, "skip %s: %v\n", filepath.Base(n), err)
				skipped++
				continue
			}
			ok++
		}
		fmt.Printf("composited %d, skipped %d\n", ok, skipped)

	default:
		fail("need -label or -labels")
	}
}

func one(base image.Image, area image.Rectangle, o bottle.Options, labelPath, outPath string, q int) error {
	label, err := load(labelPath)
	if err != nil {
		return err
	}
	img, err := bottle.Composite(base, label, area, o)
	if err != nil {
		return err
	}
	f, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer f.Close()
	return jpeg.Encode(f, img, &jpeg.Options{Quality: q})
}

func load(p string) (image.Image, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	return img, err
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "bottlecomp: "+format+"\n", a...)
	os.Exit(1)
}

// Command imgnorm makes a set of bottle photographs look like one catalog.
//
// Verified images arrive correct but wildly inconsistent: measured across one
// fetched batch, canvases ran 500x650, 540x540, 900x1350, 944x944 and
// 1200x1200, with the bottle occupying anywhere from a third to nearly all of
// the frame. Dropped into a grid they jostle — different bottle heights,
// different margins, some floating, some cropped tight. That inconsistency is
// the original complaint about the catalog, and fetching real photography does
// not fix it on its own.
//
// So every image is re-composed onto one canvas: the bottle located (by the
// same subject detection that verified it), scaled so its HEIGHT is a fixed
// share of the frame, and centred on white. After this a Bordeaux and a
// Burgundy sit at the same scale with the same headroom, and the grid reads as
// a single set of photographs.
//
//	go run ./tools/imgnorm -in fetched.png -out assets/img/wines/slug.jpg
package main

import (
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	_ "image/png"
	"os"

	"github.com/gritautomation/finevines-website/internal/imgcheck"
)

func main() {
	in := flag.String("in", "", "source image (required)")
	out := flag.String("out", "", "destination JPEG (required)")
	width := flag.Int("w", 600, "canvas width")
	height := flag.Int("h", 900, "canvas height")
	// 0.86 leaves a small, even margin top and bottom. Filling the frame
	// completely makes a grid feel cramped and crops the punt's shadow, which
	// is what grounds a bottle rather than leaving it floating.
	fill := flag.Float64("fill", 0.86, "share of canvas height the bottle occupies")
	quality := flag.Int("quality", 88, "JPEG quality")
	flag.Parse()
	if *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "need -in and -out")
		os.Exit(2)
	}

	f, err := os.Open(*in)
	if err != nil {
		fail(err)
	}
	src, _, err := image.Decode(f)
	f.Close()
	if err != nil {
		fail(err)
	}

	// Reuse the detector that verified this image, so normalisation is framed
	// on the same subject the checks were made against.
	rep := imgcheck.Analyze(src, imgcheck.Defaults())
	box := rep.Box
	if box.Empty() {
		box = src.Bounds() // no subject found: fall back to the whole frame
	}

	canvas := image.NewRGBA(image.Rect(0, 0, *width, *height))
	draw.Draw(canvas, canvas.Bounds(), &image.Uniform{color.White}, image.Point{}, draw.Src)

	// Scale on HEIGHT, not area or width. A magnum and a half-bottle differ in
	// girth far more than a viewer forgives; matching heights is what makes a
	// row of different shapes read as one set.
	scale := (*fill * float64(*height)) / float64(box.Dy())
	if w := float64(box.Dx()) * scale; w > 0.9*float64(*width) {
		scale = 0.9 * float64(*width) / float64(box.Dx())
	}
	dw, dh := int(float64(box.Dx())*scale), int(float64(box.Dy())*scale)
	ox, oy := (*width-dw)/2, (*height-dh)/2

	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			sx := box.Min.X + int(float64(x)/scale)
			sy := box.Min.Y + int(float64(y)/scale)
			if sx >= box.Max.X {
				sx = box.Max.X - 1
			}
			if sy >= box.Max.Y {
				sy = box.Max.Y - 1
			}
			r, g, b, a := src.At(sx, sy).RGBA()
			// A cut-out PNG's transparent margin must become white, not black.
			if a < 0x4000 {
				canvas.Set(ox+x, oy+y, color.White)
				continue
			}
			canvas.Set(ox+x, oy+y, color.RGBA{uint8(r / 257), uint8(g / 257), uint8(b / 257), 255})
		}
	}

	g, err := os.Create(*out)
	if err != nil {
		fail(err)
	}
	defer g.Close()
	if err := jpeg.Encode(g, canvas, &jpeg.Options{Quality: *quality}); err != nil {
		fail(err)
	}
	fmt.Printf("%s  subject %dx%d -> %dx%d on %dx%d\n", *out, box.Dx(), box.Dy(), dw, dh, *width, *height)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "imgnorm:", err)
	os.Exit(1)
}

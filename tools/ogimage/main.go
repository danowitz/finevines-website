// Command ogimage renders the site's default social-share image,
// assets/img/og-default.png (1200x630), deterministically from the Go
// standard library alone (image/draw/png — no external deps; go.sum carries
// no golang.org/x/image, so text/font rendering is deliberately avoided).
//
// Run from the repo root:
//
//	go run ./tools/ogimage
//
// The output is a committed static asset (build.Run only copies it into
// dist/, never regenerates it), so this tool exists purely for reproducibility:
// running it again on the same finevines-logo.png produces byte-identical
// bytes. The design is intentionally simple — a bordeaux field, a centred
// parchment plate framed by brass keylines, and the real FINEVINES wordmark
// composited onto the plate. The tagline is intentionally omitted for now
// (stdlib has no font and hand-rolling a bitmap face is not worth it for a
// first pass); adding it is a refine-later step once x/image/font is on hand.
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
)

// Brand tokens, copied from assets/css/site.css so the share image reads as
// the same system as the site (bordeaux-800 field, parchment-50 plate,
// brass-500 keylines, brass-600 as the plate's finer inner border).
var (
	bordeaux  = color.RGBA{0x53, 0x14, 0x27, 0xff} // --bordeaux-800
	parchment = color.RGBA{0xfa, 0xf6, 0xee, 0xff} // --parchment-50
	brass     = color.RGBA{0xc2, 0xa1, 0x4e, 0xff} // --brass-500
	brassDark = color.RGBA{0xa9, 0x85, 0x3d, 0xff} // --brass-600
)

const (
	canvasW = 1200
	canvasH = 630

	logoSrc = "assets/img/finevines-logo.png"
	out     = "assets/img/og-default.png"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "ogimage:", err)
		os.Exit(1)
	}
}

func run() error {
	logo, err := loadPNG(logoSrc)
	if err != nil {
		return err
	}

	canvas := image.NewRGBA(image.Rect(0, 0, canvasW, canvasH))
	fill(canvas, canvas.Bounds(), bordeaux)

	// Centred parchment plate with a brass keyline frame.
	const margin = 84
	plate := image.Rect(margin, margin, canvasW-margin, canvasH-margin)
	fill(canvas, plate.Inset(-8), brass) // brass border sits just outside the plate
	fill(canvas, plate, parchment)
	stroke(canvas, plate, 2, brassDark) // fine inner keyline

	// Composite the real wordmark, scaled to fit the plate width, centred.
	lb := logo.Bounds()
	targetW := 720
	targetH := targetW * lb.Dy() / lb.Dx()
	scaled := downscale(logo, targetW, targetH)
	cx, cy := (plate.Min.X+plate.Max.X)/2, (plate.Min.Y+plate.Max.Y)/2
	origin := image.Pt(cx-targetW/2, cy-targetH/2)
	compositeOver(canvas, scaled, origin)

	// Brass editorial rules above and below the wordmark.
	const ruleHalf = 300
	ruleTop := cy - targetH/2 - 44
	ruleBot := cy + targetH/2 + 44
	fill(canvas, image.Rect(cx-ruleHalf, ruleTop, cx+ruleHalf, ruleTop+3), brass)
	fill(canvas, image.Rect(cx-ruleHalf, ruleBot, cx+ruleHalf, ruleBot+3), brass)

	return writePNG(out, canvas)
}

// downscale returns a w×h RGBA copy of src using area (box) averaging over the
// source pixels each destination pixel covers — deterministic and clean for
// the pure downscale this tool always does. Averaging happens in the
// alpha-premultiplied space At().RGBA() returns, so the wordmark's antialiased
// transparent edges blend and later composite correctly.
func downscale(src image.Image, w, h int) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	for dy := 0; dy < h; dy++ {
		sy0 := b.Min.Y + dy*sh/h
		sy1 := b.Min.Y + (dy+1)*sh/h
		if sy1 <= sy0 {
			sy1 = sy0 + 1
		}
		for dx := 0; dx < w; dx++ {
			sx0 := b.Min.X + dx*sw/w
			sx1 := b.Min.X + (dx+1)*sw/w
			if sx1 <= sx0 {
				sx1 = sx0 + 1
			}
			var rs, gs, bs, as, n uint64
			for sy := sy0; sy < sy1; sy++ {
				for sx := sx0; sx < sx1; sx++ {
					r, g, bl, a := src.At(sx, sy).RGBA() // premultiplied, 0..65535
					rs += uint64(r)
					gs += uint64(g)
					bs += uint64(bl)
					as += uint64(a)
					n++
				}
			}
			if n == 0 {
				n = 1
			}
			dst.SetRGBA(dx, dy, premul(rs/n, gs/n, bs/n, as/n))
		}
	}
	return dst
}

// compositeOver alpha-composites src onto dst at origin (source-over), using
// the premultiplied values At().RGBA() returns: out = src + dst*(1-srcAlpha).
func compositeOver(dst *image.RGBA, src image.Image, origin image.Point) {
	b := src.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			sr, sg, sb, sa := src.At(x, y).RGBA()
			if sa == 0 {
				continue
			}
			dx, dy := origin.X+(x-b.Min.X), origin.Y+(y-b.Min.Y)
			dr, dg, db, da := dst.At(dx, dy).RGBA()
			inv := uint64(65535 - sa)
			r := uint64(sr) + uint64(dr)*inv/65535
			g := uint64(sg) + uint64(dg)*inv/65535
			bl := uint64(sb) + uint64(db)*inv/65535
			a := uint64(sa) + uint64(da)*inv/65535
			dst.SetRGBA(dx, dy, premul(r, g, bl, a))
		}
	}
}

// premul converts 16-bit premultiplied channel values (0..65535) to a
// color.RGBA (8-bit premultiplied), which is exactly image.RGBA's model.
func premul(r, g, b, a uint64) color.RGBA {
	return color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
}

// fill paints rectangle r with the solid colour c on img.
func fill(img *image.RGBA, r image.Rectangle, c color.RGBA) {
	draw.Draw(img, r, &image.Uniform{C: c}, image.Point{}, draw.Src)
}

// stroke draws a w-px border just inside rectangle r with colour c.
func stroke(img *image.RGBA, r image.Rectangle, w int, c color.RGBA) {
	fill(img, image.Rect(r.Min.X, r.Min.Y, r.Max.X, r.Min.Y+w), c) // top
	fill(img, image.Rect(r.Min.X, r.Max.Y-w, r.Max.X, r.Max.Y), c) // bottom
	fill(img, image.Rect(r.Min.X, r.Min.Y, r.Min.X+w, r.Max.Y), c) // left
	fill(img, image.Rect(r.Max.X-w, r.Min.Y, r.Max.X, r.Max.Y), c) // right
}

func loadPNG(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	return img, nil
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := png.Encode(f, img); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

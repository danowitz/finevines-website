// Package bottle composites a real wine label onto a real bottle photograph.
//
// It exists because the catalog's images are not consistent: of 474
// photographs, 319 are flat label scans, 62 are bottle shots, and the rest sit
// somewhere between. The portfolio grid therefore mixes flat rectangles of
// paper with studio bottle shots, and neither reads as a product photo.
//
// The approach here is deliberately NOT generative. An image model handed a
// label will redraw it, and on a wine label the text IS the content — a
// re-synthesised "Chambolle-Musigny" with a hallucinated appellation line is
// worse than no image at all, and 247 of the 319 label scans are under 600px,
// where that failure is near-certain. So the label's own pixels are warped
// onto the bottle and never regenerated. What you read on the output is what
// was on the scan.
//
// The realism comes from two things: a real photograph as the base, and a
// cylindrical projection with matched shading so the label sits ON the glass
// rather than being pasted flat across it.
package bottle

import (
	"errors"
	"image"
	"image/color"
	"math"
)

// Options tunes the projection. The zero value is not useful; use Defaults.
type Options struct {
	// Arc is how much of the bottle's circumference the label wraps, in
	// radians. A 750ml Burgundy bottle is ~78mm across and carries a ~100mm
	// label, so a little over half the circumference faces the camera. Larger
	// values compress the label's edges harder.
	Arc float64
	// Ambient is the light the label receives regardless of facing (bounce off
	// the shooting table and fill cards). Without it the label's edges crush to
	// black and the wrap reads as a dent rather than a curve.
	Ambient float64
	// SpecularAt is where the highlight sits across the label, 0 (left edge) to
	// 1 (right). It should match the highlight already on the bottle's glass —
	// DetectHighlight reads that off the base photograph.
	SpecularAt float64
	// SpecularWidth is the highlight's falloff as a fraction of label width.
	SpecularWidth float64
	// SpecularGain is how bright the highlight blows out, 0 for none.
	SpecularGain float64
	// StretchToFill scales the label to fill the whole label area, ignoring its
	// own proportions. Almost never what you want: the catalog's label scans
	// average 2:1 landscape while the area they land in is near-square, so
	// filling stretches type vertically and every serif reads wrong. Left
	// false, the label is fitted by width at its true aspect and the remaining
	// area is filled by extending its edge rows — which on a wine label is
	// blank paper, so it reads as a taller label rather than a distorted one.
	StretchToFill bool
}

// Defaults are tuned against a straight-on studio shot of a Burgundy bottle
// lit from the left, which is what the catalog's usable bases are.
func Defaults() Options {
	return Options{
		Arc:           2.30,
		Ambient:       0.62,
		SpecularAt:    0.30,
		SpecularWidth: 0.13,
		SpecularGain:  0.30,
	}
}

var (
	// ErrNoLabelArea is returned when the base photograph has no plausible
	// label region — a bottle shot too dark, too small, or cropped so the
	// label is out of frame. The caller should fall back rather than composite
	// onto a guess.
	ErrNoLabelArea = errors.New("bottle: no label area found in base image")
	// ErrEmptyImage is returned for a zero-sized base or label.
	ErrEmptyImage = errors.New("bottle: empty image")
)

// luma is Rec. 601 luminance, 0..1. Used everywhere rather than a per-channel
// average so a red capsule does not read as brighter than the glass beneath it.
func luma(c color.Color) float64 {
	r, g, b, _ := c.RGBA()
	return (0.299*float64(r) + 0.587*float64(g) + 0.114*float64(b)) / 65535.0
}

// DetectLabelArea finds the existing label on a bottle photograph.
//
// It relies on the one thing every studio bottle shot has in common: the label
// is a bright, wide, horizontally-consistent block against dark glass, sitting
// in the lower half of the bottle. Rows are scored by how bright their CENTRE
// is — sampling only the middle 40% of the bottle's width, which keeps the
// white background and the glass edge highlight out of the measurement.
//
// The returned rectangle is where a NEW label must be drawn. It does not need
// to be pixel-exact against the old one, because the new label is composited
// opaquely over it; it needs to be no smaller, or the old label peeks out.
func DetectLabelArea(img image.Image) (image.Rectangle, error) {
	b := img.Bounds()
	if b.Empty() {
		return image.Rectangle{}, ErrEmptyImage
	}

	// The bottle's horizontal extent: columns whose darkest pixel is clearly
	// darker than the background. Glass is dark, the sweep is not.
	left, right := -1, -1
	for x := b.Min.X; x < b.Max.X; x++ {
		darkest := 1.0
		for y := b.Min.Y; y < b.Max.Y; y += 4 {
			if l := luma(img.At(x, y)); l < darkest {
				darkest = l
			}
		}
		if darkest < 0.45 {
			if left < 0 {
				left = x
			}
			right = x
		}
	}
	if left < 0 || right-left < 16 {
		return image.Rectangle{}, ErrNoLabelArea
	}

	// Score rows on the bottle's centre band only.
	bw := right - left
	cx0, cx1 := left+bw*3/10, right-bw*3/10
	rowLuma := make([]float64, b.Dy())
	for y := b.Min.Y; y < b.Max.Y; y++ {
		var sum float64
		var n int
		for x := cx0; x < cx1; x++ {
			sum += luma(img.At(x, y))
			n++
		}
		if n > 0 {
			rowLuma[y-b.Min.Y] = sum / float64(n)
		}
	}

	// Search the lower 65% of the frame: a Burgundy bottle's label sits well
	// below the shoulder, and the capsule up top is bright enough to win a
	// naive whole-frame search.
	start := b.Dy() * 35 / 100
	var bestTop, bestBot int
	var inRun bool
	var runTop int
	const bright = 0.55
	for y := start; y < b.Dy(); y++ {
		if rowLuma[y] > bright {
			if !inRun {
				inRun, runTop = true, y
			}
			if y-runTop > bestBot-bestTop {
				bestTop, bestBot = runTop, y
			}
		} else {
			inRun = false
		}
	}
	if bestBot-bestTop < b.Dy()/20 {
		return image.Rectangle{}, ErrNoLabelArea
	}

	// Horizontal extent of the label within those rows, again by brightness.
	lx, rx := -1, -1
	for x := left; x <= right; x++ {
		var sum float64
		n := 0
		for y := bestTop; y <= bestBot; y++ {
			sum += luma(img.At(x, b.Min.Y+y))
			n++
		}
		if n > 0 && sum/float64(n) > bright {
			if lx < 0 {
				lx = x
			}
			rx = x
		}
	}
	if lx < 0 || rx-lx < 16 {
		return image.Rectangle{}, ErrNoLabelArea
	}
	return image.Rect(lx, b.Min.Y+bestTop, rx+1, b.Min.Y+bestBot+1), nil
}

// DetectHighlight returns where the specular highlight sits across the bottle,
// as a fraction of the label area's width. Reading it off the base rather than
// assuming it means a bottle lit from the right composites correctly without
// anyone re-tuning constants.
//
// It samples the glass ABOVE the label, where the surface is unbroken — the
// label itself carries text, and text would drag the measurement around.
func DetectHighlight(img image.Image, area image.Rectangle) float64 {
	band := area.Dy() / 3
	y1 := area.Min.Y - area.Dy()/8
	y0 := y1 - band
	if y0 < img.Bounds().Min.Y {
		return 0.5
	}
	// Skip the outer 15% each side. A bottle photographed against white has a
	// bright refractive rim at both edges of the glass that easily out-scores
	// the broad specular we actually want to reproduce — take the rim and every
	// composited label gets lit from whichever edge happened to be brighter.
	inset := area.Dx() * 15 / 100
	best, bestX := -1.0, area.Min.X+inset
	for x := area.Min.X + inset; x < area.Max.X-inset; x++ {
		var sum float64
		n := 0
		for y := y0; y < y1; y++ {
			sum += luma(img.At(x, y))
			n++
		}
		if n > 0 && sum/float64(n) > best {
			best, bestX = sum/float64(n), x
		}
	}
	if area.Dx() == 0 {
		return 0.5
	}
	return float64(bestX-area.Min.X) / float64(area.Dx())
}

// shade returns the light reaching the label at angle theta from the bottle's
// facing normal, plus a specular term at u (0..1 across the label).
func (o Options) shade(theta, u float64) float64 {
	// Lambertian falloff as the glass curves away from the light.
	s := o.Ambient + (1-o.Ambient)*math.Cos(theta)
	if o.SpecularGain > 0 && o.SpecularWidth > 0 {
		d := (u - o.SpecularAt) / o.SpecularWidth
		s += o.SpecularGain * math.Exp(-d*d)
	}
	return s
}

// bilinear samples src at fractional (fx, fy) in its own coordinate space.
// Nearest-neighbour would alias the fine serif type on a label into mush at
// the compressed edges, which is exactly where the wrap needs to stay legible.
func bilinear(src image.Image, fx, fy float64) color.RGBA {
	b := src.Bounds()
	x0 := int(math.Floor(fx))
	y0 := int(math.Floor(fy))
	dx := fx - float64(x0)
	dy := fy - float64(y0)

	at := func(x, y int) (float64, float64, float64) {
		if x < b.Min.X {
			x = b.Min.X
		}
		if x >= b.Max.X {
			x = b.Max.X - 1
		}
		if y < b.Min.Y {
			y = b.Min.Y
		}
		if y >= b.Max.Y {
			y = b.Max.Y - 1
		}
		r, g, bl, _ := src.At(x, y).RGBA()
		return float64(r) / 257, float64(g) / 257, float64(bl) / 257
	}

	r00, g00, b00 := at(x0, y0)
	r10, g10, b10 := at(x0+1, y0)
	r01, g01, b01 := at(x0, y0+1)
	r11, g11, b11 := at(x0+1, y0+1)

	lerp := func(a, b, t float64) float64 { return a + (b-a)*t }
	r := lerp(lerp(r00, r10, dx), lerp(r01, r11, dx), dy)
	g := lerp(lerp(g00, g10, dx), lerp(g01, g11, dx), dy)
	bb := lerp(lerp(b00, b10, dx), lerp(b01, b11, dx), dy)
	return color.RGBA{clamp8(r), clamp8(g), clamp8(bb), 255}
}

func clamp8(v float64) uint8 {
	if v <= 0 {
		return 0
	}
	if v >= 255 {
		return 255
	}
	return uint8(v + 0.5)
}

// Composite draws label onto base within area, wrapped around the bottle's
// curve and lit to match it, and returns a new image. base and label are not
// modified.
//
// The projection is the inverse of how a cylinder photographs. A point at
// angle θ around the bottle appears at screen offset proportional to sin θ, so
// walking across the destination in equal steps and solving θ = asin(...)
// gives the label coordinate to sample — which is why type crowds together
// towards the label's edges exactly as it does on a real bottle.
func Composite(base, label image.Image, area image.Rectangle, o Options) (*image.RGBA, error) {
	bb := base.Bounds()
	lb := label.Bounds()
	if bb.Empty() || lb.Empty() {
		return nil, ErrEmptyImage
	}
	area = area.Intersect(bb)
	if area.Empty() {
		return nil, ErrNoLabelArea
	}

	out := image.NewRGBA(bb)
	// Copy the base first; only the label area is overwritten below.
	for y := bb.Min.Y; y < bb.Max.Y; y++ {
		for x := bb.Min.X; x < bb.Max.X; x++ {
			r, g, b, a := base.At(x, y).RGBA()
			out.SetRGBA(x, y, color.RGBA{uint8(r / 257), uint8(g / 257), uint8(b / 257), uint8(a / 257)})
		}
	}

	half := math.Sin(o.Arc / 2)
	w := float64(area.Dx())
	h := float64(area.Dy())

	// Vertical mapping. Filling the area stretches a 2:1 label into a near
	// square; instead the label keeps its aspect, is centred, and the leftover
	// rows clamp to its top and bottom edges (blank paper on a wine label).
	//
	// The label is fitted by the area's width measured along the GLASS, not
	// across the screen: the wrap compresses the visible width by the ratio of
	// chord to arc, so fitting to the flat screen width would leave the label
	// noticeably too short once curved.
	arcRatio := o.Arc / (2 * half) // > 1: the label's real width exceeds the chord
	vScale := 1.0
	vOffset := 0.0
	if !o.StretchToFill {
		labelAspect := float64(lb.Dy()) / float64(lb.Dx())
		drawn := w * arcRatio * labelAspect // the label's height at true aspect
		vScale = h / drawn
		vOffset = 0.5 - 0.5*vScale
	}

	for y := area.Min.Y; y < area.Max.Y; y++ {
		v := ((float64(y-area.Min.Y)+0.5)/h)*vScale + vOffset
		if v < 0 {
			v = 0
		}
		if v > 1 {
			v = 1
		}
		for x := area.Min.X; x < area.Max.X; x++ {
			// Screen position across the label, -0.5 .. +0.5.
			s := (float64(x-area.Min.X)+0.5)/w - 0.5
			sinTheta := 2 * s * half
			if sinTheta < -1 || sinTheta > 1 {
				continue
			}
			theta := math.Asin(sinTheta)
			u := 0.5 + theta/o.Arc
			if u < 0 || u > 1 {
				continue
			}

			px := bilinear(label,
				float64(lb.Min.X)+u*float64(lb.Dx()-1),
				float64(lb.Min.Y)+v*float64(lb.Dy()-1))

			sh := o.shade(theta, (float64(x-area.Min.X)+0.5)/w)
			out.SetRGBA(x, y, color.RGBA{
				clamp8(float64(px.R) * sh),
				clamp8(float64(px.G) * sh),
				clamp8(float64(px.B) * sh),
				255,
			})
		}
	}
	return out, nil
}

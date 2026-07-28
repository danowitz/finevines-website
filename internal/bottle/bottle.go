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
	"sort"
)

// Options tunes the projection. The zero value is not useful; use Defaults.
type Options struct {
	// Arc is how much of the bottle's circumference the label wraps, in
	// radians. A 750ml Burgundy bottle is ~78mm across and carries a ~100mm
	// label, so a little over half the circumference faces the camera. Larger
	// values compress the label's edges harder.
	Arc float64
	// Ambient is the light the label receives regardless of facing, used only
	// by the synthetic fallback when no lighting could be measured off the
	// base. Without it the label's edges crush to black and the wrap reads as
	// a dent rather than a curve.
	Ambient float64
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
		Arc:     2.30,
		Ambient: 0.62,
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
func DetectLabelArea(img image.Image, arc float64) (Area, error) {
	b := img.Bounds()
	if b.Empty() {
		return Area{}, ErrEmptyImage
	}

	// 1. The bottle's horizontal extent: columns holding a pixel clearly darker
	//    than the background sweep.
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
		return Area{}, ErrNoLabelArea
	}

	// 2. The label band, scored on the bottle's centre columns only — the white
	//    sweep and the glass rim both out-score paper if they are included.
	bw := right - left
	cx0, cx1 := left+bw*3/10, right-bw*3/10
	rowLuma := make([]float64, b.Dy())
	for y := b.Min.Y; y < b.Max.Y; y++ {
		var sum float64
		n := 0
		for x := cx0; x < cx1; x++ {
			sum += luma(img.At(x, y))
			n++
		}
		if n > 0 {
			rowLuma[y-b.Min.Y] = sum / float64(n)
		}
	}
	// Search the lower 65%: the capsule is bright enough to win a naive
	// whole-frame search, and no wine label sits above the shoulder.
	from := b.Dy() * 35 / 100
	var bandTop, bandBot, runTop int
	inRun := false
	const bright = 0.55
	for y := from; y < b.Dy(); y++ {
		if rowLuma[y] > bright {
			if !inRun {
				inRun, runTop = true, y
			}
			if y-runTop > bandBot-bandTop {
				bandTop, bandBot = runTop, y
			}
		} else {
			inRun = false
		}
	}
	if bandBot-bandTop < b.Dy()/20 {
		return Area{}, ErrNoLabelArea
	}
	bandTop += b.Min.Y
	bandBot += b.Min.Y

	// 3. The label's column range, judged on rows from the MIDDLE THIRD of the
	//    band. Those rows are unambiguously label, so a column either shows
	//    paper there or it is past the label's border — no interference from
	//    the punt below or the shoulder above.
	const edge = 0.30
	q0 := bandTop + (bandBot-bandTop)/3
	q1 := bandBot - (bandBot-bandTop)/3
	lx, rx := -1, -1
	for x := left; x <= right; x++ {
		lit := 0
		for y := q0; y <= q1; y++ {
			if luma(img.At(x, y)) > edge {
				lit++
			}
		}
		if lit > (q1-q0)/2 {
			if lx < 0 {
				lx = x
			}
			rx = x
		}
	}
	if lx < 0 || rx-lx < 32 {
		return Area{}, ErrNoLabelArea
	}

	// 4. Sample the top and bottom edge in a few columns at the label's centre
	//    and at each shoulder, then take medians. Sampling rather than scanning
	//    every column is the point: the fit needs two robust estimates, not a
	//    thousand fragile ones.
	span := rx - lx
	sampleEdges := func(from, to int) (topMed, botMed int, ok bool) {
		var tops, bots []int
		for x := from; x <= to; x++ {
			// Walk outward from the band's middle so ink inside the label can
			// never be mistaken for its edge.
			mid := (bandTop + bandBot) / 2
			t, bo := mid, mid
			for y := mid; y >= bandTop-(bandBot-bandTop)/3 && y >= b.Min.Y; y-- {
				if luma(img.At(x, y)) > edge {
					t = y
				} else if t-y > 6 {
					break // six consecutive dark rows: the paper has ended
				}
			}
			for y := mid; y <= bandBot+(bandBot-bandTop)/3 && y < b.Max.Y; y++ {
				if luma(img.At(x, y)) > edge {
					bo = y
				} else if y-bo > 6 {
					break
				}
			}
			if bo > t {
				tops = append(tops, t)
				bots = append(bots, bo)
			}
		}
		if len(tops) < 3 {
			return 0, 0, false
		}
		return medianInt(tops), medianInt(bots), true
	}

	cTop, cBot, okC := sampleEdges(lx+span*45/100, lx+span*55/100)
	sTop, sBot, okS := sampleEdges(lx+span*2/100, lx+span*8/100)
	eTop, eBot, okE := sampleEdges(lx+span*92/100, lx+span*98/100)
	if !okC {
		return Area{}, ErrNoLabelArea
	}

	// 5. The bow is how far the edge rises between centre and shoulder. Average
	//    both shoulders when available; a base cropped tight on one side still
	//    fits from the other.
	bowTop, bowBot, n := 0, 0, 0
	if okS {
		bowTop += cTop - sTop
		bowBot += cBot - sBot
		n++
	}
	if okE {
		bowTop += cTop - eTop
		bowBot += cBot - eBot
		n++
	}
	if n > 0 {
		bowTop /= n
		bowBot /= n
	}
	// The shoulder samples sit ~5% inside the label's edge, where the arc has
	// only reached part of its full offset — so the raw difference understates
	// the bow. Scale by the model's own factor at the sampling position to
	// recover the value AT the edge. Measured on the synthetic base this is the
	// difference between a bow of 6 and the true 8, which is exactly the couple
	// of pixels of original label that survive in the corner.
	if k := bowFactor(0.05, arc); k > 0.05 {
		bowTop = int(math.Round(float64(bowTop) / k))
		bowBot = int(math.Round(float64(bowBot) / k))
	}

	// A negative bow would mean the edge falls away at the sides, which no
	// cylinder does; treat it as an unreliable measurement and go flat.
	if bowTop < 0 {
		bowTop = 0
	}
	if bowBot < 0 {
		bowBot = 0
	}

	// Pad outward by a pixel. The estimates come from medians and thresholds,
	// so they can land a pixel inside the true edge — and the two failure modes
	// are not symmetric: overshooting paints label over the darkest part of the
	// glass, where it is invisible, while undershooting leaves a lit strip of
	// the original label on show.
	return NewArea(lx-1, rx+2, cTop-1, cBot+1, bowTop, bowBot, arc), nil
}

// Lighting is how brightly the base photograph lights its label, measured
// column by column across the label area.
//
// This replaces modelling the light. A synthetic cosine falloff has to guess
// the lamp positions, the fill, the table bounce and the glass's own
// refraction, and it guesses badly: measured against a real studio shot, the
// synthetic version rendered a label at a flat 255 where the photograph's own
// label sits around 200 and falls to 160 at its shaded edge. The result read
// as a sticker pasted over the bottle.
//
// The old label is itself a photograph of exactly how this bottle is lit, so
// the light is simply read off it. Whatever the photographer did — a
// hard key from the left, a big soft box, a bounce card — comes across for
// free, and a differently-lit base needs no constants retuned.
type Lighting struct {
	// X0 is the column Level[0] corresponds to.
	X0 int
	// Level is the paper luminance, 0..1, one entry per column.
	Level []float64
	// Paper is the representative lit-paper level across the whole label, used
	// to normalise an incoming label to the same exposure.
	Paper float64
}

// Ok reports whether the measurement is usable.
func (l Lighting) Ok() bool { return len(l.Level) > 0 && l.Paper > 0.05 }

// at returns the light at column x, clamped to the measured range.
func (l Lighting) at(x int) float64 {
	i := x - l.X0
	if i < 0 {
		i = 0
	}
	if i >= len(l.Level) {
		i = len(l.Level) - 1
	}
	return l.Level[i]
}

// percentile returns the p-th (0..1) percentile of vs. vs is sorted in place.
func percentile(vs []float64, p float64) float64 {
	if len(vs) == 0 {
		return 0
	}
	sort.Float64s(vs)
	i := int(p * float64(len(vs)-1))
	return vs[i]
}

// MeasureLighting reads the per-column illumination off the base's existing
// label.
//
// Each column is reduced by a high PERCENTILE rather than a mean, because a
// wine label is mostly paper interrupted by text: a mean is dragged down
// wherever a line of serif type happens to fall, which would stamp the old
// label's wording into the new one as horizontal banding. The 80th percentile
// tracks the paper and steps over the ink.
//
// The profile is then smoothed, since even a percentile wobbles where a column
// runs down the stem of a capital.
func MeasureLighting(base image.Image, area Area) Lighting {
	if area.Empty() {
		return Lighting{}
	}
	raw := make([]float64, area.Cols())
	for i := 0; i < area.Cols(); i++ {
		x := area.X0 + i
		top, bot := area.Top[i], area.Bot[i]
		col := make([]float64, 0, bot-top+1)
		for y := top; y <= bot; y++ {
			col = append(col, luma(base.At(x, y)))
		}
		raw[i] = percentile(col, 0.80)
	}

	// Smooth over ~5% of the label's width.
	win := area.Cols() / 20
	if win < 1 {
		win = 1
	}
	sm := make([]float64, len(raw))
	for i := range raw {
		lo, hi := i-win, i+win
		if lo < 0 {
			lo = 0
		}
		if hi >= len(raw) {
			hi = len(raw) - 1
		}
		var sum float64
		for j := lo; j <= hi; j++ {
			sum += raw[j]
		}
		sm[i] = sum / float64(hi-lo+1)
	}

	return Lighting{
		X0:    area.X0,
		Level: sm,
		Paper: percentile(append([]float64(nil), sm...), 0.85),
	}
}

// paperLevel estimates a label image's own lit-paper luminance, so it can be
// normalised to the base's exposure. Sampled on a grid — reading every pixel
// of a 3000px scan to find one number is wasted work.
func paperLevel(img image.Image) float64 {
	b := img.Bounds()
	stepX, stepY := b.Dx()/64+1, b.Dy()/64+1
	vs := make([]float64, 0, 4096)
	for y := b.Min.Y; y < b.Max.Y; y += stepY {
		for x := b.Min.X; x < b.Max.X; x += stepX {
			vs = append(vs, luma(img.At(x, y)))
		}
	}
	return percentile(vs, 0.85)
}

// shade is the synthetic fallback, used only when the base's own lighting
// could not be measured. Lambertian falloff as the glass curves away.
func (o Options) shade(theta float64) float64 {
	return o.Ambient + (1-o.Ambient)*math.Cos(theta)
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
// light is measured off the base once with MeasureLighting; pass a zero
// Lighting to fall back to the synthetic cosine model.
func Composite(base, label image.Image, area Area, light Lighting, o Options) (*image.RGBA, error) {
	bb := base.Bounds()
	lb := label.Bounds()
	if bb.Empty() || lb.Empty() {
		return nil, ErrEmptyImage
	}
	if area.Empty() || !area.Bounds().Overlaps(bb) {
		return nil, ErrNoLabelArea
	}

	out := image.NewRGBA(bb)
	for y := bb.Min.Y; y < bb.Max.Y; y++ {
		for x := bb.Min.X; x < bb.Max.X; x++ {
			r, g, b, a := base.At(x, y).RGBA()
			out.SetRGBA(x, y, color.RGBA{uint8(r / 257), uint8(g / 257), uint8(b / 257), uint8(a / 257)})
		}
	}

	// Normalise the incoming label to the base's exposure. A scan's paper is
	// often pure 255 while a photographed label sits nearer 200; dropped in
	// unscaled it clips to flat white and reads as a sticker rather than paper
	// lit by the same lamps as the glass around it.
	paper := paperLevel(label)
	if paper < 0.05 {
		paper = 1 // a near-black label: leave it alone rather than amplify noise
	}

	half := math.Sin(o.Arc / 2)
	w := float64(area.Cols())
	arcRatio := o.Arc / (2 * half) // the label's true width exceeds the visible chord

	// Vertical fit. The label keeps its own proportions unless told otherwise:
	// the catalog's scans average 2:1 landscape and the area they land in is
	// near-square, so filling stretches every serif. Height is taken at the
	// centre column and measured against the label's ARC length rather than the
	// visible chord — fitting to screen width leaves it visibly short once
	// curved.
	vScale, vOffset := 1.0, 0.0
	if !o.StretchToFill {
		labelAspect := float64(lb.Dy()) / float64(lb.Dx())
		drawn := w * arcRatio * labelAspect
		if h := float64(area.centreHeight()); h > 0 && drawn > 0 {
			vScale = h / drawn
			vOffset = 0.5 - 0.5*vScale
		}
	}

	for i := 0; i < area.Cols(); i++ {
		x := area.X0 + i
		if x < bb.Min.X || x >= bb.Max.X {
			continue
		}
		// Screen position across the label, -0.5 .. +0.5.
		sx := (float64(i)+0.5)/w - 0.5
		sinTheta := 2 * sx * half
		if sinTheta < -1 || sinTheta > 1 {
			continue
		}
		theta := math.Asin(sinTheta)
		u := 0.5 + theta/o.Arc
		if u < 0 || u > 1 {
			continue
		}

		// This column's own top and bottom — the elliptical edge. Filling
		// between them is what both covers the original label completely and
		// gives the composite a curved boundary instead of a straight one.
		top, bot := area.colAt(x)
		colH := float64(bot - top + 1)
		if colH <= 0 {
			continue
		}

		var sh float64
		if light.Ok() {
			sh = light.at(x) / paper
		} else {
			sh = o.shade(theta)
		}

		// Glass to show wherever the new label does not reach, sampled just
		// outside the original label's footprint in this same column so it
		// carries the bottle's own colour and vertical gradient.
		aboveGlass := sampleClamped(base, x, top-2)
		belowGlass := sampleClamped(base, x, bot+2)

		for y := top; y <= bot; y++ {
			if y < bb.Min.Y || y >= bb.Max.Y {
				continue
			}
			v := ((float64(y-top)+0.5)/colH)*vScale + vOffset

			// Outside the label's own extent, paint GLASS rather than clamping
			// to the label's edge row.
			//
			// Clamping filled the whole footprint with paper, and since the
			// catalog's scans average 2:1 landscape while the footprint they
			// land in is near-square, that meant a correctly-proportioned label
			// surrounded by a huge blank slab — reading as one oversized empty
			// sticker rather than a label on a bottle. A real label of the
			// wrong size simply covers less of the glass, so that is what is
			// drawn.
			if v < 0 {
				out.SetRGBA(x, y, aboveGlass)
				continue
			}
			if v > 1 {
				out.SetRGBA(x, y, belowGlass)
				continue
			}

			px := bilinear(label,
				float64(lb.Min.X)+u*float64(lb.Dx()-1),
				float64(lb.Min.Y)+v*float64(lb.Dy()-1))
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

// sampleClamped reads base at (x, y), clamping to its bounds, and returns the
// pixel as 8-bit RGBA. Used to pick up the glass just outside the label's
// footprint, where a y a couple of pixels past the edge may fall off the image
// on a tightly-cropped base.
func sampleClamped(base image.Image, x, y int) color.RGBA {
	b := base.Bounds()
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
	r, g, bl, a := base.At(x, y).RGBA()
	return color.RGBA{uint8(r / 257), uint8(g / 257), uint8(bl / 257), uint8(a / 257)}
}

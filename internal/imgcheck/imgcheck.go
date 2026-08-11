// Package imgcheck inspects a candidate product photograph before it is
// trusted — is this ONE bottle on a clean background, or a three-bottle gift
// set, a vineyard scene, or a case carton?
//
// This runs before any text matching, deliberately. Verifying the page's
// caption tells you what a listing CLAIMS; verifying the pixels tells you what
// will actually appear on the site, and those come apart whenever a retailer
// attaches a shared hero image, a lifestyle shot, or a multipack photo to a
// single-bottle listing. It is also the cheap check: pure arithmetic over the
// image, no OCR and no network, so it discards the obvious failures before
// anything expensive runs.
//
// The method needs no model. A studio bottle shot is a single tall dark object
// on a plain sweep, so the background can be read off the corners and the
// subject found as the run of columns that differ from it. A gift set breaks
// into several such runs; a lifestyle photograph has no clean background at
// all; a carton is far too wide for its height.
package imgcheck

import (
	"image"
	"image/color"
	"math"
	"sort"
)

// Report is what a candidate image turned out to be.
type Report struct {
	// Background is the sampled sweep colour.
	Background color.RGBA
	// Subjects counts distinct objects across the frame. One is what we want.
	Subjects int
	// NeckSubjects counts separate objects in the upper third of the subject.
	// Overlapping bottles often merge into one body silhouette but retain two
	// distinct necks, which a whole-frame column scan otherwise misses.
	NeckSubjects int
	// Box bounds the largest subject.
	Box image.Rectangle
	// Fill is the share of the frame the subject occupies. A studio shot leaves
	// plenty of sweep; a photograph with no clean background approaches 1.
	Fill float64
	// Slimness is the subject's width over its height. A 750ml bottle shot full
	// height lands near 0.25; two bottles side by side double it.
	Slimness float64
	// CleanBackground is whether a consistent sweep was found at all.
	CleanBackground bool
	// SingleBottle is the verdict, with Reason explaining a rejection.
	SingleBottle bool
	Reason       string
}

// Thresholds are the bounds a single bottle shot must satisfy. Exposed so a
// caller can loosen them for, say, magnums, rather than forking the logic.
type Thresholds struct {
	// BackgroundTolerance is how far a pixel may sit from the sweep colour and
	// still count as background, as a 0..1 distance over RGB.
	BackgroundTolerance float64
	// MinColumnInk is the share of a column that must be non-background before
	// the column counts as containing subject. Low, because a bottle's neck is
	// a small part of the frame height.
	MinColumnInk float64
	// MinRunWidth is the narrowest run of columns treated as a real object,
	// as a share of image width — below this it is a shadow or a stray mark.
	MinRunWidth float64
	// GapTolerance is how wide a background gap may be before it separates two
	// objects, as a share of image width. Non-zero because a single bottle can
	// show a bright specular band that reads as background for a few columns.
	GapTolerance float64
	// MinSlimness / MaxSlimness bound a single bottle's width-to-height.
	MinSlimness, MaxSlimness float64
	// MinFill rejects sparse line art and isolated label artwork. Even a pale,
	// transparent bottle contributes substantially more foreground than printed
	// lettering floating on an otherwise empty canvas.
	MinFill float64
	// MaxFill is the most of the frame a lone bottle may occupy. Generous on
	// purpose: retail bottle shots are often cropped tight to the glass, and
	// real fetched examples measured 0.64-0.68 while a loosely framed studio
	// shot of the same bottle measured 0.24. Framing says nothing about
	// whether the subject is a bottle, so this only catches the pathological
	// case of an image with essentially no background at all — and
	// CleanBackground already rejects photographed scenes on better evidence.
	MaxFill float64
}

// Defaults are tuned for retail product photography: one bottle, shot full
// height, centred on white.
func Defaults() Thresholds {
	return Thresholds{
		BackgroundTolerance: 0.12,
		MinColumnInk:        0.04,
		MinRunWidth:         0.03,
		GapTolerance:        0.02,
		MinSlimness:         0.12,
		MaxSlimness:         0.55,
		MinFill:             0.08,
		MaxFill:             0.90,
	}
}

func dist(a, b color.RGBA) float64 {
	dr := float64(a.R) - float64(b.R)
	dg := float64(a.G) - float64(b.G)
	db := float64(a.B) - float64(b.B)
	return math.Sqrt(dr*dr+dg*dg+db*db) / 441.67 // /sqrt(3*255^2) -> 0..1
}

func at(img image.Image, x, y int) color.RGBA {
	r, g, b, a := img.At(x, y).RGBA()
	// Treat transparent as background-coloured: cut-out PNGs are common and a
	// transparent margin is background, not subject.
	if a < 0x4000 {
		return color.RGBA{255, 255, 255, 255}
	}
	return color.RGBA{uint8(r / 257), uint8(g / 257), uint8(b / 257), 255}
}

// background samples the four corners and takes the median channel values, so
// a single corner carrying a logo or a price flash cannot set the reference.
func background(img image.Image) (color.RGBA, bool) {
	b := img.Bounds()
	inset := b.Dx() / 25
	if inset < 1 {
		inset = 1
	}
	pts := []image.Point{
		{b.Min.X + inset, b.Min.Y + inset},
		{b.Max.X - 1 - inset, b.Min.Y + inset},
		{b.Min.X + inset, b.Max.Y - 1 - inset},
		{b.Max.X - 1 - inset, b.Max.Y - 1 - inset},
	}
	var rs, gs, bs []int
	for _, p := range pts {
		c := at(img, p.X, p.Y)
		rs = append(rs, int(c.R))
		gs = append(gs, int(c.G))
		bs = append(bs, int(c.B))
	}
	med := func(v []int) uint8 { sort.Ints(v); return uint8((v[1] + v[2]) / 2) }
	bg := color.RGBA{med(rs), med(gs), med(bs), 255}

	// Clean only if the corners agree with each other. Disagreement means a
	// photographed scene rather than a sweep.
	for _, p := range pts {
		if dist(at(img, p.X, p.Y), bg) > 0.18 {
			return bg, false
		}
	}
	return bg, true
}

// Analyze inspects img and reports whether it is a single bottle on a sweep.
func Analyze(img image.Image, t Thresholds) Report {
	b := img.Bounds()
	rep := Report{}
	if b.Empty() {
		rep.Reason = "empty image"
		return rep
	}

	bg, clean := background(img)
	rep.Background = bg
	rep.CleanBackground = clean

	// Occupancy per column. Sampling every other row is ample at these sizes
	// and halves the work over a few thousand candidates.
	occupied := make([]bool, b.Dx())
	minInk := int(float64(b.Dy()/2) * t.MinColumnInk)
	if minInk < 1 {
		minInk = 1
	}
	total := 0
	for x := 0; x < b.Dx(); x++ {
		ink := 0
		for y := b.Min.Y; y < b.Max.Y; y += 2 {
			if dist(at(img, b.Min.X+x, y), bg) > t.BackgroundTolerance {
				ink++
			}
		}
		total += ink
		occupied[x] = ink >= minInk
	}
	rep.Fill = float64(total) / float64(b.Dx()*(b.Dy()/2+1))

	// Runs of occupied columns, bridging gaps narrower than GapTolerance so a
	// specular highlight down the middle of one bottle does not split it in two.
	gapMax := int(float64(b.Dx()) * t.GapTolerance)
	type run struct{ lo, hi int }
	var runs []run
	cur := run{-1, -1}
	gap := 0
	for x := 0; x < b.Dx(); x++ {
		if occupied[x] {
			if cur.lo < 0 {
				cur = run{x, x}
			} else {
				cur.hi = x
			}
			gap = 0
			continue
		}
		if cur.lo >= 0 {
			gap++
			if gap > gapMax {
				runs = append(runs, cur)
				cur = run{-1, -1}
				gap = 0
			}
		}
	}
	if cur.lo >= 0 {
		runs = append(runs, cur)
	}

	minW := int(float64(b.Dx()) * t.MinRunWidth)
	var kept []run
	for _, r := range runs {
		if r.hi-r.lo+1 >= minW {
			kept = append(kept, r)
		}
	}
	rep.Subjects = len(kept)
	if len(kept) == 0 {
		rep.Reason = "no subject found"
		return rep
	}

	// The largest run is the subject; its vertical extent comes from scanning
	// only those columns.
	big := kept[0]
	for _, r := range kept[1:] {
		if r.hi-r.lo > big.hi-big.lo {
			big = r
		}
	}
	top, bot := -1, -1
	for y := b.Min.Y; y < b.Max.Y; y++ {
		hit := false
		for x := big.lo; x <= big.hi && !hit; x++ {
			if dist(at(img, b.Min.X+x, y), bg) > t.BackgroundTolerance {
				hit = true
			}
		}
		if hit {
			if top < 0 {
				top = y
			}
			bot = y
		}
	}
	if top < 0 {
		rep.Reason = "no subject found"
		return rep
	}
	rep.Box = image.Rect(b.Min.X+big.lo, top, b.Min.X+big.hi+1, bot+1)
	rep.Slimness = float64(rep.Box.Dx()) / float64(rep.Box.Dy())

	neckBottom := rep.Box.Min.Y + rep.Box.Dy()*25/100
	neckOccupied := make([]bool, rep.Box.Dx())
	neckMinInk := (neckBottom - rep.Box.Min.Y) / 40
	if neckMinInk < 1 {
		neckMinInk = 1
	}
	for x := rep.Box.Min.X; x < rep.Box.Max.X; x++ {
		ink := 0
		for y := rep.Box.Min.Y; y < neckBottom; y += 2 {
			if dist(at(img, x, y), bg) > t.BackgroundTolerance {
				ink++
			}
		}
		neckOccupied[x-rep.Box.Min.X] = ink >= neckMinInk
	}
	neckGapMax := int(float64(rep.Box.Dx()) * t.GapTolerance)
	// A real second bottle neck is a substantial part of the combined subject.
	// Thin foil lettering and specular bands can also split the upper silhouette,
	// but those runs are too narrow to count as another bottle.
	neckMinWidth := int(float64(rep.Box.Dx()) * 0.12)
	neckStart, neckLast, neckGap := -1, -1, 0
	for x, occupied := range neckOccupied {
		if occupied {
			if neckStart < 0 {
				neckStart = x
			}
			neckLast = x
			neckGap = 0
			continue
		}
		if neckStart >= 0 {
			neckGap++
			if neckGap > neckGapMax {
				if neckLast-neckStart+1 >= neckMinWidth {
					rep.NeckSubjects++
				}
				neckStart, neckLast, neckGap = -1, -1, 0
			}
		}
	}
	if neckStart >= 0 && neckLast-neckStart+1 >= neckMinWidth {
		rep.NeckSubjects++
	}

	switch {
	case !clean:
		rep.Reason = "no clean background — a photographed scene, not a product shot"
	case rep.Subjects > 1:
		rep.Reason = "multiple subjects — a gift set, multipack or lineup"
	case rep.NeckSubjects > 1:
		rep.Reason = "multiple bottle necks - overlapping bottles"
	case rep.Fill < t.MinFill:
		rep.Reason = "too little bottle-shaped foreground - likely label artwork"
	case rep.Fill > t.MaxFill:
		rep.Reason = "subject fills the frame — cropped or not a product shot"
	case rep.Slimness < t.MinSlimness:
		rep.Reason = "subject too narrow for a bottle"
	case rep.Slimness > t.MaxSlimness:
		rep.Reason = "subject too wide for a single bottle — carton, magnum or pair"
	default:
		rep.SingleBottle = true
	}
	return rep
}

// LabelBand returns the part of a bottle's bounding box worth reading text
// from: the lower portion, where the label sits. Cropping before OCR keeps the
// capsule's foil lettering and any background print out of the result.
func LabelBand(box image.Rectangle) image.Rectangle {
	h := box.Dy()
	return image.Rect(box.Min.X, box.Min.Y+h*45/100, box.Max.X, box.Min.Y+h*95/100)
}

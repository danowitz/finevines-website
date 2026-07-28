package bottle

import (
	"image"
	"image/color"
	"math"
	"testing"
)

const testArc = 2.30

// synthBottle draws the minimum a detector should cope with: a dark bottle
// body on a white sweep, with a bright label whose top and bottom edges BOW —
// rising towards the sides, as a real label on a cylinder does.
func synthBottle(w, h, lx, rx, topC, botC, bowTop, bowBot int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	white := color.RGBA{250, 250, 250, 255}
	glass := color.RGBA{28, 16, 20, 255}
	paper := color.RGBA{238, 234, 224, 255}
	bodyL, bodyR := w/5, w*4/5
	half := math.Sin(testArc / 2)
	edge := 1 - math.Cos(testArc/2)

	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			switch {
			case x >= bodyL && x < bodyR:
				img.SetRGBA(x, y, glass)
			default:
				img.SetRGBA(x, y, white)
			}
		}
	}
	for x := lx; x < rx; x++ {
		s := (float64(x-lx)+0.5)/float64(rx-lx) - 0.5
		k := (1 - math.Cos(math.Asin(2*s*half))) / edge
		t := topC - int(math.Round(float64(bowTop)*k))
		b := botC - int(math.Round(float64(bowBot)*k))
		for y := t; y <= b; y++ {
			if y >= 0 && y < h {
				img.SetRGBA(x, y, paper)
			}
		}
	}
	return img
}

func base() *image.RGBA { return synthBottle(200, 500, 50, 150, 300, 420, 8, 12) }

func TestDetectLabelAreaFindsTheFootprint(t *testing.T) {
	a, err := DetectLabelArea(base(), testArc)
	if err != nil {
		t.Fatal(err)
	}
	r := a.Bounds()
	near := func(got, want, tol int) bool { d := got - want; return d < tol && d > -tol }
	if !near(r.Min.X, 50, 4) || !near(r.Max.X, 150, 4) {
		t.Errorf("columns %d..%d, want ~50..150", r.Min.X, r.Max.X)
	}
	if a.Cols() < 80 {
		t.Errorf("only %d columns detected, want ~100 — the scan is truncating the label", a.Cols())
	}
}

func TestDetectLabelAreaRecoversTheEdgeBow(t *testing.T) {
	// The reason a rectangle is the wrong shape. If the bow is lost, the
	// composite cannot cover the original label's corners and leaves a strip.
	a, err := DetectLabelArea(base(), testArc)
	if err != nil {
		t.Fatal(err)
	}
	n := a.Cols()
	gotTop := a.Top[n/2] - a.Top[2]
	gotBot := a.Bot[n/2] - a.Bot[2]
	if gotTop < 4 || gotTop > 14 {
		t.Errorf("top bow %d, want ~8 — the edges must rise towards the sides", gotTop)
	}
	if gotBot < 7 || gotBot > 18 {
		t.Errorf("bottom bow %d, want ~12", gotBot)
	}
	// Both edges must be highest at the sides and lowest at the centre; a bow
	// with the wrong sign would read as a barrel rather than a cylinder.
	if a.Top[n/2] <= a.Top[2] || a.Bot[n/2] <= a.Bot[2] {
		t.Error("edges do not bow the right way")
	}
}

func TestDetectLabelAreaRejectsUnusableBases(t *testing.T) {
	flat := image.NewRGBA(image.Rect(0, 0, 200, 500))
	for i := range flat.Pix {
		flat.Pix[i] = 255
	}
	if _, err := DetectLabelArea(flat, testArc); err == nil {
		t.Error("a base with no bottle must be rejected, not guessed at")
	}
	if _, err := DetectLabelArea(image.NewRGBA(image.Rect(0, 0, 0, 0)), testArc); err == nil {
		t.Error("an empty image must be rejected")
	}
}

func TestNewAreaIsSmoothAndSymmetric(t *testing.T) {
	a := NewArea(0, 101, 300, 400, 10, 20, testArc)
	n := a.Cols()
	if a.Top[n/2] != 300 || a.Bot[n/2] != 400 {
		t.Errorf("centre edges %d/%d, want 300/400", a.Top[n/2], a.Bot[n/2])
	}
	// Ends reach the full bow, and the shape is symmetric about the centre.
	if a.Top[0] != 290 || a.Top[n-1] != 290 {
		t.Errorf("end top edges %d/%d, want 290 both", a.Top[0], a.Top[n-1])
	}
	if a.Bot[0] != 380 || a.Bot[n-1] != 380 {
		t.Errorf("end bottom edges %d/%d, want 380 both", a.Bot[0], a.Bot[n-1])
	}
	// Monotonic from each end to the centre — no kinks.
	for i := 1; i <= n/2; i++ {
		if a.Top[i] < a.Top[i-1] {
			t.Fatalf("top edge is not monotonic approaching the centre at %d", i)
		}
	}
}

func TestMeasureLightingTracksPaperNotInk(t *testing.T) {
	// A column crossing a line of the label's own text must not read as darker
	// lighting, or the old label's wording is stamped into every new one as
	// horizontal banding.
	img := base()
	a, err := DetectLabelArea(img, testArc)
	if err != nil {
		t.Fatal(err)
	}
	clean := MeasureLighting(img, a)

	// Paint a band of dark "text" across the middle of the label.
	for y := 350; y < 375; y++ {
		for x := 60; x < 140; x++ {
			img.SetRGBA(x, y, color.RGBA{20, 20, 20, 255})
		}
	}
	inked := MeasureLighting(img, a)

	if !clean.Ok() || !inked.Ok() {
		t.Fatal("lighting should be measurable from this base")
	}
	i := (60 + 140) / 2 // a column that runs straight through the text
	if d := math.Abs(inked.at(i) - clean.at(i)); d > 0.05 {
		t.Errorf("ink moved the measured lighting by %.3f — a percentile should step over it", d)
	}
}

func solid(w, h int, c color.RGBA) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	return img
}

func TestCompositeCoversTheOriginalLabel(t *testing.T) {
	// The defect this whole footprint model exists to fix: with a rectangle,
	// the original label survived in the bowed corners as a visible strip.
	img := base()
	a, err := DetectLabelArea(img, testArc)
	if err != nil {
		t.Fatal(err)
	}
	// A vivid label, so any surviving original paper is unmistakable.
	out, err := Composite(img, solid(100, 60, color.RGBA{200, 30, 30, 255}), a, MeasureLighting(img, a), Defaults())
	if err != nil {
		t.Fatal(err)
	}
	paper := color.RGBA{238, 234, 224, 255}
	for x := a.X0; x < a.X0+a.Cols(); x++ {
		for y := 280; y < 440; y++ {
			if out.RGBAAt(x, y) == paper {
				t.Fatalf("original label still visible at (%d,%d)", x, y)
			}
		}
	}
}

func TestCompositeLeavesTheBottleAlone(t *testing.T) {
	img := base()
	a, _ := DetectLabelArea(img, testArc)
	out, err := Composite(img, solid(100, 60, color.RGBA{200, 30, 30, 255}), a, MeasureLighting(img, a), Defaults())
	if err != nil {
		t.Fatal(err)
	}
	if out.Bounds() != img.Bounds() {
		t.Fatalf("bounds %v, want %v", out.Bounds(), img.Bounds())
	}
	for _, p := range []image.Point{{100, 50}, {10, 10}, {100, 480}, {190, 300}} {
		if out.At(p.X, p.Y) != img.At(p.X, p.Y) {
			t.Errorf("pixel %v outside the label changed", p)
		}
	}
}

func TestCompositeMatchesTheBaseExposure(t *testing.T) {
	// A scan's paper is often pure 255 while the photographed label sits near
	// 200. Dropped in unscaled it clips to flat white and reads as a sticker.
	img := base()
	a, _ := DetectLabelArea(img, testArc)
	light := MeasureLighting(img, a)
	out, err := Composite(img, solid(100, 60, color.RGBA{255, 255, 255, 255}), a, light, Defaults())
	if err != nil {
		t.Fatal(err)
	}
	n := a.Cols()
	mid := a.X0 + n/2
	got := luma(out.At(mid, (a.Top[n/2]+a.Bot[n/2])/2))
	if got > 0.97 {
		t.Errorf("composited paper at %.3f — a pure-white scan was not brought down to the base's exposure", got)
	}
	if math.Abs(got-light.Paper) > 0.08 {
		t.Errorf("composited paper %.3f vs base paper %.3f — exposures should match", got, light.Paper)
	}
}

func TestCompositeIsDeterministic(t *testing.T) {
	img := base()
	a, _ := DetectLabelArea(img, testArc)
	light := MeasureLighting(img, a)
	label := solid(100, 60, color.RGBA{200, 40, 40, 255})
	x, err := Composite(img, label, a, light, Defaults())
	if err != nil {
		t.Fatal(err)
	}
	y, _ := Composite(img, label, a, light, Defaults())
	for i := range x.Pix {
		if x.Pix[i] != y.Pix[i] {
			t.Fatalf("composite differs between runs at byte %d", i)
		}
	}
}

func TestCompositeCompressesTowardsTheEdges(t *testing.T) {
	// The cylindrical projection: equal steps across the screen must NOT be
	// equal steps across the label. Without it, type does not crowd towards the
	// edges the way it does on a real bottle.
	img := base()
	a, _ := DetectLabelArea(img, testArc)

	// A label split red|blue exactly at its horizontal midpoint. Under a linear
	// mapping the seam lands at the label's centre either way, so instead check
	// a quarter-point marker: a thin stripe at u=0.25.
	label := solid(400, 60, color.RGBA{255, 255, 255, 255})
	for y := 0; y < 60; y++ {
		for x := 99; x < 103; x++ {
			label.SetRGBA(x, y, color.RGBA{0, 0, 0, 255})
		}
	}
	out, err := Composite(img, label, a, Lighting{}, Defaults())
	if err != nil {
		t.Fatal(err)
	}

	n := a.Cols()
	row := (a.Top[n/2] + a.Bot[n/2]) / 2
	darkest, at := 1.0, 0
	for i := 0; i < n; i++ {
		if l := luma(out.At(a.X0+i, row)); l < darkest {
			darkest, at = l, i
		}
	}
	frac := float64(at) / float64(n)
	// A linear map would put a u=0.25 stripe at 0.25 of the screen width; the
	// cylinder pushes it outward, towards the compressed edge.
	if frac >= 0.25 {
		t.Errorf("stripe at %.3f of the width — expected < 0.25 under cylindrical projection", frac)
	}
	if frac < 0.10 {
		t.Errorf("stripe at %.3f — compressed far harder than a 2.3 rad wrap should", frac)
	}
}

func TestCompositeRejectsEmptyInputs(t *testing.T) {
	img := base()
	a, _ := DetectLabelArea(img, testArc)
	if _, err := Composite(img, image.NewRGBA(image.Rectangle{}), a, Lighting{}, Defaults()); err == nil {
		t.Error("an empty label must be rejected")
	}
	if _, err := Composite(img, solid(10, 10, color.RGBA{}), Area{}, Lighting{}, Defaults()); err == nil {
		t.Error("an empty area must be rejected")
	}
}

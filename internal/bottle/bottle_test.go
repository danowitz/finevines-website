package bottle

import (
	"image"
	"image/color"
	"testing"
)

// synthBottle draws the minimum a detector should cope with: a dark bottle
// body on a white sweep, with a bright label block in the lower half.
func synthBottle(w, h int, label image.Rectangle) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	white := color.RGBA{250, 250, 250, 255}
	glass := color.RGBA{28, 16, 20, 255}
	paper := color.RGBA{238, 234, 224, 255}
	bodyL, bodyR := w/4, w*3/4
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			switch {
			case image.Pt(x, y).In(label):
				img.SetRGBA(x, y, paper)
			case x >= bodyL && x < bodyR:
				img.SetRGBA(x, y, glass)
			default:
				img.SetRGBA(x, y, white)
			}
		}
	}
	return img
}

func TestDetectLabelAreaFindsTheBlock(t *testing.T) {
	want := image.Rect(30, 140, 70, 190)
	got, err := DetectLabelArea(synthBottle(100, 240, want))
	if err != nil {
		t.Fatal(err)
	}
	// Row/column thresholding lands within a pixel or two; demanding exactness
	// would test the threshold rather than the behaviour.
	near := func(a, b int) bool { d := a - b; return d < 3 && d > -3 }
	if !near(got.Min.X, want.Min.X) || !near(got.Max.X, want.Max.X) ||
		!near(got.Min.Y, want.Min.Y) || !near(got.Max.Y, want.Max.Y) {
		t.Errorf("detected %v, want ~%v", got, want)
	}
}

func TestDetectLabelAreaRejectsUnusableBases(t *testing.T) {
	// A bottle with no bright block — cropped so the label is out of frame.
	if _, err := DetectLabelArea(synthBottle(100, 240, image.Rectangle{})); err == nil {
		t.Error("a base with no label block must be rejected, not guessed at")
	}
	if _, err := DetectLabelArea(image.NewRGBA(image.Rect(0, 0, 0, 0))); err == nil {
		t.Error("an empty image must be rejected")
	}
}

func TestDetectHighlightIgnoresTheGlassRim(t *testing.T) {
	// A bottle photographed on white has a bright refractive rim at each edge
	// of the glass. The highlight we want to reproduce is the broad specular
	// inside it — taking the rim would light every label from the frame edge.
	area := image.Rect(30, 140, 70, 190)
	img := synthBottle(100, 240, area)
	for y := 100; y < 140; y++ {
		img.SetRGBA(30, y, color.RGBA{255, 255, 255, 255}) // left rim
		img.SetRGBA(69, y, color.RGBA{255, 255, 255, 255}) // right rim
		for x := 40; x < 44; x++ {
			img.SetRGBA(x, y, color.RGBA{190, 190, 190, 255}) // the real specular
		}
	}
	got := DetectHighlight(img, area)
	if got < 0.2 || got > 0.45 {
		t.Errorf("highlight at %.2f, want the specular near 0.25-0.35 rather than a rim at 0 or 1", got)
	}
}

// solid returns a label of one colour, so warping is measurable without text.
func solid(w, h int, c color.RGBA) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	return img
}

func TestCompositeLeavesTheBottleAlone(t *testing.T) {
	area := image.Rect(30, 140, 70, 190)
	base := synthBottle(100, 240, area)
	out, err := Composite(base, solid(40, 20, color.RGBA{200, 40, 40, 255}), area, Defaults())
	if err != nil {
		t.Fatal(err)
	}
	if out.Bounds() != base.Bounds() {
		t.Fatalf("bounds %v, want %v", out.Bounds(), base.Bounds())
	}
	// Everything outside the label area must survive untouched — the capsule,
	// the glass, the shadow under the punt.
	for _, p := range []image.Point{{50, 40}, {10, 10}, {50, 220}, {90, 200}} {
		if out.At(p.X, p.Y) != base.At(p.X, p.Y) {
			t.Errorf("pixel %v outside the label area changed", p)
		}
	}
	if out.At(50, 165) == base.At(50, 165) {
		t.Error("the label area was not drawn into")
	}
}

func TestCompositeIsDeterministic(t *testing.T) {
	area := image.Rect(30, 140, 70, 190)
	base := synthBottle(100, 240, area)
	label := solid(40, 20, color.RGBA{200, 40, 40, 255})
	a, err := Composite(base, label, area, Defaults())
	if err != nil {
		t.Fatal(err)
	}
	b, _ := Composite(base, label, area, Defaults())
	for i := range a.Pix {
		if a.Pix[i] != b.Pix[i] {
			t.Fatalf("composite differs between runs at byte %d", i)
		}
	}
}

func TestCompositeShadesTowardsTheEdges(t *testing.T) {
	// The point of the cylindrical model: a flat-coloured label must come out
	// darker where the glass curves away than it is face-on. Without this the
	// label reads as a sticker floating over the bottle.
	area := image.Rect(20, 140, 80, 190)
	base := synthBottle(100, 240, area)
	o := Defaults()
	o.SpecularGain = 0 // isolate the diffuse falloff from the highlight
	out, err := Composite(base, solid(60, 50, color.RGBA{220, 220, 220, 255}), area, o)
	if err != nil {
		t.Fatal(err)
	}
	centre := luma(out.At(50, 165))
	edge := luma(out.At(area.Min.X+1, 165))
	if edge >= centre {
		t.Errorf("edge luma %.3f is not darker than centre %.3f — the wrap is not shading", edge, centre)
	}
	if edge < 0.3*centre {
		t.Errorf("edge luma %.3f crushed against centre %.3f — ambient is too low, the curve reads as a dent", edge, centre)
	}
}

func TestCompositePreservesLabelAspect(t *testing.T) {
	// The catalog's scans average 2:1 landscape and land in a near-square area.
	// Filling it stretches type vertically; by default the label keeps its
	// proportions and the leftover rows extend its edges (blank paper).
	area := image.Rect(20, 100, 80, 200) // 60x100, tall
	base := synthBottle(100, 240, area)

	// A label that is red on top, blue at the bottom, so vertical placement is
	// readable straight off the output.
	label := image.NewRGBA(image.Rect(0, 0, 60, 20))
	for y := 0; y < 20; y++ {
		c := color.RGBA{220, 30, 30, 255}
		if y >= 10 {
			c = color.RGBA{30, 30, 220, 255}
		}
		for x := 0; x < 60; x++ {
			label.SetRGBA(x, y, c)
		}
	}

	out, err := Composite(base, label, area, Defaults())
	if err != nil {
		t.Fatal(err)
	}
	redder := func(x, y int) bool {
		r, _, b, _ := out.At(x, y).RGBA()
		return r > b
	}
	// Fitted at true aspect and centred, the colour flip sits near the middle
	// of the area — not at its midpoint-by-stretch, and the far top and bottom
	// are edge-clamped paper (red above, blue below).
	if !redder(50, area.Min.Y+2) {
		t.Error("top of the area should be the label's clamped top edge")
	}
	if redder(50, area.Max.Y-3) {
		t.Error("bottom of the area should be the label's clamped bottom edge")
	}

	// Stretching, by contrast, must place the flip at the exact midpoint.
	o := Defaults()
	o.StretchToFill = true
	s, err := Composite(base, label, area, o)
	if err != nil {
		t.Fatal(err)
	}
	mid := (area.Min.Y + area.Max.Y) / 2
	rs, _, bs, _ := s.At(50, mid-3).RGBA()
	if rs <= bs {
		t.Error("stretched label should still be in its red half just above the midpoint")
	}
}

func TestCompositeRejectsEmptyInputs(t *testing.T) {
	area := image.Rect(30, 140, 70, 190)
	base := synthBottle(100, 240, area)
	if _, err := Composite(base, image.NewRGBA(image.Rectangle{}), area, Defaults()); err == nil {
		t.Error("an empty label must be rejected")
	}
	if _, err := Composite(base, solid(10, 10, color.RGBA{}), image.Rect(500, 500, 600, 600), Defaults()); err == nil {
		t.Error("a label area outside the base must be rejected")
	}
}

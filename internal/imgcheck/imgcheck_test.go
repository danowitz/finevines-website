package imgcheck

import (
	"image"
	"image/color"
	"image/draw"
	"strings"
	"testing"
)

func TestAnalyzeRejectsSparseLabelArtwork(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 200, 200))
	draw.Draw(img, img.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	ink := &image.Uniform{C: color.Black}
	// A sparse rectangular design can have a bottle-like bounding-box ratio,
	// but it is still flat artwork rather than a photographed bottle.
	draw.Draw(img, image.Rect(60, 25, 140, 29), ink, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(60, 171, 140, 175), ink, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(60, 25, 64, 175), ink, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(136, 25, 140, 175), ink, image.Point{}, draw.Src)

	report := Analyze(img, Defaults())
	if report.SingleBottle {
		t.Fatalf("sparse artwork accepted as a bottle: fill=%.3f slimness=%.3f", report.Fill, report.Slimness)
	}
	if !strings.Contains(report.Reason, "label artwork") {
		t.Fatalf("unexpected rejection reason %q", report.Reason)
	}
}

func TestAnalyzeRejectsOverlappingBottlesWithTwoNecks(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 200, 220))
	draw.Draw(img, img.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	glass := &image.Uniform{C: color.RGBA{25, 25, 25, 255}}
	// The bodies overlap and therefore form one full-frame column run. Their
	// separated necks are the evidence that this is still a two-bottle shot.
	draw.Draw(img, image.Rect(45, 65, 108, 205), glass, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(82, 65, 145, 205), glass, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(61, 15, 79, 80), glass, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(111, 15, 129, 80), glass, image.Point{}, draw.Src)

	report := Analyze(img, Defaults())
	if report.SingleBottle {
		t.Fatal("two overlapping bottles accepted as one")
	}
	if report.NeckSubjects != 2 {
		t.Fatalf("neck subjects = %d, want 2", report.NeckSubjects)
	}
}

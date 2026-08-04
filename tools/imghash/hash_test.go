package main

import (
	"image"
	"image/color"
	"testing"
)

// gradient draws a deterministic test image: a dark "bottle" silhouette with a
// bright "label" band, offset controls the label's vertical position so two
// images can be made genuinely different.
func gradient(w, h, labelY int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			// white ground
			c := color.RGBA{245, 245, 245, 255}
			// bottle silhouette: middle third, full height
			if x > w/3 && x < 2*w/3 {
				c = color.RGBA{40, 20, 25, 255}
				// label band
				if y > labelY && y < labelY+h/5 {
					c = color.RGBA{230, 220, 200, 255}
				}
			}
			img.Set(x, y, c)
		}
	}
	return img
}

func TestIdenticalImagesDistanceZero(t *testing.T) {
	a := gradient(300, 900, 500)
	if d := distance(dhash(a), dhash(a)); d != 0 {
		t.Fatalf("identical images: distance = %d, want 0", d)
	}
}

func TestScaledCopyIsNear(t *testing.T) {
	a := gradient(300, 900, 500)
	b := gradient(600, 1800, 1000) // same composition at 2x
	if d := distance(dhash(a), dhash(b)); d > 6 {
		t.Fatalf("2x scaled copy: distance = %d, want <= 6", d)
	}
}

func TestDifferentCompositionIsFar(t *testing.T) {
	a := gradient(300, 900, 150) // label near the shoulder
	b := gradient(300, 900, 650) // label near the base
	if d := distance(dhash(a), dhash(b)); d < 12 {
		t.Fatalf("different label positions: distance = %d, want >= 12", d)
	}
}

func TestSubjectCropIgnoresMargin(t *testing.T) {
	// The same bottle with a much larger white margin must still read as the
	// same image once the subject is cropped: retailer shots differ mostly in
	// padding, and padding must not defeat the comparison.
	tight := gradient(300, 900, 500)
	padded := image.NewRGBA(image.Rect(0, 0, 700, 1300))
	for y := 0; y < 1300; y++ {
		for x := 0; x < 700; x++ {
			padded.Set(x, y, color.RGBA{245, 245, 245, 255})
		}
	}
	src := gradient(300, 900, 500)
	for y := 0; y < 900; y++ {
		for x := 0; x < 300; x++ {
			padded.Set(x+200, y+200, src.At(x, y))
		}
	}
	da := dhash(subjectCrop(tight))
	db := dhash(subjectCrop(padded))
	if d := distance(da, db); d > 8 {
		t.Fatalf("padded copy after subjectCrop: distance = %d, want <= 8", d)
	}
}

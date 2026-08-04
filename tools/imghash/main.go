// Command imghash reports pairwise perceptual-hash distances between images,
// so the fetch pipeline can notice when two candidates from DIFFERENT sources
// show the same bottle. Two independently-published photos that agree are
// strong evidence the search converged on the right product — two wrong
// candidates rarely agree with each other.
//
//	go run ./tools/imghash a.png b.jpg c.png
//	-> {"files":[...],"pairs":[{"a":0,"b":1,"distance":4}, ...]}
//
// The hash is a 64-bit dHash over the subject crop (content bounding box with
// the uniform ground trimmed), so retailer padding and canvas size differences
// don't defeat the comparison. Distances: 0-6 near-certain same image or a
// resize of it; <=10 very likely the same bottle artwork; >=15 different.
package main

import (
	"encoding/json"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"math/bits"
	"os"
)

// luma returns perceived brightness 0-255.
func luma(c uint32, g uint32, b uint32) float64 {
	return 0.299*float64(c>>8) + 0.587*float64(g>>8) + 0.114*float64(b>>8)
}

// subjectCrop trims the uniform ground around the subject: the background
// color is sampled from the corners, and rows/columns that are entirely
// within a tolerance of it are cut. Retail product shots differ mostly in
// padding; the subject is what has to agree.
func subjectCrop(img image.Image) image.Image {
	b := img.Bounds()
	cr, cg, cb, _ := img.At(b.Min.X, b.Min.Y).RGBA()
	bg := luma(cr, cg, cb)
	const tol = 24.0

	isBg := func(x, y int) bool {
		r, g, bl, _ := img.At(x, y).RGBA()
		d := luma(r, g, bl) - bg
		return d > -tol && d < tol
	}
	rowBg := func(y int) bool {
		for x := b.Min.X; x < b.Max.X; x += 3 {
			if !isBg(x, y) {
				return false
			}
		}
		return true
	}
	colBg := func(x int) bool {
		for y := b.Min.Y; y < b.Max.Y; y += 3 {
			if !isBg(x, y) {
				return false
			}
		}
		return true
	}

	top, bot, left, right := b.Min.Y, b.Max.Y, b.Min.X, b.Max.X
	for top < bot-1 && rowBg(top) {
		top++
	}
	for bot > top+1 && rowBg(bot-1) {
		bot--
	}
	for left < right-1 && colBg(left) {
		left++
	}
	for right > left+1 && colBg(right-1) {
		right--
	}
	if right-left < 8 || bot-top < 8 {
		return img // degenerate crop — hash the whole frame instead
	}
	return cropped{img, image.Rect(left, top, right, bot)}
}

type cropped struct {
	image.Image
	r image.Rectangle
}

func (c cropped) Bounds() image.Rectangle { return c.r }

// dhash is a two-axis difference hash: box-sample to a 9x9 grayscale grid,
// then one bit per horizontal neighbor comparison (64 bits) and one per
// vertical comparison (64 bits). Horizontal-only dHash proved blind to
// vertical composition — two bottles with the label band at different
// heights hashed identically, because a bright band and a dark band produce
// the same horizontal gradient SIGNS (caught by TestDifferentCompositionIsFar).
type hash128 [2]uint64

func dhash(img image.Image) hash128 {
	const G = 9
	b := img.Bounds()
	var cell [G][G]float64
	cw := float64(b.Dx()) / G
	ch := float64(b.Dy()) / G
	for gy := 0; gy < G; gy++ {
		for gx := 0; gx < G; gx++ {
			x0 := b.Min.X + int(float64(gx)*cw)
			x1 := b.Min.X + int(float64(gx+1)*cw)
			y0 := b.Min.Y + int(float64(gy)*ch)
			y1 := b.Min.Y + int(float64(gy+1)*ch)
			var sum float64
			var n int
			for y := y0; y < y1; y += 2 {
				for x := x0; x < x1; x += 2 {
					r, g, bl, _ := img.At(x, y).RGBA()
					sum += luma(r, g, bl)
					n++
				}
			}
			if n > 0 {
				cell[gy][gx] = sum / float64(n)
			}
		}
	}
	var h hash128
	for gy := 0; gy < G-1; gy++ { // 8 rows x 8 comparisons per axis
		for gx := 0; gx < G-1; gx++ {
			h[0] <<= 1
			if cell[gy][gx] < cell[gy][gx+1] {
				h[0] |= 1
			}
			h[1] <<= 1
			if cell[gy][gx] < cell[gy+1][gx] {
				h[1] |= 1
			}
		}
	}
	return h
}

func distance(a, b hash128) int {
	return bits.OnesCount64(a[0]^b[0]) + bits.OnesCount64(a[1]^b[1])
}

type pair struct {
	A        int `json:"a"`
	B        int `json:"b"`
	Distance int `json:"distance"`
}

func main() {
	files := os.Args[1:]
	if len(files) < 2 {
		fmt.Fprintln(os.Stderr, "usage: imghash <img> <img> [more...]")
		os.Exit(2)
	}
	hashes := make([]hash128, len(files))
	ok := make([]bool, len(files))
	for i, f := range files {
		fh, err := os.Open(f)
		if err != nil {
			continue
		}
		img, _, err := image.Decode(fh)
		fh.Close()
		if err != nil {
			continue
		}
		hashes[i] = dhash(subjectCrop(img))
		ok[i] = true
	}
	var pairs []pair
	for i := 0; i < len(files); i++ {
		for j := i + 1; j < len(files); j++ {
			if ok[i] && ok[j] {
				pairs = append(pairs, pair{i, j, distance(hashes[i], hashes[j])})
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"files": files, "pairs": pairs})
}

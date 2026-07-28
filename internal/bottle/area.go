package bottle

import (
	"image"
	"math"
)

// Area is where a label sits on a bottle photograph, stored as the label's top
// and bottom edge for EVERY column rather than as a rectangle.
//
// A rectangle is the wrong shape, and measurably so. On a real studio shot the
// existing label's edges run:
//
//	x=1030  top=2724  bot=3775   (side)
//	x=1430  top=2740  bot=3802   (centre, ~20px lower)
//	x=1830  top=2720  bot=3773   (side)
//
// The edges are elliptical arcs, because the camera does not sit exactly level
// with the label's centre: a horizontal line drawn around a cylinder projects
// to an ellipse, bowing by (1 - cos θ) towards the sides. Two consequences,
// both of which showed up in the output:
//
//  1. A rectangle inscribed in that shape cannot cover it. The old label's
//     top edge survived as a pale strip across every composite — no threshold
//     tuning fixes it, because the leftover is a geometric shortfall.
//  2. A label with dead-straight top and bottom edges reads as a sticker laid
//     over the bottle. The bow is a small cue — ~2% of the label's height —
//     but it is one the eye uses to decide whether something is round.
//
// The arcs are measured off the photograph rather than derived from an assumed
// camera position, so a base shot from a different height needs nothing retuned.
type Area struct {
	// X0 is the column Top[0]/Bot[0] describe.
	X0 int
	// Top and Bot are the label's first and last row in each column, inclusive.
	// Both have one entry per column and are the same length.
	Top, Bot []int
}

// Cols is how many columns the label spans.
func (a Area) Cols() int { return len(a.Top) }

// Empty reports whether the area covers nothing usable.
func (a Area) Empty() bool { return len(a.Top) == 0 || len(a.Top) != len(a.Bot) }

// Bounds is the enclosing rectangle, for callers that need a simple extent
// (reporting, cropping, intersection tests).
func (a Area) Bounds() image.Rectangle {
	if a.Empty() {
		return image.Rectangle{}
	}
	minY, maxY := a.Top[0], a.Bot[0]
	for i := range a.Top {
		if a.Top[i] < minY {
			minY = a.Top[i]
		}
		if a.Bot[i] > maxY {
			maxY = a.Bot[i]
		}
	}
	return image.Rect(a.X0, minY, a.X0+len(a.Top), maxY+1)
}

// colAt clamps x to the measured range and returns that column's edges.
func (a Area) colAt(x int) (top, bot int) {
	i := x - a.X0
	if i < 0 {
		i = 0
	}
	if i >= len(a.Top) {
		i = len(a.Top) - 1
	}
	return a.Top[i], a.Bot[i]
}

// centreHeight is the label's height at its middle column, used as the
// reference when fitting an incoming label at its true aspect. Measuring at the
// centre rather than averaging keeps the fit stable: the outermost columns are
// foreshortened hardest and would drag an average down.
func (a Area) centreHeight() int {
	if a.Empty() {
		return 0
	}
	i := len(a.Top) / 2
	return a.Bot[i] - a.Top[i] + 1
}

// smoothInts runs a moving average of half-width win over vs. The per-column
// edge scan is noisy wherever a descender or a speck of dust touches the
// label's border; the underlying arc is smooth, so smoothing recovers it
// without needing to fit an explicit ellipse.
func smoothInts(vs []int, win int) []int {
	if win < 1 || len(vs) == 0 {
		return vs
	}
	out := make([]int, len(vs))
	for i := range vs {
		lo, hi := i-win, i+win
		if lo < 0 {
			lo = 0
		}
		if hi >= len(vs) {
			hi = len(vs) - 1
		}
		sum := 0
		for j := lo; j <= hi; j++ {
			sum += vs[j]
		}
		out[i] = sum / (hi - lo + 1)
	}
	return out
}

// NewArea builds a label footprint from the six numbers that actually define
// it: the column range, the top and bottom edge at the label's CENTRE, and how
// far each edge rises towards the sides.
//
// This is the analytic form of what a per-column scan approximates. A
// horizontal line around a cylinder projects to an ellipse, so the edge at
// angle θ is offset from its centre value by (1-cos θ), normalised so the
// offset reaches exactly `bow` at the label's outermost column.
//
// Fitting the model beats trusting the scan. Measured column by column, the
// edges are contaminated by the label's own ink, by the punt catching light
// below, and by glass reflections at the silhouette — each of which produced a
// different wrong answer as thresholds were tuned against it. Six parameters
// estimated from robust medians cannot buckle that way, and the arcs they
// produce are smooth by construction.
func NewArea(x0, x1, topCentre, botCentre, bowTop, bowBot int, arc float64) Area {
	n := x1 - x0
	if n <= 0 {
		return Area{}
	}
	half := math.Sin(arc / 2)
	// Normalising constant: (1-cos θ) at the label's outermost column.
	edge := 1 - math.Cos(arc/2)
	if edge <= 0 {
		edge = 1
	}
	top := make([]int, n)
	bot := make([]int, n)
	// The footprint's edges span the label end to end, so position is taken
	// across the OUTER edges of the first and last column rather than their
	// centres. Sampling at centres leaves the extreme columns fractionally
	// short of the full bow — which is a pixel of the original label surviving
	// in exactly the corner this model exists to cover.
	den := float64(n - 1)
	if den <= 0 {
		den = 1
	}
	for i := 0; i < n; i++ {
		s := float64(i)/den - 0.5
		sinTheta := 2 * s * half
		if sinTheta < -1 {
			sinTheta = -1
		}
		if sinTheta > 1 {
			sinTheta = 1
		}
		k := (1 - math.Cos(math.Asin(sinTheta))) / edge
		top[i] = topCentre - int(math.Round(float64(bowTop)*k))
		bot[i] = botCentre - int(math.Round(float64(bowBot)*k))
	}
	return Area{X0: x0, Top: top, Bot: bot}
}

// medianInt returns the median of vs without disturbing the caller's slice.
// Median rather than mean throughout the fit: one column ruined by a
// reflection should move the estimate by nothing, not by its full error.
func medianInt(vs []int) int {
	if len(vs) == 0 {
		return 0
	}
	c := append([]int(nil), vs...)
	for i := 1; i < len(c); i++ {
		for j := i; j > 0 && c[j] < c[j-1]; j-- {
			c[j], c[j-1] = c[j-1], c[j]
		}
	}
	return c[len(c)/2]
}

// bowFactor is the fraction of the full edge bow reached at position `at`
// across the label (0 = left edge, 0.5 = centre, 1 = right edge).
//
// The bow follows (1-cos θ), so a sample taken a little inside the label's
// edge sees less than the whole offset. Dividing a measurement by this factor
// recovers the value at the edge itself, which is what NewArea expects.
func bowFactor(at, arc float64) float64 {
	half := math.Sin(arc / 2)
	edge := 1 - math.Cos(arc/2)
	if edge <= 0 {
		return 1
	}
	s := at - 0.5
	sinTheta := 2 * s * half
	if sinTheta < -1 {
		sinTheta = -1
	}
	if sinTheta > 1 {
		sinTheta = 1
	}
	return (1 - math.Cos(math.Asin(sinTheta))) / edge
}

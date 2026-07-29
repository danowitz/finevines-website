// Package catalog turns Salesforce rows into the wines a customer browses.
//
// The two are not the same thing, and treating them as the same is why the
// portfolio currently shows 2,665 cards for 1,971 wines. Domaine Jean-Marc
// Pavelot's Savigny-lès-Beaune 1er Cru appears eight times; JF Mugnier's
// Nuits-Saint-Georges seven times for two vintages. In 31 cases every row in a
// group is the SAME vintage — genuinely the identical bottle, listed over and
// over.
//
// That is not a data error. Each shipment clears at a different exchange rate
// and needs its own item code for cost accounting, and pre-tariff and
// post-tariff stock of the same wine must stay separate (confirmed by the
// client, 2026-07-28). Every SKU is real. They are just real to the
// ACCOUNTANT, and a buyer looking at seven identical Mugnier cards is reading
// a ledger rather than a wine list.
//
// So the catalog's unit is the wine — producer and cuvée — with vintage and
// bottle size as choices inside it, and the SKUs underneath where they belong.
package catalog

import (
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
)

// Size is a bottle format offered for a wine.
type Size struct {
	ML    int    // 750, 1500, 375...
	Label string // "750ml", "1.5L", "375ml"
}

// Vintage is one year of a wine, with the rows behind it.
type Vintage struct {
	Year  string // "" for NV
	Sizes []Size
	SKUs  []string
	Stock int
	// Wines are the underlying catalog rows. Kept so a page can show what is
	// actually orderable without re-deriving it, and so nothing about the
	// accounting reality is lost by grouping.
	Wines []model.Wine
}

// Group is one wine as a customer thinks of it.
type Group struct {
	Slug     string
	Producer string
	Name     string // the cuvée, without vintage or pack/size noise
	Region   string
	Country  string
	Varietal string
	Color    string

	Vintages []Vintage // newest first
	Sizes    []Size    // every size offered across all vintages
	Stock    int

	// Representative is the row whose descriptive enrichment and image the
	// group presents. Bottle artwork rarely changes between vintages, so one
	// image serves the wine — which also means it is judged once rather than
	// once per row.
	Representative model.Wine
}

// packSize matches the trade's "<bottles>/<size>" shorthand — 12/750, 6/375,
// 3/1.5L — which is a CASE FORMAT, not part of a wine's name.
var packSize = regexp.MustCompile(`(?i)\b(\d{1,2})\s*/\s*(\d+(?:\.\d+)?)\s*(l|liter|litre|ml)?\b`)

// bareSize matches a size on its own: .5L, 1.5L, 3L, 375ml, 750 ML.
var bareSize = regexp.MustCompile(`(?i)(^|\s)(\d*\.?\d+)\s*(ml|cl|l|liter|litre)\b`)

var yearRE = regexp.MustCompile(`\b(19|20)\d\d\b`)

// parseSize reads a size in millilitres from a number and an optional unit.
// Returns 0 when the pair is not a plausible bottle.
func parseSize(num string, unit string) int {
	v, err := strconv.ParseFloat(num, 64)
	if err != nil || v <= 0 {
		return 0
	}
	switch strings.ToLower(unit) {
	case "l", "liter", "litre":
		v *= 1000
	case "cl":
		v *= 10
	case "ml":
		// already
	default:
		// No unit. A bare number in the pack position is millilitres if it
		// looks like a bottle (375, 750, 1500) and litres if it is small
		// (3/1.5 means three 1.5-litre bottles).
		if v <= 20 {
			v *= 1000
		}
	}
	ml := int(v + 0.5)
	// Under a split and over a Nebuchadnezzar are not bottles; they are
	// mis-parses — most often a vintage range like 2018/2019.
	if ml < 180 || ml > 18000 {
		return 0
	}
	return ml
}

func sizeLabel(ml int) string {
	if ml >= 1000 && ml%1000 == 0 {
		return strconv.Itoa(ml/1000) + "L"
	}
	if ml >= 1000 {
		return strings.TrimSuffix(strconv.FormatFloat(float64(ml)/1000, 'f', 1, 64), ".0") + "L"
	}
	return strconv.Itoa(ml) + "ml"
}

// SizeOf returns the bottle size for a row: the explicit field when Salesforce
// has one, otherwise whatever the name encodes, otherwise a standard bottle.
//
// The field is populated on 25 rows of 2,665, so the name carries this in
// practice — and the name is written for the trade, not for parsing.
func SizeOf(w model.Wine) Size {
	if f := strings.TrimSpace(w.BottleSize); f != "" {
		if m := bareSize.FindStringSubmatch(" " + f); m != nil {
			if ml := parseSize(m[2], m[3]); ml > 0 {
				return Size{ML: ml, Label: sizeLabel(ml)}
			}
		}
	}
	name := w.Name
	// A vintage range must never be read as a pack: "2018/2019" is two years.
	name = yearRE.ReplaceAllStringFunc(name, func(s string) string { return "yyyy" })
	if m := packSize.FindStringSubmatch(name); m != nil {
		if ml := parseSize(m[2], m[3]); ml > 0 {
			return Size{ML: ml, Label: sizeLabel(ml)}
		}
	}
	if m := bareSize.FindStringSubmatch(name); m != nil {
		if ml := parseSize(m[2], m[3]); ml > 0 {
			return Size{ML: ml, Label: sizeLabel(ml)}
		}
	}
	return Size{ML: 750, Label: "750ml"}
}

// PackOf returns the bottles-per-case a row's name encodes (12/750, 6/1.5L),
// or the trade-standard 12 when the name doesn't say. Same masking rule as
// SizeOf: a vintage range like 2018/2019 must never be read as a pack.
func PackOf(w model.Wine) int {
	name := yearRE.ReplaceAllStringFunc(w.Name, func(string) string { return "yyyy" })
	if m := packSize.FindStringSubmatch(name); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil && n > 0 {
			return n
		}
	}
	return 12
}

// CuveeName strips everything that identifies a SHIPMENT rather than a wine:
// the vintage, the case format, the trade's asterisks and hold markers.
func CuveeName(w model.Wine) string {
	n := w.Name
	n = yearRE.ReplaceAllString(n, " ")
	n = packSize.ReplaceAllString(n, " ")
	n = bareSize.ReplaceAllString(n, " ")
	n = regexp.MustCompile(`(?i)\s*-\s*(gm\s+hold|hold|do not sell|dns)\b.*$`).ReplaceAllString(n, "")
	n = strings.ReplaceAll(n, "*", " ")
	return strings.Join(strings.Fields(n), " ")
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

// key is what decides two rows are the same wine.
func key(w model.Wine) string {
	p := strings.ToLower(strings.TrimSpace(w.Producer))
	c := strings.ToLower(CuveeName(w))
	// When the producer field is empty it leads the name anyway, so the cuvée
	// alone still separates estates.
	return strings.Trim(nonAlnum.ReplaceAllString(p+" "+c, "-"), "-")
}

// Build groups rows into wines, newest vintage first.
func Build(wines []model.Wine) []Group {
	byKey := map[string][]model.Wine{}
	var order []string
	for _, w := range wines {
		if strings.TrimSpace(w.Slug) == "" || strings.TrimSpace(w.Name) == "" {
			continue
		}
		k := key(w)
		if k == "" {
			continue
		}
		if _, seen := byKey[k]; !seen {
			order = append(order, k)
		}
		byKey[k] = append(byKey[k], w)
	}

	out := make([]Group, 0, len(byKey))
	for _, k := range order {
		rows := byKey[k]
		g := Group{Slug: k, Name: CuveeName(rows[0]), Producer: rows[0].Producer}

		byYear := map[string][]model.Wine{}
		var years []string
		for _, w := range rows {
			y := strings.TrimSpace(w.Vintage)
			if _, seen := byYear[y]; !seen {
				years = append(years, y)
			}
			byYear[y] = append(byYear[y], w)
		}
		// Newest first; NV and blank sort last, since a buyer scanning a wine
		// wants the current release at the top.
		sort.Slice(years, func(i, j int) bool {
			a, b := years[i], years[j]
			if (a == "") != (b == "") {
				return b == ""
			}
			return a > b
		})

		sizeSeen := map[int]bool{}
		for _, y := range years {
			v := Vintage{Year: y, Wines: byYear[y]}
			vSize := map[int]bool{}
			for _, w := range byYear[y] {
				v.Stock += w.StockQty
				if w.SKU != "" {
					v.SKUs = append(v.SKUs, w.SKU)
				}
				s := SizeOf(w)
				if !vSize[s.ML] {
					vSize[s.ML] = true
					v.Sizes = append(v.Sizes, s)
				}
				if !sizeSeen[s.ML] {
					sizeSeen[s.ML] = true
					g.Sizes = append(g.Sizes, s)
				}
			}
			sort.Slice(v.Sizes, func(i, j int) bool { return v.Sizes[i].ML < v.Sizes[j].ML })
			sort.Strings(v.SKUs)
			g.Stock += v.Stock
			g.Vintages = append(g.Vintages, v)
		}
		sort.Slice(g.Sizes, func(i, j int) bool { return g.Sizes[i].ML < g.Sizes[j].ML })

		// The representative is the newest vintage's best-enriched row: it
		// supplies the image and the tasting copy, so the richest one wins
		// rather than whichever happened to sort first.
		best := g.Vintages[0].Wines[0]
		for _, v := range g.Vintages {
			for _, w := range v.Wines {
				if w.MetadataScore > best.MetadataScore {
					best = w
				}
			}
		}
		g.Representative = best
		g.Region, g.Country, g.Varietal, g.Color = best.Region, best.Country, best.Varietal, best.Color
		if g.Producer == "" {
			g.Producer = best.Producer
		}
		out = append(out, g)
	}
	return out
}

package main

import (
	"fmt"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
)

// bucket classifies a wine into the coarse category the dry run samples
// across: red / white / sparkling / rose / spirits / other. It is a keyword
// scan over varietal+name+color+style — deliberately rough (the catalog's
// color/style coverage is thin: ~93% of placeholder wines have neither), but
// good enough to spread a 12-wine sample across the styles that render
// differently (dark glass, pale glass, foil-capped sparkling, spirit bottles).
// Order matters: sparkling and spirits keywords outrank the base color words
// so "Brut Champagne (Chardonnay)" lands in sparkling, not white.
func bucket(w model.Wine) string {
	s := strings.ToLower(w.Varietal + " " + w.Name + " " + w.Color + " " + w.Style)
	switch {
	case containsAny(s, "sparkling", "champagne", "prosecco", "cava", "brut", "cremant", "crémant", "lambrusco", "franciacorta", "pét-nat", "pet-nat", "spumante", "sekt"):
		return "sparkling"
	case containsAny(s, "vodka", "gin", "whisky", "whiskey", "bourbon", "rum", "tequila", "mezcal", "liqueur", "amaro", "brandy", "cognac", "armagnac", "grappa", "vermouth", "sake", "soju", "scotch", "aperitivo", "absinthe", "eau-de-vie"):
		return "spirits"
	case containsAny(s, "rosé", "rosado", "rosato", "rose "):
		return "rose"
	case containsAny(s, "chardonnay", "sauvignon blanc", "riesling", "pinot gris", "pinot grigio", "albariño", "albarino", "grüner", "gruner", "chenin", "viognier", "gewürz", "gewurz", "muscadet", "vermentino", "verdejo", "godello", "txakoli", "moscato", "sémillon", "semillon", "white", "blanc", "bianco", "branco"):
		return "white"
	case containsAny(s, "cabernet", "pinot noir", "merlot", "syrah", "shiraz", "grenache", "garnacha", "tempranillo", "sangiovese", "nebbiolo", "barbera", "zinfandel", "malbec", "mourvèdre", "mourvedre", "carmenère", "carmenere", "gamay", "primitivo", "aglianico", "mencía", "mencia", "red", "rouge", "rosso", "tinto"):
		return "red"
	}
	return "other"
}

func containsAny(s string, words ...string) bool {
	for _, w := range words {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

// synthesizePrompt builds an image prompt for a wine with no stored
// enrichment prompt, in the same voice as the stored ones (see
// data/enrichment/*.json): identity first, then a studio-setting clause. Most
// of the catalog needs this path — model.Wine never persisted imagePrompt, so
// only the ~28 SKUs in data/enrichment/ carry a stored prompt.
func synthesizePrompt(w model.Wine) string {
	identity := strings.Join(nonEmpty(w.Vintage, w.Producer, w.Name), " ")
	var descriptors []string
	if c := strings.TrimSpace(w.Color); c != "" {
		descriptors = append(descriptors, strings.ToLower(c))
	}
	if v := strings.TrimSpace(w.Varietal); v != "" {
		descriptors = append(descriptors, v)
	}
	s := "Photorealistic studio product photograph of a single bottle of " + identity
	if len(descriptors) > 0 {
		s += " (" + strings.Join(descriptors, ", ") + ")"
	}
	if from := firstNonEmpty(w.Region, w.Country); from != "" {
		s += " from " + from
	}
	s += ". Correct bottle shape and closure for the style, elegant label, neutral warm-grey backdrop, soft key light, subtle reflection, no props, bottle fills the frame."
	return s
}

func nonEmpty(vals ...string) []string {
	var out []string
	for _, v := range vals {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// pickRepresentative selects up to want[bucket] wines per bucket from the
// catalog, considering only wines whose image is currently the generated SVG
// label (the placeholder population a batch run would regenerate — never a
// wine that already has a real photograph). Within a bucket it takes at most
// one wine per producer, so a 3-wine sample never collapses into one
// producer's house style. Iteration over wines is by ascending slug, so the
// pick is deterministic run-over-run.
func pickRepresentative(wines []model.Wine, want map[string]int) []model.Wine {
	sorted := append([]model.Wine(nil), wines...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Slug < sorted[j].Slug })

	taken := map[string]int{}         // bucket -> picked count
	usedProducer := map[string]bool{} // bucket + "\x00" + producer
	var picked []model.Wine
	for _, w := range sorted {
		if w.ImageSource != model.ImageGeneratedLabel {
			continue
		}
		b := bucket(w)
		if taken[b] >= want[b] {
			continue
		}
		key := b + "\x00" + w.Producer
		if usedProducer[key] {
			continue
		}
		usedProducer[key] = true
		taken[b]++
		picked = append(picked, w)
	}

	// Report shortfalls loudly rather than silently under-sampling.
	for b, n := range want {
		if taken[b] < n {
			fmt.Printf("note: bucket %q filled %d of %d requested (catalog has no more distinct-producer placeholders)\n", b, taken[b], n)
		}
	}
	return picked
}

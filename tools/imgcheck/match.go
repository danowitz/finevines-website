package main

import (
	"sort"
	"strings"
	"unicode"
)

// OCR does not read a wine label cleanly. Measured on real bottles, the Windows
// engine returned "Héntiers" for "Héritiers", "I‌CON-VILLAGES" for
// "MÂCON-VILLAGES", and "MAUPERTUI" for "MAUPERTUIS" — the words are there but
// characters drop, double and transpose. So matching is by edit distance, not
// equality; demanding exact strings would reject nearly every correct image.
const maxEdits = 2

// noise is vocabulary shared by half the catalog. Matching on it means matching
// everything: nearly every Burgundy is a "domaine", a third are "grand cru".
var noise = map[string]bool{
	"domaine": true, "domaines": true, "chateau": true, "weingut": true,
	"maison": true, "tenuta": true, "azienda": true, "bodegas": true,
	"cave": true, "clos": true, "quinta": true, "estate": true, "winery": true,
	"wine": true, "wines": true, "vineyard": true, "vineyards": true,
	"grand": true, "cru": true, "premier": true, "1er": true, "les": true,
	"des": true, "aux": true, "appellation": true, "controlee": true,
	"rouge": true, "blanc": true, "red": true, "white": true, "vieilles": true,
	"vignes": true, "reserve": true, "cuvee": true, "villages": true,
	"village": true, "product": true, "france": true, "alc": true, "vol": true,
	"contains": true, "sulfites": true, "produce": true, "bottled": true,
	// Grape names identify a style, never a producer. Leaving them in let a
	// Max Ferd. Richter Mosel satisfy a query for FX Pichler's Kellerberg on
	// the strength of the word "riesling" alone.
	"riesling": true, "chardonnay": true, "pinot": true, "noir": true,
	"cabernet": true, "sauvignon": true, "merlot": true, "syrah": true,
	"grenache": true, "nebbiolo": true, "sangiovese": true, "tempranillo": true,
	"malbec": true, "gamay": true, "chenin": true, "viognier": true,
	"franc": true, "gris": true, "veltliner": true, "gruner": true,
	"spatlese": true, "kabinett": true, "brut": true, "sec": true,
}

func fold(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			// Strip diacritics crudely but adequately: OCR mangles them anyway.
			switch r {
			case 'à', 'â', 'ä', 'á':
				r = 'a'
			case 'é', 'è', 'ê', 'ë':
				r = 'e'
			case 'î', 'ï', 'í':
				r = 'i'
			case 'ô', 'ö', 'ó':
				r = 'o'
			case 'û', 'ü', 'ú', 'ù':
				r = 'u'
			case 'ç':
				r = 'c'
			}
			b.WriteRune(r)
		default:
			b.WriteRune(' ')
		}
	}
	return b.String()
}

// isYear reports a bare four-digit vintage. Excluded from matching: a front
// label very often omits the year entirely, carrying it on a neck label or an
// embossed capsule instead, so requiring it rejects correct images.
func isYear(w string) bool {
	if len(w) != 4 {
		return false
	}
	if w[:2] != "19" && w[:2] != "20" {
		return false
	}
	for _, c := range w {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func words(s string) []string {
	var out []string
	for _, w := range strings.Fields(fold(s)) {
		if len(w) >= 4 && !noise[w] && !isYear(w) {
			out = append(out, w)
		}
	}
	return out
}

// editDistance is standard Levenshtein, bounded by the shorter string.
func editDistance(a, b string) int {
	la, lb := len(a), len(b)
	prev := make([]int, lb+1)
	cur := make([]int, lb+1)
	for j := 0; j <= lb; j++ {
		prev[j] = j
	}
	for i := 1; i <= la; i++ {
		cur[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			m := prev[j] + 1
			if cur[j-1]+1 < m {
				m = cur[j-1] + 1
			}
			if prev[j-1]+cost < m {
				m = prev[j-1] + cost
			}
			cur[j] = m
		}
		prev, cur = cur, prev
	}
	return prev[lb]
}

// longestCommonRun returns the length of the longest substring shared by a
// and b. It is the structural half of the fuzzy match: OCR damage is scattered
// single characters, so a misread word keeps a long intact stretch of the
// original, while two genuinely different words do not.
func longestCommonRun(a, b string) int {
	best := 0
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for i := 1; i <= len(a); i++ {
		for j := 1; j <= len(b); j++ {
			if a[i-1] == b[j-1] {
				cur[j] = prev[j-1] + 1
				if cur[j] > best {
					best = cur[j]
				}
			} else {
				cur[j] = 0
			}
		}
		prev, cur = cur, prev
		for j := range cur {
			cur[j] = 0
		}
	}
	return best
}

// minCommonRun is how much of a word must survive intact for a fuzzy match.
//
// Edit distance alone is not enough, and one real pair proves it: "pichler"
// and "richter" are two substitutions apart — as are "lafarge" and OCR's
// "cafargc". One is a different producer, the other is the right one badly
// read. What separates them is structure: lafarge/cafargc share "afarg", five
// unbroken characters, while pichler/richter share only "ich".
const minCommonRun = 5

// near reports whether want appears among the OCR words, allowing for the
// character damage OCR inflicts but not for a different word entirely.
func near(want string, got []string) bool {
	for _, g := range got {
		// Exact, or one is a clean prefix of the other — OCR truncates lines
		// and Salesforce truncates names.
		if g == want || strings.HasPrefix(g, want) || (strings.HasPrefix(want, g) && len(g) >= 5) {
			return true
		}
		// Short words get no fuzzy allowance at all. Two edits on a five-letter
		// word is most of the word, and short words are the least distinctive
		// ones anyway.
		if len(want) < 6 {
			continue
		}
		if editDistance(want, g) <= maxEdits && longestCommonRun(want, g) >= minCommonRun {
			return true
		}
	}
	return false
}

type matchResult struct {
	want, found, missing []string
	ok                   bool
}

// match asks whether the label text names this wine.
//
// The bar is a MAJORITY of the wine's distinctive words, not all of them.
// Stage 1 has already established the image is a bottle, and a label legitimately
// omits things the catalog name carries — importer shorthand, the vintage on a
// separate neck label, an appellation abbreviated. Requiring every word would
// reject correct images for cataloguing artefacts. Requiring one would accept a
// different grower on the same vineyard, which is exactly the substitution this
// exists to stop.
func match(name, labelText string) matchResult {
	want := words(name)
	got := words(labelText)
	sort.Strings(want)

	r := matchResult{want: want}
	for _, w := range want {
		if near(w, got) {
			r.found = append(r.found, w)
		} else {
			r.missing = append(r.missing, w)
		}
	}
	// Two independent words, or one long distinctive one.
	//
	// A majority bar was tried first and rejected three of six CORRECT images.
	// OCR reads a label's ornate appellation line badly — "GRAND VIN DE
	// BORDEAUX" came back as `"O"OEAVX` — while the producer's name, set large
	// and plain, survives. So the evidence that matters is concentrated in one
	// or two words, and demanding breadth throws away good matches.
	//
	// One SHORT word is not enough: querying Benjamin Leroux's Clos de la Roche
	// returns Roche de Bellene's, whose label genuinely reads "roche". Length
	// is the proxy for how much a word narrows the field — "marjosse",
	// "lafarge" and "kellerberg" each identify one estate, "roche" does not.
	const distinctive = 7
	long := 0
	for _, w := range r.found {
		if len(w) >= distinctive {
			long++
		}
	}
	r.ok = len(r.found) >= 2 || long >= 1
	return r
}

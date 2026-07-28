package main

import (
	"encoding/json"
	"os"
	"sort"
	"strings"
)

// Deciding whether a label names the wine we asked for.
//
// The first version of this accepted on "two matching words, or one word of
// seven or more characters". An external review broke it with 19 real wines,
// every one reproduced against the code:
//
//	Domaine Anne Gros Clos Vougeot   accepted  Gros Frère et Soeur Clos-Vougeot
//	Michel Lafarge Meursault         accepted  Coche-Dury Meursault
//	Sarget de Gruaud Larose          accepted  Château Gruaud Larose (the grand vin)
//	F.X. Pichler Kellerberg          accepted  Emmerich Knoll Ried Kellerberg
//	Les Forts de Latour Pauillac     accepted  Château Latour Pauillac
//
// The fault was treating a long word as identity. "meursault" is on bottles
// from forty producers; "kellerberg" is shared by Pichler, Knoll and
// Pichler-Krutzler; "monvigliero" by Burlotto and Fratelli Alessandria. A
// seven-character appellation proves nothing about who made the wine, and
// showing a wholesale customer the wrong grower's bottle is the failure this
// exists to prevent.
//
// It also could not accept Petrus, Opus One, Château d'Yquem, LAN or Clos du
// Val, whose names are too short or too "generic" to survive its filters at
// all.
//
// THE RULE NOW: every word that IDENTIFIES this wine must appear on the label.
//
// Identifying is measured, not declared. tools/tokenindex counts how many
// distinct producers in this catalog use each word; "lafarge" appears under
// three, "meursault" under eighteen, "chambertin" under twenty-eight. A
// hand-written noise list cannot do this job, because there is no globally
// correct answer — "Chardonnay" is a grape in most names and the producer in
// "Domaine du Chardonnay", "Clos" is generic across Burgundy and part of "Clos
// du Val".
//
// That single rule fixes all five cases above: the label carries the
// appellation but not "anne", not "lafarge", not "sarget", not "pichler", not
// "forts". And it accepts a correct label that OCR has mangled, because
// matching stays fuzzy — just fuzzy about the RIGHT words.

// maxProducersForIdentity is how many producers may share a word before it
// stops proving identity.
//
// Measured on this catalog, the two populations barely overlap: producer
// surnames run 1-4 (lecheneaut 1, pichler 2, lafarge 3, chave 4 — the last
// genuinely being Domaine J.L. Chave and J.L. Chave Sélection, two different
// producers) while appellations start at 5 and climb (estephe 5, savigny 10,
// meursault 18, chambertin 28). Four is the gap between them.
const maxProducersForIdentity = 4

// Index maps a word to the number of distinct producers using it. A word that
// is absent has never been seen in this catalog and is treated as identifying:
// the failure to avoid is accepting a wrong bottle, and an unknown word is
// more likely a producer this book does not carry than a shared appellation.
type Index map[string][]string

func LoadIndex(path string) Index {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil // absent index: everything is identifying, i.e. strictest
	}
	var ix Index
	if json.Unmarshal(b, &ix) != nil {
		return nil
	}
	return ix
}

func (ix Index) identifies(tok string) bool {
	ps, ok := ix[tok]
	if !ok {
		return true // never seen here: assume it distinguishes
	}
	// A nil list means the word is shared too widely to be worth listing.
	return ps != nil && len(ps) <= maxProducersForIdentity
}

// producerKey reduces a name to the estate it belongs to, the same way
// tools/tokenindex does, so the two agree on what counts as one producer.
func producerKey(name string) string {
	designator := map[string]bool{
		"domaine": true, "domaines": true, "chateau": true, "ch": true,
		"weingut": true, "maison": true, "tenuta": true, "azienda": true,
		"agricola": true, "bodegas": true, "bodega": true, "cave": true,
		"caves": true, "quinta": true, "estate": true, "winery": true,
		"cantina": true, "podere": true, "vignobles": true, "les": true,
		"la": true, "le": true, "de": true, "du": true, "des": true, "di": true,
	}
	var f []string
	for _, t := range strings.Fields(normalize(name)) {
		if designator[t] || len(t) < 2 {
			continue
		}
		f = append(f, t)
		if len(f) == 2 {
			break
		}
	}
	return strings.Join(f, " ")
}

// maxProducersForConflict bounds how widely a word may be shared and still
// count as evidence FOR a particular producer. Looser than the identity bound:
// this is looking for a reason to refuse, and a forename shared by five
// estates still tells you which of them you are looking at.
const maxProducersForConflict = 8

// conflicts reports a producer the LABEL points to that is not the one asked
// for, or "" if none.
//
// This is what a frequency threshold alone cannot do. Forenames are shared as
// widely as appellations — paul under 12 producers, jean under 10, bruno under
// 5 — so they never qualify as identifying, yet they are the entire difference
// between Paul Pillot and Jean-Marc Pillot, or Philippe Colin and Bruno Colin.
// Asking "does this word belong to somebody else" catches what "is this word
// rare" cannot.
func (ix Index) conflicts(want string, labelWords []string) string {
	if ix == nil {
		return ""
	}
	key := producerKey(want)
	if key == "" {
		return ""
	}
	asked := map[string]bool{}
	for _, w := range words(want) {
		asked[w] = true
	}
	for _, w := range labelWords {
		if asked[w] {
			continue // the label agreeing with the query is not a conflict
		}
		ps, ok := ix[w]
		if !ok || ps == nil || len(ps) > maxProducersForConflict {
			continue
		}
		mine := false
		for _, p := range ps {
			// A shared leading word ("anne gros" vs "anne parent") is enough to
			// call it ours; requiring an exact key would flag a producer whose
			// own name the catalog spells two ways.
			if p == key || strings.HasPrefix(p, key) || strings.HasPrefix(key, p) {
				mine = true
				break
			}
		}
		if !mine {
			return w + " -> " + strings.Join(ps, "/")
		}
	}
	return ""
}

// fold maps accented letters down to ASCII. ñ, ã and õ were missing from an
// earlier version, which silently rejected "Doña Paula" — the query kept a
// character the OCR of the label never would.
func fold(r rune) rune {
	switch r {
	case 'à', 'â', 'ä', 'á', 'ã', 'å':
		return 'a'
	case 'é', 'è', 'ê', 'ë':
		return 'e'
	case 'î', 'ï', 'í', 'ì':
		return 'i'
	case 'ô', 'ö', 'ó', 'ò', 'õ':
		return 'o'
	case 'û', 'ü', 'ú', 'ù':
		return 'u'
	case 'ç':
		return 'c'
	case 'ñ':
		return 'n'
	case 'ß':
		return 's'
	}
	return ' '
}

func normalize(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r > 127:
			b.WriteRune(fold(r))
		default:
			b.WriteByte(' ')
		}
	}
	return b.String()
}

func isYear(w string) bool {
	if len(w) != 4 || (w[:2] != "19" && w[:2] != "20") {
		return false
	}
	for _, c := range w {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// words splits text into candidate match words, DEDUPLICATED.
//
// The floor is two characters, not four. The old four-character floor erased
// whole producers — LAN, COS, Dow's, Opus One, Le Pin — and left their wines
// with nothing to match on but the appellation, which is precisely the
// evidence that must not be sufficient.
//
// Deduplication matters: without it "Château Canon Pecresse Canon-Fronsac"
// asked for "canon" twice, and a single "CANON" on a Château Canon label
// satisfied both, counting one word as two independent matches.
func words(s string) []string {
	seen := map[string]bool{}
	var out []string
	for _, w := range strings.Fields(normalize(s)) {
		if len(w) < 2 || isYear(w) || seen[w] {
			continue
		}
		seen[w] = true
		out = append(out, w)
	}
	return out
}

func editDistance(a, b string) int {
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
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
	return prev[len(b)]
}

// longestCommonRun is the structural half of fuzzy matching. OCR damage is
// scattered characters, so a misread word keeps a long intact stretch of the
// original; two different words do not. "lafarge"/"cafargc" and
// "pichler"/"richter" are both two edits apart — the first shares "afarg",
// the second only "ich".
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

const (
	maxEdits     = 2
	minCommonRun = 5
	minFuzzyLen  = 6 // shorter words get no fuzzy allowance at all
)

// findIn looks for want among the label's words and returns the INDEX of the
// word it consumed, or -1. Returning an index lets the caller strike that word
// off, so one word on the label can never satisfy two different requirements.
func findIn(want string, got []string, used []bool) int {
	for i, g := range got {
		if used[i] {
			continue
		}
		if g == want || strings.HasPrefix(g, want) || (strings.HasPrefix(want, g) && len(g) >= 5) {
			return i
		}
	}
	if len(want) < minFuzzyLen {
		return -1
	}
	for i, g := range got {
		if used[i] || len(g) < minFuzzyLen {
			continue
		}
		if editDistance(want, g) <= maxEdits && longestCommonRun(want, g) >= minCommonRun {
			return i
		}
	}
	return -1
}

type matchResult struct {
	want        []string // every word of the wine's name
	identifying []string // the subset that actually distinguishes it
	found       []string // identifying words present on the label
	missing     []string // identifying words absent — why it was refused
	conflict    string   // a producer the label points to instead
	ok          bool
}

// match reports whether labelText names the wine called name.
func match(name, labelText string, ix Index) matchResult {
	want := words(name)
	got := words(labelText)
	used := make([]bool, len(got))

	r := matchResult{want: want}
	for _, w := range want {
		if ix.identifies(w) {
			r.identifying = append(r.identifying, w)
		}
	}

	// A name made entirely of shared words — "Domaine Grand Cru Rouge" —
	// identifies nothing, and no image can be verified against it. Refuse
	// rather than fall back to something weaker: this is the case where
	// accepting anything is most tempting and most wrong.
	if len(r.identifying) == 0 {
		return r
	}

	for _, w := range r.identifying {
		if i := findIn(w, got, used); i >= 0 {
			used[i] = true
			r.found = append(r.found, w)
		} else {
			r.missing = append(r.missing, w)
		}
	}
	sort.Strings(r.found)
	sort.Strings(r.missing)

	// EVERY identifying word must be present. Not most, not two — every one.
	// "Sarget de Gruaud Larose" and "Château Gruaud Larose" share two of three;
	// the one they do not share is the entire difference between a second wine
	// and a first growth.
	if len(r.missing) != 0 {
		return r
	}

	// ...and the label must not point somewhere else. Every identifying word
	// can be present and the bottle still be another estate's, when the two
	// share a surname and differ only by a forename the query never demanded.
	if c := ix.conflicts(name, got); c != "" {
		r.conflict = c
		return r
	}

	r.ok = true
	return r
}

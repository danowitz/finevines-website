// Command tokenindex measures how much each word in the catalog actually
// identifies a producer, and writes the result for the image verifier to use.
//
// The verifier's original rule — accept on any long word — treats a shared
// appellation as proof of identity, and an external review broke it with 19
// real wines. "meursault" is on bottles from Lafarge, Coche-Dury, Roulot and
// forty others; "monvigliero" is shared by Burlotto and Fratelli Alessandria;
// "kellerberg" by F.X. Pichler, Knoll and Pichler-Krutzler. None of them names
// a producer.
//
// The fix needs to know which words distinguish and which do not, and a
// hand-written noise list cannot: there is no globally correct answer.
// "Chardonnay" is a grape in almost every name and the producer in "Domaine du
// Chardonnay"; "Clos" is generic across Burgundy and part of "Clos du Val".
//
// So it is measured rather than declared, against the catalog this actually
// has to serve: a word that appears under ONE producer distinguishes that
// producer; a word appearing under many distinguishes nothing. That is exactly
// the property the verifier needs, it needs no taxonomy of the world's wine
// regions, and it stays correct as the book changes.
//
//	go run ./tools/tokenindex -wines data/wines.json -out data/token-index.json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
)

func main() {
	in := flag.String("wines", "data/wines.json", "catalog")
	out := flag.String("out", "data/token-index.json", "token index to write")
	flag.Parse()

	wines, err := model.LoadWines(*in)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	// producerOf: the catalog carries a producer field for only some rows; for
	// the rest the producer leads the name. Two words is a deliberate
	// approximation — "Domaine Anne" and "Anne Gros" both key to the same
	// estate closely enough for counting, and over-splitting would inflate the
	// producer count and make real words look generic.
	// Leading designators are stripped before keying, or the same estate counts
	// as several producers and its own surname stops looking identifying:
	// "Domaine Michel Lafarge", "Michel Lafarge" and "Lafarge" split three ways
	// and made "lafarge" appear shared by three producers, which is exactly
	// backwards.
	designator := map[string]bool{
		"domaine": true, "domaines": true, "chateau": true, "ch": true,
		"weingut": true, "maison": true, "tenuta": true, "azienda": true,
		"agricola": true, "bodegas": true, "bodega": true, "cave": true,
		"caves": true, "quinta": true, "estate": true, "winery": true,
		"cantina": true, "podere": true, "vignobles": true, "les": true,
		"la": true, "le": true, "de": true, "du": true, "des": true, "di": true,
	}
	producerOf := func(w model.Wine) string {
		src := strings.TrimSpace(w.Producer)
		if src == "" {
			src = w.Name
		}
		var f []string
		for _, t := range indexTokens(src) {
			if designator[t] {
				continue
			}
			f = append(f, t)
			if len(f) == 2 {
				break
			}
		}
		return strings.Join(f, " ")
	}

	// token -> set of producers using it
	byToken := map[string]map[string]bool{}
	for _, w := range wines {
		if strings.TrimSpace(w.Name) == "" {
			continue
		}
		p := producerOf(w)
		if p == "" {
			continue
		}
		for _, t := range indexTokens(w.Producer + " " + w.Name) {
			if byToken[t] == nil {
				byToken[t] = map[string]bool{}
			}
			byToken[t][p] = true
		}
	}

	// Emit the PRODUCERS per token, not just how many.
	//
	// A count alone cannot separate "shared because it is an appellation" from
	// "shared because it is a common forename" — paul appears under 12
	// producers and jean under 10, exactly like a village. But those forenames
	// are the entire difference between Paul Pillot and Jean-Marc Pillot, and
	// between Philippe Colin and Bruno Colin. Knowing WHICH producers use a
	// word lets the verifier notice that a label carries evidence for a
	// producer that is not the one asked for.
	perToken := make(map[string][]string, len(byToken))
	counts := make(map[string]int, len(byToken))
	for t, ps := range byToken {
		counts[t] = len(ps)
		// Only carry the producer list where it can discriminate. A word used
		// by dozens of estates is an appellation or a grape; listing them all
		// would treble the file to say nothing.
		if len(ps) <= 12 {
			names := make([]string, 0, len(ps))
			for p := range ps {
				names = append(names, p)
			}
			sort.Strings(names)
			perToken[t] = names
		} else {
			perToken[t] = nil
		}
	}

	b, err := json.Marshal(perToken)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, b, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	// Report the extremes, because they are how anyone checks this is sane.
	type kv struct {
		t string
		n int
	}
	var all []kv
	for t, n := range counts {
		all = append(all, kv{t, n})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].n != all[j].n {
			return all[i].n > all[j].n
		}
		return all[i].t < all[j].t
	})
	unique := 0
	for _, k := range all {
		if k.n == 1 {
			unique++
		}
	}
	fmt.Printf("%d wines -> %d distinct tokens\n", len(wines), len(counts))
	fmt.Printf("%d appear under exactly one producer (identifying)\n\n", unique)
	fmt.Println("least identifying (shared by the most producers):")
	for _, k := range all[:min(14, len(all))] {
		fmt.Printf("  %4d producers  %s\n", k.n, k.t)
	}
}

// indexTokens splits a name the same way the verifier does, minus the noise
// list — the whole point is to DERIVE what is noise rather than assume it.
func indexTokens(s string) []string {
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
	seen := map[string]bool{}
	var out []string
	for _, t := range strings.Fields(b.String()) {
		if len(t) < 2 || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

// fold maps the accented letters that appear in European wine names down to
// ASCII. Kept in one place and shared with the verifier — an earlier version
// missed ñ, which silently rejected "Doña Paula".
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

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

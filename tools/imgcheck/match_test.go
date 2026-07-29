package main

import "testing"

// Tests for the pieces below the matching rule itself. The rule's own cases —
// wrong producers, second wines, short names — are in review_test.go, built
// from the adversarial review that broke the previous version.

func TestVintageIsNotRequired(t *testing.T) {
	// Front labels frequently omit the year, carrying it on a neck label or an
	// embossed capsule, so requiring it rejects correct images.
	for _, w := range words("Meursault 2022") {
		if w == "2022" {
			t.Error("a bare vintage must not become a match word")
		}
	}
	if !isYear("2022") || !isYear("1999") {
		t.Error("isYear missed a plausible vintage")
	}
	// A four-digit lot or bin number is not a vintage.
	if isYear("1234") || isYear("750m") {
		t.Error("isYear was too eager")
	}
}

func TestWordsAreDeduplicated(t *testing.T) {
	// "Canon" appears twice in Château Canon-Pécresse Canon-Fronsac. Asked for
	// twice, a single CANON on a different château's label satisfied both.
	seen := map[string]int{}
	for _, w := range words("Chateau Canon Pecresse Canon-Fronsac") {
		seen[w]++
	}
	for w, n := range seen {
		if n > 1 {
			t.Errorf("%q appears %d times; words() must deduplicate", w, n)
		}
	}
}

func TestShortWordsSurvive(t *testing.T) {
	// A four-character floor erased whole producers — LAN, COS, Dow's, Le Pin,
	// Opus One — leaving their wines nothing to match on but the appellation,
	// which is exactly the evidence that must never be sufficient.
	for _, c := range []struct{ in, want string }{
		{"LAN D-12", "lan"},
		{"Opus One", "one"},
		{"Le Pin", "pin"},
		{"Clos du Val", "val"},
	} {
		found := false
		for _, w := range words(c.in) {
			if w == c.want {
				found = true
			}
		}
		if !found {
			t.Errorf("words(%q) dropped %q — got %v", c.in, c.want, words(c.in))
		}
	}
}

func TestAccentFolding(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"Château", "chateau"},
		{"Spätlese", "spatlese"},
		{"Doña Paula", "dona paula"},
		{"Estèphe", "estephe"},
		{"São João", "sao joao"},
	} {
		if got := normalize(c.in); got != c.want {
			t.Errorf("normalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestFuzzyMatchingSeparatesDamageFromDifference(t *testing.T) {
	// Both pairs are exactly two substitutions apart, so edit distance alone
	// cannot tell them apart. The intact run can: "afarg" is five characters,
	// "ich" is three.
	for _, c := range []struct {
		want, got string
		match     bool
	}{
		{"lafarge", "cafargc", true},  // the right producer, badly read
		{"pichler", "richter", false}, // a different producer entirely
		{"kellerberg", "kellerberq", true},
		{"meursault", "montrachet", false},
		{"marjosse", "marjosse", true},
	} {
		used := []bool{false}
		got := findIn(c.want, []string{c.got}, used) >= 0
		if got != c.match {
			t.Errorf("findIn(%q, %q) = %v, want %v", c.want, c.got, got, c.match)
		}
	}
}

func TestFindInConsumesTheWordItMatched(t *testing.T) {
	// One word on a label may satisfy only one requirement.
	got := []string{"canon"}
	used := make([]bool, len(got))
	i := findIn("canon", got, used)
	if i < 0 {
		t.Fatal("first lookup should match")
	}
	used[i] = true
	if findIn("canon", got, used) >= 0 {
		t.Error("the same label word was matched twice")
	}
}

func TestIndexIdentifies(t *testing.T) {
	ix := Index{
		"meursault":  nil, // shared too widely to list
		"chambertin": nil,
		"lafarge":    {"michel lafarge", "lafarge pere", "frederic lafarge"},
		"marjosse":   {"marjosse"},
	}
	for _, c := range []struct {
		tok  string
		want bool
	}{
		{"marjosse", true},   // one producer
		{"lafarge", true},    // three, still a surname
		{"meursault", false}, // eighteen: an appellation
		{"chambertin", false},
		{"petrus", true}, // absent from the catalog: assume it identifies
	} {
		if got := ix.identifies(c.tok); got != c.want {
			t.Errorf("identifies(%q) = %v, want %v", c.tok, got, c.want)
		}
	}
	// With no index at all the rule must get STRICTER, never looser.
	var none Index
	if !none.identifies("meursault") {
		t.Error("a missing index must treat every word as identifying")
	}
}

func TestWatermarkDetection(t *testing.T) {
	if got := watermark("CLOS-VOUGEOT ANNE GROS vivino"); got != "vivino" {
		t.Errorf("watermark() = %q, want vivino", got)
	}
	if got := watermark("CHATEAU MARJOSSE GRAND VIN DE BORDEAUX"); got != "" {
		t.Errorf("watermark() = %q, want none", got)
	}
	// A damaged read is NOT caught, and that is documented rather than papered
	// over: catching "vlvlno" needs a rule loose enough to also match "vino",
	// which is on most Italian labels. Provenance is the real check.
	for _, mangled := range []string{"ANNE GROS vlvlno", "MARJOSSE vvlno"} {
		if got := watermark(mangled); got != "" {
			t.Errorf("watermark(%q) = %q — if this now works, tighten the doc comment", mangled, got)
		}
	}
}

func TestWatermarkedHostIsTheReliableCheck(t *testing.T) {
	if got := WatermarkedHost("images.vivino.com"); got != "vivino" {
		t.Errorf("WatermarkedHost(vivino) = %q", got)
	}
	if got := WatermarkedHost("www.domaine-anne-gros.com"); got != "" {
		t.Errorf("WatermarkedHost(producer site) = %q, want none", got)
	}
}

package main

import "testing"

// The label strings below are VERBATIM Windows OCR output from real fetched
// bottle photographs — not idealised text. That is the point: OCR reads a wine
// label badly, and every threshold here exists because of a specific way it
// failed. "GRAND VIN DE BORDEAUX" came back as `"O"OEAVX`; "Domaine Michel
// Lafarge" as "Dontailtc fliiclpcl Cafargc". Any rule that only works on clean
// text is worthless in this pipeline.
var cases = []struct {
	name      string // the wine, as the catalog holds it
	label     string // what OCR actually read off the bottle
	wantMatch bool
	why       string
}{
	{
		name:      "Domaine Anne Gros Clos Vougeot Grand Cru 2022",
		label:     "CLOS-VOUGEOT GRAND LE GRAND MAUPERTUI 00M AIN E ANNE GROS",
		wantMatch: true,
		why:       "producer and vineyard both legible",
	},
	{
		name:      "Château Marjosse Bordeaux Rouge 2022",
		label:     `CHATEAU MARJOSSE "O"OEAVX`,
		wantMatch: true,
		why:       "one long distinctive word survives; the appellation line is destroyed",
	},
	{
		name:      "Domaine Michel Lafarge Meursault 2022",
		label:     "ettvsattlt Dontailtc fliiclpcl Cafargc c Bourgogne boutcillrs i",
		wantMatch: true,
		why:       "barely readable, but 'Cafargc' is one edit from 'lafarge'",
	},
	{
		name:      "Heritiers Comte Lafon Macon Village 2025",
		label:     "Réco'te MACON-VILLAGES Les Hér.fiers du Comte",
		wantMatch: true,
		why:       "two words match even though the estate name is truncated",
	},
	{
		// The substitution this whole stage exists to catch: a different estate
		// on the SAME vineyard. Page text was entirely consistent.
		name:      "Benjamin Leroux Clos de la Roche Grand Cru 2018",
		label:     "'MAISON ROCHE DE BELLEW ' CLOS DE LA ROCHE VIN DE BOURCOCNE",
		wantMatch: false,
		why:       "only 'roche' matches, and it is the vineyard, not the grower",
	},
	{
		name:      "Weingut Fx Pichler Riesling Kellerberg 2022",
		label:     "ScriC.Rithttr Wehlener Sonnenuhr Riesling Spätlese MOSEL",
		wantMatch: false,
		why:       "a different producer entirely; only the grape name is shared",
	},
}

func TestMatchAgainstRealOCR(t *testing.T) {
	for _, c := range cases {
		got := match(c.name, c.label)
		if got.ok != c.wantMatch {
			t.Errorf("%s\n  label   %q\n  want ok=%v (%s), got ok=%v (found %v, missing %v)",
				c.name, c.label, c.wantMatch, c.why, got.ok, got.found, got.missing)
		}
	}
}

func TestGrapeNamesAreNotIdentity(t *testing.T) {
	// Leaving grapes in let a Mosel Riesling satisfy a query for a Wachau one
	// purely on the word "riesling".
	for _, w := range []string{"riesling", "chardonnay", "cabernet", "sauvignon"} {
		if got := words("Domaine " + w); len(got) != 0 {
			t.Errorf("%q should carry no identifying words, got %v", w, got)
		}
	}
}

func TestGenericWineVocabularyIsIgnored(t *testing.T) {
	// A name made only of shared vocabulary identifies nothing, so it must never
	// match — silently accepting anything for it is the worst failure available.
	if got := match("Domaine Grand Cru Rouge", "Maison Roche de Bellene Clos de la Roche"); got.ok {
		t.Errorf("a name with no distinctive words must not match: found %v", got.found)
	}
}

func TestVintageIsNotRequired(t *testing.T) {
	// Front labels frequently omit the year — it lives on a neck label or the
	// capsule — so requiring it rejects correct images.
	for _, w := range words("Meursault 2022") {
		if w == "2022" {
			t.Error("a bare vintage must not be a required match word")
		}
	}
}

func TestOneShortWordIsNotEnough(t *testing.T) {
	// "roche" appears on every Clos de la Roche from every grower.
	if got := match("Benjamin Leroux Clos de la Roche", "Domaine Castagnier Clos de la Roche"); got.ok {
		t.Errorf("a single short shared word must not carry a match: found %v", got.found)
	}
}

func TestWatermarkDetection(t *testing.T) {
	// A clean read is caught.
	if got := watermark("CLOS-VOUGEOT ANNE GROS vivino"); got != "vivino" {
		t.Errorf("watermark() = %q, want vivino", got)
	}
	if got := watermark("CHATEAU MARJOSSE GRAND VIN DE BORDEAUX"); got != "" {
		t.Errorf("watermark() = %q, want none", got)
	}

	// And a damaged read is NOT — documented rather than papered over. These
	// are verbatim OCR of Vivino's mark on real images. Catching them needs a
	// rule loose enough to also match "vino", which is on most Italian labels,
	// so the trade is not worth making. Provenance is the real check.
	for _, mangled := range []string{"ANNE GROS vlvlno", "MARJOSSE vvlno"} {
		if got := watermark(mangled); got != "" {
			t.Errorf("watermark(%q) = %q — if this now works, tighten the claim in the doc comment", mangled, got)
		}
	}
}

func TestWatermarkedHostIsTheReliableCheck(t *testing.T) {
	// What OCR cannot do from damaged pixels, the download URL states outright.
	if got := WatermarkedHost("images.vivino.com"); got != "vivino" {
		t.Errorf("WatermarkedHost(images.vivino.com) = %q, want vivino", got)
	}
	if got := WatermarkedHost("www.wine-searcher.com"); got != "wine-searcher" {
		t.Errorf("WatermarkedHost(wine-searcher) = %q, want wine-searcher", got)
	}
	// A producer's own site carries no source mark.
	if got := WatermarkedHost("www.domaine-anne-gros.com"); got != "" {
		t.Errorf("WatermarkedHost(producer site) = %q, want none", got)
	}
}

func TestEditDistanceTolerance(t *testing.T) {
	// The OCR damage actually observed, and the limit of what should pass.
	for _, c := range []struct {
		want, got string
		near      bool
	}{
		// Both pairs are exactly two substitutions apart, so edit distance
		// cannot tell them apart. The intact run can: "afarg" is five
		// characters, "ich" is three.
		{"lafarge", "cafargc", true},  // the right producer, badly read
		{"pichler", "richter", false}, // a different producer entirely
		{"marjosse", "marjosse", true},
		{"leroux", "bellew", false},
		{"kellerberg", "kellerberq", true}, // one substitution, run of nine
		{"meursault", "montrachet", false}, // two real Burgundy appellations
	} {
		if got := near(c.want, []string{c.got}); got != c.near {
			t.Errorf("near(%q, %q) = %v, want %v", c.want, c.got, got, c.near)
		}
	}
}

package main

import "testing"

// Every case in this file came from an external adversarial review that broke
// the previous matcher, plus the real OCR examples that must keep working.
// They are real wines, spelled as they appear in trade catalogs — that is what
// made them useful, and it is why they are pinned here rather than paraphrased.
var ix = LoadIndex("../../data/token-index.json")

func TestRejectsWrongProducerSharingAnAppellation(t *testing.T) {
	// The failure that matters: a different grower on the same ground. Each of
	// these was ACCEPTED by the previous rule.
	for _, c := range []struct{ what, name, label string }{
		{"two Gros estates in Clos-Vougeot",
			"Domaine Anne Gros Clos Vougeot", "Domaine Gros Frere et Soeur Clos-Vougeot"},
		{"Domaine vs Olivier Leflaive",
			"Domaine Leflaive Puligny-Montrachet", "Olivier Leflaive Puligny-Montrachet"},
		{"two Pillots in Chassagne",
			"Paul Pillot Chassagne-Montrachet", "Jean-Marc Pillot Chassagne-Montrachet"},
		{"two Colins in Chassagne",
			"Philippe Colin Chassagne-Montrachet", "Bruno Colin Chassagne-Montrachet"},
		{"appellation alone is not identity",
			"Michel Lafarge Meursault", "Coche-Dury Meursault"},
		{"a shared Wachau vineyard",
			"F.X. Pichler Riesling Kellerberg", "Emmerich Knoll Riesling Ried Kellerberg"},
		{"a shared Barolo cru",
			"G.B. Burlotto Barolo Monvigliero", "Fratelli Alessandria Barolo Monvigliero"},
	} {
		if got := match(c.name, c.label, ix); got.ok {
			t.Errorf("%s: accepted the wrong producer\n  want %q\n  got  %q\n  matched on %v",
				c.what, c.name, c.label, got.found)
		}
	}
}

func TestRejectsSecondWineForItsGrandVin(t *testing.T) {
	// The estate is right and the appellation is right; only the wine is
	// wrong, and it is the more expensive one.
	for _, c := range []struct{ name, label string }{
		{"Sarget de Gruaud Larose", "Chateau Gruaud Larose"},
		{"Les Forts de Latour Pauillac", "Chateau Latour Pauillac"},
		{"Pagodes de Cos Saint-Estephe", "Chateau Cos d'Estournel Saint-Estephe"},
		{"Pavillon Rouge du Chateau Margaux", "Chateau Margaux"},
	} {
		if got := match(c.name, c.label, ix); got.ok {
			t.Errorf("accepted the grand vin for its second wine\n  want %q\n  got %q\n  matched on %v",
				c.name, c.label, got.found)
		}
	}
}

func TestOneLabelWordCannotSatisfyTwoRequirements(t *testing.T) {
	// "Canon" appears twice in the requested name (the estate and the
	// appellation). Without deduplication and without consuming the matched
	// word, a single "CANON" on a different château's label counted as two
	// independent matches.
	got := match("Chateau Canon Pecresse Canon-Fronsac 2020", "CHATEAU CANON 2020", ix)
	if got.ok {
		t.Errorf("accepted Chateau Canon for Canon-Pecresse; matched on %v", got.found)
	}
}

func TestAcceptsNamesThatAreShortOrGeneric(t *testing.T) {
	// All of these were REJECTED before: their names are too short, or made
	// entirely of words a hand-written noise list discards.
	for _, c := range []struct{ name, label string }{
		{"Petrus 2018", "Petrus 2018"},
		{"Chateau d'Yquem 2021", "Chateau d'Yquem 2021"},
		{"Chateau Ausone 2018", "Chateau Ausone 2018"},
		{"Opus One 2021", "Opus One 2021"},
		{"LAN D-12 2022", "LAN D-12 2022"},
		{"Le Pin 2020", "Le Pin 2020"},
		{"Clos du Val Cabernet Sauvignon 2022", "Clos du Val Cabernet Sauvignon 2022"},
		{"J.J. Prum Riesling Kabinett 2011", "J.J. Prum Riesling Kabinett 2011"},
		{"Dow's Vintage Port 2016", "Dow's Vintage Port 2016"},
	} {
		if got := match(c.name, c.label, ix); !got.ok {
			t.Errorf("rejected its own label: %q  missing %v (identifying: %v)",
				c.name, got.missing, got.identifying)
		}
	}
}

func TestFoldsAccentsTheLabelWillNotHave(t *testing.T) {
	// OCR returns "DOÑA PAULA"; an earlier fold table omitted ñ, so the query
	// kept a character the comparison could never meet.
	if got := match("Dona Paula Estate Malbec 2021", "DOÑA PAULA ESTATE MALBEC 2021", ix); !got.ok {
		t.Errorf("accent folding failed: missing %v", got.missing)
	}
	if got := match("Chateau Lilian Ladouys Saint-Estephe", "Château Lilian Ladouys SAINT-ESTÈPHE", ix); !got.ok {
		t.Errorf("accent folding failed: missing %v", got.missing)
	}
}

func TestStillReadsRealDamagedOCR(t *testing.T) {
	// Verbatim Windows OCR from real fetched bottles. Tightening the rule must
	// not cost the ability to read a genuinely bad scan.
	for _, c := range []struct{ name, label string }{
		{"Domaine Anne Gros Clos Vougeot Grand Cru 2022",
			"CLOS-VOUGEOT GRAND LE GRAND MAUPERTUI 00M AIN E ANNE GROS"},
		{"Chateau Marjosse Bordeaux Rouge 2022", `CHATEAU MARJOSSE "O"OEAVX`},
	} {
		if got := match(c.name, c.label, ix); !got.ok {
			t.Errorf("rejected a correct damaged label: %q missing %v", c.name, got.missing)
		}
	}
}

func TestStrictnessCostsSomeCorrectImages(t *testing.T) {
	// A deliberate trade, recorded rather than tuned away.
	//
	// This label IS Michel Lafarge's Meursault; OCR read the forename as
	// "fliiclpcl", so "michel" cannot be found and the strict rule refuses it.
	// Allowing one identifying word to be missing would recover it — and would
	// also re-admit "Domaine Anne Gros Clos Vougeot" matching a Gros Frère et
	// Soeur label on "gros" alone, which is the failure this exists to stop.
	//
	// Coverage is the cheaper thing to lose, and it is not lost: the pipeline
	// sends refusals to a vision model, which recovered exactly this image in a
	// real run. Local strict, vision recovers.
	got := match("Domaine Michel Lafarge Meursault 2022",
		"ettvsattlt Dontailtc fliiclpcl Cafargc c Bourgogne boutcillrs i", ix)
	if got.ok {
		t.Error("if this now passes locally, the rule was loosened — check the Anne Gros case still fails")
	}
	if len(got.found) == 0 {
		t.Errorf("expected a partial match on the surname, got nothing (missing %v)", got.missing)
	}
}

func TestRefusesToGuessWhenNothingIdentifies(t *testing.T) {
	// A name of nothing but shared words cannot be verified against any image.
	got := match("Domaine Grand Cru Rouge", "Maison Roche de Bellene Clos de la Roche", ix)
	if got.ok {
		t.Errorf("accepted on shared words alone: %v", got.found)
	}
	if len(got.identifying) != 0 {
		t.Errorf("expected nothing identifying, got %v", got.identifying)
	}
}

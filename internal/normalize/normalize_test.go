package normalize

import "testing"

func TestProducer(t *testing.T) {
	cases := map[string]string{
		"LAMY, HUBERT":      "Hubert Lamy",
		"MOREY, PIERRE":     "Pierre Morey",
		"serafin":           "Serafin",
		"ANTHONY & DOMINIC": "Anthony & Dominic",
		"ZOLO":              "Zolo",
		"GHOST BLOCK":       "Ghost Block",
		"Hubert Lamy":       "Hubert Lamy", // already clean → unchanged
		"":                  "",
	}
	for in, want := range cases {
		if got := Producer(in); got != want {
			t.Errorf("Producer(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestProducerStripsInternalLotCode: Salesforce appends a lot code to the
// brand on the 2011 Burgundies — "LEROUX, BENJAMIN - BCL11". It is an
// internal warehouse reference, not part of the estate's name, and the
// "LAST, FIRST" reversal scatters it into the MIDDLE of the result:
// "Benjamin - BCL11 Leroux".
//
// Left in, it reaches the public site three ways: it prints on every card and
// detail page, it splits one estate across two producer collection pages
// (Benjamin Leroux's 24 wines in one, these 2 in another), and it seeds the
// slug. Eight producers are affected.
//
// The code is stripped wherever it sits: on the raw brand before reversal,
// and on an already-mangled value so stored catalog text can be repaired
// without a fresh Salesforce pull.
func TestProducerStripsInternalLotCode(t *testing.T) {
	cases := map[string]string{
		// Raw Salesforce forms.
		"LEROUX, BENJAMIN - BCL11": "Benjamin Leroux",
		"AMBROISE - BCL11":         "Ambroise",
		"CLAIR, BRUNO - BCL11":     "Bruno Clair",
		"MOREY, PIERRE BLC 13":     "Pierre Morey",
		// Already-normalized values carrying the scattered code.
		"Benjamin - BCL11 Leroux":   "Benjamin Leroux",
		"Charlopin-Parizot - BCL11": "Charlopin-Parizot",
		"Pierre Blc 13 Morey":       "Pierre Morey",
		"Camille Giroud - BCL11":    "Camille Giroud",
		// Real brands that merely contain digits must survive untouched —
		// including their casing, which titleWord preserves for all-caps
		// tokens so appellation initialisms like DOCG and XIV survive too.
		"GEN5":      "GEN5",
		"ATOMIQUE3": "ATOMIQUE3",
		"1+1=3":     "1+1=3",
		"Ambroise":  "Ambroise",
	}
	for in, want := range cases {
		if got := Producer(in); got != want {
			t.Errorf("Producer(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestStripForeignVintage covers prose that names the WRONG year.
//
// The client's consolidation decision (2026-08-04) is that descriptive prose
// barely changes across vintages of one cuvée: enrichment runs once per wine
// and tools/proseshare fans the result out to the siblings. That decision is
// about tasting character. It is not a decision to tell a customer the 2023
// is the 2024 — but the donor's year travels inside the copied sentence, so
// 58 wines currently do exactly that ("This Moscato d'Asti 'Centive' 2024…"
// on the 2023's page).
//
// The year is removed rather than swapped. Shared prose describes the cuvée,
// so saying nothing about the year is honest; rewriting "the 2012 unfolds"
// into "the 2018 unfolds" would manufacture a vintage-specific claim about a
// wine nobody tasted.
func TestStripForeignVintage(t *testing.T) {
	cases := []struct{ text, vintage, want string }{
		// The donor's year, mid-sentence.
		{"This Moscato d’Asti “Centive” 2024 from Tenuta Olim Bauda offers elegance.", "2023",
			"This Moscato d’Asti “Centive” from Tenuta Olim Bauda offers elegance."},
		{"Benjamin Leroux’s 2023 Charmes-Chambertin unfolds with restraint.", "2022",
			"Benjamin Leroux’s Charmes-Chambertin unfolds with restraint."},
		{"This 2020 Domaine Jean-Louis Chave Saint-Joseph reveals a bouquet.", "2023",
			"This Domaine Jean-Louis Chave Saint-Joseph reveals a bouquet."},
		// The wine's OWN year is correct and must stay.
		{"The 2019 is drinking beautifully now.", "2019", "The 2019 is drinking beautifully now."},
		// Drink windows are not vintage claims, including one that opens close
		// to the vintage — proximity alone cannot tell the two apart.
		{"Drink through 2036.", "2019", "Drink through 2036."},
		{"A window of 2025–2032 rewards patience.", "2023", "A window of 2025–2032 rewards patience."},
		{"Enjoy after 2024 onwards.", "2022", "Enjoy after 2024 onwards."},
		// "from" is NOT a drink cue here: it precedes a producer far more often
		// than a date, and treating it as one left contaminated wines uncorrected.
		{"This Meursault from 2023 reveals refinement.", "2022", "This Meursault reveals refinement."},
		{"Marsannay Blanc from Domaine Sylvain Pataille 2022 presents lift.", "2021", "Marsannay Blanc from Domaine Sylvain Pataille presents lift."},
		// Found in the live catalog: a forward-looking cue reads as a year
		// close to the vintage, and stripping it leaves "decanting after."
		{"Rewarding gentle decanting after 2028.", "2022", "Rewarding gentle decanting after 2028."},
		{"Best broached beyond 2026.", "2023", "Best broached beyond 2026."},
		// Estate history is not vintage contamination, however phrased.
		{"The domaine was founded in 1932 by the family.", "2019",
			"The domaine was founded in 1932 by the family."},
		{"Maxime Cheurlin took over in 2012 and remade the estate.", "2018",
			"Maxime Cheurlin took over in 2012 and remade the estate."},
		{"Vines planted in 2014 now yield concentrated fruit.", "2020",
			"Vines planted in 2014 now yield concentrated fruit."},
		// A year modifying a noun cannot be edited at token level without
		// wrecking the sentence, so it is deliberately left for a human.
		{"La Dominode from the 2022 vintage by Bize.", "2021", "La Dominode from the 2022 vintage by Bize."},
		// Nothing to do.
		{"A poised, mineral Chablis.", "2021", "A poised, mineral Chablis."},
		{"", "2021", ""},
	}
	for _, c := range cases {
		if got := StripForeignVintage(c.text, c.vintage); got != c.want {
			t.Errorf("StripForeignVintage(%q, %q)\n  = %q\n want %q", c.text, c.vintage, got, c.want)
		}
	}
}

// TestStripCitations: the enrichment model left its sources in the prose as
// markdown links — "([bourgognewine.dk](https://…?utm_source=openai))" —
// and eleven fields across six wines render that literally on a customer-
// facing page. Provenance belongs in the Sources map, which the catalog
// already keeps; it does not belong in a tasting note.
func TestStripCitations(t *testing.T) {
	cases := []struct{ in, want string }{
		// Parenthesised, mid-sentence, with the sentence's period outside.
		{"Grown on limestone soils ([vignerons.com](https://www.vignerons.com/x?utm_source=openai)).",
			"Grown on limestone soils."},
		// Ends the string with no terminal punctuation of its own.
		{"Pairs with roasted game ([bourgognewine.dk](https://bourgognewine.dk/p/1?utm_source=openai))",
			"Pairs with roasted game."},
		// Glued straight onto the preceding word, no space.
		{"Aromas found in the 2023 notes([alphonse.lu](https://www.alphonse.lu/fr/shop/a?utm_source=openai))",
			"Aromas found in the 2023 notes."},
		// Two citations in one field.
		{"Bright fruit ([a.com](https://a.com/1)) and firm tannin ([b.com](https://b.com/2)).",
			"Bright fruit and firm tannin."},
		// A bare URL with no markdown wrapper.
		{"See https://www.louislatour.com/pdf/en/x.pdf for the estate's notes.",
			"See for the estate's notes."},
		// Prose with no citation is returned untouched, brackets and all.
		{"A poised Chablis (Grand Cru) with real length.", "A poised Chablis (Grand Cru) with real length."},
		{"", ""},
	}
	for _, c := range cases {
		if got := StripCitations(c.in); got != c.want {
			t.Errorf("StripCitations(%q)\n  = %q\n want %q", c.in, got, c.want)
		}
	}
}

func TestVintage(t *testing.T) {
	cases := map[string]string{"14": "2014", "18": "2018", "98": "1998", "2021": "2021", "NV": "NV", "": ""}
	for in, want := range cases {
		if got := Vintage(in); got != want {
			t.Errorf("Vintage(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWineName(t *testing.T) {
	cases := []struct{ desc, brand, want string }{
		{"14 LAMY ST AUBIN ROUGE 1C DERRIERE CHEZ EDOUARD 12/750", "LAMY, HUBERT",
			"Saint Aubin Rouge 1er Cru Derriere chez Edouard"},
		{"18 ANTHONY & DOMINIC PINOT NOIR 1/3.0", "ANTHONY & DOMINIC", "Pinot Noir"},
		{"14 SERAFIN PERE ET FILS BOURGOGNE ROUGE 12/750", "serafin", "Pere et Fils Bourgogne Rouge"},
		{"15 CH PUY-SERVAIN TERREMONT 12/500", "HECQUET", "Château Puy-Servain Terremont"},
		// Everything from the first pack token on is warehouse noise, never
		// name content — hold notes, unit words, asterisks, duplicated pack
		// tokens (rule verified against the full live roster 2026-07-29).
		{"21 CLOS HENRI PETIT CLOS SAUVIGNON BLANC 12/750 HOLD FOR BEAUMONTS", "CLOS HENRI",
			"Petit Clos Sauvignon Blanc"},
		{"20 TEMPO D'ANGELUS BORDEAUX ROUGE 6/750* GM HOLD", "", "Tempo D'angelus Bordeaux Rouge"},
		{"18 BENJAMIN LEROUX BATARD MONTRACHET GRAND CRU 3/1.5L", "LEROUX, BENJAMIN",
			"Batard Montrachet Grand Cru"},
		{"21 DOM MARCEL DEISS ALSACE RIBEAUVILLE 12/750(HOLD UNTIL 2018/2019 ARE SOLD)", "DEISS, MARCEL",
			"Domaine Marcel Deiss Alsace Ribeauville"},
		{"21 DOM MEO-CAMUZET CORTON PERRIERES GRAND CRU 12/750 12/750", "MEO-CAMUZET",
			"Domaine Meo-Camuzet Corton Perrieres Grand Cru"},
		{"19 CAVE LA COMTADINE COTES DU RHONE 12/750 - ORGANIC*", "CAVE LA COMTADINE",
			"Cotes du Rhone"},
		// A mid-name pack token also RESCUES names the old end-anchored rule
		// never detected as trade shorthand. "NV" is a vintage marker (the
		// vintage field already says NV), so it strips like a 2-digit prefix.
		{"NV PROSCOTTO SPARKLING WINE 24/375 CANS", "", "Proscotto Sparkling Wine"},
		{"NV VARA HIGH DESERT GIN 12/750**", "VARA", "High Desert Gin"},
		{"NV CIDER FARM OAK AGED CIDER 1/19.5 LITER", "THE CIDER FARM", "Oak Aged Cider"},
		// The pack token can arrive GLUED to the last word ("GRAND CRU12/750",
		// "(100% PINOT NOIR)12/750" — live data): cut at the digits, keep the word.
		{"NV CHAMPAGNE CAMILLE SAVES ANAIS JOLIE COEUR BRUT GRAND CRU12/750", "CAMILLE SAVES",
			"Champagne Camille Saves Anais Jolie Coeur Brut Grand Cru"},
		{"NV DOM JEAN NOEL GAGNARD CREMANT DE BOURGOGNE GRAND LYS EXTRA BRUT (100% PINOT NOIR)12/750", "",
			"Domaine Jean Noel Gagnard Cremant de Bourgogne Grand Lys Extra Brut (100% Pinot Noir)"},
		{"20 DOM PARENT BOURGOGNE PINOT NOIR CUVEE XIV12/750", "PARENT",
			"Domaine Parent Bourgogne Pinot Noir Cuvee XIV"},
		// A leading multi-vintage token ("16/17/18 …", a vertical assortment)
		// must NOT be treated as a glued pack token and blank the name.
		{"16/17/18 ROCCA DI MONTEGROSSI CHIANTI GRAN SELEZIONE DOCG 6/750 VERTICAL ASSORTMENT( 2 BTLS EA 16/17/18)", "ROCCA DI MONTEGROSSI",
			"16/17/18 Rocca Di Montegrossi Chianti Gran Selezione DOCG"},
		// Already-clean (mock/enriched) names pass through untouched.
		{"Saint-Aubin 1er Cru « Derrière chez Édouard »", "Hubert Lamy",
			"Saint-Aubin 1er Cru « Derrière chez Édouard »"},
	}
	for _, c := range cases {
		if got := WineName(c.desc, c.brand); got != c.want {
			t.Errorf("WineName(%q, %q)\n  = %q\n want %q", c.desc, c.brand, got, c.want)
		}
	}
}

func TestIsTradeName(t *testing.T) {
	if !IsTradeName("14 LAMY ST AUBIN 12/750") {
		t.Error("vintage-prefixed trade string should be detected")
	}
	if !IsTradeName("NV VARA HIGH DESERT GIN 12/750**") {
		t.Error("mid-name pack token (double star) should be detected")
	}
	if !IsTradeName("NV PROSCOTTO SPARKLING WINE 24/375 CANS") {
		t.Error("pack token followed by a unit word should be detected")
	}
	if IsTradeName("Saint-Aubin 1er Cru") {
		t.Error("clean name should NOT be flagged as trade")
	}
}

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

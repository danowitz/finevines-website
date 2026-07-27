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
	if IsTradeName("Saint-Aubin 1er Cru") {
		t.Error("clean name should NOT be flagged as trade")
	}
}

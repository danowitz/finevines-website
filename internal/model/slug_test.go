package model

import "testing"

func TestSlugify(t *testing.T) {
	cases := []struct {
		parts []string
		want  string
	}{
		{[]string{"Hubert Lamy", "Saint-Aubin 1er Cru « Derrière chez Édouard »", "2021"},
			"hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021"},
		{[]string{"Château d'Yquem", "Sauternes", "2015"}, "chateau-d-yquem-sauternes-2015"},
		{[]string{"Weingut Müller", "Riesling", ""}, "weingut-muller-riesling"},
		{[]string{"  spaces  "}, "spaces"},
	}
	for _, c := range cases {
		if got := Slugify(c.parts...); got != c.want {
			t.Errorf("Slugify(%v) = %q, want %q", c.parts, got, c.want)
		}
	}
}

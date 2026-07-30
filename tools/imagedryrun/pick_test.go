package main

import (
	"strings"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

func TestBucketClassifiesByVarietalNameAndColor(t *testing.T) {
	cases := []struct {
		name string
		wine model.Wine
		want string
	}{
		{"red by varietal", model.Wine{Varietal: "Cabernet Sauvignon"}, "red"},
		{"white by varietal", model.Wine{Varietal: "Chardonnay"}, "white"},
		{"sparkling beats white", model.Wine{Varietal: "Chardonnay", Name: "Brut Champagne"}, "sparkling"},
		{"sparkling by color", model.Wine{Color: "white sparkling"}, "sparkling"},
		{"spirits by name", model.Wine{Name: "Straight Bourbon Whiskey"}, "spirits"},
		{"rose by color", model.Wine{Color: "Rosé"}, "rose"},
		{"red by color word", model.Wine{Color: "deep garnet-ruby red"}, "red"},
		{"unknown", model.Wine{Name: "Mystery Bottling"}, "other"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := bucket(tc.wine); got != tc.want {
				t.Errorf("bucket(%+v) = %q, want %q", tc.wine, got, tc.want)
			}
		})
	}
}

func TestSynthesizePromptNamesTheWineAndStudioSetting(t *testing.T) {
	w := model.Wine{
		Producer: "Domaine Hubert Lamy",
		Name:     "Saint-Aubin En Remilly",
		Vintage:  "2019",
		Varietal: "Chardonnay",
		Region:   "Burgundy",
		Color:    "white",
	}
	got := synthesizePrompt(w)
	for _, want := range []string{"2019", "Domaine Hubert Lamy", "Saint-Aubin En Remilly", "Chardonnay", "Burgundy"} {
		if !strings.Contains(got, want) {
			t.Errorf("synthesizePrompt missing %q in: %s", want, got)
		}
	}
	if !strings.Contains(strings.ToLower(got), "studio") {
		t.Errorf("synthesizePrompt should describe a studio product photograph, got: %s", got)
	}
}

func TestSynthesizePromptOmitsEmptyFieldsCleanly(t *testing.T) {
	w := model.Wine{Producer: "Someone", Name: "Something NV"}
	got := synthesizePrompt(w)
	if strings.Contains(got, "  ") || strings.Contains(got, "()") || strings.Contains(got, " from .") {
		t.Errorf("synthesizePrompt leaves artifacts for empty fields: %s", got)
	}
}

// pickRepresentative must (a) only choose wines currently on the SVG
// placeholder, (b) spread across buckets, (c) not pick two wines from the
// same producer within a bucket, and (d) be deterministic.
func TestPickRepresentativeSpreadsBucketsAndProducers(t *testing.T) {
	var wines []model.Wine
	mk := func(producer, name, varietal, color, imageSource string) model.Wine {
		return model.Wine{
			Producer: producer, Name: name, Varietal: varietal, Color: color,
			ImageSource: imageSource,
			Slug:        model.Slugify(producer, name, ""),
		}
	}
	// Two reds from the SAME producer — only one may be picked.
	wines = append(wines, mk("Alpha Cellars", "Estate Cab", "Cabernet Sauvignon", "", model.ImageGeneratedLabel))
	wines = append(wines, mk("Alpha Cellars", "Reserve Cab", "Cabernet Sauvignon", "", model.ImageGeneratedLabel))
	wines = append(wines, mk("Beta Winery", "Pinot Noir", "Pinot Noir", "", model.ImageGeneratedLabel))
	wines = append(wines, mk("Gamma Estate", "Chardonnay", "Chardonnay", "", model.ImageGeneratedLabel))
	wines = append(wines, mk("Delta House", "Blanc de Blancs", "Chardonnay", "white sparkling", model.ImageGeneratedLabel))
	wines = append(wines, mk("Epsilon Distilling", "Small Batch Bourbon", "", "amber", model.ImageGeneratedLabel))
	// A wine with a REAL image must never be picked, whatever its bucket.
	wines = append(wines, mk("Zeta Vineyards", "Merlot", "Merlot", "", model.ImageOldSite))

	got := pickRepresentative(wines, map[string]int{"red": 2, "white": 1, "sparkling": 1, "spirits": 1})

	if len(got) != 5 {
		t.Fatalf("picked %d wines, want 5", len(got))
	}
	producersInRed := map[string]bool{}
	for _, w := range got {
		if w.ImageSource != model.ImageGeneratedLabel {
			t.Errorf("picked %s which already has a real image (%s)", w.Slug, w.ImageSource)
		}
		if bucket(w) == "red" {
			if producersInRed[w.Producer] {
				t.Errorf("two red picks from the same producer %q", w.Producer)
			}
			producersInRed[w.Producer] = true
		}
	}

	again := pickRepresentative(wines, map[string]int{"red": 2, "white": 1, "sparkling": 1, "spirits": 1})
	for i := range got {
		if got[i].Slug != again[i].Slug {
			t.Fatalf("pickRepresentative is not deterministic: run1[%d]=%s run2[%d]=%s", i, got[i].Slug, i, again[i].Slug)
		}
	}
}

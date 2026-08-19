package notify

import (
	"strings"
	"testing"
)

func sampleDiff() RunDiff {
	return RunDiff{
		NewWines: []WineRef{
			{SKU: "AB1201", Producer: "Domaine Bart", Name: "Marsannay La Montagne", Vintage: "2019",
				URL: "https://finevines.com/wines/bart-marsannay-la-montagne-2019/"},
		},
		Delisted: []WineRef{
			{SKU: "MB5110", Producer: "Brezza", Name: "Langhe Chardonnay", Vintage: "2021",
				URL: "https://finevines.com/wines/brezza-langhe-chardonnay-2021/", Note: "out of stock, page kept"},
		},
		NewImages: []WineRef{
			{SKU: "PM5030", Producer: "Altocedro", Name: "Ano Cero Malbec", Vintage: "2024",
				URL:      "https://finevines.com/wines/altocedro-ano-cero-malbec-2024/",
				ImageURL: "https://finevines.com/assets/img/wines/altocedro-ano-cero-malbec-2024.jpg",
				Note:     "https://example-producer.ar/vinos/"},
		},
		QueueActions: []AppliedAction{
			{ID: "a2", SKU: "MB5110", Kind: "image-select", Reviewer: "george",
				Outcome: "text regenerated with the reviewer's note"},
		},
		Coverage: Coverage{Wines: 2619, RealImages: 574, RealImagePct: 22, MeanMetadata: 61},
	}
}

func TestRender_SubjectCountsWhatChanged(t *testing.T) {
	m := Render(sampleDiff(), "https://finevines.com")
	if !strings.HasPrefix(m.Subject, "FineVines catalog") {
		t.Errorf("Subject = %q, want it to open with the catalog name", m.Subject)
	}
	for _, want := range []string{"1 new wine", "1 delisting", "1 new photograph"} {
		if !strings.Contains(m.Subject, want) {
			t.Errorf("Subject %q is missing %q", m.Subject, want)
		}
	}
}

func TestRender_SubjectPluralisesAndOmitsEmptyCategories(t *testing.T) {
	d := RunDiff{NewWines: []WineRef{{SKU: "A"}, {SKU: "B"}}}
	m := Render(d, "https://finevines.com")
	if !strings.Contains(m.Subject, "2 new wines") {
		t.Errorf("Subject = %q, want a plural", m.Subject)
	}
	if strings.Contains(m.Subject, "delisting") || strings.Contains(m.Subject, "photograph") {
		t.Errorf("Subject = %q mentions a category with nothing in it", m.Subject)
	}
}

func TestRender_BothBodiesCarryEverySectionAndItsLinks(t *testing.T) {
	m := Render(sampleDiff(), "https://finevines.com")
	for name, body := range map[string]string{"HTMLBody": m.HTMLBody, "TextBody": m.TextBody} {
		for _, want := range []string{
			"Marsannay La Montagne",
			"https://finevines.com/wines/bart-marsannay-la-montagne-2019/",
			"Langhe Chardonnay",
			"out of stock, page kept",
			"Ano Cero Malbec",
			"https://example-producer.ar/vinos/",
			"george",
			"574",
			"22%",
			"2,619 wines published",
			"Descriptive detail — grape, region, and tasting notes — is sourced automatically and deepens with every run.",
		} {
			if !strings.Contains(body, want) {
				t.Errorf("%s is missing %q", name, want)
			}
		}
		// The old "averages N out of 100" framing reads as a failing grade to a
		// client reader and was replaced (2026-08-03). Coverage.MeanMetadata still
		// gets computed for future use; it just isn't rendered into this sentence.
		if strings.Contains(body, "out of 100") {
			t.Errorf("%s still renders the retired coverage-score sentence", name)
		}
	}
	if !strings.Contains(m.HTMLBody, `src="https://finevines.com/assets/img/wines/altocedro-ano-cero-malbec-2024.jpg"`) {
		t.Error("HTMLBody has no thumbnail for the new photograph")
	}
}

// The email is client-facing: George and Barbara read it. Two standing rules
// apply to every word of it, and a test is the only thing that keeps them
// applying as the copy is edited.
func TestRender_ObeysTheClientCopyRules(t *testing.T) {
	m := Render(sampleDiff(), "https://finevines.com")
	for name, body := range map[string]string{
		"Subject": m.Subject, "HTMLBody": m.HTMLBody, "TextBody": m.TextBody,
	} {
		// "trade" is not George's vocabulary (directed 2026-07-29).
		if strings.Contains(strings.ToLower(body), "trade") {
			t.Errorf(`%s uses the word "trade"`, name)
		}
		// No addresses anywhere the client can see (directed 2026-07-29).
		for _, banned := range []string{"P.O. Box", "PO Box", "Fax", "Illinois 60", "IL 60"} {
			if strings.Contains(body, banned) {
				t.Errorf("%s contains %q — no addresses in client-facing copy", name, banned)
			}
		}
	}
}

// Rendering is pure: the same diff must produce byte-identical output, or a
// snapshot test of the email is impossible and a "did anything change" check on
// the digest itself becomes unreliable.
func TestRender_IsDeterministic(t *testing.T) {
	a := Render(sampleDiff(), "https://finevines.com")
	b := Render(sampleDiff(), "https://finevines.com")
	if a != b {
		t.Error("Render is not deterministic for the same RunDiff")
	}
}

// HTML from the catalog has to be escaped: a producer called "Ma & Pa" must not
// break the markup.
func TestRender_EscapesCatalogText(t *testing.T) {
	d := RunDiff{NewWines: []WineRef{{SKU: "X", Producer: "Ma & Pa", Name: `Cuvée "Spéciale" <1>`,
		URL: "https://finevines.com/wines/x/"}}}
	m := Render(d, "https://finevines.com")
	if strings.Contains(m.HTMLBody, "<1>") {
		t.Error("HTMLBody did not escape catalog text")
	}
	if !strings.Contains(m.HTMLBody, "Ma &amp; Pa") {
		t.Error("HTMLBody did not escape the ampersand")
	}
	// The plain-text body must NOT be escaped — it is read as text.
	if !strings.Contains(m.TextBody, "Ma & Pa") {
		t.Error("TextBody escaped text that should stay literal")
	}
}

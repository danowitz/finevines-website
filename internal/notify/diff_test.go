package notify

import (
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

const base = "https://finevines.com"

func wine(sku, slug string, mods ...func(*model.Wine)) model.Wine {
	w := model.Wine{
		ID: sku, SKU: sku, Slug: slug, Producer: "Domaine Bart",
		Name: "Marsannay La Montagne", Vintage: "2019",
		Description: "Old prose.", EnrichedAt: "2026-07-01T00:00:00Z",
		ImagePath: "assets/img/wines/" + slug + ".svg", ImageSource: model.ImageGeneratedLabel,
		MetadataScore: 40,
	}
	for _, m := range mods {
		m(&w)
	}
	return w
}

func TestDiff_NewWineIsListedWithAnAbsoluteLink(t *testing.T) {
	after := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019")}
	d := Diff(nil, after, nil, base)

	if len(d.NewWines) != 1 {
		t.Fatalf("NewWines = %d, want 1", len(d.NewWines))
	}
	got := d.NewWines[0]
	if got.URL != "https://finevines.com/wines/bart-marsannay-la-montagne-2019/" {
		t.Errorf("URL = %q", got.URL)
	}
	if got.Producer != "Domaine Bart" || got.Vintage != "2019" {
		t.Errorf("WineRef = %+v", got)
	}
	if !d.Changed() {
		t.Error("Changed() = false with a new wine")
	}
}

func TestDiff_DelistingCoversBothGoingUnavailableAndDisappearing(t *testing.T) {
	before := []model.Wine{
		wine("AB1201", "bart-marsannay-la-montagne-2019"),
		wine("MB5110", "brezza-langhe-chardonnay-2021"),
	}
	after := []model.Wine{
		wine("AB1201", "bart-marsannay-la-montagne-2019", func(w *model.Wine) {
			w.Status = model.StatusUnavailable
		}),
		// MB5110 is gone from the catalog entirely — past its delisting grace.
	}
	d := Diff(before, after, nil, base)

	if len(d.Delisted) != 2 {
		t.Fatalf("Delisted = %d entries, want 2 (one unavailable, one dropped)", len(d.Delisted))
	}
	bySKU := map[string]WineRef{}
	for _, r := range d.Delisted {
		bySKU[r.SKU] = r
	}
	if bySKU["AB1201"].Note != "out of stock, page kept" {
		t.Errorf("AB1201 note = %q", bySKU["AB1201"].Note)
	}
	if bySKU["MB5110"].Note != "removed from the catalog" {
		t.Errorf("MB5110 note = %q", bySKU["MB5110"].Note)
	}
}

func TestDiff_TextRefreshNeedsBothANewTimestampAndNewProse(t *testing.T) {
	before := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019")}

	// Prose changed and the timestamp moved: a real refresh.
	refreshed := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019", func(w *model.Wine) {
		w.Description = "Steely and unoaked."
		w.EnrichedAt = "2026-07-29T08:15:00Z"
	})}
	if d := Diff(before, refreshed, nil, base); len(d.TextRefreshed) != 1 {
		t.Errorf("TextRefreshed = %d, want 1", len(d.TextRefreshed))
	}

	// The timestamp moved but the prose is identical — a re-enrich that landed on
	// the same words. Reporting it would fill the digest with non-events.
	restamped := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019", func(w *model.Wine) {
		w.EnrichedAt = "2026-07-29T08:15:00Z"
	})}
	if d := Diff(before, restamped, nil, base); len(d.TextRefreshed) != 0 {
		t.Errorf("TextRefreshed = %d for an identical re-enrich, want 0", len(d.TextRefreshed))
	}
}

func TestDiff_NewImageIsAPhotographReplacingALabel(t *testing.T) {
	before := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019")}
	after := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019", func(w *model.Wine) {
		w.ImagePath = "assets/img/wines/bart-marsannay-la-montagne-2019.jpg"
		w.ImageSource = model.ImageScrapedWeb
		w.ImageSourceURL = "https://example-producer.fr/vins/"
	})}
	d := Diff(before, after, nil, base)

	if len(d.NewImages) != 1 {
		t.Fatalf("NewImages = %d, want 1", len(d.NewImages))
	}
	got := d.NewImages[0]
	// The thumbnail has to be an absolute URL: it is rendered inside an email
	// client, which has no page to be relative to.
	if got.ImageURL != "https://finevines.com/assets/img/wines/bart-marsannay-la-montagne-2019.jpg" {
		t.Errorf("ImageURL = %q", got.ImageURL)
	}
	if got.Note != "https://example-producer.fr/vins/" {
		t.Errorf("Note = %q — the digest must show where the photograph came from", got.Note)
	}
}

// A wine already holding a photograph that gets a DIFFERENT photograph (a
// console swap) is a new image too — the reviewer needs to see the result of
// their own click.
func TestDiff_ASwappedPhotographCountsAsANewImage(t *testing.T) {
	before := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019", func(w *model.Wine) {
		w.ImagePath = "assets/img/wines/bart-marsannay-la-montagne-2019.jpg"
		w.ImageSource = model.ImageScrapedWeb
		w.ImageSourceURL = "https://old-source.example/"
	})}
	after := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019", func(w *model.Wine) {
		w.ImagePath = "assets/img/wines/bart-marsannay-la-montagne-2019.jpg"
		w.ImageSource = model.ImageScrapedWeb
		w.ImageSourceURL = "https://example-producer.fr/vins/"
	})}
	if d := Diff(before, after, nil, base); len(d.NewImages) != 1 {
		t.Errorf("NewImages = %d for a swapped photograph, want 1", len(d.NewImages))
	}
}

func TestDiff_CoverageUsesActivePublishedWines(t *testing.T) {
	after := []model.Wine{
		wine("A", "a", func(w *model.Wine) {
			w.ImagePath, w.ImageSource, w.MetadataScore = "assets/img/wines/a.jpg", model.ImageScrapedWeb, 80
		}),
		wine("B", "b", func(w *model.Wine) { w.MetadataScore = 40 }),
		wine("C", "c", func(w *model.Wine) { w.MetadataScore = 30 }),
		wine("D", "d", func(w *model.Wine) {
			w.ImagePath, w.ImageSource, w.MetadataScore = "assets/img/wines/d.jpg", model.ImageOldSite, 90
			w.Status = model.StatusUnavailable
		}),
	}
	d := Diff(nil, after, nil, base)
	if d.Coverage.Wines != 3 {
		t.Errorf("Coverage.Wines = %d, want 3 active published rows", d.Coverage.Wines)
	}
	if d.Coverage.RealImages != 1 || d.Coverage.RealImagePct != 33 {
		t.Errorf("Coverage images = %d (%d%%), want 1 (33%%)", d.Coverage.RealImages, d.Coverage.RealImagePct)
	}
	if d.Coverage.MeanMetadata != 50 { // (80+40+30)/3; unavailable D is excluded
		t.Errorf("Coverage.MeanMetadata = %d, want 50", d.Coverage.MeanMetadata)
	}
}

// A run that only drained the queue still changed something.
func TestDiff_QueueActionsAloneCountAsAChange(t *testing.T) {
	same := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019")}
	d := Diff(same, same, []AppliedAction{
		{ID: "a3", SKU: "AB1201", Kind: "image-select", Reviewer: "george", Outcome: "selected image prepared for deployment"},
	}, base)
	if !d.Changed() {
		t.Error("Changed() = false with a queue action applied")
	}
}

// The silence guarantee: an unchanged nightly run must produce no email at all.
func TestDiff_AnUnchangedRunHasNotChanged(t *testing.T) {
	same := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019")}
	if Diff(same, same, nil, base).Changed() {
		t.Error("Changed() = true for an identical before/after — the digest would be sent every night")
	}
}

// A trailing slash on the configured base URL must not double up in the links.
func TestDiff_BaseURLTrailingSlashIsTolerated(t *testing.T) {
	after := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019")}
	d := Diff(nil, after, nil, "https://finevines.com/")
	if d.NewWines[0].URL != "https://finevines.com/wines/bart-marsannay-la-montagne-2019/" {
		t.Errorf("URL = %q", d.NewWines[0].URL)
	}
}

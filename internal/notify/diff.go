// Package notify turns one pipeline run into the digest email that closes the
// loop on it.
//
// Images now publish themselves behind two automated gates, which means the
// email is the only thing standing between a wrong bottle going live and a human
// noticing. So the digest has one job: say what changed, link to it, and be
// short enough that it is still being read in six months. That last constraint
// is why Diff is fussy about what counts as a change — a re-enrich that landed
// on the same words, or a nightly run that found nothing, must produce NOTHING,
// because a digest that arrives every night saying "no changes" is a digest
// nobody opens.
//
// Diff and Render are pure functions over two catalog snapshots. Only
// SMTPSender touches the network, behind the Sender interface, so no test ever
// sends mail to anyone.
package notify

import (
	"math"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/queue"
)

// WineRef is one wine as the digest names it: enough to recognise, plus the two
// absolute URLs an email client needs (it has no page to be relative to).
//
// Note is the per-list reason the wine is here — why it was delisted, where its
// new photograph came from — rather than a field of the wine itself.
type WineRef struct {
	SKU      string
	Slug     string
	Producer string
	Name     string
	Vintage  string
	URL      string
	ImageURL string
	Note     string
}

// Coverage is the catalog-health line the client actually asked for: how much of
// the portfolio has a real photograph, and how much of the displayed metadata
// was sourced rather than inferred.
type Coverage struct {
	Wines        int
	RealImages   int
	RealImagePct int
	MeanMetadata int
}

// RunDiff is everything one digest reports.
type RunDiff struct {
	NewWines      []WineRef
	Delisted      []WineRef
	TextRefreshed []WineRef
	NewImages     []WineRef
	QueueActions  []queue.Applied
	Coverage      Coverage
}

// Changed reports whether this run altered anything worth an email. Coverage is
// deliberately NOT part of the test: it is computed over the whole catalog every
// run and drifts by a fraction of a percent on its own, which would make every
// run look like a change.
func (d RunDiff) Changed() bool {
	return len(d.NewWines) > 0 || len(d.Delisted) > 0 || len(d.TextRefreshed) > 0 ||
		len(d.NewImages) > 0 || len(d.QueueActions) > 0
}

// Diff compares the catalog as it stood at the start of the run against the
// catalog the run produced.
//
// Keyed by ID (the Salesforce record ID), not slug: a slug changes when a wine
// is renamed or re-vintaged, and a slug-keyed diff would report one rename as a
// delisting plus a brand-new wine.
func Diff(before, after []model.Wine, applied []queue.Applied, siteBaseURL string) RunDiff {
	root := strings.TrimRight(siteBaseURL, "/")

	beforeByID := make(map[string]model.Wine, len(before))
	for _, w := range before {
		beforeByID[w.ID] = w
	}
	afterByID := make(map[string]model.Wine, len(after))
	for _, w := range after {
		afterByID[w.ID] = w
	}

	d := RunDiff{QueueActions: applied}

	for _, w := range after {
		prev, existed := beforeByID[w.ID]
		if !existed {
			d.NewWines = append(d.NewWines, ref(root, w, ""))
			continue
		}
		// Going unavailable: the page stays published (preserving its search
		// ranking) but the wine leaves the portfolio, so it is worth reporting.
		if prev.Status != model.StatusUnavailable && w.Status == model.StatusUnavailable {
			d.Delisted = append(d.Delisted, ref(root, w, "out of stock, page kept"))
		}
		// A text refresh needs BOTH a moved timestamp and different prose. The
		// timestamp alone moves on every successful re-enrich, including ones
		// that produce the identical paragraph, and those are not news.
		if prev.EnrichedAt != w.EnrichedAt && proseChanged(prev, w) {
			d.TextRefreshed = append(d.TextRefreshed, ref(root, w, ""))
		}
		// A new image is any real photograph the wine did not have in this exact
		// form before: a first photo replacing the SVG label, or a console swap
		// replacing one photo with another. The reviewer who clicked swap needs
		// to see the result of their own click.
		if isPhoto(w) && (prev.ImagePath != w.ImagePath || prev.ImageSourceURL != w.ImageSourceURL) {
			d.NewImages = append(d.NewImages, ref(root, w, w.ImageSourceURL))
		}
	}

	// Wines that left the catalog entirely — past the delisting grace period, or
	// withheld on purpose. There is no `after` record to link to, so the
	// reference is built from the `before` one; the URL 301s to /portfolio/ via
	// the lifecycle redirect map.
	for _, w := range before {
		if _, still := afterByID[w.ID]; !still {
			d.Delisted = append(d.Delisted, ref(root, w, "removed from the catalog"))
		}
	}

	d.Coverage = coverageOf(after)
	return d
}

// proseChanged reports whether any of the written fields actually differ. Kept
// separate from the timestamp test so "re-enriched" and "re-enriched to
// something new" stay distinguishable.
func proseChanged(a, b model.Wine) bool {
	return a.Description != b.Description ||
		a.SommelierNotes != b.SommelierNotes ||
		a.Aroma != b.Aroma || a.Palate != b.Palate || a.Finish != b.Finish ||
		strings.Join(a.FoodPairings, "|") != strings.Join(b.FoodPairings, "|")
}

// isPhoto reports whether the wine's image is a real photograph rather than the
// generated SVG label or an AI-generated bottle. It reuses
// model.ImageFieldSource so this can never drift from how the coverage score
// classifies the same value.
func isPhoto(w model.Wine) bool {
	return model.ImageFieldSource(w.ImageSource) == model.SourceFound
}

func coverageOf(wines []model.Wine) Coverage {
	c := Coverage{Wines: len(wines)}
	if len(wines) == 0 {
		return c
	}
	sum := 0
	for _, w := range wines {
		sum += w.MetadataScore
		if isPhoto(w) {
			c.RealImages++
		}
	}
	c.RealImagePct = int(math.Round(100 * float64(c.RealImages) / float64(len(wines))))
	c.MeanMetadata = int(math.Round(float64(sum) / float64(len(wines))))
	return c
}

// ref builds a WineRef with both absolute URLs. The image URL is left empty for
// a wine on the SVG label: an email client rendering a vector label at thumbnail
// size adds nothing a reader can judge.
func ref(root string, w model.Wine, note string) WineRef {
	r := WineRef{
		SKU: w.SKU, Slug: w.Slug, Producer: w.Producer, Name: w.Name,
		Vintage: w.Vintage, URL: root + "/wines/" + w.Slug + "/", Note: note,
	}
	if isPhoto(w) && w.ImagePath != "" {
		r.ImageURL = root + "/" + strings.TrimPrefix(w.ImagePath, "/")
	}
	return r
}

// Package model holds the shared data contract between enrich (producer),
// the Claude skills (producers), and build (consumer). JSON tags are the
// contract from the design spec §3 — do not rename without a spec change.
package model

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ImageSource values (Wine.ImageSource) record how a wine's image was obtained.
// The first three are the original generated/producer set; the scraped-* pair
// is the search-scrape chain's real-image outcomes.
const (
	ImageGeneratedPhoto   = "generated-photo"   // legacy value; migrated away and never newly produced
	ImageGeneratedLabel   = "generated-label"   // legacy persisted key for the neutral unavailable-image SVG
	ImageProducerSupplied = "producer-supplied" // supplied by the producer/importer
	ImageOldSite          = "old-site"          // FineVines' own photo, harvested from the old finevines.com
	ImageScrapedWeb       = "scraped-web"       // real bottle/label image found via web search
	ImageScrapedGoogle    = "scraped-google"    // real image via Google image-search fallback
	ImageReviewerSupplied = "reviewer-supplied" // image explicitly selected and pasted by an authorized catalog reviewer
	// ImageLabelScan marks a flat label scan wearing a wine's image slot — the
	// old finevines.com photographed LABELS, not bottles (audit 2026-08-04:
	// 468 of 492 old-site images), and some scraped finds are the same. A scan
	// renders (better than nothing) but is a stand-in like a generated photo:
	// replaceable by any real bottle shot, hunted by the fetch pipeline, and
	// preserved (not SVG-downgraded) across re-enrichment.
	ImageLabelScan = "label-scan"
)

// FieldSource records where one enriched field's value came from, so the
// catalog can report how much of a wine's displayed metadata is real (sourced)
// versus inferred from varietal/region — the coverage the client asked to see.
type FieldSource string

const (
	SourceSalesforce FieldSource = "salesforce" // authoritative field straight from the org
	SourceFound      FieldSource = "found"      // extracted from a real web source (kept in Wine.Sources)
	SourceDerived    FieldSource = "derived"    // inferred from varietal + region + style, no wine-specific source
	SourceMissing    FieldSource = "missing"    // could not be determined
)

// ScoredFields is the canonical set of displayable enriched fields the
// MetadataScore is computed over — "the metadata we want to display" whose
// real-vs-inferred ratio the score reports. The Salesforce-authoritative
// identity inputs (producer, name, vintage, varietal, region) are the GIVENS
// everything else is derived from, so they are deliberately not scored.
var ScoredFields = []string{
	"description", "sommelierNotes", "aroma", "palate", "finish", "foodPairings",
	"appellation", "country", "color", "abv", "bottleSize", "drinkWindow", "image",
}

// MetadataScore returns 0–100: the share of ScoredFields whose value is REAL
// (SourceSalesforce or SourceFound) rather than inferred (SourceDerived) or
// absent (SourceMissing). It answers "how much of the displayed metadata did we
// actually source versus infer from varietal/region." A field absent from the
// map counts as missing.
func MetadataScore(sources map[string]FieldSource) int {
	if len(ScoredFields) == 0 {
		return 0
	}
	real := 0
	for _, f := range ScoredFields {
		switch sources[f] {
		case SourceSalesforce, SourceFound:
			real++
		}
	}
	return int(math.Round(100 * float64(real) / float64(len(ScoredFields))))
}

// ParseFieldSource maps a provenance string (as reported by the enrichment
// step) to a FieldSource, defaulting anything unrecognized — including "" — to
// SourceMissing so an omitted or malformed value never counts as real.
func ParseFieldSource(s string) FieldSource {
	switch FieldSource(s) {
	case SourceSalesforce:
		return SourceSalesforce
	case SourceFound:
		return SourceFound
	case SourceDerived:
		return SourceDerived
	default:
		return SourceMissing
	}
}

// ImageFieldSource classifies an ImageSource value for provenance scoring: a
// producer-supplied or scraped real image counts as found; a legacy generated
// photo or the SVG-label fallback counts as derived; empty is missing. Callers
// set Wine.Sources["image"] = ImageFieldSource(w.ImageSource) so the image
// participates in MetadataScore consistently.
func ImageFieldSource(imageSource string) FieldSource {
	switch imageSource {
	case ImageProducerSupplied, ImageOldSite, ImageScrapedWeb, ImageScrapedGoogle, ImageReviewerSupplied:
		return SourceFound
	case "":
		return SourceMissing
	default: // generated-photo, generated-label, label-scan
		return SourceDerived
	}
}

// StatusUnavailable marks a wine retained in the catalog data but currently
// out of stock: its detail page stays published (preserving any search
// ranking) while it is hidden from the portfolio, facets, search index, and
// sitemap. An empty Status means active. Wines withheld on purpose
// (ready-to-sell = false) or gone from the org are never retained — see
// enrich.Delist.
const StatusUnavailable = "unavailable"

// Image-review statuses are durable catalog instructions. NoMatch records a
// completed human rejection; Required records a review recovery action and
// prevents automated image import until a reviewer makes a fresh decision.
const (
	ImageReviewNoMatch  = "no-match"
	ImageReviewRequired = "needs-review"
)

// Wine is one row of data/wines.json — the enrich pipeline's output and
// build's primary input. JSON tags are the contract — do not rename existing
// ones without a spec change; new descriptive fields are additive and
// omitempty so older rows stay valid.
type Wine struct {
	// Identity & commercial — Salesforce-authoritative.
	ID         string `json:"id"`
	SourceHash string `json:"sourceHash"`
	SKU        string `json:"sku"`
	Producer   string `json:"producer"`
	Name       string `json:"name"`
	Vintage    string `json:"vintage"`
	StockQty   int    `json:"stockQty"`
	// StockCases is the on-hand quantity in CASES, verbatim from Salesforce
	// (FV_OnHand_Qty__c) — fractional part = a broken case. StockQty above is
	// its ceiled shadow (kept for the eligibility test and for older data
	// written before this field existed). See catalog.OnHandCases.
	StockCases float64 `json:"stockCases,omitempty"`
	// CasePack is bottles-per-case from Salesforce (FV_Bottles_Per_Case__c).
	// 0 = unknown; catalog.PackOf falls back to name parsing, then 12.
	CasePack int `json:"casePack,omitempty"`

	// Classification.
	Varietal    string `json:"varietal"`
	Region      string `json:"region"`
	Appellation string `json:"appellation"`
	Country     string `json:"country,omitempty"`
	Color       string `json:"color,omitempty"`
	Style       string `json:"style"`

	// Tasting — facts are sourced or derived, but the prose is always written
	// original (never lifted verbatim) even when the underlying facts scraped.
	Description    string   `json:"description"`
	SommelierNotes string   `json:"sommelierNotes"`
	Aroma          string   `json:"aroma,omitempty"`
	Palate         string   `json:"palate,omitempty"`
	Finish         string   `json:"finish,omitempty"`
	FoodPairings   []string `json:"foodPairings,omitempty"`

	// Technical.
	ABV         string `json:"abv,omitempty"`
	BottleSize  string `json:"bottleSize,omitempty"`
	DrinkWindow string `json:"drinkWindow,omitempty"`

	// Media.
	ImagePath      string `json:"imagePath"`
	ImageSource    string `json:"imageSource"`
	ImageSourceURL string `json:"imageSourceUrl,omitempty"`
	// ImageReviewStatus records either an explicit human no-match decision or a
	// review recovery action that requires another human decision. A no-match
	// prevents the rolling package from repeating a rejected set; needs-review
	// prevents automated import from bypassing the reopened review. The action ID
	// is the durable idempotency key for completed decisions.
	ImageReviewStatus   string `json:"imageReviewStatus,omitempty"`
	ImageReviewedAt     string `json:"imageReviewedAt,omitempty"`
	ImageReviewActionID string `json:"imageReviewActionId,omitempty"`

	// Enrichment provenance & scoring. Sources maps each ScoredFields key to
	// where its value came from; MetadataScore is derived from it. MatchConfidence
	// (0–100) is how sure the enricher is it matched the right wine, set by the
	// search step. EnrichedAt is an RFC3339 timestamp of the last enrich pass.
	Sources         map[string]FieldSource `json:"sources,omitempty"`
	MetadataScore   int                    `json:"metadataScore"`
	MatchConfidence int                    `json:"matchConfidence"`
	EnrichedAt      string                 `json:"enrichedAt,omitempty"`

	Slug string `json:"slug"`

	// Lifecycle. Empty Status = active. DelistedAt is the RFC3339 UTC time
	// the wine was last seen going out of stock; enrich.Delist drops the
	// page entirely once this exceeds the grace period.
	Status     string `json:"status,omitempty"`
	DelistedAt string `json:"delistedAt,omitempty"`
}

// ReopenImageReview applies the catalog side of a review recovery action. The
// old decision cannot remain attached to a new wine revision, while Required
// keeps fresh discovery from bypassing the human review console.
func (w *Wine) ReopenImageReview(fallbackPath string) {
	w.SetImage(fallbackPath, ImageGeneratedLabel, "")
	w.ImageReviewStatus = ImageReviewRequired
	w.ImageReviewedAt = ""
	w.ImageReviewActionID = ""
}

// SetImage applies the coupled image and provenance fields for one catalog row.
// Review identity remains separate because an action is bound to one specific
// wine revision even when several rows share the same public-slug image bytes.
func (w *Wine) SetImage(imagePath, imageSource, imageSourceURL string) {
	w.ImagePath = imagePath
	w.ImageSource = imageSource
	w.ImageSourceURL = imageSourceURL
	if w.Sources == nil {
		w.Sources = make(map[string]FieldSource)
	}
	w.Sources["image"] = ImageFieldSource(imageSource)
	w.MetadataScore = MetadataScore(w.Sources)
}

// NewsPost is one data/news/<slug>.json file.
type NewsPost struct {
	Title    string `json:"title"`
	Date     string `json:"date"` // YYYY-MM-DD
	Category string `json:"category"`
	Body     string `json:"body"`
	Image    string `json:"image,omitempty"`
	Slug     string `json:"slug"`
}

// TeamMember is one entry of data/team.json.
type TeamMember struct {
	Name      string `json:"name"`
	Role      string `json:"role"`
	Email     string `json:"email"`
	PhotoPath string `json:"photoPath,omitempty"`
	Note      string `json:"note,omitempty"`
}

// ContactInfo is the single source of truth for the public phone and email
// rendered on the contact page and in the shared footer. The street address
// and fax number were removed 2026-07-29 (client direction: no addresses
// published anywhere on the site).
type ContactInfo struct {
	PhoneDisplay string `json:"phoneDisplay"`
	PhoneHref    string `json:"phoneHref"`
	Email        string `json:"email"`
}

// SiteContent holds the small amount of hand-curated, site-wide content that
// is neither Salesforce-owned wine/team data nor office-managed news data.
// ContactConfirmed is deployment evidence: production remains blocked until
// the client has explicitly approved the organization-wide contact values.
type SiteContent struct {
	Contact           ContactInfo `json:"contact"`
	ContactConfirmed  bool        `json:"contactConfirmed"`
	FeaturedWineSlugs []string    `json:"featuredWineSlugs"`
	// BookProducers optionally overrides the homepage Book band's producer
	// roll with the client's own shortlist (matched case-insensitively
	// against the catalog; unknown names are skipped). Empty ⇒ the roll
	// derives from the catalog's deepest holdings (build.bookProducers).
	BookProducers []string `json:"bookProducers,omitempty"`
	// Testimonial is the contact page's account quote, rendered only when
	// Quote is non-empty. TestimonialConfirmed is the same deployment
	// evidence as ContactConfirmed: the block may render on preview builds,
	// but a production deploy with an UNCONFIRMED (drafted, not
	// client-approved) testimonial is a launch blocker — a fabricated quote
	// presented as a real account's words is worse than no quote at all.
	Testimonial          Testimonial `json:"testimonial,omitempty"`
	TestimonialConfirmed bool        `json:"testimonialConfirmed"`
}

// Testimonial is one account quote (see SiteContent.Testimonial).
type Testimonial struct {
	Quote       string `json:"quote"`
	Attribution string `json:"attribution"`
}

// LoadSiteContent reads required site-wide content and rejects incomplete
// contact records. Unlike wines.json's first-run behavior, site.json is
// required: silently falling back here would recreate the duplicated contact
// constants this file exists to eliminate.
func LoadSiteContent(path string) (SiteContent, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return SiteContent{}, err
	}
	var content SiteContent
	if err := json.Unmarshal(data, &content); err != nil {
		return SiteContent{}, err
	}
	required := []struct{ field, value string }{
		{"contact.phoneDisplay", content.Contact.PhoneDisplay},
		{"contact.phoneHref", content.Contact.PhoneHref},
		{"contact.email", content.Contact.Email},
	}
	for _, item := range required {
		if strings.TrimSpace(item.value) == "" {
			return SiteContent{}, fmt.Errorf("%s is required in %s", item.field, path)
		}
	}
	return content, nil
}

// LoadWines reads and parses path as JSON. A missing file is not an error:
// it returns an empty slice and a nil error (first-run behavior).
func LoadWines(path string) ([]Wine, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return []Wine{}, nil
	}
	if err != nil {
		return nil, err
	}
	var wines []Wine
	if err := json.Unmarshal(data, &wines); err != nil {
		return nil, err
	}
	return wines, nil
}

// SaveWines writes wines to path as pretty-printed JSON sorted by slug
// (deterministic for clean diffs); the caller's slice is not modified.
//
// The write is atomic: data is written to a temp file created alongside
// path (same directory, so the later rename stays on one filesystem), then
// renamed into place. Enrich rewrites data/wines.json every 50 wines during
// the initial 5-10k-wine run as its crash-safety checkpoint; a plain
// os.WriteFile that crashes mid-write would leave a truncated file that
// fails LoadWines on resume, defeating the whole point of checkpointing.
// os.Rename is atomic on the same filesystem, so a reader (including a
// resumed enrich run) only ever observes the old complete file or the new
// complete file, never a partial one.
func SaveWines(path string, wines []Wine) error {
	sorted := append([]Wine(nil), wines...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Slug < sorted[j].Slug })
	data, err := json.MarshalIndent(sorted, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename below has succeeded

	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

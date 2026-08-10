// Package build renders data/*.json into a complete static site in dist/.
// It is a pure function of its inputs: no network, no clocks, no randomness —
// the same data must produce a byte-identical dist/ (tested in Task 9).
package build

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/catalog"
	"github.com/gritautomation/finevines-website/internal/label"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// redirectsJSONName is both the file redirects.Save writes at the repo root
// (internal/redirects/mapping.go's Save, invoked from cmd/finevines's
// runRedirects — the SAME location mergeRedirects is pointed at it here) and
// the filename it's published under in dist/. `finevines build` and
// `finevines redirects` are both always run from the repo root
// (cmd/finevines/main.go's runBuild/runRedirects pass bare relative paths
// like "data" and "redirects.json"), so reading this literal name from the
// process's cwd is the correct, consistent lookup.
const redirectsJSONName = "redirects.json"

// site is the seam between loadSite (producer) and every page template
// (consumer): the full data set behind one build run. Tasks 6-8 read
// Wines/News/Team from here to add the portfolio, wine-detail, news, and
// about pages without changing this struct's shape.
type site struct {
	Wines []model.Wine
	// Delisted holds unavailable wines (model.StatusUnavailable) split out of
	// Wines at load time: they still render their own detail page (any search
	// ranking they earned survives the stock-out) but must never appear on any
	// browse surface. Because every existing consumer of Wines — the
	// portfolio, facets, catalog index, search, sitemap, featured picks, and
	// hot-sellers — was written before this field existed, none of them need
	// to change: Wines being active-only excludes Delisted wines BY
	// CONSTRUCTION rather than by each consumer remembering to filter.
	Delisted []model.Wine
	News     []model.NewsPost
	Team     []model.TeamMember
	Content  model.SiteContent
	BaseURL  string
	// GAID is the Google Analytics 4 measurement ID (G-XXXXXXXXXX), promoted
	// through page's embedded *site so base.html.tmpl's head can emit the
	// gtag snippet. Empty by default (analytics off) — which keeps the build
	// output deterministic and byte-identical unless a real ID is configured.
	GAID string
	// Content-hashed URLs for the fixed CSS/JS assets (fingerprintAsset).
	// site.css etc. are referenced from every page; serving them unversioned
	// means a CDN keeps handing out the old stylesheet against new HTML after
	// a deploy (and the portfolio JS↔template hook contract breaks the same
	// way). Hashing the filename makes each deploy self-busting, like the
	// catalog-index.
	CSSURL         string
	NavJSURL       string
	PortfolioJSURL string
	FiltersJSURL   string
	// HotSellerSlugs is data/hot-sellers.json's ranking (best first), loaded
	// by loadSite; Run resolves it against the catalog into the homepage's
	// HotSellers section. Empty (file absent/thin) ⇒ no section.
	HotSellerSlugs []string
	// AccountsServed is data/accounts.json's distinct-accounts-invoiced count
	// (trailing year), loaded by loadSite for the homepage credibility
	// ledger. Zero (file absent) ⇒ the ledger omits its accounts entry.
	AccountsServed int
}

// page is the template data shared by every page: the site's data plus this
// page's own metadata. Embedding *site promotes Wines/News/Team/BaseURL so
// the head/header/footer templates can reach them through a single dot,
// alongside Title/Description/Path for this specific page. Page types that
// need extra data (see homePage below) embed page the same way.
type page struct {
	*site
	Title       string
	Description string
	Path        string // absolute path from the site root, e.g. "/" or "/contact/"
	// OGImage is this page's social-share image, site-relative and WITHOUT a
	// leading slash (same convention as model.Wine.ImagePath). Empty means
	// "use the site default" — see OGImageURL. The wine detail page overrides
	// it to the wine's own photo, but only for raster formats (see isRasterImage).
	OGImage string
	// CanonicalPath overrides which URL search engines should treat as this
	// content's address. Empty — the normal case — means the page is its own
	// canonical. Set only where the site knowingly publishes near-duplicate
	// pages: vintages of one wine that share copied prose (see
	// canonicalVintage). Never a redirect: the page stays published, linked,
	// and reachable; it simply defers ranking to the page it duplicates.
	CanonicalPath string
}

// Canonical is the path this page declares as its own address. Used by
// base.html.tmpl's <link rel="canonical"> and by the sitemap, which must
// advertise canonical URLs only.
func (p page) Canonical() string {
	if p.CanonicalPath != "" {
		return p.CanonicalPath
	}
	return p.Path
}

// isCanonical reports whether this page is the canonical version of its own
// content — i.e. whether the sitemap should list it.
func (p page) isCanonical() bool { return p.CanonicalPath == "" || p.CanonicalPath == p.Path }

// defaultOGImage is the branded 1200x630 share image every page falls back to
// (committed asset, generated by tools/ogimage). Stored WITHOUT a leading
// slash to match ImagePath, so OGImageURL can join it the same way the wine
// JSON-LD joins .Wine.ImagePath: BaseURL + "/" + path.
const defaultOGImage = "assets/img/og-default.png"

// OGImageURL returns the ABSOLUTE URL of this page's Open Graph / Twitter
// share image — required, since Facebook/LinkedIn/X will not fetch a relative
// og:image. It mirrors wine.html.tmpl's JSON-LD image join (BaseURL + "/" +
// site-relative path) and falls back to the branded default when the page set
// no per-page image. Promoted to every page data type through page embedding,
// so head.tmpl reaches it as .OGImageURL on any page.
func (p page) OGImageURL() string {
	img := p.OGImage
	if img == "" {
		img = defaultOGImage
	}
	return p.BaseURL + "/" + img
}

// isRasterImage reports whether path is a raster format usable as an og:image.
// SVG (and any non-raster) is excluded on purpose: Facebook, LinkedIn, and X
// do NOT render SVG social images, so a wine whose only art is a generated
// vector label must fall back to the branded default PNG rather than emit an
// og:image the scrapers will drop. WebP is likewise excluded — its OG support
// is inconsistent across the major scrapers — leaving only the safe, always-
// rendered .jpg/.jpeg/.png.
func isRasterImage(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".jpg", ".jpeg", ".png":
		return true
	default:
		return false
	}
}

// pagePath returns this page's site-root-relative Path. Because every page
// data type (homePage, portfolioPage, winePage, ...) embeds page rather
// than naming it as a field, Go's method promotion gives all of them this
// method for free — so Run can collect the exact path each page was
// rendered with (for the sitemap) straight from the same value that page's
// own <link rel="canonical"> used, instead of re-deriving or hand-listing
// URLs elsewhere.
func (p page) pagePath() string { return p.Path }

// homePage adds the homepage's own derived data (its latest-news digest) on
// top of the shared page contract.
type homePage struct {
	page
	LatestNews    []model.NewsPost
	FeaturedWines []model.Wine
	// Book is "The Book" band: the house judged by its portfolio (see
	// bookProducers). No Producers ⇒ no band.
	Book bookBand
	// Ledger is the credibility band under the hero: counts the live catalog
	// can actually back (see ledgerStats). Empty (thin catalog) ⇒ no band.
	Ledger []ledgerStat
	// HotSellers is the sales-driven "what Illinois is pouring" section:
	// wines resolved from data/hot-sellers.json's ranking. Deliberately
	// rendered WITHOUT sales volumes — case velocity is competitively
	// sensitive for a distributor, so the ranking curates and never counts.
	HotSellers []model.Wine
}

// bookProducer is one name in the Book band's roll, linking to its filtered
// portfolio view. It deliberately uses catalog facts only; the site does not
// invent producer biographies before FineVines supplies them.
type bookProducer struct {
	Name string
	URL  string
}

// bookBand is the homepage's "The Book" section: in the wholesale wine
// business a house is judged by its book, so the band name-drops the
// portfolio's deepest holdings — borrowed credibility from names the
// audience already respects. The roll derives from the catalog (see
// bookProducers) until site.json's bookProducers override supplies George's
// own picks: which suppliers get billing is an allocation-politics call
// that belongs to the client, not the pipeline.
type bookBand struct {
	// CountLabel is the lede's "310 growers and estates" phrase, or the
	// generic "growers and estates" when the count is too small to impress
	// (same anti-credibility rationale as minLedgerWines).
	CountLabel string
	Producers  []bookProducer
}

// ledgerStat is one entry in the homepage's credibility band: a count the
// live catalog can actually back, presented as plain fact. Counts, never
// superlatives — "largest" is a claim the trade would snort at, "310
// producers" is a ledger line the portfolio verifies one click away.
type ledgerStat struct {
	Value string
	Label string
}

// minLedgerWines is the floor under the credibility band. Small counts read
// as anti-credibility (a band boasting "12 wines" does the opposite of its
// job), so thin catalogs — mock runs, tests, a mid-migration build — omit
// the band entirely rather than shrink it.
const minLedgerWines = 100

// minLedgerAccounts is the same floor for the accounts-served entry: below
// it the entry is omitted (the rest of the band still renders).
const minLedgerAccounts = 50

// ledgerStats derives the homepage credibility band from the catalog plus
// the accounts-served count (data/accounts.json; 0 when absent). The wine
// count is floored to the nearest hundred ("2,600+") and accounts to the
// nearest fifty ("500+") so the figures stay true as stock moves and
// accounts churn between refreshes — and so the exact counts (mildly
// competitively sensitive) are never published. Producer and region counts
// are exact distinct values. The closing tenure entry restates the About
// page's client-confirmed "200+ years" copy — the one line not derived from
// data files. Fields with no data are skipped, never zero-filled.
func ledgerStats(wines []model.Wine, accounts int) []ledgerStat {
	if len(wines) < minLedgerWines {
		return nil
	}
	producers := make(map[string]struct{})
	regions := make(map[string]struct{})
	for _, w := range wines {
		if p := strings.TrimSpace(w.Producer); p != "" {
			producers[p] = struct{}{}
		}
		if r := strings.TrimSpace(w.Region); r != "" {
			regions[r] = struct{}{}
		}
	}
	stats := []ledgerStat{{Value: comma(len(wines)/100*100) + "+", Label: "Wines in Portfolio"}}
	if len(producers) > 0 {
		stats = append(stats, ledgerStat{Value: comma(len(producers)), Label: "Producers Represented"})
	}
	if len(regions) > 0 {
		stats = append(stats, ledgerStat{Value: comma(len(regions)), Label: "Regions of Origin"})
	}
	if accounts >= minLedgerAccounts {
		stats = append(stats, ledgerStat{Value: comma(accounts/50*50) + "+", Label: "Accounts Served"})
	}
	return append(stats, ledgerStat{Value: "200+", Label: "Years in the Business, Combined"})
}

// winePage carries one wine plus the shared page contract (Title/Description/
// Path/BaseURL) that base.html.tmpl's head/header/footer require. Because it
// embeds page (which embeds *site), the wine template reaches BaseURL as
// .BaseURL and this wine's own fields as .Wine.*.
type winePage struct {
	page
	Wine model.Wine
	// Unavailable marks a delisted (model.StatusUnavailable) wine's own
	// detail page: still rendered (any search ranking it earned survives the
	// stock-out) but with the JSON-LD offer flipped to OutOfStock and a
	// visible unavailable notice in place of the normal availability markup.
	Unavailable bool
	// OtherVintages are this wine's other years, newest first, excluding this
	// page's own. The portfolio collapses vintages to a single card that links
	// only the newest release, so without these links every older vintage is
	// an orphan reachable from sitemap.xml alone. Empty for a wine with one
	// vintage, and the template renders nothing at all in that case.
	OtherVintages []vintageLink
	// ProducerURL / RegionURL / VarietalURL are this wine's links UP into the
	// collection pages, or "" when no collection was published for that value (see
	// publishedCollections — collections are built from cards, detail pages
	// from rows, and the two do not always carry the same region). Empty means
	// the template
	// shows the value as plain text rather than a link to a 404.
	ProducerURL string
	RegionURL   string
	VarietalURL string
	// Crumbs is the breadcrumb trail, ending with this wine itself. It drives
	// both the visible nav and the BreadcrumbList JSON-LD, so the two can
	// never describe different paths.
	Crumbs []crumb
}

// crumb is one step of a breadcrumb trail: a label and the page it points at.
// The final crumb points at the current page, which is what schema.org's
// BreadcrumbList expects.
type crumb struct {
	Name string
	URL  string
}

// vintageLink is one year of a wine and the detail page that year lives on.
type vintageLink struct {
	Year string
	Slug string
}

// Label is the link's anchor text. Champagne, sherry and most sparkling wine
// ship non-vintage, which catalog.Build carries as an empty Year — rendering
// that verbatim would emit an empty <a></a>: unclickable, silent to a screen
// reader, and useless as the anchor text these links exist to provide.
func (v vintageLink) Label() string {
	if strings.TrimSpace(v.Year) == "" {
		return "NV"
	}
	return v.Year
}

// ldProp is one schema.org PropertyValue (name/value) for the wine's Product
// JSON-LD additionalProperty array.
type ldProp struct{ Name, Value string }

// LDProps returns the enriched, non-empty descriptive fields as JSON-LD
// PropertyValues, so search engines see the structured facts (country, ABV,
// drink window, etc.) that the visible facts grid shows. Empty fields are
// omitted, so a lightly-enriched wine simply carries fewer properties. The
// wine template ranges this to emit a comma-clean array.
func (w winePage) LDProps() []ldProp {
	var p []ldProp
	add := func(name, value string) {
		if strings.TrimSpace(value) != "" {
			p = append(p, ldProp{Name: name, Value: value})
		}
	}
	add("Country", w.Wine.Country)
	add("Region", w.Wine.Region)
	add("Appellation", w.Wine.Appellation)
	add("Varietal", w.Wine.Varietal)
	add("Colour", w.Wine.Color)
	add("Style", w.Wine.Style)
	add("Alcohol by volume", w.Wine.ABV)
	add("Bottle size", w.Wine.BottleSize)
	add("Drink window", w.Wine.DrinkWindow)
	return p
}

// facetGroup is one filter group in the portfolio sidebar: a facet key and
// its distinct values across the whole (cleaned) wine list, sorted for
// determinism. Facet must exactly match one of portfolio.js's FACET_KEYS
// (producer/region/varietal/country/vintage) — the template emits it as each
// checkbox's data-facet attribute AND as the URL query-param name, which is
// how the JS groups selections and round-trips them through the URL. Values
// span the ENTIRE catalog (not just one paginated page) because the client
// engine filters against the full catalog-index, so every possible facet
// value must be offered on every page.
type facetGroup struct {
	Facet string
	Label string
	// Values is the SEED only — the top facetSeedSize values by wine count for
	// a Big group, or every value for a small one. It is not the whole set.
	// portfolio.js rebuilds each group from the catalog-index once it loads,
	// which is where the remaining ~493 values come from. Seeding rather than
	// emitting all 577 values on all ~56 paginated pages is what takes the
	// portfolio page from ~147KB to under 100KB; the values themselves lose no
	// crawlable surface, since every producer/region/varietal already appears
	// as body text on its own /wines/<slug>/ page.
	Values []facetValue
	// Total is the number of DISTINCT values across the whole catalog, not the
	// number seeded. It drives the group header's count and the "Show all N
	// producers" expander label before the JS has loaded.
	Total int
	// Big marks a group large enough to need a filter-within-group search box
	// and a top-N expander (producer/region/varietal).
	Big bool
	// Grid renders the group as a compact chip grid rather than a checkbox
	// list — vintage, where the values are all four characters wide.
	Grid bool
	// Open is the <details open> state on first paint. The big groups start
	// collapsed: an expanded 310-item producer list is the thing this whole
	// change exists to remove.
	Open bool
}

// Placeholder is the filter-within-group input's placeholder, e.g.
// "Filter 310 producers…". It states the FULL total, not the seeded 12, so the
// control tells the visitor what searching it will actually reach.
func (g facetGroup) Placeholder() string {
	return fmt.Sprintf("Filter %s %ss…", comma(g.Total), strings.ToLower(g.Label))
}

// ExpandLabel is the "Show all 310 producers" expander text for the no-JS /
// pre-hydration state. portfolio.js rewrites it with the count AVAILABLE under
// the current filters as soon as it loads.
func (g facetGroup) ExpandLabel() string {
	return fmt.Sprintf("Show all %s %ss", comma(g.Total), strings.ToLower(g.Label))
}

// HasMore reports whether the catalog holds more values than this group seeded,
// i.e. whether the expander is meaningful at all.
func (g facetGroup) HasMore() bool { return g.Total > len(g.Values) }

// facetValue is one selectable value plus how many wines carry it across the
// whole catalog. The count drives the seed's ranking; portfolio.js overwrites
// the rendered number with a live, filter-aware count as soon as it loads.
type facetValue struct {
	Value string
	Count int
}

// newsPage carries the full news list (already newest-first, from loadSite)
// plus the shared page contract for the news landing page.
type newsPage struct {
	page
	Posts []model.NewsPost
}

// newsPostPage carries one post plus the shared page contract (Title/
// Description/Path/BaseURL) that base.html.tmpl's head/header/footer
// require. Because it embeds page, each post gets its own unique title,
// meta description, and canonical URL — that per-post uniqueness is the
// entire SEO point of the News & Events skill (see the design spec).
type newsPostPage struct {
	page
	Post model.NewsPost
}

// portfolioPage carries ONE paginated slice of the catalog — this page's 48
// wine cards — plus the facet groups (which span the whole catalog, not just
// this page) and the pagination metadata the template and portfolio.js need.
//
// Why paginate the SEO surface rather than render all ~2,600 wines into one
// document: the old single-page portfolio was a 2MB, 65k-DOM-node page that
// took ~12s to paint on 3G. Now each /portfolio/page/N/ is a small (tens of
// KB) real-HTML document with real <a href> cards AND prev/next <a> links, so
// a crawler or no-JS visitor can walk the entire catalog page by page, while
// portfolio.js progressively takes over with client-side filtering against
// the compact catalog-index once it loads. Every wine still has its own
// crawlable /wines/<slug>/ detail page — that is the primary SEO surface; the
// paginated list is the browsable index into it.
type portfolioPage struct {
	page
	Facets []facetGroup
	Wines  []cardWine // this page's slice of grouped cards only (≤ portfolioPageSize)

	// IndexURL is the content-hashed catalog-index URL portfolio.js fetches to
	// drive client-side filtering/sorting/pagination. Hashing lets Bunny cache
	// it immutably: the filename changes whenever the data does, so browsers
	// never serve a stale index.
	IndexURL string
	PageSize int // portfolioPageSize; echoed to the JS so both sides agree
	// PageNum/PageCount/Total drive the server-rendered pagination nav and the
	// result counter; PrevURL/NextURL are the crawlable prev/next links (empty
	// string ⇒ no such neighbour, so the template renders a disabled control).
	PageNum   int
	PageCount int
	Total     int
	PrevURL   string
	NextURL   string
}

// indexEntry is one row of dist/assets/catalog-index.<hash>.json, the compact
// per-wine record portfolio.js fetches to drive client-side browsing. It
// carries ONLY the fields the browse UI needs (identity, classification, and
// the thumbnail) — deliberately NOT descriptions/tasting notes, which would
// bloat the index the browser downloads on every /portfolio/ visit and live
// only on the per-wine detail pages. Field names are the JS↔Go contract
// (portfolio.js reads w.producer, w.varietal, etc. by these exact lowercase
// keys) — do not rename without updating both sides.
type indexEntry struct {
	Slug     string `json:"slug"`
	SKU      string `json:"sku"`
	Producer string `json:"producer"`
	Name     string `json:"name"`
	Vintage  string `json:"vintage"`
	Region   string `json:"region"`
	Varietal string `json:"varietal"`
	Country  string `json:"country"`
	Color    string `json:"color"`
	Img      string `json:"img"`
	// Avail is the pre-composed availability line ("74 bottles · 6 cs + 2");
	// see availability(). Empty when out of stock.
	Avail string `json:"avail,omitempty"`
	// Vints is the group's full vintage list (newest first) when the card
	// collapses more than one vintage; portfolio.js uses it for the vintage
	// facet and the card's vintage span, falling back to Vintage when absent.
	Vints []string `json:"vints,omitempty"`
}

func Run(dataDir, assetsDir, templatesDir, distDir, baseURL, gaID string) error {
	s, err := loadSite(dataDir, baseURL, gaID)
	if err != nil {
		return err
	}
	tmpl, err := template.New("").Funcs(template.FuncMap{
		"paragraphs": paragraphs,
		"excerpt":    excerpt,
		"hasPrefix":  strings.HasPrefix,
		"comma":      comma,
		"spaceJoin":  spaceJoin,
		"avail":      availability,
		"initials":   initials,
		"spellnum":   spellNum,
		"lower":      strings.ToLower,
		// inc/last exist for breadcrumb rendering: schema.org positions are
		// 1-based while range indices are 0-based, and the final crumb is the
		// current page, which must render as text rather than a self-link.
		"inc":  func(i int) int { return i + 1 },
		"last": func(i int, c []crumb) bool { return i == len(c)-1 },
	}).ParseGlob(filepath.Join(templatesDir, "*.tmpl"))
	if err != nil {
		return err
	}
	// Start each build from an empty dist/ so stale output can never linger.
	// The catalog-index filename is content-hashed, so without this every data
	// change would drop a fresh catalog-index.<hash>.json and leave the old ones
	// behind (deployed as orphans); likewise, if the catalog ever shrinks, the
	// now-surplus /portfolio/page/N/ dirs would stick around, crawlable and in
	// stale sitemaps. Cleaning keeps dist/ an exact mirror of this build.
	if err := cleanDir(distDir); err != nil {
		return err
	}
	if err := copyTree(assetsDir, filepath.Join(distDir, "assets")); err != nil {
		return err
	}
	// Fingerprint the fixed CSS/JS AFTER the tree copy (it renames the copies
	// in dist/, never touches assetsDir) and BEFORE any page renders, so every
	// template sees the hashed URLs.
	for _, fp := range []struct {
		rel string
		dst *string
	}{
		{"css/site.css", &s.CSSURL},
		{"js/nav.js", &s.NavJSURL},
		{"js/portfolio.js", &s.PortfolioJSURL},
		{"js/filters.js", &s.FiltersJSURL},
	} {
		url, err := fingerprintAsset(distDir, fp.rel)
		if err != nil {
			return err
		}
		*fp.dst = url
	}
	// Delisted wines still render their own detail page (see the render loop
	// below), so they need the same no-broken-image fallback as active wines.
	labelWines := make([]model.Wine, 0, len(s.Wines)+len(s.Delisted))
	labelWines = append(labelWines, s.Wines...)
	labelWines = append(labelWines, s.Delisted...)
	if err := ensureLabels(distDir, labelWines); err != nil {
		return err
	}
	// dist/redirects.json = old-site crawl map ∪ lifecycle map. See
	// mergeRedirects for the missing-file tolerance and conflict rule.
	if err := mergeRedirects(distDir, redirectsJSONName, filepath.Join(dataDir, "lifecycle-redirects.json")); err != nil {
		return err
	}

	latestNews := s.News
	if len(latestNews) > 3 {
		latestNews = latestNews[:3]
	}
	featuredWines := selectFeaturedWines(s.Wines, s.Content.FeaturedWineSlugs, 4)
	// min 3 / max 4: the home wine grid is four-up, so four fills one clean
	// row; the ranking file's extra entries are sold-out slack (see
	// selectHotSellers).
	hotSellers := selectHotSellers(s.Wines, s.HotSellerSlugs, 3, 4)

	pages := []struct {
		rel, tmpl string
		data      any
	}{
		{"", "home", homePage{
			page: page{
				site:  s,
				Title: "FineVines - Wholesale Wine & Spirits, Illinois",
				Description: "FineVines is a licensed wholesale distributor of wine and spirits, pouring " +
					"elegance with a sommelier's touch for restaurants and retailers across Chicagoland " +
					"and all of Illinois.",
				Path: "/",
			},
			LatestNews:    latestNews,
			FeaturedWines: featuredWines,
			Book:          bookBandOf(s.Wines, s.Content.BookProducers),
			HotSellers:    hotSellers,
			Ledger:        ledgerStats(s.Wines, s.AccountsServed),
		}},
		{"contact", "contact", page{
			site:  s,
			Title: "Contact - FineVines",
			Description: "Reach the FineVines team: wholesale wine and spirits distribution for " +
				"licensed retailers, restaurants, and hospitality accounts across Chicagoland " +
				"and all of Illinois.",
			Path: "/contact/",
		}},
		{"news", "news", newsPage{
			page: page{
				site:        s,
				Title:       "News & Events - FineVines",
				Description: "Tastings, allocations, and news from the FineVines team.",
				Path:        "/news/",
			},
			Posts: s.News,
		}},
		// About does NOT wrap page in a bigger type — .Team is already
		// reachable through the embedded *site, and head/header/footer only
		// need Title/Description/Path, which page supplies directly. Passing
		// a bare *site here would break head/header/footer (see Task 5's
		// page-embedding contract in the doc comment above).
		{"about", "about", page{
			site:  s,
			Title: "About - FineVines",
			Description: "A service company, first and last. Meet the FineVines sales, warehouse, and " +
				"support team.",
			Path: "/about/",
		}},
		// Privacy policy and legal (Terms and Conditions of Use) are both real
		// published pages, not redirects — see data/legal/privacy-policy.md and
		// data/legal/legal.md's header notes, and the doc comments atop
		// templates/privacy-policy.html.tmpl and templates/legal.html.tmpl.
		// Neither wraps page in a bigger type, same reasoning as about above.
		{"privacy-policy", "privacy-policy", page{
			site:  s,
			Title: "Privacy Policy - FineVines",
			Description: "How FineVines collects, uses, and protects the personal information visitors " +
				"share with us.",
			Path: "/privacy-policy/",
		}},
		{"legal", "legal", page{
			site:        s,
			Title:       "Legal - FineVines",
			Description: "The terms and conditions that govern use of the FineVines website.",
			Path:        "/legal/",
		}},
	}
	// paths collects every rendered page's site-root-relative Path, in
	// render order, so sitemap.xml can be built from what Run actually
	// produced rather than a second, independently-maintained URL list.
	var paths []string
	for _, p := range pages {
		if err := renderPage(tmpl, distDir, p.rel, p.tmpl, p.data); err != nil {
			return err
		}
		if pd, ok := p.data.(pathed); ok {
			paths = append(paths, pd.pagePath())
		}
	}

	// The paginated portfolio + its compact catalog-index are rendered as
	// their own unit: writeCatalogIndex must run first so the hashed index URL
	// is known before the pages that embed it are rendered, and renderPortfolio
	// contributes every /portfolio/ + /portfolio/page/N/ path to the sitemap.
	// Both browse surfaces render from the same grouped card list: one card
	// per wine (vintages collapsed), while the detail pages below stay per-row.
	cards := portfolioCards(s.Wines)
	indexURL, err := writeCatalogIndex(distDir, cards)
	if err != nil {
		return err
	}
	portfolioPaths, err := renderPortfolio(tmpl, distDir, s, cards, indexURL)
	if err != nil {
		return err
	}
	paths = append(paths, portfolioPaths...)

	// Producer / region / varietal landing pages, from the same collapsed
	// cards the portfolio shows. They render after the portfolio because they
	// are the same catalog cut a different way — and before the detail pages,
	// which link up into them.
	collections := collectionsByKind(cards)
	collectionPaths, err := renderCollections(tmpl, distDir, s, collections)
	if err != nil {
		return err
	}
	paths = append(paths, collectionPaths...)
	// Which collections actually exist, so a wine page never links one that doesn't.
	published := newPublishedCollections(collections)

	// renderWine renders one wine's detail page. Both active and delisted
	// wines get a page (see winePage.Unavailable's doc comment), but only
	// active pages join the sitemap — an unavailable wine's page still
	// exists and is reachable/indexable on its own terms, it just isn't
	// advertised as part of the current catalog.
	// Computed once over the active catalog: a delisted wine is not offered as
	// another vintage of anything, and an active wine must not advertise one.
	otherVintages := otherVintagesBySlug(s.Wines)
	// Which vintages merely reuse a sibling's prose, and therefore defer to it.
	canonicalOf := canonicalVintage(s.Wines)
	renderWine := func(w model.Wine, unavailable bool) error {
		path := "/wines/" + w.Slug + "/"
		producerURL := published.urlFor(collectionKindByKey("producer"), w.Producer)
		data := winePage{
			page: page{
				site:          s,
				Title:         fmt.Sprintf("%s %s %s - FineVines", w.Producer, w.Name, w.Vintage),
				Description:   firstNonEmpty(w.Description, w.Producer+" "+w.Name),
				Path:          path,
				CanonicalPath: canonicalOf[w.Slug],
			},
			Wine:          w,
			Unavailable:   unavailable,
			OtherVintages: otherVintages[w.Slug],
			ProducerURL:   producerURL,
			RegionURL:     published.urlFor(collectionKindByKey("region"), w.Region),
			VarietalURL:   published.urlFor(collectionKindByKey("varietal"), w.Varietal),
			Crumbs: wineCrumbs(crumbSpec{
				ProducerName: w.Producer,
				ProducerURL:  producerURL,
				WineName:     spaceJoin(w.Name, w.Vintage),
				WineURL:      path,
			}),
		}
		// Prefer the wine's own photo as its share image, but only when it's a
		// raster the social scrapers actually render — an .svg (or .webp)
		// label falls through to the branded default (see isRasterImage).
		if isRasterImage(w.ImagePath) {
			data.OGImage = w.ImagePath
		}
		if err := renderPage(tmpl, distDir, "wines/"+w.Slug, "wine", data); err != nil {
			return err
		}
		// A sitemap advertises canonical URLs. A vintage that defers to a
		// sibling stays published, linked and crawlable — it just isn't
		// submitted as a page in its own right.
		if !unavailable && data.isCanonical() {
			paths = append(paths, data.pagePath())
		}
		return nil
	}
	// One slug is one page. Two ACTIVE rows can normalize to the same slug —
	// almost always the same wine in two bottle formats, which a
	// producer/name/vintage slug cannot tell apart because size lives in none
	// of the three. Rendering per-row wrote the same file twice AND pushed the
	// path into the sitemap twice (91 duplicate <loc> entries on the live
	// catalog), so the row list is collapsed to one representative per slug
	// first.
	for _, w := range dedupeBySlug(s.Wines) {
		if err := renderWine(w, false); err != nil {
			return err
		}
	}
	// Delisted wines render AFTER active ones, so a slug shared between an
	// active and a delisted wine (a data anomaly — e.g. two Salesforce rows
	// that normalize to the same producer/name/vintage) must not let the
	// OutOfStock delisted page clobber the active page just written to the
	// same dist/wines/<slug>/ directory. The active page always wins; the
	// collision is logged so it surfaces as a data problem to fix, not
	// silently swallowed.
	activeSlugs := make(map[string]bool, len(s.Wines))
	for _, w := range s.Wines {
		activeSlugs[w.Slug] = true
	}
	for _, w := range s.Delisted {
		if activeSlugs[w.Slug] {
			log.Printf("build: skipping delisted wine %s (SKU %s) — slug %q is already claimed by an active wine",
				w.ID, w.SKU, w.Slug)
			continue
		}
		if err := renderWine(w, true); err != nil {
			return err
		}
	}

	for _, n := range s.News {
		data := newsPostPage{
			page: page{
				site:        s,
				Title:       n.Title + " - FineVines",
				Description: excerpt(n.Body, 160),
				Path:        "/news/" + n.Slug + "/",
			},
			Post: n,
		}
		if err := renderPage(tmpl, distDir, "news/"+n.Slug, "newspost", data); err != nil {
			return err
		}
		paths = append(paths, data.pagePath())
	}

	if err := writeSitemap(distDir, s.BaseURL, paths); err != nil {
		return err
	}
	if err := writeRobots(distDir, s.BaseURL); err != nil {
		return err
	}
	return nil
}

// pathed is implemented by every page data type via page's promoted
// pagePath method (see page.pagePath's doc comment). Used to collect the
// sitemap's URL list from the same values each page rendered with.
type pathed interface{ pagePath() string }

// paragraphs splits a news post's body into paragraphs on blank lines and
// trims each. The news skill writes plain prose separated by "\n\n" — no
// markdown engine (YAGNI); this is the full extent of body formatting.
// Exposed to templates via template.FuncMap in Run.
func paragraphs(body string) []string {
	parts := strings.Split(body, "\n\n")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// excerpt returns a short plain-text summary of a news post's body for its
// meta description: the first paragraph, truncated to maxLen runes at a
// word boundary with a trailing ellipsis if cut.
func excerpt(body string, maxLen int) string {
	first := body
	if paras := paragraphs(body); len(paras) > 0 {
		first = paras[0]
	}
	runes := []rune(first)
	if len(runes) <= maxLen {
		return first
	}
	cut := string(runes[:maxLen])
	if i := strings.LastIndex(cut, " "); i > 0 {
		cut = cut[:i]
	}
	return strings.TrimSpace(cut) + "…"
}

// initials returns a compact monogram for a team member without a portrait.
// It uses the first and last whitespace-separated name parts so middle names
// and initials do not make the fallback visually noisy.
func initials(name string) string {
	parts := strings.Fields(name)
	if len(parts) == 0 {
		return ""
	}
	first := []rune(parts[0])
	out := string(first[0])
	if len(parts) > 1 {
		last := []rune(parts[len(parts)-1])
		out += string(last[0])
	}
	return strings.ToUpper(out)
}

// firstNonEmpty returns s if it is non-empty, else fallback. Used for a
// page's meta description when the wine record itself has none.
func firstNonEmpty(s, fallback string) string {
	if s != "" {
		return s
	}
	return fallback
}

// spaceJoin joins its non-empty, trimmed arguments with single spaces. Used
// for a wine card's img alt text so a missing producer/vintage never leaves a
// double space ("Bottle of  Pauillac 2018") — it mirrors the collapse
// portfolio.js does client-side, keeping server and JS card markup identical.
func spaceJoin(parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, " ")
}

// availability renders a wine card's availability line from the on-hand
// quantity in CASES (FV_OnHand_Qty__c's true unit, verified live 2026-07-29 —
// this line originally mis-read StockQty as bottles; the fractional part is a
// broken case) and the case pack the product name encodes (12 when it doesn't
// say): "205 bottles · 17 cases + 1"; a holding short of one full case is just
// its bottle count. Composed HERE, once, and shipped verbatim in both
// the server-rendered cards and the catalog-index (indexEntry.Avail) so
// portfolio.js never re-derives it — the two renderings must stay identical.
func availability(w model.Wine) string {
	cases := catalog.OnHandCases(w)
	if cases <= 0 {
		return ""
	}
	pack := catalog.PackOf(w)
	return availLine(int(cases*float64(pack)+0.5), pack)
}

// availLine formats a bottle count with its case arithmetic. pack <= 0 means
// the packs behind the count vary (a mixed-format group), so the line stays a
// bottle count only — "cases" isn't one unit across a 6-pack magnum row and a
// 12-pack 750ml row.
func availLine(b, pack int) string {
	if b <= 0 {
		return ""
	}
	unit := "bottles"
	if b == 1 {
		unit = "bottle"
	}
	s := fmt.Sprintf("%s %s", comma(b), unit)
	if pack <= 0 {
		return s
	}
	cs, rem := b/pack, b%pack
	// Client-facing vocabulary only (2026-08-04): "broken case" and the "cs"
	// abbreviation are warehouse shorthand. A holding short of a full case is
	// just its bottle count; full cases spell the word out.
	if cs == 0 {
		return s
	}
	caseWord := "cases"
	if cs == 1 {
		caseWord = "case"
	}
	s += fmt.Sprintf(" · %d %s", cs, caseWord)
	if rem > 0 {
		s += fmt.Sprintf(" + %d", rem)
	}
	return s
}

// cardWine is one portfolio card: a wine group's representative row plus the
// group-wide facts the card presents. The grid shows one card per WINE
// (producer + cuvée, per catalog.Build), not one per Salesforce row — two
// vintages of the same wine collapse into a single card (the Acre 2018/2019
// regression). Every row still gets its own detail page; only the browse
// surfaces (grid + catalog-index) collapse.
type cardWine struct {
	model.Wine
	// Vints is every vintage in the group, newest first, blanks dropped.
	Vints []string
	// Avail is the availability line summed across the whole group.
	Avail string
}

// VintLabel is the card's vintage span: the group's vintages joined with a
// middot ("2019 · 2018"); a single-vintage card reads exactly as before.
func (c cardWine) VintLabel() string { return strings.Join(c.Vints, " · ") }

// otherVintagesBySlug maps every wine detail page's slug to the OTHER
// vintages of the same wine, newest first.
//
// It reuses catalog.Build's grouping, so "the same wine" means exactly what
// the portfolio means by it (producer + cuvée, with vintage and pack/size
// noise stripped) and the two surfaces can never disagree about which pages
// belong together. Within a vintage the best-enriched row supplies the link
// target, matching how the card picks its representative — and a vintage CAN
// hold more than one slug, because a 375ml and a 750ml of one year differ in
// the name that Slugify sees but not in the cuvée that grouping sees.
func otherVintagesBySlug(wines []model.Wine) map[string][]vintageLink {
	out := map[string][]vintageLink{}
	for _, g := range catalog.Build(wines) {
		if len(g.Vintages) < 2 {
			continue // nothing to link; the template renders no section
		}
		// One link per vintage, in catalog.Build's newest-first order.
		links := make([]vintageLink, 0, len(g.Vintages))
		for _, v := range g.Vintages {
			rep := v.Wines[0]
			for _, w := range v.Wines {
				if w.MetadataScore > rep.MetadataScore {
					rep = w
				}
			}
			links = append(links, vintageLink{Year: v.Year, Slug: rep.Slug})
		}
		// Every row in the group gets the list minus its own page, so the
		// links run in both directions and no page ever links itself.
		for _, v := range g.Vintages {
			for _, w := range v.Wines {
				others := make([]vintageLink, 0, len(links)-1)
				for _, l := range links {
					if l.Slug == w.Slug {
						continue
					}
					others = append(others, l)
				}
				if len(others) > 0 {
					out[w.Slug] = others
				}
			}
		}
	}
	return out
}

// portfolioCards collapses catalog rows into one card per wine. The
// representative row — supplying the card's link, image, and copy — is the
// newest vintage's best-enriched row, so the card leads with the current
// release; stock is summed across every row in the group.
func portfolioCards(wines []model.Wine) []cardWine {
	groups := catalog.Build(wines)
	cards := make([]cardWine, 0, len(groups))
	for _, g := range groups {
		rep := g.Vintages[0].Wines[0]
		for _, w := range g.Vintages[0].Wines {
			if w.MetadataScore > rep.MetadataScore {
				rep = w
			}
		}
		var vints []string
		for _, v := range g.Vintages {
			if strings.TrimSpace(v.Year) != "" {
				vints = append(vints, v.Year)
			}
		}
		cards = append(cards, cardWine{Wine: rep, Vints: vints, Avail: groupAvailability(g)})
	}
	return cards
}

// groupAvailability composes one availability line for a whole group by
// summing bottles across its rows. The case arithmetic carries over only when
// every in-stock row shares one case pack; mixed packs fall back to the
// bottle count alone (see availLine).
func groupAvailability(g catalog.Group) string {
	bottles, pack := 0, 0
	uniform := true
	for _, v := range g.Vintages {
		for _, w := range v.Wines {
			cases := catalog.OnHandCases(w)
			if cases <= 0 {
				continue
			}
			p := catalog.PackOf(w)
			bottles += int(cases*float64(p) + 0.5)
			if pack == 0 {
				pack = p
			} else if p != pack {
				uniform = false
			}
		}
	}
	if !uniform {
		pack = 0
	}
	return availLine(bottles, pack)
}

// spellNum spells a small count as a capitalized word ("Ten"), for counts
// that open headline prose — the About page's "Ten people. Two hundred years
// in the business." stays correct as team.json changes. Counts past twenty fall
// back to digits, which is also the better typography at that size.
// Exposed to templates via template.FuncMap in Run.
func spellNum(n int) string {
	words := []string{"Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven",
		"Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
		"Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty"}
	if n >= 0 && n < len(words) {
		return words[n]
	}
	return comma(n)
}

// comma formats a non-negative integer with thousands separators (2665 →
// "2,665"). The portfolio's server-rendered result counter uses it so the
// first paint already reads "2,665 wines", matching what portfolio.js later
// writes via Number.toLocaleString() — no 2665→2,665 flash on hydration.
func comma(n int) string {
	s := fmt.Sprintf("%d", n)
	if n < 1000 {
		return s
	}
	// Insert a comma every three digits from the right.
	var b strings.Builder
	pre := len(s) % 3
	if pre > 0 {
		b.WriteString(s[:pre])
	}
	for i := pre; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}

// ensureLabels writes a generated château-style label SVG into dist for every
// wine whose ImagePath has no file behind it, and returns once dist can render
// the catalog with no broken image.
//
// This makes the neutral unavailable-image SVG a genuine BUILD ARTIFACT rather than
// committed source. Before this, only `enrich` ever called label.Generate
// (internal/enrich/images.go), so a fresh clone without the SVGs checked in
// built a site full of broken images — which is why they were checked in at
// all. Now they can be gitignored: build reproduces any that are absent.
//
// It writes into distDir, never back into assetsDir. A build must not mutate
// its own source tree — that would make the second of two identical builds
// take a different path through this function than the first.
//
// Only genuinely missing files are generated, so a real bottle photograph (the
// 478 .jpg entries matched from the old site) is never overwritten by a
// neutral fallback. label.Generate is deterministic and product-neutral — every wine
// yields byte-identical SVG, with no clock and no randomness — so this
// preserves TestBuildIsDeterministic.
func ensureLabels(distDir string, wines []model.Wine) error {
	for _, w := range wines {
		rel := strings.TrimPrefix(w.ImagePath, "/")
		if rel == "" {
			continue
		}
		dst := filepath.Join(distDir, filepath.FromSlash(rel))
		if _, err := os.Stat(dst); err == nil {
			continue // already present (copied from assets/), leave it alone
		} else if !os.IsNotExist(err) {
			return err
		}
		// Only ever synthesize the neutral SVG. A missing .jpg means a photo we
		// expected is genuinely gone, and silently writing a vector label in
		// its place would hide that; the wine's imagePath needs correcting in
		// the data instead.
		if !strings.EqualFold(filepath.Ext(dst), ".svg") {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		svg := label.Generate(salesforce.WineRaw{
			SKU:         w.SKU,
			Producer:    w.Producer,
			Name:        w.Name,
			Vintage:     w.Vintage,
			Varietal:    w.Varietal,
			Region:      w.Region,
			Country:     w.Country,
			Appellation: w.Appellation,
			Style:       w.Style,
		})
		if err := os.WriteFile(dst, svg, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// buildFacets computes, for each portfolio facet, the distinct values
// present across wines — sorted for determinism (build's output must be
// byte-identical for the same input; iterating a map without sorting would
// break that). Order of the returned groups is the sidebar's display order.
func buildFacets(wines []model.Wine) []facetGroup {
	// Facets and their display order. `style` is dropped — it is empty on every
	// wine in the real data — and `color` is dropped as a facet (only ~1% of
	// wines carry one, too sparse to be a useful filter), though color is still
	// shipped in the catalog-index for possible future use. `country` is added:
	// it is populated on ~29% of wines and is a natural top-level browse axis.
	// Empty values are skipped below, so the ~61% of wines with no producer
	// simply don't contribute a producer value rather than a blank checkbox.
	//
	// big  → gets a filter box and a "show all" expander, and is seeded with
	//        only the top facetSeedSize values.
	// grid → renders as a chip grid instead of a checkbox list.
	// open → starts expanded. Only the two small groups do; the big ones are
	//        collapsed, which is the point of the change.
	specs := []struct {
		facet, label    string
		big, grid, open bool
		get             func(model.Wine) string
	}{
		{facet: "producer", label: "Producer", big: true, get: func(w model.Wine) string { return w.Producer }},
		{facet: "region", label: "Region", big: true, get: func(w model.Wine) string { return w.Region }},
		{facet: "varietal", label: "Varietal", big: true, get: func(w model.Wine) string { return w.Varietal }},
		{facet: "vintage", label: "Vintage", grid: true, open: true, get: func(w model.Wine) string { return w.Vintage }},
		{facet: "country", label: "Country", open: true, get: func(w model.Wine) string { return w.Country }},
	}
	groups := make([]facetGroup, len(specs))
	for i, sp := range specs {
		counts := make(map[string]int)
		for _, w := range wines {
			if v := sp.get(w); v != "" {
				counts[v]++
			}
		}
		values := make([]facetValue, 0, len(counts))
		for v, n := range counts {
			values = append(values, facetValue{Value: v, Count: n})
		}

		// Rank by count desc, then value asc. The second key is not cosmetic:
		// Go randomises map iteration and sort.Slice is not stable, so without
		// a TOTAL order two builds of identical data would emit different
		// orderings and break TestBuildIsDeterministic.
		sort.Slice(values, func(a, b int) bool {
			if values[a].Count != values[b].Count {
				return values[a].Count > values[b].Count
			}
			return values[a].Value < values[b].Value
		})
		// Vintage reads as a chronology, not a popularity list — newest first.
		if sp.grid {
			sort.Slice(values, func(a, b int) bool { return values[a].Value > values[b].Value })
		}

		total := len(values)
		if sp.big && total > facetSeedSize {
			values = values[:facetSeedSize]
		}
		groups[i] = facetGroup{
			Facet:  sp.facet,
			Label:  sp.label,
			Values: values,
			Total:  total,
			Big:    sp.big,
			Grid:   sp.grid,
			Open:   sp.open,
		}
	}
	return groups
}

// facetSeedSize is how many values a Big facet group renders server-side. It
// must match the TOP_N default in assets/js/portfolio.js, or the list would
// visibly re-length the moment the catalog-index lands.
const facetSeedSize = 12

// portfolioPageSize is how many wine cards each portfolio page renders, both
// server-side (one document per page) and client-side (the JS engine's page
// window). Kept in one place so the two sides can never disagree — it's echoed
// into each page's data-page-size for portfolio.js to read.
const portfolioPageSize = 48

// writeCatalogIndex writes the compact, content-hashed catalog index the
// browser fetches to drive client-side browsing, and returns its site-root
// URL for the templates to embed.
//
// It replaces the old dist/search-index.json. Two deliberate changes: (1) it
// lives under dist/assets/ with a sha256-derived filename
// (catalog-index.<hash>.json) so Bunny can cache it immutably — the name only
// changes when the bytes do, so a browser never serves a stale index against
// fresh data; (2) it carries only browse fields (identity, classification,
// thumbnail), never descriptions/tasting notes, keeping the download small.
//
// Marshaled compact (json.Marshal, not MarshalIndent) since it's fetched on
// every first /portfolio/ visit; at ~2,600 wines this is a few hundred KB,
// which Bunny gzips. Entries follow wines' order (already slug-sorted in
// wines.json), so the index lines up with the server-rendered card order.
func writeCatalogIndex(distDir string, cards []cardWine) (string, error) {
	entries := make([]indexEntry, len(cards))
	for i, c := range cards {
		// The entry's vintage leads with the group's newest year (drives the
		// sort and the default facet value); the full list rides in vints only
		// when the card actually collapses more than one vintage.
		vintage := c.Vintage
		if len(c.Vints) > 0 {
			vintage = c.Vints[0]
		}
		var vints []string
		if len(c.Vints) > 1 {
			vints = c.Vints
		}
		entries[i] = indexEntry{
			Slug:     c.Slug,
			SKU:      c.SKU,
			Producer: c.Producer,
			Name:     c.Name,
			Vintage:  vintage,
			Region:   c.Region,
			Varietal: c.Varietal,
			Country:  c.Country,
			Color:    c.Color,
			Img:      "/" + c.ImagePath,
			Avail:    c.Avail,
			Vints:    vints,
		}
	}
	data, err := json.Marshal(entries)
	if err != nil {
		return "", err
	}
	// First 8 hex of sha256 is ample to make the URL change on any data change
	// (collisions across a single site's builds are not a concern here).
	sum := sha256.Sum256(data)
	name := "catalog-index." + hex.EncodeToString(sum[:])[:8] + ".json"
	dir := filepath.Join(distDir, "assets")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		return "", err
	}
	return "/assets/" + name, nil
}

// fingerprintAsset renames dist/assets/<rel> to carry the first 8 hex of its
// content's sha256 (site.css → site.<hash>.css) and returns the hashed
// site-relative URL. Same scheme and rationale as the catalog-index: the CDN
// can cache the file immutably because any content change changes the URL.
// It operates on the copy in dist/ only — the source assets/ tree keeps its
// stable, un-hashed filenames.
func fingerprintAsset(distDir, rel string) (string, error) {
	src := filepath.Join(distDir, "assets", filepath.FromSlash(rel))
	data, err := os.ReadFile(src)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	ext := filepath.Ext(rel)
	hashed := strings.TrimSuffix(rel, ext) + "." + hex.EncodeToString(sum[:])[:8] + ext
	if err := os.Rename(src, filepath.Join(distDir, "assets", filepath.FromSlash(hashed))); err != nil {
		return "", err
	}
	return "/assets/" + hashed, nil
}

// portfolioPageURL is the canonical site-root path for portfolio page n:
// page 1 is the bare /portfolio/ (no /page/1/ variant, to avoid a duplicate
// URL for the same content), every later page is /portfolio/page/N/.
func portfolioPageURL(n int) string {
	if n <= 1 {
		return "/portfolio/"
	}
	return fmt.Sprintf("/portfolio/page/%d/", n)
}

// renderPortfolio renders the paginated catalog: one real-HTML document per
// page of portfolioPageSize wines, each with server-rendered cards, facet
// sidebar, sort control, and crawlable prev/next links. It returns every
// rendered page's site-root path so Run can feed them all to the sitemap —
// that is how a crawler discovers the whole catalog without executing JS.
//
// Facets are computed ONCE over the whole cleaned catalog (not per page): the
// client engine filters against the full catalog-index, so the same complete
// set of facet values must be offered on every page.
func renderPortfolio(tmpl *template.Template, distDir string, s *site, cards []cardWine, indexURL string) ([]string, error) {
	facets := buildFacets(s.Wines)
	total := len(cards)
	pageCount := (total + portfolioPageSize - 1) / portfolioPageSize
	if pageCount < 1 {
		pageCount = 1 // always render at least /portfolio/, even with zero wines
	}

	const desc = "Browse the full FineVines wholesale portfolio. Filter by producer, region, " +
		"varietal, country, or vintage across every wine currently in stock."

	var paths []string
	for n := 1; n <= pageCount; n++ {
		start := (n - 1) * portfolioPageSize
		end := start + portfolioPageSize
		if end > total {
			end = total
		}
		var pageWines []cardWine
		if start < total {
			pageWines = cards[start:end]
		}

		// Page 1 keeps the plain "Portfolio" title; later pages carry a
		// "- Page N of M" suffix so paginated URLs aren't near-duplicate titles.
		title := "Portfolio - FineVines"
		if n > 1 {
			title = fmt.Sprintf("Portfolio - Page %d of %d - FineVines", n, pageCount)
		}

		rel := "portfolio"
		if n > 1 {
			rel = fmt.Sprintf("portfolio/page/%d", n)
		}

		prevURL := ""
		if n > 1 {
			prevURL = portfolioPageURL(n - 1)
		}
		nextURL := ""
		if n < pageCount {
			nextURL = portfolioPageURL(n + 1)
		}

		data := portfolioPage{
			page: page{
				site:        s,
				Title:       title,
				Description: desc,
				Path:        portfolioPageURL(n),
			},
			Facets:    facets,
			Wines:     pageWines,
			IndexURL:  indexURL,
			PageSize:  portfolioPageSize,
			PageNum:   n,
			PageCount: pageCount,
			Total:     total,
			PrevURL:   prevURL,
			NextURL:   nextURL,
		}
		if err := renderPage(tmpl, distDir, rel, "portfolio", data); err != nil {
			return nil, err
		}
		paths = append(paths, data.Path)
	}
	return paths, nil
}

// usableWines drops rows with an empty slug or empty name. The live
// wines.json contains one such placeholder (the blank SKU-513001 record) that,
// left in, sorts first, renders a broken/empty card, misaligns the catalog,
// and would emit a dead /wines//  detail page. Filtering here — once, at the
// single load point — means the portfolio pages, the catalog-index, the
// per-wine detail loop, and the sitemap all draw from the same cleaned list
// and can never disagree about what the catalog contains.
func usableWines(wines []model.Wine) []model.Wine {
	out := make([]model.Wine, 0, len(wines))
	for _, w := range wines {
		if strings.TrimSpace(w.Slug) == "" || strings.TrimSpace(w.Name) == "" {
			continue
		}
		out = append(out, w)
	}
	return collapseSpellingVariants(out)
}

// classifiedFields are the fields a visitor filters and browses the catalog
// BY, as opposed to reads. Each one is both a portfolio facet and a
// collection dimension, which is exactly why their spelling has to be
// consistent: an inconsistent one splits a filter.
var classifiedFields = []struct {
	name string
	get  func(*model.Wine) *string
}{
	{"producer", func(w *model.Wine) *string { return &w.Producer }},
	{"region", func(w *model.Wine) *string { return &w.Region }},
	{"varietal", func(w *model.Wine) *string { return &w.Varietal }},
	{"country", func(w *model.Wine) *string { return &w.Country }},
}

// collapseSpellingVariants rewrites each classified field to ONE spelling per
// slug across the whole catalog.
//
// Salesforce spells some values more than one way: "Burgundy - C d Nuits",
// "Burgundy, C d Nuits" and "Burgundy C d Nuits" are one region; "Cabernet /
// Merlot", "Cabernet/ Merlot" and "Cabernet/merlot" are one blend. Eleven
// values are split this way across 223 rows, and every collision in the live
// data is punctuation — never two genuinely different things.
//
// Split, they are worse than untidy. The portfolio rail offers them as
// separate checkboxes, so ticking one hides the wines filed under another
// spelling: a filter that lies about the catalog. The collection pages
// already merged by slug, so the two surfaces disagreed about the same cut.
//
// It runs here, at the single load point every surface draws from, rather
// than as an edit to wines.json — because the next Salesforce sync would
// re-import the variants and silently re-split the filter. Slugs are NOT
// re-derived: they are published URLs, and the stored slug stays the address
// whatever spelling the label settles on.
//
// The winner is the spelling most rows use, ties broken alphabetically so the
// build stays byte-identical run to run.
func collapseSpellingVariants(wines []model.Wine) []model.Wine {
	for _, field := range classifiedFields {
		// slug -> spelling -> how many rows use it.
		spellings := map[string]map[string]int{}
		for i := range wines {
			value := strings.TrimSpace(*field.get(&wines[i]))
			if value == "" {
				continue
			}
			slug := model.Slugify(value)
			if slug == "" {
				continue
			}
			if spellings[slug] == nil {
				spellings[slug] = map[string]int{}
			}
			spellings[slug][value]++
		}

		canonical := make(map[string]string, len(spellings))
		for slug, counts := range spellings {
			if len(counts) == 1 {
				continue // the common case: nothing to choose between
			}
			best, bestN := "", -1
			for value, n := range counts {
				if n > bestN || (n == bestN && value < best) {
					best, bestN = value, n
				}
			}
			canonical[slug] = best
		}
		if len(canonical) == 0 {
			continue
		}
		for i := range wines {
			p := field.get(&wines[i])
			if want, ok := canonical[model.Slugify(strings.TrimSpace(*p))]; ok {
				*p = want
			}
		}
	}
	return wines
}

// strippedYear matches a year that normalize.StripForeignVintage REMOVED from
// a sibling's copy — the space in front goes with it, exactly as the repair
// took it — so proseKey can put it back for comparison.
var strippedYear = regexp.MustCompile(`\s*\b(19|20)\d\d\b`)

// proseKey is the descriptive copy a wine detail page is built around. Two
// rows with the same key render pages that differ only in a year — the fields
// listed here ARE the page's prose, and everything else on it is a fact grid.
//
// Comparison is byte-exact APART from years, and that boundary is deliberate
// (client decision, 2026-08-09). It has to ignore years at all because the
// catalog repairs shared prose by stripping the donor's year out of the
// sibling's copy (normalize.StripForeignVintage): the two texts stop being
// byte-equal even though one is plainly a copy, and 62 near-duplicates would
// quietly start competing again.
//
// But it must not go further. Vintages separately enriched with the same
// sentence and their own correct years ("This 2021 Atomique³ … is poised",
// "This 2022 …") also collapse under a year-blind comparison, and merging
// those would take another 429 pages out of the index — pages the catalog
// wants ranking on their own. So the key only tolerates a year that is
// ABSENT on one side, never two different years.
func proseKey(w model.Wine) string {
	return strings.Join([]string{
		strings.TrimSpace(w.Description),
		strings.TrimSpace(w.SommelierNotes),
		strings.TrimSpace(w.Aroma),
		strings.TrimSpace(w.Palate),
		strings.TrimSpace(w.Finish),
	}, "\x00")
}

// sameProse reports whether two rows carry the same descriptive copy, ignoring
// a year that the vintage repair removed from one of them.
//
// The asymmetry is the whole point: "…Centive 2024 from Tenuta…" and
// "…Centive from Tenuta…" are one text with the year taken out, while
// "This 2021 …" and "This 2022 …" are two texts. Stripping years from BOTH
// sides would conflate them; stripping from only the side that still has one,
// and only when that makes it equal to the other, does not.
func sameProse(a, b string) bool {
	if a == b {
		return true
	}
	// Whichever side still carries years, remove them and compare again. A
	// genuine copy-with-year-removed matches; two different years do not,
	// because removing 2021 from one and 2022 from the other is only equal
	// when both are stripped — which this never does.
	return strippedYear.ReplaceAllString(a, "") == b ||
		strippedYear.ReplaceAllString(b, "") == a
}

// canonicalVintage maps a wine slug to the slug it should canonicalise to,
// for the vintages that merely reuse a sibling's prose.
//
// 147 wines carry byte-identical description, sommelier note, aroma, palate
// and finish across their vintages — a deliberate earlier choice that bought
// 100% prose coverage by copying. Measured on the built site the resulting
// pages are ~87% identical by 5-gram overlap, with the older page containing
// no word the newer one lacks. Published as independent pages they do not
// become 377 ranking pages; they become one winner per cluster plus a pile of
// duplicates working against the catalog's quality signals.
//
// So within a group the NEWEST vintage holding a given prose key keeps it and
// every older vintage sharing that exact key points at it. Rows with their own
// copy are untouched — this must not flatten real writing — and empty prose is
// never treated as shared, or every unenriched wine would collapse onto one
// page.
//
// The rule keys off the prose being IDENTICAL, so it disappears on its own the
// moment enrichment writes genuine per-vintage copy: no flag to remember, no
// code to revisit.
func canonicalVintage(wines []model.Wine) map[string]string {
	out := map[string]string{}
	for _, g := range catalog.Build(wines) {
		// catalog.Build orders Vintages newest first, so the first row seen
		// for a prose key is the newest one carrying it.
		// Compared pairwise rather than through a map, because sameProse is a
		// predicate, not a hash — it tolerates a year on one side only, which
		// no single key can express. Groups hold a handful of vintages, so
		// the quadratic walk is free.
		var owners []model.Wine
		for _, v := range g.Vintages {
			for _, w := range v.Wines {
				if strings.TrimSpace(w.Description) == "" {
					continue // nothing written here to duplicate
				}
				key := proseKey(w)
				matched := false
				for _, o := range owners {
					if !sameProse(proseKey(o), key) {
						continue
					}
					if o.Slug != w.Slug {
						out[w.Slug] = "/wines/" + o.Slug + "/"
					}
					matched = true
					break
				}
				if !matched {
					owners = append(owners, w)
				}
			}
		}
	}
	return out
}

// crumbSpec is what a wine's breadcrumb trail is assembled from.
type crumbSpec struct {
	ProducerName string
	ProducerURL  string // "" when the producer has no published collection
	WineName     string
	WineURL      string
}

// wineCrumbs builds the trail Portfolio › Producers › <Producer> › <Wine>,
// skipping the producer steps when that producer has no collection — a trail must
// never contain a step that 404s, and a two-step trail is better than a
// broken four-step one.
func wineCrumbs(spec crumbSpec) []crumb {
	crumbs := []crumb{{Name: "Portfolio", URL: "/portfolio/"}}
	if spec.ProducerURL != "" {
		producers := collectionKindByKey("producer")
		crumbs = append(crumbs,
			crumb{Name: producers.Plural, URL: collectionIndexURL(producers)},
			crumb{Name: spec.ProducerName, URL: spec.ProducerURL},
		)
	}
	return append(crumbs, crumb{Name: spec.WineName, URL: spec.WineURL})
}

// dedupeBySlug collapses rows that share a slug to one row each, keeping
// first-seen order so the build stays byte-identical run to run.
//
// The survivor is the best-enriched row (highest MetadataScore) — the same
// rule catalog.Build uses to pick a group's Representative, so the detail
// page a collision produces is the page the portfolio card already links to
// rather than a second, differently-worded one. Ties keep the first row,
// which is stable because wines.json load order is.
//
// Each collision is logged: it is a real data problem (two Salesforce rows
// the catalog cannot distinguish by URL) and should be fixed upstream, not
// silently absorbed here.
func dedupeBySlug(wines []model.Wine) []model.Wine {
	at := make(map[string]int, len(wines))
	out := make([]model.Wine, 0, len(wines))
	for _, w := range wines {
		i, seen := at[w.Slug]
		if !seen {
			at[w.Slug] = len(out)
			out = append(out, w)
			continue
		}
		log.Printf("build: slug %q is claimed by more than one active wine (SKU %s and SKU %s) — rendering one page from the better-enriched row",
			w.Slug, out[i].SKU, w.SKU)
		if w.MetadataScore > out[i].MetadataScore {
			out[i] = w
		}
	}
	return out
}

func loadSite(dataDir, baseURL, gaID string) (*site, error) {
	wines, err := model.LoadWines(filepath.Join(dataDir, "wines.json"))
	if err != nil {
		return nil, err
	}
	content, err := model.LoadSiteContent(filepath.Join(dataDir, "site.json"))
	if err != nil {
		return nil, fmt.Errorf("load site content: %w", err)
	}
	cleaned := usableWines(wines)
	// Unavailable wines keep a published detail page (their search ranking
	// survives the stock-out) but appear on NO browse surface: s.Wines is
	// active-only, so the portfolio, facets, catalog index, search, featured
	// picks, hot-sellers, and sitemap all exclude them by construction.
	var active, delisted []model.Wine
	for _, w := range cleaned {
		if w.Status == model.StatusUnavailable {
			delisted = append(delisted, w)
			continue
		}
		active = append(active, w)
	}
	s := &site{Wines: active, Delisted: delisted, Content: content, BaseURL: baseURL, GAID: gaID}
	// hot-sellers.json is optional: written by `finevines enrich` against a
	// live org (mock/dev runs don't have it), and the homepage simply omits
	// its sales-driven section when it's absent.
	hotSellers, err := model.LoadHotSellers(filepath.Join(dataDir, "hot-sellers.json"))
	if err != nil {
		return nil, fmt.Errorf("load hot-sellers: %w", err)
	}
	s.HotSellerSlugs = make([]string, 0, len(hotSellers.Wines))
	for _, h := range hotSellers.Wines {
		s.HotSellerSlugs = append(s.HotSellerSlugs, h.Slug)
	}
	// accounts.json is optional on the same terms as hot-sellers.json; a
	// missing file loads as zero and the ledger omits its accounts entry.
	accounts, err := model.LoadAccountsServed(filepath.Join(dataDir, "accounts.json"))
	if err != nil {
		return nil, fmt.Errorf("load accounts-served: %w", err)
	}
	s.AccountsServed = accounts.Accounts
	// team.json is optional until seeded
	if data, err := os.ReadFile(filepath.Join(dataDir, "team.json")); err == nil {
		if err := jsonUnmarshal(data, &s.Team); err != nil {
			return nil, err
		}
	}
	newsDir := filepath.Join(dataDir, "news")
	entries, _ := os.ReadDir(newsDir)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(newsDir, e.Name()))
		if err != nil {
			return nil, err
		}
		var post model.NewsPost
		if err := jsonUnmarshal(data, &post); err != nil {
			return nil, err
		}
		s.News = append(s.News, post)
	}
	sort.Slice(s.News, func(i, j int) bool { return s.News[i].Date > s.News[j].Date }) // newest first
	return s, nil
}

// selectHotSellers resolves the sales-driven ranking (data/hot-sellers.json,
// best first) against the current catalog. Unlike selectFeaturedWines there is
// NO fallback fill: every slot here is a claim that the wine is actually
// moving, so a vacancy is dropped, never invented. Wines that have left the
// catalog or sold out since the ranking was computed (it can be up to one
// enrich run staler than wines.json) are skipped. The ranking file carries
// more entries than max on purpose — the slack absorbs those drops and still
// fills the row. Fewer than min survivors omits the whole section: a one-card
// "hot sellers" section reads as a markdown bin, not a pulse.
func selectHotSellers(wines []model.Wine, slugs []string, min, max int) []model.Wine {
	bySlug := make(map[string]model.Wine, len(wines))
	for _, wine := range wines {
		bySlug[wine.Slug] = wine
	}
	selected := make([]model.Wine, 0, max)
	for _, slug := range slugs {
		if len(selected) == max {
			break
		}
		wine, ok := bySlug[slug]
		// A full case on hand is the floor: a "hot seller" down to loose
		// bottles reads as a markdown bin, not a pulse.
		if !ok || catalog.OnHandCases(wine) < 1 || wine.ImagePath == "" {
			continue
		}
		selected = append(selected, wine)
	}
	if len(selected) < min {
		return nil
	}
	return selected
}

// selectFeaturedWines resolves the hand-curated slug list, then fills any
// vacancy deterministically from the live catalog. The fallback keeps the
// homepage intact when a featured SKU drops out of stock during a nightly
// Salesforce sync; unique producers are preferred for visual variety.
func selectFeaturedWines(wines []model.Wine, slugs []string, limit int) []model.Wine {
	if limit <= 0 {
		return nil
	}
	bySlug := make(map[string]model.Wine, len(wines))
	for _, wine := range wines {
		bySlug[wine.Slug] = wine
	}
	selected := make([]model.Wine, 0, limit)
	seenSlugs := make(map[string]bool, limit)
	seenProducers := make(map[string]bool, limit)
	add := func(wine model.Wine) bool {
		if len(selected) == limit || wine.Slug == "" || wine.ImagePath == "" || seenSlugs[wine.Slug] {
			return false
		}
		selected = append(selected, wine)
		seenSlugs[wine.Slug] = true
		if wine.Producer != "" {
			seenProducers[wine.Producer] = true
		}
		return true
	}
	for _, slug := range slugs {
		if wine, ok := bySlug[slug]; ok {
			add(wine)
		}
	}
	for _, wine := range wines {
		if len(selected) == limit {
			break
		}
		if wine.Producer == "" || seenProducers[wine.Producer] || !isRasterImage(wine.ImagePath) {
			continue
		}
		add(wine)
	}
	for _, wine := range wines {
		if len(selected) == limit {
			break
		}
		if wine.Producer == "" || seenProducers[wine.Producer] {
			continue
		}
		add(wine)
	}
	for _, wine := range wines {
		if len(selected) == limit {
			break
		}
		add(wine)
	}
	return selected
}

// featuredProducers turns the featured bottle selection into the homepage's
// producer-family cards. Counts and regions come from the current catalog, so
// the section stays factual and updates with the same nightly data as browse.
// bookProducerCount is how many names the Book band's roll carries. Seven
// reads as a considered shortlist; more reads as a directory.
const bookProducerCount = 7

// bookBandOf assembles the Book band: the roll (bookProducers) plus the
// lede's count phrase, which only carries a number once the distinct-producer
// count is large enough to impress (>= minLedgerWines, reusing the band
// floor as a sensible "worth counting" threshold).
func bookBandOf(wines []model.Wine, picks []string) bookBand {
	distinct := make(map[string]struct{})
	for _, w := range wines {
		if p := strings.TrimSpace(w.Producer); p != "" {
			distinct[strings.ToLower(p)] = struct{}{}
		}
	}
	label := "growers and estates"
	if len(distinct) >= minLedgerWines {
		label = comma(len(distinct)) + " growers and estates"
	}
	return bookBand{CountLabel: label, Producers: bookProducers(wines, picks, bookProducerCount)}
}

// bookProducers selects the Book band's roll. With picks (site.json's
// bookProducers — George's own shortlist) each name is resolved
// case-insensitively against the catalog, in pick order; unknown names are
// skipped so a delisted producer quietly drops off rather than 404ing into
// an empty portfolio filter. Without picks the roll defaults to the
// catalog's deepest holdings — most wines carried first, name ascending on
// ties so the roll is deterministic — which is honest ("deepest" is a fact,
// not a favor) until the client curates.
func bookProducers(wines []model.Wine, picks []string, limit int) []bookProducer {
	if limit <= 0 {
		return nil
	}
	counts := make(map[string]int)
	canonical := make(map[string]string) // lower-cased -> as written in the catalog
	for _, w := range wines {
		p := strings.TrimSpace(w.Producer)
		if p == "" {
			continue
		}
		counts[p]++
		canonical[strings.ToLower(p)] = p
	}

	link := func(name string) bookProducer {
		return bookProducer{Name: name, URL: "/portfolio/?producer=" + url.QueryEscape(name)}
	}

	if len(picks) > 0 {
		out := make([]bookProducer, 0, limit)
		seen := make(map[string]bool, limit)
		for _, pick := range picks {
			name, ok := canonical[strings.ToLower(strings.TrimSpace(pick))]
			if !ok || seen[name] {
				continue
			}
			seen[name] = true
			out = append(out, link(name))
			if len(out) == limit {
				break
			}
		}
		return out
	}

	names := make([]string, 0, len(counts))
	for name := range counts {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if counts[names[i]] != counts[names[j]] {
			return counts[names[i]] > counts[names[j]]
		}
		return names[i] < names[j]
	})
	if len(names) > limit {
		names = names[:limit]
	}
	out := make([]bookProducer, 0, len(names))
	for _, name := range names {
		out = append(out, link(name))
	}
	return out
}

func renderPage(tmpl *template.Template, distDir, rel, name string, data any) error {
	outDir := filepath.Join(distDir, filepath.FromSlash(rel))
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	f, err := os.Create(filepath.Join(outDir, "index.html"))
	if err != nil {
		return err
	}
	defer f.Close()
	return tmpl.ExecuteTemplate(f, name, data)
}

// mergeRedirects publishes dist/redirects.json as the union of every source
// path given, so the deployed Edge middleware
// (internal/redirects/middleware.ts.tmpl) — which fetches /redirects.json
// from the live site at runtime — actually finds the generated redirect map
// instead of 404ing into an effectively empty one.
//
// In production this is called with two sources: the old-site crawl map
// (redirectsJSONName, written by redirects.Save at the repo root) and the
// lifecycle map (data/lifecycle-redirects.json, maintained by enrich as
// wines are renamed or delisted). Sources are applied in order, later
// sources overwriting earlier ones on a key conflict — since lifecycle is
// passed last, its entries win: it is newer knowledge about OUR OWN URLs,
// while the crawl map only speculates about old-site paths.
//
// Each source is individually optional (a from-scratch checkout, or one
// that hasn't run `redirects` or delisted anything yet, has neither file) —
// a missing source is not an error, just nothing to contribute. If no
// source contributes anything, nothing is written, matching the old
// copy-only behavior on a missing file.
//
// Sources are accepted as explicit paths (rather than this function
// resolving redirectsJSONName against the process's cwd itself) so callers
// — tests included — can point it at arbitrary fixture locations instead of
// planting files at the process's real working directory.
func mergeRedirects(distDir string, sources ...string) error {
	merged := map[string]string{}
	for _, src := range sources {
		data, err := os.ReadFile(src)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		m := map[string]string{}
		if err := json.Unmarshal(data, &m); err != nil {
			return fmt.Errorf("parse %s: %w", src, err)
		}
		for k, v := range m {
			merged[k] = v
		}
	}
	if len(merged) == 0 {
		return nil
	}
	data, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(distDir, redirectsJSONName), append(data, '\n'), 0o644)
}

// cleanDir empties dir of all its contents but leaves the directory itself in
// place. It deliberately does NOT remove dir: on Windows a directory that any
// process holds as its working directory (an open editor, a shell, an
// antivirus scan) cannot be unlinked, so os.RemoveAll(dir) would fail the whole
// build — whereas the files and subtrees inside it delete fine. A missing dir
// is not an error (the first build has none); MkdirAll recreates as needed.
func cleanDir(dir string) error {
	if strings.TrimSpace(dir) == "" {
		return errors.New("build: distDir must not be empty")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		// Files at the root of assets/ are the full-size image masters —
		// source control only, ~500KB each. Everything the site serves lives
		// in a subdirectory (opt/, img/, css/, js/, fonts/, video/), so
		// root-level files never ship to the CDN.
		if filepath.Dir(rel) == "." {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

// jsonUnmarshal is a thin wrapper over encoding/json.Unmarshal so error
// messages can carry the source filename in a later task without touching
// every call site.
func jsonUnmarshal(data []byte, v any) error {
	return json.Unmarshal(data, v)
}

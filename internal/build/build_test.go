package build

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

func TestRunGeneratesHomeAndSharedChrome(t *testing.T) {
	dist := t.TempDir()
	err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", "")
	if err != nil {
		t.Fatal(err)
	}
	home, err := os.ReadFile(filepath.Join(dist, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"<title>FineVines",
		"Pouring elegance with a sommelier", // tagline present
		`src="/assets/opt/pour-hero.jpg"`,
		`alt="Wine being poured for service"`,
		`The Heart of What We Do`,
		`Families Behind the Bottles`,
		`href="/wines/hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021/"`,
		`href="/portfolio/?producer=Hubert&#43;Lamy"`,
		`rel="canonical" href="https://finevines.com/"`,
		`href="/assets/css/site.`,
		`href="/assets/img/favicon.ico"`,                            // favicon wired in base head
		`<img src="/assets/img/finevines-logo.png" alt="FineVines"`, // real logo wordmark in header
		// Social/link-preview meta: Open Graph, Twitter Card, and the mobile
		// theme-color. og:image / twitter:image MUST be absolute (scrapers
		// won't fetch a relative one) and, with no per-page override, resolve
		// to the branded default share PNG.
		`<meta property="og:type" content="website">`,
		`<meta property="og:site_name" content="FineVines">`,
		`<meta property="og:title" content="FineVines`,
		`<meta property="og:url" content="https://finevines.com/">`,
		`<meta property="og:image" content="https://finevines.com/assets/img/og-default.png">`,
		`<meta property="og:image:width" content="1200">`,
		`<meta name="twitter:card" content="summary_large_image">`,
		`<meta name="twitter:site" content="@finevineswine">`,
		`<meta name="twitter:image" content="https://finevines.com/assets/img/og-default.png">`,
		`<meta name="theme-color" content="#531427">`,
	} {
		if !strings.Contains(string(home), want) {
			t.Errorf("home missing %q", want)
		}
	}

	// Enterprise footer: the real colored logo image (on a light chip for
	// legibility on the dark bordeaux band, per the client QA fix), all four
	// column headings, the real social handles, the verified contact details,
	// and the static-year bottom bar (no runtime clock — must
	// stay deterministic).
	for _, want := range []string{
		`class="footer-logo"`,                           // logo lockup wraps the image
		`>Explore</h2>`, `>Trade</h2>`, `>Contact</h2>`, // column headings
		`href="https://www.instagram.com/finevineswine/"`, // real Instagram
		`href="https://twitter.com/finevineswine"`,        // real X/Twitter
		`href="https://www.linkedin.com/company/1291059"`, // real LinkedIn
		`Become a Customer`,                               // trade CTA
		`2725 Thomas St`,
		`Melrose Park, IL 60160`,
		`href="tel:&#43;17083436702"`,
		`Fax: <a href="tel:&#43;17083436536">(708) 343-6536</a>`,
		`href="mailto:info@finevines.com"`,
		`&copy; 2026 FineVines. All rights reserved.`, // static year, no clock
	} {
		if !strings.Contains(string(home), want) {
			t.Errorf("footer missing %q", want)
		}
	}
	// The text wordmark was replaced by the real logo image — it must be gone.
	if strings.Contains(string(home), "footer-wordmark") {
		t.Error("footer should use the real logo image, not the text wordmark")
	}
	// The colored brand logo image now appears in BOTH the header and the
	// footer, so there must be exactly two logo <img>s.
	if n := strings.Count(string(home), "finevines-logo.png"); n != 2 {
		t.Errorf("expected exactly 2 logo images (header + footer), got %d", n)
	}
	// The mobile nav hamburger must be present and accessible (aria-controls
	// pointing at the nav it toggles, aria-expanded state).
	for _, want := range []string{
		`class="nav-toggle"`,
		`aria-controls="site-nav"`,
		`aria-expanded="false"`,
		`id="site-nav"`,
		`src="/assets/js/nav.`,
	} {
		if !strings.Contains(string(home), want) {
			t.Errorf("header nav toggle missing %q", want)
		}
	}
	// No fabricated contact data may reappear in the footer.
	for _, bad := range []string{"[to be confirmed]", "(847)", "(630)", "(773)"} {
		if strings.Contains(string(home), bad) {
			t.Errorf("footer must not contain fabricated contact detail %q", bad)
		}
	}
	cssMatches, err := filepath.Glob(filepath.Join(dist, "assets", "css", "site.*.css"))
	if err != nil {
		t.Fatal(err)
	}
	if len(cssMatches) != 1 {
		t.Errorf("want exactly one fingerprinted site stylesheet, got %v", cssMatches)
	}
}

func TestRunGeneratesContactFromSiteContent(t *testing.T) {
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}
	contact, err := os.ReadFile(filepath.Join(dist, "contact", "index.html"))
	if err != nil {
		t.Fatal("contact page missing:", err)
	}
	for _, want := range []string{
		"2725 Thomas St",
		"Melrose Park, IL 60160",
		`href="tel:&#43;17083436702"`,
		`href="tel:&#43;17083436536"`,
		`href="mailto:info@finevines.com"`,
	} {
		if !strings.Contains(string(contact), want) {
			t.Errorf("contact page missing verified detail %q", want)
		}
	}
	if strings.Contains(string(contact), "[to be confirmed]") {
		t.Error("contact page must not publish confirmation placeholders")
	}
}

// TestRunCopiesRedirectsJSONWhenPresent guards Fix 1: redirects.Save writes
// redirects.json to the repo root (the process's working directory), and
// nothing else previously copied it into dist/ — so the deployed Edge
// middleware's runtime fetch of /redirects.json 404'd into an empty map and
// every discovered 301 silently no-op'd. Run must now pick it up from cwd
// and copy it into dist/ verbatim.
func TestRunCopiesRedirectsJSONWhenPresent(t *testing.T) {
	dataDir := mustAbs(t, "testdata")
	assetsDir := mustAbs(t, "../../assets")
	templatesDir := mustAbs(t, "../../templates")
	dist := t.TempDir()

	workDir := t.TempDir()
	want := []byte("{\n  \"/old-page.html\": \"/new-page/\"\n}\n")
	if err := os.WriteFile(filepath.Join(workDir, "redirects.json"), want, 0o644); err != nil {
		t.Fatal(err)
	}
	chdir(t, workDir)

	if err := Run(dataDir, assetsDir, templatesDir, dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(filepath.Join(dist, "redirects.json"))
	if err != nil {
		t.Fatalf("dist/redirects.json not written: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("dist/redirects.json = %q, want %q (bytes must match exactly, per deploy's hash-diff)", got, want)
	}
}

// TestRunSucceedsWithoutRedirectsJSON guards the other half of Fix 1: a
// fresh checkout (or one that hasn't run `finevines redirects` yet) has no
// redirects.json at the repo root — that must not fail the build, and
// dist/redirects.json must simply not exist.
func TestRunSucceedsWithoutRedirectsJSON(t *testing.T) {
	dataDir := mustAbs(t, "testdata")
	assetsDir := mustAbs(t, "../../assets")
	templatesDir := mustAbs(t, "../../templates")
	dist := t.TempDir()

	chdir(t, t.TempDir()) // empty working dir: no redirects.json here

	if err := Run(dataDir, assetsDir, templatesDir, dist, "https://finevines.com", ""); err != nil {
		t.Fatalf("Run should succeed when redirects.json is absent: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dist, "redirects.json")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("dist/redirects.json should not exist when the source file is absent, stat err = %v", err)
	}
}

// mustAbs resolves rel (relative to the package directory this test binary
// starts in) to an absolute path. Tests that chdir (see chdir below) must
// resolve dataDir/assetsDir/templatesDir through this first, since those
// Run arguments stop being valid relative paths once the process's cwd
// moves.
func mustAbs(t *testing.T, rel string) string {
	t.Helper()
	abs, err := filepath.Abs(rel)
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

// chdir switches the test process's working directory to dir for the
// duration of the calling test, restoring the original directory via
// t.Cleanup. Needed because copyRedirectsJSON reads "redirects.json"
// relative to the process's cwd — matching where redirects.Save writes it
// (repo root) and where cmd/finevines's runBuild/runRedirects always
// operate from.
func chdir(t *testing.T, dir string) {
	t.Helper()
	orig, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(orig); err != nil {
			t.Fatal(err)
		}
	})
}

// TestGA4Hook verifies the config-driven analytics hook: the gtag snippet
// is emitted only when a real GA4 id (G-…) is configured. An empty id (the
// default, which keeps the build byte-identical) and a stray legacy UA id
// (Universal Analytics stopped processing data in July 2023 — a UA tag must
// never be emitted) both produce no snippet.
func TestGA4Hook(t *testing.T) {
	render := func(t *testing.T, gaID string) string {
		t.Helper()
		dist := t.TempDir()
		if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", gaID); err != nil {
			t.Fatal(err)
		}
		home, err := os.ReadFile(filepath.Join(dist, "index.html"))
		if err != nil {
			t.Fatal(err)
		}
		return string(home)
	}

	// Real GA4 id → snippet present, configured with that exact id.
	withID := render(t, "G-ABC1234567")
	for _, want := range []string{
		`src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234567"`,
		`gtag('config','G-ABC1234567')`,
	} {
		if !strings.Contains(withID, want) {
			t.Errorf("GA4 snippet missing %q when a G- id is configured", want)
		}
	}

	// Empty id (default) → nothing emitted, so the build stays deterministic.
	if got := render(t, ""); strings.Contains(got, "googletagmanager.com/gtag") {
		t.Error("GA snippet must not be emitted when FINEVINES_GA_ID is empty")
	}

	// Legacy UA id → nothing emitted (guarded by the G- prefix check).
	if got := render(t, "UA-41731070-1"); strings.Contains(got, "googletagmanager.com/gtag") {
		t.Error("GA snippet must not be emitted for a legacy UA (Universal Analytics) id")
	}
}

func TestWineDetailPages(t *testing.T) {
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}
	page, err := os.ReadFile(filepath.Join(dist, "wines",
		"hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)
	for _, want := range []string{
		`<script type="application/ld+json">`,
		`"@type": "Product"`,
		`"@type": "Offer"`,
		`"availability": "https://schema.org/InStock"`,
		"<title>Hubert Lamy",         // unique title
		`alt="Bottle of Hubert Lamy`, // real alt text
		`rel="canonical" href="https://finevines.com/wines/hubert-lamy-`,
		`<meta name="twitter:card" content="summary_large_image">`,
		`<meta property="og:title" content="Hubert Lamy`, // per-wine og:title
		// This wine's art is a .webp — NOT a scraper-safe raster — so its
		// og:image must fall back to the branded default, not point at the webp.
		`<meta property="og:image" content="https://finevines.com/assets/img/og-default.png">`,
	} {
		if !strings.Contains(html, want) {
			t.Errorf("wine page missing %q", want)
		}
	}
	if strings.Contains(html, "ab1234.webp") && strings.Contains(html, `property="og:image" content="https://finevines.com/assets/img/wines/ab1234.webp"`) {
		t.Error("webp wine art must NOT be used as og:image (scrapers won't render it)")
	}

	// The Ridgeview wine's art IS a .jpg, so its own photo (absolute URL) must
	// override the default as the og:image — the per-page raster override.
	rid, err := os.ReadFile(filepath.Join(dist, "wines",
		"ridgeview-cellars-estate-cabernet-sauvignon-2020", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	ridHTML := string(rid)
	for _, want := range []string{
		`<meta property="og:image" content="https://finevines.com/assets/img/wines/ef9012.jpg">`,
		`<meta name="twitter:image" content="https://finevines.com/assets/img/wines/ef9012.jpg">`,
	} {
		if !strings.Contains(ridHTML, want) {
			t.Errorf("ridgeview wine page missing raster og override %q", want)
		}
	}
}

func TestPortfolioPage(t *testing.T) {
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}
	page, err := os.ReadFile(filepath.Join(dist, "portfolio", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)

	// All three fixture wines must appear as crawlable links to their detail
	// pages — this is the SEO surface, so it must be real HTML, not something
	// portfolio.js assembles at runtime.
	for _, w := range []struct{ name, href string }{
		{"Saint-Aubin 1er Cru", `href="/wines/hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021/"`},
		{"Côtes du Rhône Villages", `href="/wines/domaine-petit-clos-cotes-du-rhone-villages-2022/"`},
		{"Estate Cabernet Sauvignon", `href="/wines/ridgeview-cellars-estate-cabernet-sauvignon-2020/"`},
	} {
		if !strings.Contains(html, w.href) {
			t.Errorf("portfolio missing link %q", w.href)
		}
		if !strings.Contains(html, w.name) {
			t.Errorf("portfolio missing wine name %q", w.name)
		}
	}

	// JS↔template hook contract: portfolio.js (Step 3) depends on these
	// selectors/attributes existing verbatim in the rendered markup.
	for _, want := range []string{
		`class="wine-grid view-cards"`,
		`data-slug="hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021"`,
		`data-facet="producer"`,
		`id="portfolio-count"`,
		`id="portfolio-search"`,
		`src="/assets/js/portfolio.`,
		`class="page-hero"`, // signature bordeaux hero band on section pages
		// Cards | List view toggle control + the grid's default view class
		// that portfolio.js swaps between (facet filtering works in both).
		`class="view-toggle"`,
		`data-view="cards"`,
		`data-view="list"`,
		// Off-canvas filter drawer (≤1024px): the Filters button in the toolbar
		// opens the .facets panel, which now carries an id so aria-controls and
		// the drawer JS can target it, a close (×) control, and a backdrop.
		// filters.js drives open/close; the search box + facet checkboxes stay
		// inside .facets so portfolio.js keeps filtering in both card & list views.
		`class="filters-toggle"`,
		`aria-controls="portfolio-facets"`,
		`id="portfolio-facets"`,
		`class="facets-close"`,
		`class="facets-backdrop"`,
		`src="/assets/js/filters.`,
		// New paginated-catalog hooks portfolio.js depends on: the content-
		// hashed index URL + pageSize/page metadata on the grid, the sort
		// select, the country facet (replaced style), the per-value count span,
		// the empty state, and the crawlable pagination nav.
		`data-index-url="/assets/catalog-index.`,
		`data-page-size="48"`,
		`data-page="1"`,
		`data-page-count="1"`,
		`id="portfolio-sort"`,
		`data-facet="country"`,
		`class="facet-count"`,
		`id="portfolio-empty"`,
		`class="pagination"`,
		// Filter rail (issue #4). portfolio.js wires the whole rail by
		// DELEGATION off these data-attributes, because value rows are
		// re-rendered on every query — so each of these is a hard contract.
		`data-facet-group="producer"`,
		`data-facet-values="producer"`,
		`data-facet-filter="producer"`,
		`class="facet-row"`,
		`class="facet-label"`,
		`class="facet-total"`,
		`class="facet-selected"`,
		`id="portfolio-chips"`,
		`class="facets-apply"`,
		// Vintage is a chip grid, and the big groups ship collapsed.
		`class="facet-values is-grid"`,
	} {
		if !strings.Contains(html, want) {
			t.Errorf("portfolio missing hook %q", want)
		}
	}
	// style was dropped as a facet — its checkbox must be gone.
	if strings.Contains(html, `data-facet="style"`) {
		t.Error("portfolio must not render the dropped 'style' facet")
	}

	// The seed is capped. This is the page-weight guarantee: the old rail put
	// every one of 577 facet values on all ~56 paginated pages, ~40% of the
	// bytes. A regression here would be invisible to every other assertion.
	if n := strings.Count(html, `data-facet="producer"`); n > facetSeedSize {
		t.Errorf("producer facet rendered %d values, want at most %d", n, facetSeedSize)
	}
	// The big groups must arrive COLLAPSED. <details open> on producer is
	// exactly the state this work exists to remove.
	if strings.Contains(html, `data-big="1" open>`) {
		t.Error("big facet groups must not render <details open>")
	}
	// NOTE: the "show all N" expander is deliberately NOT asserted here. This
	// fixture holds three wines, so no group exceeds the seed and rendering an
	// expander would be the bug. HasMore() is covered by
	// TestBuildFacetsRanksAndSeeds, and the real control is exercised against
	// the full 2,665-wine build in tests/e2e/filter-rail.test.js.
}

func TestNewsPagesAndHomeDigest(t *testing.T) {
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}

	landing, err := os.ReadFile(filepath.Join(dist, "news", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	landingHTML := string(landing)
	for _, want := range []string{
		"Spring Portfolio Tasting",
		`href="/news/spring-portfolio-tasting/"`,
	} {
		if !strings.Contains(landingHTML, want) {
			t.Errorf("news landing missing %q", want)
		}
	}
	// Fix 4: the landing excerpt must be truncated via the excerpt() helper,
	// not the raw multi-paragraph .Body — the fixture's second paragraph
	// must never appear on the landing page, and the truncated excerpt must
	// carry its trailing ellipsis.
	if strings.Contains(landingHTML, "Light bites will be served") {
		t.Error("news landing excerpt should be truncated, not the full multi-paragraph body")
	}
	if !strings.Contains(landingHTML, "…") {
		t.Error("news landing excerpt should be truncated with a trailing ellipsis")
	}
	home, err := os.ReadFile(filepath.Join(dist, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	homeHTML := string(home)
	if strings.Contains(homeHTML, "Light bites will be served") {
		t.Error("home news digest should be truncated, not the full multi-paragraph body")
	}
	if !strings.Contains(homeHTML, "…") {
		t.Error("home news digest should be truncated with a trailing ellipsis")
	}

	post, err := os.ReadFile(filepath.Join(dist, "news", "spring-portfolio-tasting", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	postHTML := string(post)
	for _, want := range []string{
		"<title>Spring Portfolio Tasting",
		`rel="canonical" href="https://finevines.com/news/spring-portfolio-tasting/"`,
		`<script type="application/ld+json">`,
		`"@type": "NewsArticle"`,
		"datePublished",
		"2026-04-12",
		"Light bites will be served", // full body still renders on the post page, unlike the landing excerpt
		// Fix 3: the fixture's "image" field must render on the post page.
		`<img class="news-post-photo" src="/assets/news/spring-tasting.jpg" alt="Spring Portfolio Tasting">`,
	} {
		if !strings.Contains(postHTML, want) {
			t.Errorf("news post missing %q", want)
		}
	}
}

func TestAboutPage(t *testing.T) {
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}
	page, err := os.ReadFile(filepath.Join(dist, "about", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)
	for _, want := range []string{
		"<title>About",
		`rel="canonical" href="https://finevines.com/about/"`,
		"George Molitor",
		"Founder &amp; President",
		"Barbara Fultz",
		"Office Manager",
		`class="team-monogram"`,
		`>GM</span>`,
		`>BF</span>`,
		`href="mailto:george@finevines.com"`,
		`href="mailto:barb@finevines.com"`,
	} {
		if !strings.Contains(html, want) {
			t.Errorf("about page missing %q", want)
		}
	}
	for _, internal := range []string{"confirm email", "barbara@finevines.com"} {
		if strings.Contains(html, internal) {
			t.Errorf("about page leaked internal or superseded roster data %q", internal)
		}
	}
}

func TestNewsPagesEmptyState(t *testing.T) {
	dataDir := t.TempDir()
	for _, name := range []string{"wines.json", "team.json", "site.json"} {
		data, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dataDir, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dataDir, "news"), 0o755); err != nil {
		t.Fatal(err)
	}

	dist := t.TempDir()
	if err := Run(dataDir, "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		filepath.Join(dist, "index.html"),
		filepath.Join(dist, "news", "index.html"),
	} {
		page, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(page), "Fresh notes from the FineVines trade team are on the way.") {
			t.Errorf("%s missing the news empty state", path)
		}
	}
}

func TestInitials(t *testing.T) {
	for _, tc := range []struct {
		name string
		want string
	}{
		{name: "George Molitor", want: "GM"},
		{name: "Barbara Fultz", want: "BF"},
		{name: "Connie", want: "C"},
		{name: "  ", want: ""},
	} {
		if got := initials(tc.name); got != tc.want {
			t.Errorf("initials(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// TestCatalogIndex replaces the old search-index.json test. The compact
// per-wine browse index now lives at dist/assets/catalog-index.<hash>.json:
// content-hashed (so Bunny caches it immutably), compact-marshaled, and
// carrying only browse fields — including the new sku/country/color keys and
// NO style key (style is empty on every real wine, dropped from the schema).
func TestCatalogIndex(t *testing.T) {
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}
	// The old flat dist/search-index.json must be gone.
	if _, err := os.Stat(filepath.Join(dist, "search-index.json")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("legacy dist/search-index.json should no longer be written, stat err = %v", err)
	}

	matches, err := filepath.Glob(filepath.Join(dist, "assets", "catalog-index.*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 {
		t.Fatalf("want exactly one content-hashed catalog-index, got %d: %v", len(matches), matches)
	}
	data, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "\n") {
		t.Error("catalog-index should be compact (json.Marshal), not indented")
	}
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(data, &entries); err != nil {
		t.Fatalf("catalog-index does not parse: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("want 3 entries, got %d", len(entries))
	}
	wantKeys := []string{"slug", "sku", "producer", "name", "vintage", "region", "varietal", "country", "color", "img"}
	for _, e := range entries {
		for _, k := range wantKeys {
			if _, ok := e[k]; !ok {
				t.Errorf("catalog-index entry missing key %q: %v", k, e)
			}
		}
		if _, ok := e["style"]; ok {
			t.Errorf("catalog-index entry must not carry the dropped 'style' key: %v", e)
		}
	}
	// The empty-slug placeholder must never reach the index — the first entry
	// (index is slug-sorted) must have a real slug.
	var first struct {
		Slug string `json:"slug"`
	}
	if err := json.Unmarshal(mustFirstEntry(t, data), &first); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(first.Slug) == "" {
		t.Error("first catalog-index entry has an empty slug — the blank wine was not filtered out")
	}
}

// mustFirstEntry returns the raw JSON of the first element of a JSON array.
func mustFirstEntry(t *testing.T, data []byte) []byte {
	t.Helper()
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) == 0 {
		t.Fatal("catalog-index is empty")
	}
	return raw[0]
}

func TestSitemapListsEveryPage(t *testing.T) {
	dist := t.TempDir()
	Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", "")
	sm, _ := os.ReadFile(filepath.Join(dist, "sitemap.xml"))
	for _, want := range []string{
		"<loc>https://finevines.com/</loc>",
		"<loc>https://finevines.com/portfolio/</loc>",
		"<loc>https://finevines.com/wines/hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021/</loc>",
		"<loc>https://finevines.com/news/spring-portfolio-tasting/</loc>",
	} {
		if !strings.Contains(string(sm), want) {
			t.Errorf("sitemap missing %q", want)
		}
	}
	if strings.Contains(string(sm), "<lastmod>") {
		t.Error("sitemap must not contain lastmod (breaks determinism)")
	}
}

func TestRobotsTxt(t *testing.T) {
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}
	robots, err := os.ReadFile(filepath.Join(dist, "robots.txt"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"User-agent: *",
		"Allow: /",
		"Sitemap: https://finevines.com/sitemap.xml",
	} {
		if !strings.Contains(string(robots), want) {
			t.Errorf("robots.txt missing %q", want)
		}
	}
}

func TestBuildIsDeterministic(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	Run("testdata", "../../assets", "../../templates", a, "https://finevines.com", "")
	Run("testdata", "../../assets", "../../templates", b, "https://finevines.com", "")
	if diff := treeDiff(t, a, b); diff != "" { // helper: walk both, compare bytes
		t.Fatalf("non-deterministic build:\n%s", diff)
	}
}

// treeDiff walks both dist trees and reports any files that differ, are
// missing from one side, or are only present on one side. Returns "" when
// the trees are byte-identical — the regression guard behind
// TestBuildIsDeterministic (build.Run must be a pure function of its
// inputs: no network, no clocks, no randomness, no unsorted map iteration).
func treeDiff(t *testing.T, a, b string) string {
	t.Helper()
	hashesA := hashTree(t, a)
	hashesB := hashTree(t, b)
	var diffs []string
	for rel, ha := range hashesA {
		hb, ok := hashesB[rel]
		if !ok {
			diffs = append(diffs, fmt.Sprintf("only in %s: %s", a, rel))
			continue
		}
		if ha != hb {
			diffs = append(diffs, fmt.Sprintf("content differs: %s", rel))
		}
	}
	for rel := range hashesB {
		if _, ok := hashesA[rel]; !ok {
			diffs = append(diffs, fmt.Sprintf("only in %s: %s", b, rel))
		}
	}
	sort.Strings(diffs)
	return strings.Join(diffs, "\n")
}

// hashTree walks root and returns a map of slash-separated relative
// path -> sha256 hex digest of the file's bytes.
func hashTree(t *testing.T, root string) map[string]string {
	t.Helper()
	hashes := make(map[string]string)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		hashes[filepath.ToSlash(rel)] = hex.EncodeToString(sum[:])
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return hashes
}

// TestBuildGeneratesMissingLabels covers the rule that lets the ~2,200
// generated label SVGs stay OUT of source control: whatever is missing from
// assets/, the build reproduces into dist/, so the site never ships a broken
// image. Before this, only `enrich` called label.Generate, so the SVGs had to
// be committed or a fresh clone built a site full of broken <img>s.
func TestBuildGeneratesMissingLabels(t *testing.T) {
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}

	// The fixture's three wines all point at images that do NOT exist under
	// assets/img/wines/, one per extension.
	svg := filepath.Join(dist, "assets", "img", "wines", "cd5678.svg")
	got, err := os.ReadFile(svg)
	if err != nil {
		t.Fatalf("build must generate the missing label SVG: %v", err)
	}
	if !bytes.HasPrefix(bytes.TrimSpace(got), []byte("<svg")) {
		t.Errorf("generated label is not an SVG document, starts: %.40q", got)
	}
	// It must be the wine's OWN label, not a placeholder.
	if !bytes.Contains(got, []byte("DOMAINE PETIT-CLOS")) {
		t.Error("generated label does not carry the wine's producer")
	}

	// A missing .jpg/.webp is a data error (a photo we expected is gone) and
	// must stay visible, not be papered over with a generated vector label.
	for _, name := range []string{"ef9012.jpg", "ab1234.webp"} {
		if _, err := os.Stat(filepath.Join(dist, "assets", "img", "wines", name)); !os.IsNotExist(err) {
			t.Errorf("build must not synthesise %s in place of a missing photo", name)
		}
	}
}

// TestEnsureLabelsNeverOverwrites protects the 478 real bottle photographs
// matched from the old site: a file that is already there is the source of
// truth and must survive the build untouched.
func TestEnsureLabelsNeverOverwrites(t *testing.T) {
	dist := t.TempDir()
	rel := filepath.Join("assets", "img", "wines", "keep.svg")
	if err := os.MkdirAll(filepath.Join(dist, "assets", "img", "wines"), 0o755); err != nil {
		t.Fatal(err)
	}
	sentinel := []byte("<svg><!-- the real one --></svg>")
	if err := os.WriteFile(filepath.Join(dist, rel), sentinel, 0o644); err != nil {
		t.Fatal(err)
	}

	wines := []model.Wine{{
		Slug: "keep", SKU: "K1", Producer: "Keeper", Name: "Cuvee",
		ImagePath: "assets/img/wines/keep.svg",
	}}
	if err := ensureLabels(dist, wines); err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(filepath.Join(dist, rel))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, sentinel) {
		t.Errorf("ensureLabels overwrote an existing image:\n got %q\nwant %q", got, sentinel)
	}
}

// wineWith builds a minimal wine carrying just the facet fields under test.
func wineWith(slug, producer, region, varietal, country, vintage string) model.Wine {
	return model.Wine{
		Slug: slug, Name: slug, Producer: producer, Region: region,
		Varietal: varietal, Country: country, Vintage: vintage,
	}
}

// TestBuildFacetsRanksAndSeeds covers the rule that makes a 310-value group
// usable: the server emits only the highest-count values, ranked, with the
// full total carried separately for the header and the expander.
func TestBuildFacetsRanksAndSeeds(t *testing.T) {
	// 3 Lamy, 2 Roulot, 1 each for 14 others => 16 distinct producers, so the
	// seed must cut at facetSeedSize (12) and Total must still report 16.
	var wines []model.Wine
	add := func(n int, producer string) {
		for i := 0; i < n; i++ {
			wines = append(wines, wineWith(fmt.Sprintf("%s-%d", producer, i), producer, "Burgundy", "Chardonnay", "France", "2021"))
		}
	}
	add(3, "Lamy")
	add(2, "Roulot")
	for i := 0; i < 14; i++ {
		add(1, fmt.Sprintf("Small%02d", i))
	}

	groups := buildFacets(wines)

	// Display order is the sidebar's order and is part of the contract.
	var order []string
	for _, g := range groups {
		order = append(order, g.Facet)
	}
	if want := []string{"producer", "region", "varietal", "vintage", "country"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("facet order = %v, want %v", order, want)
	}

	producer := groups[0]
	if producer.Total != 16 {
		t.Errorf("Total = %d, want 16 (the whole catalog, not the seed)", producer.Total)
	}
	if len(producer.Values) != facetSeedSize {
		t.Errorf("seeded %d values, want %d", len(producer.Values), facetSeedSize)
	}
	if !producer.HasMore() {
		t.Error("HasMore must be true when the catalog holds more than the seed")
	}
	// Ranked by count desc: the two multi-wine producers lead.
	if producer.Values[0].Value != "Lamy" || producer.Values[0].Count != 3 {
		t.Errorf("first value = %+v, want Lamy/3", producer.Values[0])
	}
	if producer.Values[1].Value != "Roulot" || producer.Values[1].Count != 2 {
		t.Errorf("second value = %+v, want Roulot/2", producer.Values[1])
	}
	// Ties break alphabetically — the tiebreak that makes the ordering total,
	// and therefore the build deterministic.
	for i := 2; i < len(producer.Values)-1; i++ {
		a, b := producer.Values[i], producer.Values[i+1]
		if a.Count == b.Count && a.Value >= b.Value {
			t.Errorf("tie at %d not broken alphabetically: %q then %q", i, a.Value, b.Value)
		}
	}

	// Small groups are never capped and carry every value.
	country := groups[4]
	if country.Total != 1 || len(country.Values) != 1 {
		t.Errorf("country = %d values / total %d, want 1/1", len(country.Values), country.Total)
	}
	if country.HasMore() {
		t.Error("a fully-seeded group must not offer an expander")
	}
}

// TestBuildFacetsGroupFlags pins the first-paint behaviour: the big groups
// arrive collapsed (the whole point of the change) and vintage reads as a
// newest-first grid rather than a popularity ranking.
func TestBuildFacetsGroupFlags(t *testing.T) {
	wines := []model.Wine{
		wineWith("a", "P1", "R1", "V1", "France", "2019"),
		wineWith("b", "P1", "R1", "V1", "France", "2021"),
		wineWith("c", "P2", "R2", "V2", "Italy", "2020"),
		// An empty value must never become a checkbox.
		wineWith("d", "", "", "", "", ""),
	}
	byFacet := map[string]facetGroup{}
	for _, g := range buildFacets(wines) {
		byFacet[g.Facet] = g
	}

	for _, facet := range []string{"producer", "region", "varietal"} {
		g := byFacet[facet]
		if !g.Big {
			t.Errorf("%s should be a big group", facet)
		}
		if g.Open {
			t.Errorf("%s must ship COLLAPSED — an expanded 310-item list is the bug", facet)
		}
	}
	for _, facet := range []string{"vintage", "country"} {
		if g := byFacet[facet]; !g.Open {
			t.Errorf("%s should ship expanded", facet)
		}
	}

	vintage := byFacet["vintage"]
	if !vintage.Grid {
		t.Error("vintage should render as a grid")
	}
	// Newest first, and 2021 (count 1) ahead of 2019 (count 1) is chronology
	// not ranking — the assertion that would fail if vintage were count-sorted.
	var years []string
	for _, v := range vintage.Values {
		years = append(years, v.Value)
	}
	if want := []string{"2021", "2020", "2019"}; !reflect.DeepEqual(years, want) {
		t.Errorf("vintages = %v, want %v (newest first)", years, want)
	}

	// The blank wine contributed nothing anywhere.
	for facet, g := range byFacet {
		for _, v := range g.Values {
			if v.Value == "" {
				t.Errorf("%s emitted an empty facet value", facet)
			}
		}
	}
}

// TestBuildFacetsLabels covers the copy that has to state the FULL total, not
// the twelve on screen — otherwise the control understates what it reaches.
func TestBuildFacetsLabels(t *testing.T) {
	var wines []model.Wine
	for i := 0; i < 1500; i++ {
		wines = append(wines, wineWith(fmt.Sprintf("w%d", i), fmt.Sprintf("P%04d", i), "R", "V", "France", "2021"))
	}
	g := buildFacets(wines)[0]
	if got, want := g.Placeholder(), "Filter 1,500 producers…"; got != want {
		t.Errorf("Placeholder() = %q, want %q", got, want)
	}
	if got, want := g.ExpandLabel(), "Show all 1,500 producers"; got != want {
		t.Errorf("ExpandLabel() = %q, want %q", got, want)
	}
}

// TestBuildFacetsIsDeterministic guards the ordering tiebreak directly. Go
// randomises map iteration, so a ranking keyed only on count would shuffle
// tied values between builds and break byte-identical output.
func TestBuildFacetsIsDeterministic(t *testing.T) {
	var wines []model.Wine
	for i := 0; i < 40; i++ {
		// Every producer has exactly one wine — all ties, worst case.
		wines = append(wines, wineWith(fmt.Sprintf("w%d", i), fmt.Sprintf("P%02d", i), "R", "V", "France", "2021"))
	}
	first := buildFacets(wines)
	for i := 0; i < 20; i++ {
		if got := buildFacets(wines); !reflect.DeepEqual(got, first) {
			t.Fatalf("buildFacets is not deterministic across runs (iteration %d)", i)
		}
	}
}

func TestFeaturedHomepageSelectionFallsBackWithoutRepeatingProducers(t *testing.T) {
	wines := []model.Wine{
		{Slug: "a", Producer: "Alpha", ImagePath: "assets/a.jpg", Region: "Burgundy"},
		{Slug: "b", Producer: "Alpha", ImagePath: "assets/b.jpg", Region: "Burgundy"},
		{Slug: "c", Producer: "Cellar C", ImagePath: "assets/c.png", Region: "Piedmont"},
		{Slug: "d", Producer: "Domaine D", ImagePath: "assets/d.svg", Region: "Rhône Valley"},
	}
	got := selectFeaturedWines(wines, []string{"missing", "b"}, 3)
	if len(got) != 3 {
		t.Fatalf("featured wines = %+v, want three", got)
	}
	if want := []string{"b", "c", "d"}; !reflect.DeepEqual(
		[]string{got[0].Slug, got[1].Slug, got[2].Slug}, want,
	) {
		t.Fatalf("featured slugs = %v, want %v", got, want)
	}

	producers := featuredProducers(wines, got)
	if len(producers) != 3 {
		t.Fatalf("featured producers = %+v, want three unique producers", producers)
	}
	if producers[0].Count != 2 || producers[0].URL != "/portfolio/?producer=Alpha" {
		t.Errorf("Alpha producer card = %+v", producers[0])
	}
	if producers[2].CountLabel != "1 current listing" {
		t.Errorf("singular producer count = %q", producers[2].CountLabel)
	}
	if producers[1].URL != "/portfolio/?producer=Cellar+C" {
		t.Errorf("producer URL should be query encoded, got %q", producers[1].URL)
	}
}

// TestHomeHotSellersSectionIsSalesDriven covers the data-present path: a
// testdata copy with a hot-sellers.json ranking renders the "What the Trade
// Is Pouring" section in RANKED order (not catalog order), shows each card's
// availability line, and never leaks the ranking's raw case volumes — those
// are private diagnostics (competitively sensitive), the section curates
// without counting.
func TestHomeHotSellersSectionIsSalesDriven(t *testing.T) {
	data := t.TempDir()
	if err := os.CopyFS(data, os.DirFS("testdata")); err != nil {
		t.Fatal(err)
	}
	// Ridgeview (SF-00789) outsells Petit-Clos outsells Lamy — deliberately
	// the reverse of wines.json's slug order so an accidental catalog-order
	// render fails the order assertion below. 8.25 is a distinctive volume
	// that must never appear in the HTML.
	hs := model.HotSellers{
		Updated:    "2026-07-29T00:00:00Z",
		WindowDays: 30,
		Wines: []model.HotSeller{
			{Slug: "ridgeview-cellars-estate-cabernet-sauvignon-2020", Cases: 8.25},
			{Slug: "domaine-petit-clos-cotes-du-rhone-villages-2022", Cases: 4.5},
			{Slug: "hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021", Cases: 2},
		},
	}
	if err := model.SaveHotSellers(filepath.Join(data, "hot-sellers.json"), hs); err != nil {
		t.Fatal(err)
	}

	dist := t.TempDir()
	if err := Run(data, "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}
	homeBytes, err := os.ReadFile(filepath.Join(dist, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	home := string(homeBytes)

	for _, want := range []string{
		`class="wrap home-hot-sellers"`,
		`What the Trade Is Pouring`,
		`In Demand`,
	} {
		if !strings.Contains(home, want) {
			t.Errorf("home missing hot-sellers marker %q", want)
		}
	}

	section := home[strings.Index(home, `home-hot-sellers`):]
	section = section[:strings.Index(section, `</section>`)]
	first := strings.Index(section, `href="/wines/ridgeview-cellars-estate-cabernet-sauvignon-2020/"`)
	second := strings.Index(section, `href="/wines/domaine-petit-clos-cotes-du-rhone-villages-2022/"`)
	third := strings.Index(section, `href="/wines/hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021/"`)
	if first < 0 || second < 0 || third < 0 {
		t.Fatalf("hot-sellers section missing ranked wines (indexes %d, %d, %d)", first, second, third)
	}
	if !(first < second && second < third) {
		t.Errorf("hot sellers not in ranked order: indexes %d, %d, %d", first, second, third)
	}

	// Availability (stock, a number we already publish) yes; sales volume no.
	// The leak check is scoped to the section — elsewhere in the page "8.25"
	// occurs as SVG path coordinates in the footer icons.
	if !strings.Contains(section, `class="avail"`) {
		t.Errorf("hot-seller cards missing availability line")
	}
	if strings.Contains(section, "8.25") {
		t.Errorf("hot-sellers section leaks the ranking's case volume (8.25) — sales numbers must never render")
	}
}

// TestHomeHotSellersOmittedWhenAbsentOrThin covers both omission paths: no
// hot-sellers.json at all (mock/dev builds), and a ranking too thin to read
// as a real pulse (fewer than three resolvable wines).
func TestHomeHotSellersOmittedWhenAbsentOrThin(t *testing.T) {
	// Plain testdata has no hot-sellers.json.
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}
	home, err := os.ReadFile(filepath.Join(dist, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(home), "home-hot-sellers") {
		t.Errorf("home renders hot-sellers section with no hot-sellers.json present")
	}

	// A ranking whose entries mostly no longer resolve (sold out / gone from
	// the catalog) must drop the whole section, not render a lonely card.
	data := t.TempDir()
	if err := os.CopyFS(data, os.DirFS("testdata")); err != nil {
		t.Fatal(err)
	}
	hs := model.HotSellers{
		Updated:    "2026-07-29T00:00:00Z",
		WindowDays: 30,
		Wines: []model.HotSeller{
			{Slug: "hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021", Cases: 9},
			{Slug: "no-longer-in-catalog", Cases: 7},
			{Slug: "also-gone", Cases: 5},
		},
	}
	if err := model.SaveHotSellers(filepath.Join(data, "hot-sellers.json"), hs); err != nil {
		t.Fatal(err)
	}
	dist2 := t.TempDir()
	if err := Run(data, "../../assets", "../../templates", dist2, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}
	home2, err := os.ReadFile(filepath.Join(dist2, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(home2), "home-hot-sellers") {
		t.Errorf("home renders hot-sellers section from a ranking with only one resolvable wine")
	}
}

// TestBuild_UnavailableWineHasPageButIsHiddenFromBrowse guards the delisting
// lifecycle's build-side contract: a wine with Status ==
// model.StatusUnavailable keeps its own detail page (so any search ranking it
// earned survives the stock-out) rendered with an OutOfStock JSON-LD offer
// and a visible unavailable notice, but is otherwise invisible — dropped from
// the sitemap, the portfolio grid, and the compact catalog-index JSON that
// feeds client-side search/filters. An active wine alongside it is
// unaffected and still asserts InStock.
func TestBuild_UnavailableWineHasPageButIsHiddenFromBrowse(t *testing.T) {
	data := t.TempDir()
	if err := os.CopyFS(data, os.DirFS("testdata")); err != nil {
		t.Fatal(err)
	}
	wines := []model.Wine{
		{ID: "SF-1", SKU: "AA1111", Producer: "Alpha", Name: "Active Red", Vintage: "2021",
			Slug: "alpha-active-red-2021", Description: "d", ImagePath: "assets/img/wines/a.svg"},
		{ID: "SF-2", SKU: "BB2222", Producer: "Beta", Name: "Gone Blanc", Vintage: "2020",
			Slug: "beta-gone-blanc-2020", Description: "d", ImagePath: "assets/img/wines/b.svg",
			Status: model.StatusUnavailable, DelistedAt: "2026-07-01T00:00:00Z"},
	}
	if err := model.SaveWines(filepath.Join(data, "wines.json"), wines); err != nil {
		t.Fatal(err)
	}

	dist := t.TempDir()
	if err := Run(data, "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}

	// 1. The unavailable wine still gets a page...
	page := readFile(t, filepath.Join(dist, "wines", "beta-gone-blanc-2020", "index.html"))
	if !strings.Contains(page, "currently unavailable") {
		t.Error("unavailable page must say so")
	}
	if !strings.Contains(page, `"availability": "https://schema.org/OutOfStock"`) {
		t.Error("unavailable page must carry OutOfStock JSON-LD")
	}

	// 2. ...but is absent from sitemap, portfolio, and the catalog index.
	sitemap := readFile(t, filepath.Join(dist, "sitemap.xml"))
	if strings.Contains(sitemap, "beta-gone-blanc-2020") {
		t.Error("unavailable wine must not be in the sitemap")
	}
	if !strings.Contains(sitemap, "alpha-active-red-2021") {
		t.Error("active wine must still be in the sitemap")
	}
	portfolio := readFile(t, filepath.Join(dist, "portfolio", "index.html"))
	if strings.Contains(portfolio, "beta-gone-blanc-2020") {
		t.Error("unavailable wine must not appear on the portfolio grid")
	}
	// The compact catalog index feeds client-side search/filters.
	idx := globOne(t, filepath.Join(dist, "assets", "catalog-index*.json"))
	if strings.Contains(readFile(t, idx), "beta-gone-blanc-2020") {
		t.Error("unavailable wine must not be in the catalog index")
	}

	// 3. Active wine's page asserts InStock unchanged.
	active := readFile(t, filepath.Join(dist, "wines", "alpha-active-red-2021", "index.html"))
	if !strings.Contains(active, `"availability": "https://schema.org/InStock"`) {
		t.Error("active page must remain InStock")
	}

	// 4. The delisted wine's own page still gets its no-broken-image label
	// fallback generated, same as an active wine — its detail page is a real
	// published page, not a second-class one.
	if _, err := os.Stat(filepath.Join(dist, "assets", "img", "wines", "b.svg")); err != nil {
		t.Errorf("delisted wine's label image was not generated: %v", err)
	}
}

// readFile reads path and fails the test on error, returning the contents as
// a string for strings.Contains checks against rendered dist/ output.
func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// globOne resolves pattern to exactly one file (e.g. the content-hashed
// catalog-index.<hash>.json) and fails the test if zero or more than one
// match, since a hashed filename can't be predicted ahead of the build.
func globOne(t *testing.T, pattern string) string {
	t.Helper()
	matches, err := filepath.Glob(pattern)
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 {
		t.Fatalf("glob %q: want exactly one match, got %v", pattern, matches)
	}
	return matches[0]
}

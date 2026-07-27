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
	"sort"
	"strings"
	"testing"
)

func TestRunGeneratesHomeAndContact(t *testing.T) {
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
		"Pouring elegance with a sommelier",                      // tagline present
		`rel="canonical" href="https://finevines.com/"`,
		`href="/assets/css/site.css"`,
		`href="/assets/img/favicon.ico"`,                         // favicon wired in base head
		`<img src="/assets/img/finevines-logo.png" alt="FineVines"`, // real logo wordmark in header
	} {
		if !strings.Contains(string(home), want) {
			t.Errorf("home missing %q", want)
		}
	}

	// Enterprise footer: text wordmark (not the colored logo image, which
	// would clash on the dark bordeaux band), all four column headings, the
	// real social handles, the clearly-marked contact placeholders, and the
	// static-year bottom bar (no runtime clock — must stay deterministic).
	for _, want := range []string{
		`class="footer-wordmark">FINEVINES`,                              // styled text wordmark
		`>Explore</h2>`, `>Trade</h2>`, `>Contact</h2>`,                  // column headings
		`href="https://www.instagram.com/finevineswine/"`,               // real Instagram
		`href="https://twitter.com/finevineswine"`,                      // real X/Twitter
		`href="https://www.linkedin.com/company/1291059"`,               // real LinkedIn
		`Become a Customer`,                                             // trade CTA
		`[Mailing address &mdash; to be confirmed]`,                     // placeholder, not fabricated
		`Email: [to be confirmed]`,
		`&copy; 2026 FineVines. All rights reserved.`,                   // static year, no clock
	} {
		if !strings.Contains(string(home), want) {
			t.Errorf("footer missing %q", want)
		}
	}
	// The colored brand logo image must stay in the HEADER only — the footer
	// renders the wordmark as text, so there must be exactly one logo <img>.
	if n := strings.Count(string(home), "finevines-logo.png"); n != 1 {
		t.Errorf("expected exactly 1 logo image (header only), got %d", n)
	}
	// No fabricated contact data may reappear in the footer.
	for _, bad := range []string{"@finevines.com", "(847)", "(630)", "(773)"} {
		if strings.Contains(string(home), bad) {
			t.Errorf("footer must not contain fabricated contact detail %q", bad)
		}
	}
	if _, err := os.Stat(filepath.Join(dist, "contact", "index.html")); err != nil {
		t.Error("contact page missing")
	}
	if _, err := os.Stat(filepath.Join(dist, "assets", "css", "site.css")); err != nil {
		t.Error("assets not copied into dist")
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
	} {
		if !strings.Contains(html, want) {
			t.Errorf("wine page missing %q", want)
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
		`class="wine-grid"`,
		`data-slug="hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021"`,
		`data-facet="producer"`,
		`id="portfolio-count"`,
		`id="portfolio-search"`,
		`src="/assets/js/portfolio.js"`,
		`class="page-hero"`, // signature bordeaux hero band on section pages
	} {
		if !strings.Contains(html, want) {
			t.Errorf("portfolio missing hook %q", want)
		}
	}
}

func TestNewsPages(t *testing.T) {
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
	} {
		if !strings.Contains(html, want) {
			t.Errorf("about page missing %q", want)
		}
	}
}

func TestSearchIndex(t *testing.T) {
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dist, "search-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "\n") {
		t.Error("search-index.json should be compact (json.Marshal), not indented")
	}
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(data, &entries); err != nil {
		t.Fatalf("search-index.json does not parse: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("want 3 entries, got %d", len(entries))
	}
	wantKeys := []string{"slug", "producer", "name", "vintage", "varietal", "region", "style", "img"}
	for _, e := range entries {
		for _, k := range wantKeys {
			if _, ok := e[k]; !ok {
				t.Errorf("search-index entry missing key %q: %v", k, e)
			}
		}
	}
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

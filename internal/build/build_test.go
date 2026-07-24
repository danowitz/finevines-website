package build

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunGeneratesHomeAndContact(t *testing.T) {
	dist := t.TempDir()
	err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com")
	if err != nil {
		t.Fatal(err)
	}
	home, err := os.ReadFile(filepath.Join(dist, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"<title>Fine Vines",
		"Pouring elegance with a sommelier", // tagline present
		`rel="canonical" href="https://finevines.com/"`,
		`href="/assets/css/site.css"`,
	} {
		if !strings.Contains(string(home), want) {
			t.Errorf("home missing %q", want)
		}
	}
	if _, err := os.Stat(filepath.Join(dist, "contact", "index.html")); err != nil {
		t.Error("contact page missing")
	}
	if _, err := os.Stat(filepath.Join(dist, "assets", "css", "site.css")); err != nil {
		t.Error("assets not copied into dist")
	}
}

func TestWineDetailPages(t *testing.T) {
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com"); err != nil {
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
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com"); err != nil {
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
	} {
		if !strings.Contains(html, want) {
			t.Errorf("portfolio missing hook %q", want)
		}
	}
}

func TestSearchIndex(t *testing.T) {
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com"); err != nil {
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

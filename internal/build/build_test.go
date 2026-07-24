package build

import (
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

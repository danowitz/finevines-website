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

package enrich

import (
	"path/filepath"
	"testing"
)

func TestLifecycleRedirects_RoundTripAndMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lifecycle-redirects.json")

	got, err := LoadLifecycleRedirects(path)
	if err != nil || len(got) != 0 {
		t.Fatalf("missing file must load as empty map, got %v / %v", got, err)
	}

	m := map[string]string{"/wines/old-slug/": "/wines/new-slug/"}
	if err := SaveLifecycleRedirects(path, m); err != nil {
		t.Fatal(err)
	}
	got, err = LoadLifecycleRedirects(path)
	if err != nil || got["/wines/old-slug/"] != "/wines/new-slug/" {
		t.Fatalf("round-trip failed: %v / %v", got, err)
	}
}

func TestCollapseRedirects_ChainsSelfLoopsAndReactivation(t *testing.T) {
	m := map[string]string{
		"/wines/a/": "/wines/b/", // chain head
		"/wines/b/": "/wines/c/", // chain middle
		"/wines/d/": "/wines/d/", // self-loop -> removed
		"/wines/e/": "/portfolio/",
	}
	live := map[string]bool{"b": true} // wine b is back in the catalog

	got := CollapseRedirects(m, live)

	if got["/wines/a/"] != "/wines/c/" {
		t.Errorf("chain a->b->c must collapse to a->c, got %q", got["/wines/a/"])
	}
	if _, ok := got["/wines/b/"]; ok {
		t.Error("reactivated wine b must lose its redirect (its page exists again)")
	}
	if _, ok := got["/wines/d/"]; ok {
		t.Error("self-loop must be removed")
	}
	if got["/wines/e/"] != "/portfolio/" {
		t.Errorf("plain entry must survive, got %q", got["/wines/e/"])
	}
}

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

func TestCollapseRedirects_CyclesAreRemoved(t *testing.T) {
	tests := []struct {
		name    string
		m       map[string]string
		live    map[string]bool
		dropped []string
		kept    map[string]string
	}{
		{
			name: "2-node cycle removes both",
			m: map[string]string{
				"/wines/a/": "/wines/b/",
				"/wines/b/": "/wines/a/",
			},
			live:    map[string]bool{},
			dropped: []string{"/wines/a/", "/wines/b/"},
			kept:    map[string]string{},
		},
		{
			name: "3-node cycle removes all",
			m: map[string]string{
				"/wines/a/": "/wines/b/",
				"/wines/b/": "/wines/c/",
				"/wines/c/": "/wines/a/",
			},
			live:    map[string]bool{},
			dropped: []string{"/wines/a/", "/wines/b/", "/wines/c/"},
			kept:    map[string]string{},
		},
		{
			name: "entry leading into cycle is removed",
			m: map[string]string{
				"/wines/x/": "/wines/a/",
				"/wines/a/": "/wines/b/",
				"/wines/b/": "/wines/a/",
			},
			live:    map[string]bool{},
			dropped: []string{"/wines/x/", "/wines/a/", "/wines/b/"},
			kept:    map[string]string{},
		},
		{
			name: "cycle coexists with valid entry",
			m: map[string]string{
				"/wines/a/": "/wines/b/",
				"/wines/b/": "/wines/a/",
				"/wines/c/": "/portfolio/",
			},
			live:    map[string]bool{},
			dropped: []string{"/wines/a/", "/wines/b/"},
			kept:    map[string]string{"/wines/c/": "/portfolio/"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CollapseRedirects(tt.m, tt.live)

			// Verify dropped entries are gone
			for _, entry := range tt.dropped {
				if _, ok := got[entry]; ok {
					t.Errorf("expected %q to be dropped, but it exists with target %q", entry, got[entry])
				}
			}

			// Verify kept entries survive
			for from, expectedTo := range tt.kept {
				if got[from] != expectedTo {
					t.Errorf("expected %q -> %q, got %q", from, expectedTo, got[from])
				}
			}

			// Verify no extra entries
			if len(got) != len(tt.kept) {
				t.Errorf("expected %d entries, got %d: %v", len(tt.kept), len(got), got)
			}
		})
	}
}

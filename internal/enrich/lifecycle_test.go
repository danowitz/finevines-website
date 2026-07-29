package enrich

import (
	"os"
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

// TestSaveLifecycleRedirectsIsAtomic guards the same crash-safety property as
// model.SaveWines (finding: SaveLifecycleRedirects was a plain os.WriteFile,
// which truncates in place — a crash mid-write would destroy the whole
// accumulated redirect map, and unlike wines.json that knowledge cannot be
// reconstructed from Salesforce on a later run). Asserts the two observable
// consequences of the temp-file+rename mechanism: a normal round trip still
// works, and no ".tmp-*" file is left in the target directory once
// SaveLifecycleRedirects returns successfully.
func TestSaveLifecycleRedirectsIsAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "lifecycle-redirects.json")
	m := map[string]string{"/wines/old-slug/": "/wines/new-slug/"}

	if err := SaveLifecycleRedirects(path, m); err != nil {
		t.Fatal(err)
	}

	got, err := LoadLifecycleRedirects(path)
	if err != nil || got["/wines/old-slug/"] != "/wines/new-slug/" {
		t.Fatalf("round trip through atomic SaveLifecycleRedirects failed: %v / %v", got, err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "lifecycle-redirects.json" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("directory should contain only lifecycle-redirects.json after a successful save, got %v", names)
	}
}

// TestCollapseRedirects_ChainsSelfLoopsAndReactivation: chain-following stops
// the moment it lands on a live wine page rather than flattening straight
// through it. Before this fix, a->b->c with b live collapsed to a->c — but
// that sends a visitor of the OLD "a" URL past b's live page to c, when b's
// page is the correct (and only truthful) landing spot: the wine at "a" was
// renamed to "b", and "b" is the current page. Only a genuinely dead
// intermediate hop should be flattened through.
func TestCollapseRedirects_ChainsSelfLoopsAndReactivation(t *testing.T) {
	m := map[string]string{
		"/wines/a/": "/wines/b/", // chain head
		"/wines/b/": "/wines/c/", // chain middle -- but b is LIVE, see below
		"/wines/d/": "/wines/d/", // self-loop -> removed
		"/wines/e/": "/portfolio/",
	}
	live := map[string]bool{"b": true} // wine b is back in the catalog

	got := CollapseRedirects(m, live)

	if got["/wines/a/"] != "/wines/b/" {
		t.Errorf("chain a->b->c must stop AT the live page b (a->b), not flatten through it to c, got %q", got["/wines/a/"])
	}
	if _, ok := got["/wines/b/"]; ok {
		t.Error("reactivated wine b must lose its own redirect (its page exists again)")
	}
	if _, ok := got["/wines/d/"]; ok {
		t.Error("self-loop must be removed")
	}
	if got["/wines/e/"] != "/portfolio/" {
		t.Errorf("plain entry must survive, got %q", got["/wines/e/"])
	}
}

// TestCollapseRedirects_RenameThenRevertResolvesToLivePage is the repro for
// the permanent-data-loss bug: a wine renamed a->b then renamed BACK to a
// leaves two stale entries — a->b (from the first rename) and b->a (from
// the revert) — with "a" live again. Filtering only the OUTPUT by liveSlugs
// is not enough: chain-following used to consult the RAW map, see the
// now-meaningless a->b entry, call the whole thing a cycle, and drop
// EVERYTHING — including the one entry that is still correct: b's page is
// gone and must 301 to the current live page, "a".
func TestCollapseRedirects_RenameThenRevertResolvesToLivePage(t *testing.T) {
	m := map[string]string{
		"/wines/a/": "/wines/b/", // stale: superseded by the revert below; a is live, so this must vanish
		"/wines/b/": "/wines/a/", // still true: b's page is gone, must land on the live "a"
	}
	live := map[string]bool{"a": true}

	got := CollapseRedirects(m, live)

	if got["/wines/b/"] != "/wines/a/" {
		t.Errorf("rename-then-revert must resolve b->a (live terminal), got %q (full map %v)", got["/wines/b/"], got)
	}
	if _, ok := got["/wines/a/"]; ok {
		t.Error("live wine a's own stale source entry must not survive")
	}
	if len(got) != 1 {
		t.Errorf("want exactly 1 surviving entry, got %v", got)
	}
}

// TestCollapseRedirects_ChainStopsAtLiveTerminal is the general (non-revert)
// case: a longer chain a->b->c where the MIDDLE hop, b, has come back to
// life. The chain must stop AT b — the visitor lands on a real page — not
// be flattened straight through to c.
func TestCollapseRedirects_ChainStopsAtLiveTerminal(t *testing.T) {
	m := map[string]string{
		"/wines/a/": "/wines/b/",
		"/wines/b/": "/wines/c/",
	}
	live := map[string]bool{"b": true}

	got := CollapseRedirects(m, live)

	if got["/wines/a/"] != "/wines/b/" {
		t.Errorf("chain must stop at the live page b, got %q", got["/wines/a/"])
	}
	if _, ok := got["/wines/b/"]; ok {
		t.Error("b's own stale entry must not survive now that its page is live")
	}
}

// TestCollapseRedirects_IntoDeadCycleFallsBackToPortfolio: an entry whose
// chain leads INTO a genuine (all-dead) cycle without itself being a member
// of it must not simply vanish (a silent 404) — it falls back to
// /portfolio/, the same generic target any other dropped-and-gone wine
// gets. The cycle's own members (a, b below) have no single sane target and
// are still removed entirely.
func TestCollapseRedirects_IntoDeadCycleFallsBackToPortfolio(t *testing.T) {
	m := map[string]string{
		"/wines/x/": "/wines/a/",
		"/wines/a/": "/wines/b/",
		"/wines/b/": "/wines/a/",
	}
	got := CollapseRedirects(m, map[string]bool{})

	if got["/wines/x/"] != "/portfolio/" {
		t.Errorf("entry leading into a dead cycle must fall back to /portfolio/, got %q", got["/wines/x/"])
	}
	if _, ok := got["/wines/a/"]; ok {
		t.Error("cycle member a must still be removed, not given a fallback")
	}
	if _, ok := got["/wines/b/"]; ok {
		t.Error("cycle member b must still be removed, not given a fallback")
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
			// Updated for the into-cycle fallback fix: x is NOT a member of
			// the dead a<->b cycle it walks into, so it falls back to
			// /portfolio/ instead of vanishing; a and b (the actual cycle
			// members) still have no sane single target and stay dropped.
			name: "entry leading into cycle falls back to portfolio, cycle members removed",
			m: map[string]string{
				"/wines/x/": "/wines/a/",
				"/wines/a/": "/wines/b/",
				"/wines/b/": "/wines/a/",
			},
			live:    map[string]bool{},
			dropped: []string{"/wines/a/", "/wines/b/"},
			kept:    map[string]string{"/wines/x/": "/portfolio/"},
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

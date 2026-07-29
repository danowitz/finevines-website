package enrich

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Lifecycle redirects are the 301 map the SITE ITSELF generates as wines are
// renamed or delisted, as opposed to the old-finevines.com crawl map built by
// the `redirects` subcommand. They persist append-only in
// data/lifecycle-redirects.json (sibling of wines.json) and are merged into
// dist/redirects.json at build time, which the Bunny Edge middleware already
// serves as 301s.

// LoadLifecycleRedirects reads the map at path. A missing file is a normal
// first run: empty map, nil error.
func LoadLifecycleRedirects(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	m := map[string]string{}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// SaveLifecycleRedirects writes the map as indented JSON (map keys marshal
// sorted, so the file diffs cleanly in review).
//
// The write is atomic — the same temp-file+rename pattern as
// model.SaveWines (see its doc comment for the full rationale). A plain
// os.WriteFile truncates in place, so a crash mid-write would destroy the
// WHOLE accumulated redirect map; unlike wines.json, that knowledge cannot
// be reconstructed from Salesforce on a later run once the dropped/renamed
// wine's old record is gone from `existing` — so this file's durability
// matters just as much as wines.json's.
func SaveLifecycleRedirects(path string, m map[string]string) error {
	data, err := json.MarshalIndent(m, "", "  ")
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

// isLiveWinePage reports whether path (a redirect map key or value, e.g.
// "/wines/foo/") points at a wine slug currently in liveSlugs — i.e. a real,
// published page, not a stale redirect target.
func isLiveWinePage(path string, liveSlugs map[string]bool) bool {
	slug, ok := strings.CutPrefix(path, "/wines/")
	if !ok {
		return false
	}
	return liveSlugs[strings.TrimSuffix(slug, "/")]
}

// CollapseRedirects normalizes the accumulated map:
//
//   - an entry whose SOURCE is a live wine page again (reactivated slug) is
//     pruned BEFORE any chain-following happens — the page exists,
//     redirecting it would shadow real content, and the stale entry must
//     never be treated as a live hop when some OTHER entry's chain passes
//     through it (this is what makes rename-then-revert correct: a→b, b→a
//     with "a" live must resolve to b→a, not be misread as a cycle and
//     dropped wholesale — see TestCollapseRedirects_RenameThenRevertResolvesToLivePage);
//   - a chain that lands on a live wine page STOPS there — it is a
//     terminal, not a hop to keep following, even in the general
//     (non-revert) case where a middle hop of a longer chain came back to
//     life;
//   - ordinary all-dead chains are flattened (a→b, b→c ⇒ a→c) so no visitor
//     ever hops twice;
//   - a chain that loops back on ITSELF — a self-loop, or a genuine cycle
//     among all-dead pages — removes every node that is a MEMBER of that
//     cycle; there is no single sane target to give them;
//   - an entry whose chain merely LEADS INTO such a dead cycle, without
//     being a member of it, is not left to silently 404: it falls back to
//     delistRedirectTarget, the same generic target any other dropped wine
//     gets.
//
// liveSlugs holds bare wine slugs (no /wines/ prefix). The input map is not
// mutated.
func CollapseRedirects(m map[string]string, liveSlugs map[string]bool) map[string]string {
	// Prune live-SOURCE entries FIRST, before any chain-following: the page
	// they'd redirect from exists again, so they must never participate in
	// another entry's chain or cycle detection.
	pruned := make(map[string]string, len(m))
	for from, to := range m {
		if isLiveWinePage(from, liveSlugs) {
			continue
		}
		pruned[from] = to
	}

	out := make(map[string]string, len(pruned))
	for from, to0 := range pruned {
		visited := make(map[string]bool)
		to := to0
		cyclic := false
		for {
			if isLiveWinePage(to, liveSlugs) {
				break // terminal: the chain has landed on a live wine page
			}
			if visited[to] {
				cyclic = true
				break
			}
			visited[to] = true
			next, ok := pruned[to]
			if !ok {
				break // terminal: not (or no longer) in the map
			}
			to = next
		}

		switch {
		case cyclic && visited[from]:
			// `from` is itself a member of the dead cycle it walked into —
			// there is no single sane target for it. Drop entirely.
			continue
		case cyclic:
			// The chain leads into a dead cycle it isn't part of. Don't let
			// it 404 — fall back to the same generic target a hard drop uses.
			out[from] = delistRedirectTarget
		case from == to:
			continue // resolved straight back to itself (defensive; see self-loop handling above)
		default:
			out[from] = to
		}
	}
	return out
}

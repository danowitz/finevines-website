package enrich

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
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
func SaveLifecycleRedirects(path string, m map[string]string) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

// CollapseRedirects normalizes the accumulated map:
//
//   - an entry whose SOURCE is a live wine page again (reactivated slug) is
//     removed — the page exists, redirecting it would shadow real content;
//   - chains are flattened (a→b, b→c ⇒ a→c) so no visitor ever hops twice;
//   - self-loops and cyclic chains are removed entirely.
//
// liveSlugs holds bare wine slugs (no /wines/ prefix). The input map is not
// mutated.
func CollapseRedirects(m map[string]string, liveSlugs map[string]bool) map[string]string {
	out := make(map[string]string, len(m))
	for from, to := range m {
		if slug, ok := strings.CutPrefix(from, "/wines/"); ok {
			if liveSlugs[strings.TrimSuffix(slug, "/")] {
				continue // page is back — no redirect
			}
		}
		// Follow the chain, tracking visited nodes to detect cycles.
		visited := make(map[string]bool)
		for {
			if visited[to] {
				// Cycle detected: this entry leads into a cycle, drop it.
				to = ""
				break
			}
			visited[to] = true
			next, ok := m[to]
			if !ok {
				// Found a terminal target (not in the map).
				break
			}
			to = next
		}
		if to == "" || from == to {
			// Dropped due to cycle or self-loop.
			continue
		}
		out[from] = to
	}
	return out
}

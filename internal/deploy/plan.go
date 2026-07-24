// Package deploy uploads a built dist/ tree to a Bunny.net Storage Zone
// using a hash-diff (only files whose content changed since the last
// deploy are uploaded), then purges the Pull Zone CDN cache.
//
// The package splits cleanly into two halves:
//   - Plan (this file): pure, no I/O beyond reading distDir — computes what
//     needs to change. Fully unit-testable with a temp directory.
//   - BunnyClient (bunny.go): the actual HTTP calls against Bunny.net's
//     Storage and Pull Zone APIs. Fully unit-testable with httptest.
package deploy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// Plan walks distDir, computes a sha256 (hex) of every file's contents keyed
// by its site-root-relative path (forward-slash, OS-independent), and
// compares that current tree against oldManifest (the manifest saved after
// the previous deploy) to decide what needs to change:
//
//   - a file whose hash differs from oldManifest, or that has no entry in
//     oldManifest at all, belongs in uploads.
//   - a key present in oldManifest with no corresponding file on disk
//     anymore belongs in deletes.
//   - newManifest is the current tree's full path->hash map, exactly as
//     found on disk right now (regardless of upload/delete status) — this
//     is what gets persisted as the new manifest after a successful deploy.
//
// uploads and deletes are both sorted for deterministic output and stable
// logs. Plan does no network I/O and never touches Bunny.net.
func Plan(distDir string, oldManifest map[string]string) (uploads []string, deletes []string, newManifest map[string]string, err error) {
	newManifest = map[string]string{}

	walkErr := filepath.WalkDir(distDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(distDir, path)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)

		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		sum := sha256.Sum256(data)
		newManifest[rel] = hex.EncodeToString(sum[:])
		return nil
	})
	if walkErr != nil {
		return nil, nil, nil, walkErr
	}

	for rel, hash := range newManifest {
		if oldHash, ok := oldManifest[rel]; !ok || oldHash != hash {
			uploads = append(uploads, rel)
		}
	}
	for rel := range oldManifest {
		if _, ok := newManifest[rel]; !ok {
			deletes = append(deletes, rel)
		}
	}
	sort.Strings(uploads)
	sort.Strings(deletes)

	return uploads, deletes, newManifest, nil
}

// LoadManifest reads the persisted path->sha256 manifest from the previous
// deploy. A missing file is treated as "first deploy" and returns an empty,
// non-nil map with no error rather than failing — there's nothing wrong
// with deploying for the very first time.
func LoadManifest(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	m := map[string]string{}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// SaveManifest persists the manifest as compact JSON. encoding/json sorts
// map keys when marshaling, so the output is deterministic across runs
// (stable diffs if the manifest is ever inspected or diffed by hand).
func SaveManifest(path string, m map[string]string) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

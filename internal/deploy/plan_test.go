package deploy

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// sha256Hex hashes content independently of the Plan implementation, so
// fixtures don't derive their "ground truth" by calling the function under
// test.
func sha256Hex(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// writeDistFixture creates a temp dist/ tree with 3 files:
//   - unchanged.txt:  content that will match oldManifest exactly
//   - sub/changed.txt: content that will NOT match oldManifest (hash differs)
//   - new.txt:         a file with no entry in oldManifest at all
//
// It returns the dir and the sha256 hex hashes of each file's fixed content,
// computed independently of Plan, so tests can build an oldManifest without
// relying on the function under test to produce its own expected values.
func writeDistFixture(t *testing.T) (dir string, unchangedHash, changedHash, newHash string) {
	t.Helper()
	dir = t.TempDir()

	write := func(rel, content string) {
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	const unchangedContent = "same content"
	const changedContent = "new version of content"
	const newContent = "brand new file"

	write("unchanged.txt", unchangedContent)
	write("sub/changed.txt", changedContent)
	write("new.txt", newContent)

	return dir, sha256Hex(unchangedContent), sha256Hex(changedContent), sha256Hex(newContent)
}

func TestPlan_UploadsChangedAndNewDeletesOrphan(t *testing.T) {
	dir, unchangedHash, _, _ := writeDistFixture(t)

	oldManifest := map[string]string{
		"unchanged.txt":   unchangedHash,      // matches -> not uploaded
		"sub/changed.txt": "stale-hash-value", // differs -> uploaded
		// "new.txt" intentionally absent -> uploaded
		"orphan.txt": "orphan-hash", // no file on disk -> deleted
	}

	uploads, deletes, newManifest, err := Plan(dir, oldManifest)
	if err != nil {
		t.Fatalf("Plan returned error: %v", err)
	}

	wantUploads := []string{"new.txt", "sub/changed.txt"} // sorted
	if !reflect.DeepEqual(uploads, wantUploads) {
		t.Errorf("uploads = %v, want %v", uploads, wantUploads)
	}

	wantDeletes := []string{"orphan.txt"}
	if !reflect.DeepEqual(deletes, wantDeletes) {
		t.Errorf("deletes = %v, want %v", deletes, wantDeletes)
	}

	if len(newManifest) != 3 {
		t.Fatalf("newManifest has %d entries, want 3: %v", len(newManifest), newManifest)
	}
	for _, key := range []string{"unchanged.txt", "sub/changed.txt", "new.txt"} {
		if _, ok := newManifest[key]; !ok {
			t.Errorf("newManifest missing key %q", key)
		}
	}
	if _, ok := newManifest["orphan.txt"]; ok {
		t.Errorf("newManifest should not contain orphan.txt (it doesn't exist on disk)")
	}
}

func TestPlan_FirstDeployUploadsEverythingNoDeletes(t *testing.T) {
	dir, _, _, _ := writeDistFixture(t)

	uploads, deletes, newManifest, err := Plan(dir, map[string]string{})
	if err != nil {
		t.Fatalf("Plan returned error: %v", err)
	}

	wantUploads := []string{"new.txt", "sub/changed.txt", "unchanged.txt"} // sorted
	if !reflect.DeepEqual(uploads, wantUploads) {
		t.Errorf("uploads = %v, want %v", uploads, wantUploads)
	}
	if len(deletes) != 0 {
		t.Errorf("deletes = %v, want empty", deletes)
	}
	if len(newManifest) != 3 {
		t.Errorf("newManifest has %d entries, want 3", len(newManifest))
	}
}

func TestPlan_NoChangesNoUploadsNoDeletes(t *testing.T) {
	dir, unchangedHash, changedHash, newHash := writeDistFixture(t)

	oldManifest := map[string]string{
		"unchanged.txt":   unchangedHash,
		"sub/changed.txt": changedHash,
		"new.txt":         newHash,
	}

	uploads, deletes, _, err := Plan(dir, oldManifest)
	if err != nil {
		t.Fatalf("Plan returned error: %v", err)
	}
	if len(uploads) != 0 {
		t.Errorf("uploads = %v, want empty when nothing changed", uploads)
	}
	if len(deletes) != 0 {
		t.Errorf("deletes = %v, want empty when nothing changed", deletes)
	}
}

func TestPlan_UsesForwardSlashKeysOnAnyOS(t *testing.T) {
	dir, _, _, _ := writeDistFixture(t)

	_, _, newManifest, err := Plan(dir, map[string]string{})
	if err != nil {
		t.Fatalf("Plan returned error: %v", err)
	}
	if _, ok := newManifest["sub/changed.txt"]; !ok {
		t.Errorf("expected forward-slash key %q in manifest, got keys %v", "sub/changed.txt", keysOf(newManifest))
	}
}

func keysOf(m map[string]string) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}

func TestLoadManifest_MissingFileReturnsEmptyMap(t *testing.T) {
	dir := t.TempDir()
	m, err := LoadManifest(filepath.Join(dir, ".bunny-manifest.json"))
	if err != nil {
		t.Fatalf("LoadManifest on missing file should not error, got: %v", err)
	}
	if m == nil || len(m) != 0 {
		t.Errorf("LoadManifest on missing file = %v, want empty non-nil map", m)
	}
}

func TestSaveAndLoadManifestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".bunny-manifest.json")
	original := map[string]string{
		"a.txt":     "hash-a",
		"sub/b.txt": "hash-b",
	}

	if err := SaveManifest(path, original); err != nil {
		t.Fatalf("SaveManifest error: %v", err)
	}

	loaded, err := LoadManifest(path)
	if err != nil {
		t.Fatalf("LoadManifest error: %v", err)
	}
	if !reflect.DeepEqual(loaded, original) {
		t.Errorf("round-tripped manifest = %v, want %v", loaded, original)
	}
}

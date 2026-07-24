package deploy

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// fakeUploader is an in-memory Uploader used to test Run's orchestration
// without any network calls. It records every Upload/Delete/Purge call it
// receives and can be told to fail a specific upload path, so tests can
// exercise the "abort before manifest save" path deterministically. All
// methods lock mu because Run dispatches uploads concurrently across a
// worker pool — an unsynchronized fake would itself be a data race and could
// mask (or falsely report) races in Run.
type fakeUploader struct {
	mu       sync.Mutex
	uploaded map[string][]byte
	deleted  []string
	purgeN   int

	failPath string
	failErr  error
}

func (f *fakeUploader) Upload(ctx context.Context, relPath string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failPath != "" && relPath == f.failPath {
		return f.failErr
	}
	if f.uploaded == nil {
		f.uploaded = map[string][]byte{}
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	f.uploaded[relPath] = cp
	return nil
}

func (f *fakeUploader) Delete(ctx context.Context, relPath string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, relPath)
	return nil
}

func (f *fakeUploader) Purge(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.purgeN++
	return nil
}

func (f *fakeUploader) uploadedKeys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	ks := make([]string, 0, len(f.uploaded))
	for k := range f.uploaded {
		ks = append(ks, k)
	}
	return ks
}

// writeRunFixtureFile writes one file (creating parent dirs as needed) under
// dir, using a slash-separated rel path regardless of host OS.
func writeRunFixtureFile(t *testing.T, dir, rel, content string) {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// captureLog returns a log func(string, ...any) that appends formatted lines
// to the returned slice pointer, for asserting on Run's log output (e.g. the
// "nothing to deploy" no-op message).
func captureLog() (func(string, ...any), *[]string) {
	var lines []string
	return func(format string, args ...any) {
		lines = append(lines, fmt.Sprintf(format, args...))
	}, &lines
}

func TestRun_HappyPathUploadsOnlyDiffDeletesOrphanAndPurgesOnce(t *testing.T) {
	dist := t.TempDir()
	manifestDir := t.TempDir()
	manifestPath := filepath.Join(manifestDir, ".bunny-manifest.json")

	const aboutContent = "same about page"
	writeRunFixtureFile(t, dist, "about.html", aboutContent)        // unchanged vs manifest
	writeRunFixtureFile(t, dist, "index.html", "new home page")     // new -> uploaded
	writeRunFixtureFile(t, dist, "css/site.css", "body{color:red}") // new, in subdir -> uploaded

	oldManifest := map[string]string{
		"about.html": sha256Hex(aboutContent),
		"old.html":   "stale-hash-no-longer-on-disk", // orphan -> deleted
	}
	if err := SaveManifest(manifestPath, oldManifest); err != nil {
		t.Fatalf("seeding manifest: %v", err)
	}

	fake := &fakeUploader{}
	logf, logs := captureLog()

	err := Run(context.Background(), fake, dist, manifestPath, 4, logf)
	if err != nil {
		t.Fatalf("Run returned error: %v", err)
	}

	wantUploaded := []string{"css/site.css", "index.html"}
	gotUploaded := fake.uploadedKeys()
	sortStrings(gotUploaded)
	if !reflect.DeepEqual(gotUploaded, wantUploaded) {
		t.Errorf("uploaded = %v, want %v (about.html must NOT be uploaded, it's unchanged)", gotUploaded, wantUploaded)
	}
	if got := string(fake.uploaded["index.html"]); got != "new home page" {
		t.Errorf("uploaded index.html content = %q, want %q", got, "new home page")
	}

	if !reflect.DeepEqual(fake.deleted, []string{"old.html"}) {
		t.Errorf("deleted = %v, want [old.html]", fake.deleted)
	}

	if fake.purgeN != 1 {
		t.Errorf("purgeN = %d, want exactly 1", fake.purgeN)
	}

	savedManifest, err := LoadManifest(manifestPath)
	if err != nil {
		t.Fatalf("reloading saved manifest: %v", err)
	}
	wantManifest := map[string]string{
		"about.html":   sha256Hex(aboutContent),
		"index.html":   sha256Hex("new home page"),
		"css/site.css": sha256Hex("body{color:red}"),
	}
	if !reflect.DeepEqual(savedManifest, wantManifest) {
		t.Errorf("saved manifest = %v, want %v", savedManifest, wantManifest)
	}

	joined := strings.Join(*logs, "\n")
	if !strings.Contains(joined, "2") || !strings.Contains(joined, "1") {
		t.Errorf("expected summary log mentioning counts, got: %v", *logs)
	}
}

func TestRun_UploadFailureAbortsBeforeManifestSaveAndPurge(t *testing.T) {
	dist := t.TempDir()
	manifestDir := t.TempDir()
	manifestPath := filepath.Join(manifestDir, ".bunny-manifest.json")

	writeRunFixtureFile(t, dist, "a.txt", "aaa")
	writeRunFixtureFile(t, dist, "b.txt", "bbb")

	// Seed a manifest with known, distinguishable content so we can prove it
	// is byte-for-byte unchanged after the failed run (not just "different
	// from newManifest" but literally untouched on disk).
	initialManifest := map[string]string{"unrelated.txt": "some-old-hash"}
	if err := SaveManifest(manifestPath, initialManifest); err != nil {
		t.Fatalf("seeding manifest: %v", err)
	}
	before, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("reading seeded manifest: %v", err)
	}

	boom := errors.New("boom: simulated upload failure")
	fake := &fakeUploader{failPath: "b.txt", failErr: boom}
	logf, _ := captureLog()

	err = Run(context.Background(), fake, dist, manifestPath, 4, logf)
	if err == nil {
		t.Fatal("expected Run to return an error when an upload fails")
	}
	if !strings.Contains(err.Error(), "b.txt") {
		t.Errorf("error = %q, want it to name the failed path b.txt", err.Error())
	}

	after, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("reading manifest after failed run: %v", err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Errorf("manifest file changed after a failed upload: before=%q after=%q", before, after)
	}

	if fake.purgeN != 0 {
		t.Errorf("purgeN = %d, want 0 — must not purge after a failed upload", fake.purgeN)
	}
}

func TestRun_EmptyDiffSkipsPurgeAndLogsNothingToDeploy(t *testing.T) {
	dist := t.TempDir()
	manifestDir := t.TempDir()
	manifestPath := filepath.Join(manifestDir, ".bunny-manifest.json")

	const content = "unchanging content"
	writeRunFixtureFile(t, dist, "same.txt", content)

	oldManifest := map[string]string{"same.txt": sha256Hex(content)}
	if err := SaveManifest(manifestPath, oldManifest); err != nil {
		t.Fatalf("seeding manifest: %v", err)
	}

	fake := &fakeUploader{}
	logf, logs := captureLog()

	err := Run(context.Background(), fake, dist, manifestPath, 4, logf)
	if err != nil {
		t.Fatalf("Run returned error on no-op deploy: %v", err)
	}

	if len(fake.uploaded) != 0 {
		t.Errorf("uploaded = %v, want none", fake.uploaded)
	}
	if len(fake.deleted) != 0 {
		t.Errorf("deleted = %v, want none", fake.deleted)
	}
	if fake.purgeN != 0 {
		t.Errorf("purgeN = %d, want 0 — a no-op deploy must not churn the CDN cache", fake.purgeN)
	}

	found := false
	for _, l := range *logs {
		if strings.Contains(l, "nothing to deploy") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a log line containing %q, got: %v", "nothing to deploy", *logs)
	}
}

// sortStrings is a tiny local helper so this file doesn't need to import
// "sort" just for one call site's worth of use beyond what's already pulled
// in by the package under test.
func sortStrings(ss []string) {
	for i := 1; i < len(ss); i++ {
		for j := i; j > 0 && ss[j-1] > ss[j]; j-- {
			ss[j-1], ss[j] = ss[j], ss[j-1]
		}
	}
}

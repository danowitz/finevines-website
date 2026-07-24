package model

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWineJSONRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wines.json")
	in := []Wine{
		{ID: "SF-2", SKU: "ZZ1", Slug: "b-wine", StockQty: 3, ImageSource: "generated-label"},
		{ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy", Slug: "a-wine", StockQty: 14,
			ImageSource: "generated-photo", ImagePath: "assets/img/wines/AB1234.jpg"},
	}
	if err := SaveWines(path, in); err != nil {
		t.Fatal(err)
	}
	out, err := LoadWines(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out[0].Slug != "a-wine" { // sorted by slug on save
		t.Fatalf("got %+v", out)
	}
	if out[1].SKU != "ZZ1" {
		t.Errorf("round-trip lost data: %+v", out[1])
	}
}

func TestSaveWinesDoesNotMutateCallerSlice(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wines.json")
	in := []Wine{
		{Slug: "b-wine"},
		{Slug: "a-wine"},
	}
	if err := SaveWines(path, in); err != nil {
		t.Fatal(err)
	}
	if in[0].Slug != "b-wine" || in[1].Slug != "a-wine" {
		t.Fatalf("SaveWines mutated caller's slice order: %+v", in)
	}
}

func TestLoadWinesMissingFileReturnsEmpty(t *testing.T) {
	out, err := LoadWines(filepath.Join(t.TempDir(), "wines.json"))
	if err != nil || len(out) != 0 {
		t.Fatalf("want empty slice + nil err on first run, got %v, %v", out, err)
	}
}

// TestSaveWinesIsAtomic guards the crash-safety checkpointing enrich relies
// on: SaveWines must write via a temp file + rename, not a plain
// os.WriteFile, so a crash mid-write can never leave a truncated
// data/wines.json behind. This asserts the two observable consequences of
// that mechanism — a normal round trip still works, and no ".tmp-*" file
// is left in the target directory once SaveWines returns successfully.
func TestSaveWinesIsAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wines.json")
	in := []Wine{
		{Slug: "z-wine", SKU: "ZZ1", StockQty: 3},
		{Slug: "a-wine", SKU: "AA1", StockQty: 14},
	}
	if err := SaveWines(path, in); err != nil {
		t.Fatal(err)
	}

	out, err := LoadWines(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out[0].Slug != "a-wine" || out[1].Slug != "z-wine" {
		t.Fatalf("round trip through atomic SaveWines failed: %+v", out)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "wines.json" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("directory should contain only wines.json after a successful save, got %v", names)
	}
}

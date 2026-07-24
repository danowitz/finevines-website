package model

import (
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

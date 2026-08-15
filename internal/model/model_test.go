package model

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

func TestLoadSiteContentRequiresCompleteContact(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "site.json")
	valid := `{
		"contact": {
			"phoneDisplay": "(708) 343-6702",
			"phoneHref": "+17083436702",
			"email": "info@finevines.com"
		},
		"contactConfirmed": false,
		"featuredWineSlugs": ["featured-wine"]
	}`
	if err := os.WriteFile(path, []byte(valid), 0o644); err != nil {
		t.Fatal(err)
	}
	content, err := LoadSiteContent(path)
	if err != nil {
		t.Fatal(err)
	}
	if content.Contact.PhoneHref != "+17083436702" || len(content.FeaturedWineSlugs) != 1 {
		t.Fatalf("site content lost data: %+v", content)
	}

	incomplete := `{"contact":{"phoneDisplay":"(708) 343-6702"}}`
	if err := os.WriteFile(path, []byte(incomplete), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadSiteContent(path); err == nil {
		t.Error("incomplete site contact should be rejected")
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

func TestWineStatusRoundTripAndOmitEmpty(t *testing.T) {
	// An active wine must serialize WITHOUT status/delistedAt keys, so the
	// on-disk format of the existing 2,664-wine catalog is unchanged.
	active, err := json.Marshal(Wine{ID: "SF-1", Slug: "a-wine"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(active), "status") || strings.Contains(string(active), "delistedAt") {
		t.Errorf("active wine must omit status fields, got %s", active)
	}

	// An unavailable wine round-trips both fields.
	w := Wine{ID: "SF-2", Status: StatusUnavailable, DelistedAt: "2026-07-29T12:00:00Z"}
	b, _ := json.Marshal(w)
	var got Wine
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusUnavailable || got.DelistedAt != "2026-07-29T12:00:00Z" {
		t.Errorf("round-trip lost status: %+v", got)
	}
}

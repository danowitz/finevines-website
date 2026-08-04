package queue

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLedger_HasIsTrueOnlyForRecordedIDs(t *testing.T) {
	l := Ledger{Applied: []Applied{
		{ID: "a1", SKU: "AB1201", Kind: ActionImageSwap, AppliedAt: "2026-07-29T08:15:00Z"},
	}}
	if !l.Has("a1") {
		t.Error("Has(a1) = false, want true")
	}
	if l.Has("a2") {
		t.Error("Has(a2) = true, want false")
	}
}

// A missing ledger is first-run behaviour, not a failure — the same contract
// model.LoadWines has for a missing data/wines.json.
func TestLoadLedger_MissingFileIsEmptyNotAnError(t *testing.T) {
	l, err := LoadLedger(filepath.Join(t.TempDir(), "queue-ledger.json"))
	if err != nil {
		t.Fatalf("LoadLedger returned error: %v", err)
	}
	if len(l.Applied) != 0 {
		t.Errorf("LoadLedger of a missing file = %d entries, want 0", len(l.Applied))
	}
}

func TestSaveLedger_RoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue-ledger.json")
	want := Ledger{Applied: []Applied{
		{ID: "a1", SKU: "AB1201", Kind: ActionImageSwap, Reviewer: "barbara",
			AppliedAt: "2026-07-29T08:15:00Z", Outcome: "image replaced"},
	}}
	if err := SaveLedger(path, want); err != nil {
		t.Fatalf("SaveLedger: %v", err)
	}
	got, err := LoadLedger(path)
	if err != nil {
		t.Fatalf("LoadLedger: %v", err)
	}
	if len(got.Applied) != 1 || got.Applied[0] != want.Applied[0] {
		t.Errorf("round trip mismatch:\n got %+v\nwant %+v", got.Applied, want.Applied)
	}
	// Committed to the repo, so it has to diff cleanly: one entry per line,
	// trailing newline.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(data); n == 0 || data[n-1] != '\n' {
		t.Error("SaveLedger did not end the file with a newline")
	}
}

func TestSaveFlags_RoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "flags.json")
	want := []Flag{{SKU: "PM5030", Slug: "brezza-barolo-docg-2019", Reviewer: "george",
		Reason: "wrong producer", FlaggedAt: "2026-07-29T08:15:00Z"}}
	if err := SaveFlags(path, want); err != nil {
		t.Fatalf("SaveFlags: %v", err)
	}
	got, err := LoadFlags(path)
	if err != nil {
		t.Fatalf("LoadFlags: %v", err)
	}
	if len(got) != 1 || got[0] != want[0] {
		t.Errorf("round trip mismatch:\n got %+v\nwant %+v", got, want)
	}
}

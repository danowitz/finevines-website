package queue

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
)

// Applied is one ledger entry: proof that an Action ID was applied, and what
// happened. This is what makes the drain idempotent — a run that crashes after
// applying half the queue, or a second repository_dispatch fired for the same
// batch, re-reads the same actions and skips the ones already here.
//
// Outcome is prose, not an enum, because it is read by a human looking at a
// diff: "image replaced", "text regenerated", "no such SKU in the catalog".
type Applied struct {
	ID        string `json:"id"`
	SKU       string `json:"sku"`
	Kind      string `json:"action"`
	Reviewer  string `json:"reviewer"`
	AppliedAt string `json:"appliedAt"`
	Outcome   string `json:"outcome"`
}

// Ledger is data/queue-ledger.json — committed with the data, because CI keeps
// no state between runs and the whole point is to remember across them.
type Ledger struct {
	Applied []Applied `json:"applied"`
}

// Has reports whether id has already been applied. Linear over the slice on
// purpose: the ledger grows by a handful of entries a week, and a map would
// have to be rebuilt on every load for no measurable gain.
func (l Ledger) Has(id string) bool {
	for _, a := range l.Applied {
		if a.ID == id {
			return true
		}
	}
	return false
}

// LoadLedger reads path. A missing file is first-run behaviour, not an error —
// the same contract model.LoadWines has for a missing data/wines.json.
func LoadLedger(path string) (Ledger, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Ledger{}, nil
	}
	if err != nil {
		return Ledger{}, err
	}
	var l Ledger
	if err := json.Unmarshal(data, &l); err != nil {
		return Ledger{}, err
	}
	return l, nil
}

// SaveLedger writes l to path, indented and newline-terminated so its commits
// diff one entry at a time.
func SaveLedger(path string, l Ledger) error {
	return writeJSON(path, l)
}

// Flag is one wine a reviewer marked as wrong: wrong producer, wrong vintage,
// a duplicate. Flags are RECORDED, never auto-applied. Delisting or renaming a
// wine is a commercial decision, so the pipeline's only job is to make sure the
// flag reaches Joel and does not get lost between runs.
type Flag struct {
	SKU       string `json:"sku"`
	Slug      string `json:"slug"`
	Reviewer  string `json:"reviewer"`
	Reason    string `json:"reason"`
	FlaggedAt string `json:"flaggedAt"`
}

// LoadFlags reads data/flags.json; a missing file means no flags yet.
func LoadFlags(path string) ([]Flag, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var flags []Flag
	if err := json.Unmarshal(data, &flags); err != nil {
		return nil, err
	}
	return flags, nil
}

// SaveFlags writes flags to path.
func SaveFlags(path string, flags []Flag) error {
	if flags == nil {
		flags = []Flag{}
	}
	return writeJSON(path, flags)
}

// writeJSON is the one write shape both files use. Plain os.WriteFile, not the
// atomic temp-and-rename model.SaveWines does: these files are written once at
// the end of a drain, not checkpointed 40 times through a multi-hour run, so
// there is no window worth defending against.
func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

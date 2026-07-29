package model

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// HotSeller is one row of data/hot-sellers.json: a web-eligible wine ranked by
// how fast it is actually moving through the trade.
type HotSeller struct {
	Slug string `json:"slug"`
	// Cases is the NET cases invoiced over the trailing window (fractional —
	// broken-case sales are part-cases). It is provenance/diagnostics for this
	// PRIVATE repo file only: the build renders the ranking, never the volume —
	// case velocity is competitively sensitive for a distributor.
	Cases float64 `json:"cases"`
}

// HotSellers is data/hot-sellers.json: the sales-driven homepage ranking,
// written by `finevines enrich` (see cmd/finevines) and read by
// `finevines build`. The file is OPTIONAL — a missing file simply means the
// homepage omits its hot-sellers section (mock/dev runs, or orgs without the
// invoice sync).
type HotSellers struct {
	Updated    string      `json:"updated"` // RFC3339, when the ranking was computed
	WindowDays int         `json:"windowDays"`
	Wines      []HotSeller `json:"wines"` // best first
}

// LoadHotSellers reads path; a missing file returns the zero value and no
// error (the section is optional by design — see HotSellers).
func LoadHotSellers(path string) (HotSellers, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return HotSellers{}, nil
	}
	if err != nil {
		return HotSellers{}, err
	}
	var hs HotSellers
	if err := json.Unmarshal(data, &hs); err != nil {
		return HotSellers{}, err
	}
	return hs, nil
}

// SaveHotSellers writes path atomically (temp file + rename, same rationale as
// SaveWines: a reader must only ever observe a complete file).
func SaveHotSellers(path string, hs HotSellers) error {
	data, err := json.MarshalIndent(hs, "", "  ")
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

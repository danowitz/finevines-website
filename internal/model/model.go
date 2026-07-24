// Package model holds the shared data contract between enrich (producer),
// the Claude skills (producers), and build (consumer). JSON tags are the
// contract from the design spec §3 — do not rename without a spec change.
package model

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

const (
	ImageGeneratedPhoto   = "generated-photo"
	ImageGeneratedLabel   = "generated-label"
	ImageProducerSupplied = "producer-supplied"
)

// Wine is one row of data/wines.json — the enrich pipeline's output and
// build's primary input.
type Wine struct {
	ID             string `json:"id"`
	SourceHash     string `json:"sourceHash"`
	SKU            string `json:"sku"`
	Producer       string `json:"producer"`
	Name           string `json:"name"`
	Vintage        string `json:"vintage"`
	Varietal       string `json:"varietal"`
	Region         string `json:"region"`
	Appellation    string `json:"appellation"`
	Style          string `json:"style"`
	StockQty       int    `json:"stockQty"`
	Description    string `json:"description"`
	SommelierNotes string `json:"sommelierNotes"`
	ImagePath      string `json:"imagePath"`
	ImageSource    string `json:"imageSource"`
	Slug           string `json:"slug"`
}

// NewsPost is one data/news/<slug>.json file.
type NewsPost struct {
	Title    string `json:"title"`
	Date     string `json:"date"` // YYYY-MM-DD
	Category string `json:"category"`
	Body     string `json:"body"`
	Image    string `json:"image,omitempty"`
	Slug     string `json:"slug"`
}

// TeamMember is one entry of data/team.json.
type TeamMember struct {
	Name      string `json:"name"`
	Role      string `json:"role"`
	Email     string `json:"email"`
	PhotoPath string `json:"photoPath,omitempty"`
	Note      string `json:"note,omitempty"`
}

// LoadWines reads and parses path as JSON. A missing file is not an error:
// it returns an empty slice and a nil error (first-run behavior).
func LoadWines(path string) ([]Wine, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return []Wine{}, nil
	}
	if err != nil {
		return nil, err
	}
	var wines []Wine
	if err := json.Unmarshal(data, &wines); err != nil {
		return nil, err
	}
	return wines, nil
}

// SaveWines writes wines to path as pretty-printed JSON sorted by slug
// (deterministic for clean diffs); the caller's slice is not modified.
//
// The write is atomic: data is written to a temp file created alongside
// path (same directory, so the later rename stays on one filesystem), then
// renamed into place. Enrich rewrites data/wines.json every 50 wines during
// the initial 5-10k-wine run as its crash-safety checkpoint; a plain
// os.WriteFile that crashes mid-write would leave a truncated file that
// fails LoadWines on resume, defeating the whole point of checkpointing.
// os.Rename is atomic on the same filesystem, so a reader (including a
// resumed enrich run) only ever observes the old complete file or the new
// complete file, never a partial one.
func SaveWines(path string, wines []Wine) error {
	sorted := append([]Wine(nil), wines...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Slug < sorted[j].Slug })
	data, err := json.MarshalIndent(sorted, "", "  ")
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

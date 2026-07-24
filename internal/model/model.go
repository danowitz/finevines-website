// Package model holds the shared data contract between enrich (producer),
// the Claude skills (producers), and build (consumer). JSON tags are the
// contract from the design spec §3 — do not rename without a spec change.
package model

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
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
func SaveWines(path string, wines []Wine) error {
	sorted := append([]Wine(nil), wines...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Slug < sorted[j].Slug })
	data, err := json.MarshalIndent(sorted, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

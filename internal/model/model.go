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

type NewsPost struct {
	Title    string `json:"title"`
	Date     string `json:"date"` // YYYY-MM-DD
	Category string `json:"category"`
	Body     string `json:"body"`
	Image    string `json:"image,omitempty"`
	Slug     string `json:"slug"`
}

type TeamMember struct {
	Name      string `json:"name"`
	Role      string `json:"role"`
	Email     string `json:"email"`
	PhotoPath string `json:"photoPath,omitempty"`
	Note      string `json:"note,omitempty"`
}

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

func SaveWines(path string, wines []Wine) error {
	sort.Slice(wines, func(i, j int) bool { return wines[i].Slug < wines[j].Slug })
	data, err := json.MarshalIndent(wines, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

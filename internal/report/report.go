// Package report renders the enrichment coverage report — the editor-facing
// view of how much of each wine's displayed metadata was really sourced
// (Salesforce or a web search hit) versus inferred from varietal/region. It is
// a single self-contained HTML file written to a LOCAL path (never into dist/,
// so it never reaches the public CDN): a worklist for spotting wines that need
// a better enrichment pass. See MetadataScore/FieldSource in package model.
package report

import (
	"bytes"
	"fmt"
	"html/template"
	"os"
	"path/filepath"
	"sort"

	"github.com/gritautomation/finevines-website/internal/model"
)

// attentionBelow is the metadataScore under which a wine is flagged as
// "needs attention" in the summary — mostly-inferred data worth a re-search.
const attentionBelow = 50

// fieldLabels are the compact column headers for each model.ScoredFields key,
// in the same order.
var fieldLabels = map[string]string{
	"description": "Desc", "sommelierNotes": "Somm", "aroma": "Arom", "palate": "Pal",
	"finish": "Fin", "foodPairings": "Food", "appellation": "Appn", "country": "Ctry",
	"color": "Col", "abv": "ABV", "bottleSize": "Size", "drinkWindow": "Drink", "image": "Img",
}

// sourceGlyph is the single-character mark shown in a coverage cell per source.
var sourceGlyph = map[model.FieldSource]string{
	model.SourceSalesforce: "S",
	model.SourceFound:      "F",
	model.SourceDerived:    "D",
	model.SourceMissing:    "·",
}

type cell struct {
	Class string // CSS class -> colour
	Glyph string
	Title string // hover tooltip: "aroma: derived"
}

type row struct {
	Wine  model.Wine
	Band  string // score band CSS class
	Cells []cell
}

type viewData struct {
	GeneratedNote string
	Headers       []string
	Total         int
	AvgScore      int
	AvgMatch      int
	NeedAttention int
	AttentionPct  int
	ImageReal     int
	ImageRealPct  int
	Rows          []row
}

// Render produces the self-contained HTML report for wines. generatedNote is a
// short free-text line shown under the title (e.g. "33 wines · demo catalog").
func Render(wines []model.Wine, generatedNote string) ([]byte, error) {
	// Worst coverage first — the report is a worklist, so the wines that most
	// need a human/re-search pass sort to the top.
	sorted := append([]model.Wine(nil), wines...)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.MetadataScore != b.MetadataScore {
			return a.MetadataScore < b.MetadataScore
		}
		if a.MatchConfidence != b.MatchConfidence {
			return a.MatchConfidence < b.MatchConfidence
		}
		if a.Producer != b.Producer {
			return a.Producer < b.Producer
		}
		return a.Name < b.Name
	})

	headers := make([]string, len(model.ScoredFields))
	for i, f := range model.ScoredFields {
		headers[i] = fieldLabels[f]
	}

	var sumScore, sumMatch, needs, imageReal int
	rows := make([]row, 0, len(sorted))
	for _, w := range sorted {
		sumScore += w.MetadataScore
		sumMatch += w.MatchConfidence
		if w.MetadataScore < attentionBelow {
			needs++
		}
		if model.ImageFieldSource(w.ImageSource) == model.SourceFound {
			imageReal++
		}

		cells := make([]cell, len(model.ScoredFields))
		for i, f := range model.ScoredFields {
			src := w.Sources[f]
			if src == "" {
				src = model.SourceMissing
			}
			cells[i] = cell{
				Class: "src-" + string(src),
				Glyph: sourceGlyph[src],
				Title: f + ": " + string(src),
			}
		}
		rows = append(rows, row{Wine: w, Band: scoreBand(w.MetadataScore), Cells: cells})
	}

	n := len(sorted)
	vd := viewData{
		GeneratedNote: generatedNote,
		Headers:       headers,
		Total:         n,
		AvgScore:      mean(sumScore, n),
		AvgMatch:      mean(sumMatch, n),
		NeedAttention: needs,
		AttentionPct:  pct(needs, n),
		ImageReal:     imageReal,
		ImageRealPct:  pct(imageReal, n),
		Rows:          rows,
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, vd); err != nil {
		return nil, fmt.Errorf("report: render: %w", err)
	}
	return buf.Bytes(), nil
}

// Write loads winesPath, renders the report, and writes it to outPath,
// creating the parent directory if needed. Used by both the `report`
// subcommand and the tail of an enrich run.
func Write(winesPath, outPath string) error {
	wines, err := model.LoadWines(winesPath)
	if err != nil {
		return fmt.Errorf("report: load %s: %w", winesPath, err)
	}
	note := fmt.Sprintf("%d wines", len(wines))
	html, err := Render(wines, note)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return fmt.Errorf("report: mkdir %s: %w", filepath.Dir(outPath), err)
	}
	if err := os.WriteFile(outPath, html, 0o644); err != nil {
		return fmt.Errorf("report: write %s: %w", outPath, err)
	}
	return nil
}

func scoreBand(score int) string {
	switch {
	case score >= 67:
		return "band-high"
	case score >= 34:
		return "band-mid"
	default:
		return "band-low"
	}
}

func mean(sum, n int) int {
	if n == 0 {
		return 0
	}
	return (sum + n/2) / n // rounded
}

func pct(part, n int) int {
	if n == 0 {
		return 0
	}
	return (part*100 + n/2) / n
}

var tmpl = template.Must(template.New("report").Funcs(template.FuncMap{
	"add": func(a, b int) int { return a + b },
}).Parse(reportHTML))

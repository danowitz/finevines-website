package enrich

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// ManualEnricher is a stopgap Enricher that reads a pre-authored EnrichResult
// from <dir>/<SKU>.json instead of calling a live model — used while the OpenAI
// account's billing is being set up, so enrichment can be produced by hand (or
// via the chat interface) and still flow through the real Run/scoring/report
// pipeline unchanged. A wine with no authored file falls back to a minimal
// DERIVED result so the catalog stays complete; its low coverage score then
// flags it in the report as still needing a real pass.
type ManualEnricher struct {
	dir string
}

func NewManualEnricher(dir string) *ManualEnricher { return &ManualEnricher{dir: dir} }

var _ Enricher = (*ManualEnricher)(nil)

// SKUFileBase makes a filesystem-safe base name for a SKU's enrichment file.
// Item numbers can contain characters that are illegal in filenames (notably
// "*" on Windows, seen on ~1 in 6 rows), so those are replaced with "_". Both
// ManualEnricher (reader) and tools/importenrichment (writer) use this, so a
// SKU always maps to the same file.
func SKUFileBase(sku string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '*', '/', '\\', ':', '?', '"', '<', '>', '|':
			return '_'
		}
		return r
	}, sku)
}

func (m *ManualEnricher) Enrich(_ context.Context, w salesforce.WineRaw) (EnrichResult, error) {
	data, err := os.ReadFile(filepath.Join(m.dir, SKUFileBase(w.SKU)+".json"))
	if err != nil {
		if os.IsNotExist(err) {
			return deriveResult(w), nil // not authored yet → derived placeholder
		}
		return EnrichResult{}, fmt.Errorf("manual enrich %s: %w", w.SKU, err)
	}
	res, err := parseEnrichResult(data)
	if err != nil {
		return EnrichResult{}, fmt.Errorf("manual enrich %s: %w", w.SKU, err)
	}
	return res, nil
}

// deriveResult builds a modest, honestly-labelled DERIVED EnrichResult from a
// wine's Salesforce fields alone (no web facts), so an un-authored wine still
// appears in the catalog with a truthful low coverage score.
func deriveResult(w salesforce.WineRaw) EnrichResult {
	color := ""
	switch {
	case strings.Contains(w.Style, "Rosé"):
		color = "Rosé"
	case strings.Contains(w.Style, "Sparkling"):
		color = "Sparkling"
	case strings.Contains(w.Style, "White"):
		color = "White"
	case strings.Contains(w.Style, "Fortified"):
		color = "Fortified"
	case w.Style != "":
		color = "Red"
	}
	desc := strings.TrimSpace(fmt.Sprintf("A %s from %s.", strings.TrimSpace(w.Varietal+" "+w.Style), firstNonEmpty(w.Appellation, w.Region, "the estate")))
	return EnrichResult{
		Description:     desc,
		SommelierNotes:  "Serve at the temperature typical for its style.",
		Color:           color,
		MatchConfidence: 40,
		Sources: map[string]string{
			"description":    "derived",
			"sommelierNotes": "derived",
			"color":          "derived",
		},
		ImagePrompt: fmt.Sprintf("A studio product photograph of a %s wine bottle.", firstNonEmpty(color, "red")),
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// LabelOnlyProvider is an ImageProvider that always declines, so ResolveImage
// falls straight through to the deterministic SVG label. Used in manual mode
// (no image API available while billing is pending); real photos arrive later
// via the OpenAI image chain.
type LabelOnlyProvider struct{}

func (LabelOnlyProvider) GenerateJPEG(context.Context, string) ([]byte, error) {
	return nil, ErrImageRejected
}

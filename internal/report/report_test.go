package report

import (
	"strings"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

func sampleWines() []model.Wine {
	return []model.Wine{
		{
			SKU: "HIGH1", Producer: "High Estate", Name: "Reserve", Vintage: "2020",
			MetadataScore: 85, MatchConfidence: 96, ImageSource: model.ImageScrapedWeb,
			Sources: map[string]model.FieldSource{"description": model.SourceFound, "color": model.SourceSalesforce},
		},
		{
			SKU: "LOW1", Producer: "Low Estate", Name: "Table Red", Vintage: "2022",
			MetadataScore: 15, MatchConfidence: 60, ImageSource: model.ImageGeneratedLabel,
			Sources: map[string]model.FieldSource{"description": model.SourceDerived},
		},
		{
			SKU: "MID1", Producer: "Mid Estate", Name: "Blanc", Vintage: "2021",
			MetadataScore: 50, MatchConfidence: 80, ImageSource: model.ImageProducerSupplied,
			Sources: map[string]model.FieldSource{"appellation": model.SourceSalesforce},
		},
	}
}

func TestRenderSortsWorstFirstAndSummarizes(t *testing.T) {
	html, err := Render(sampleWines(), "3 wines · test")
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	s := string(html)

	// Worst coverage (LOW1, score 15) must appear before the best (HIGH1, 85).
	if strings.Index(s, "LOW1") > strings.Index(s, "HIGH1") {
		t.Error("rows not sorted worst-coverage-first: LOW1 should precede HIGH1")
	}
	// Every wine is present.
	for _, sku := range []string{"HIGH1", "MID1", "LOW1"} {
		if !strings.Contains(s, sku) {
			t.Errorf("report missing wine %s", sku)
		}
	}
	// Summary: avg score = round((85+15+50)/3) = 50; one wine below 50.
	if !strings.Contains(s, ">50%<") {
		t.Error("expected average coverage 50% in summary")
	}
	// noindex so a stray copy can't be crawled.
	if !strings.Contains(s, "noindex") {
		t.Error("report must carry a noindex robots meta")
	}
	// Legend present.
	if !strings.Contains(s, "Found (web)") {
		t.Error("expected provenance legend")
	}
}

func TestRenderEmpty(t *testing.T) {
	html, err := Render(nil, "0 wines")
	if err != nil {
		t.Fatalf("Render(nil): %v", err)
	}
	if !strings.Contains(string(html), ">0<") {
		t.Error("empty report should still render with a zero total")
	}
}

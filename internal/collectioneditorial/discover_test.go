package collectioneditorial

import (
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

func TestDiscoverUsesOnlyLiveCatalogAndCollapsesSlugVariants(t *testing.T) {
	wines := []model.Wine{
		{Slug: "one", Name: "Wine One", Producer: "Lignier Michelot", Region: "Burgundy, C d Nuits", Varietal: "Pinot Noir", Country: "France", StockQty: 12},
		{Slug: "two", Name: "Wine Two", Producer: "Lignier-Michelot", Region: "Burgundy - C d Nuits", Varietal: "Pinot Noir", Country: "France", StockQty: 6},
		{Slug: "gone", Name: "Gone", Producer: "Unavailable Estate", Region: "Nowhere", Varietal: "Unknown", Country: "France", StockQty: 0},
		{Slug: "delisted", Name: "Delisted", Producer: "Delisted Estate", Region: "Nowhere", Varietal: "Unknown", Country: "France", StockQty: 12, Status: model.StatusUnavailable},
	}
	candidates := Discover(wines)
	counts := map[string]int{}
	for _, candidate := range candidates {
		counts[string(candidate.Kind)+"/"+candidate.Slug] = candidate.WineCount
	}
	if counts["producer/lignier-michelot"] != 2 || counts["region/burgundy-c-d-nuits"] != 2 || counts["varietal/pinot-noir"] != 2 {
		t.Fatalf("variant collections were not collapsed: %#v", counts)
	}
	if len(counts) != 3 {
		t.Fatalf("unavailable catalog values leaked into discovery: %#v", counts)
	}
}

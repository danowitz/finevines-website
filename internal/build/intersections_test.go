package build

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

func TestBuildIntersectionsRequiresDepthAndProducerDiversity(t *testing.T) {
	var cards []cardWine
	for i := 0; i < 6; i++ {
		producer := "Alpha"
		if i > 2 {
			producer = "Beta"
		}
		cards = append(cards, cardWine{Wine: model.Wine{Slug: string(rune('a' + i)), Producer: producer, Region: "Burgundy", Varietal: "Pinot Noir"}})
	}
	for i := 0; i < 8; i++ {
		cards = append(cards, cardWine{Wine: model.Wine{Slug: "thin", Producer: "Solo", Region: "Napa Valley", Varietal: "Cabernet Sauvignon"}})
	}
	got := buildIntersections(cards)
	if len(got) != 1 || got[0].Region != "Burgundy" || got[0].Varietal != "Pinot Noir" {
		t.Fatalf("intersections = %+v", got)
	}
}

func TestBuildPublishesFocusedIntersectionWithHierarchyAndDiscoveryLinks(t *testing.T) {
	data := t.TempDir()
	if err := os.CopyFS(data, os.DirFS("testdata")); err != nil {
		t.Fatal(err)
	}
	taxonomy := `{"version":1,"aliases":{"region":{"Bugundy":"Burgundy"},"producer":{},"varietal":{}},"regions":[{"name":"Burgundy"},{"name":"Côte de Nuits","parent":"Burgundy"}]}`
	if err := os.WriteFile(filepath.Join(data, "taxonomy.json"), []byte(taxonomy), 0o644); err != nil {
		t.Fatal(err)
	}
	var wines []model.Wine
	for i := 0; i < 6; i++ {
		producer := "Alpha Estate"
		if i >= 3 {
			producer = "Beta Estate"
		}
		wines = append(wines, collectionWine(
			"burgundy-pinot-"+string(rune('a'+i)), producer, "Pinot Noir "+string(rune('A'+i)), "Côte de Nuits", "Pinot Noir", "202"+string(rune('0'+i)),
		))
	}
	wines = append(wines, collectionWine("burgundy-chardonnay", "Gamma Estate", "Chardonnay", "Burgundy", "Chardonnay", "2023"))
	if err := model.SaveWines(filepath.Join(data, "wines.json"), wines); err != nil {
		t.Fatal(err)
	}
	dist := t.TempDir()
	if err := Run(data, "../../assets", "../../templates", dist, "https://finevines.com", ""); err != nil {
		t.Fatal(err)
	}

	intersectionPath := filepath.Join(dist, "regions", "cote-de-nuits", "varietals", "pinot-noir", "index.html")
	page := readFile(t, intersectionPath)
	for _, want := range []string{"Alpha Estate and Beta Estate", "/regions/burgundy/", "/varietals/pinot-noir/"} {
		if !strings.Contains(page, want) {
			t.Errorf("intersection page missing %q", want)
		}
	}
	region := readFile(t, filepath.Join(dist, "regions", "cote-de-nuits", "index.html"))
	if !strings.Contains(region, "/regions/cote-de-nuits/varietals/pinot-noir/") || !strings.Contains(region, "/regions/burgundy/") {
		t.Error("region page must link to both its parent and focused intersection")
	}
	parent := readFile(t, filepath.Join(dist, "regions", "burgundy", "index.html"))
	if got := strings.Count(parent, `href="/regions/cote-de-nuits/"`); got != 1 {
		t.Errorf("child region must appear once across related and hierarchy navigation, got %d", got)
	}
	varietal := readFile(t, filepath.Join(dist, "varietals", "pinot-noir", "index.html"))
	if !strings.Contains(varietal, "/regions/cote-de-nuits/varietals/pinot-noir/") {
		t.Error("varietal page must link back to its focused intersection")
	}
	sitemap := readFile(t, filepath.Join(dist, "sitemap.xml"))
	if !strings.Contains(sitemap, "https://finevines.com/regions/cote-de-nuits/varietals/pinot-noir/") {
		t.Error("focused intersection must be discoverable in the sitemap")
	}
	redirects := readFile(t, filepath.Join(dist, "redirects.json"))
	if !strings.Contains(redirects, `"/regions/bugundy/": "/regions/burgundy/"`) {
		t.Error("taxonomy alias redirect must be included in deployment redirects")
	}
}

package taxonomy

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

func TestCatalogNormalizesAndBuildsRegionHierarchy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "taxonomy.json")
	data := `{"version":1,"aliases":{"region":{"Bugundy":"Burgundy"},"producer":{"H Lamy":"Hubert Lamy"},"varietal":{}},"regions":[{"name":"Burgundy"},{"name":"Côte de Nuits","parent":"Burgundy"}]}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	got := c.Normalize([]model.Wine{{Region: "Bugundy", Producer: "H Lamy"}})[0]
	if got.Region != "Burgundy" || got.Producer != "Hubert Lamy" {
		t.Fatalf("normalized = %+v", got)
	}
	if trail := c.RegionTrail("Côte de Nuits"); !reflect.DeepEqual(trail, []string{"Burgundy", "Côte de Nuits"}) {
		t.Fatalf("trail = %#v", trail)
	}
	if children := c.RegionChildren("Burgundy"); !reflect.DeepEqual(children, []string{"Côte de Nuits"}) {
		t.Fatalf("children = %#v", children)
	}
	if c.Redirects()["/regions/bugundy/"] != "/regions/burgundy/" {
		t.Fatalf("redirects = %#v", c.Redirects())
	}
}

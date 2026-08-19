package taxonomy

import (
	"encoding/json"
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

func TestCatalogReconcilesOnlyExplicitOrUnambiguousProducerIdentities(t *testing.T) {
	path := filepath.Join(t.TempDir(), "taxonomy.json")
	data := `{
		"version":1,
		"aliases":{"region":{},"producer":{"Chave":"Jean-Louis Chave"},"varietal":{}},
		"producerPrefixes":{"Domaine Jl Chave":"Jean-Louis Chave","Jl Chave Selection":"Jean-Louis Chave"},
		"regions":[]
	}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	wines := []model.Wine{
		{Name: "Domaine Jl Chave Saint Joseph", Producer: ""},
		{Name: "Jl Chave Selection Offerus", Producer: ""},
		{Name: "Known Family Pinot Noir", Producer: "Known Family"},
		{Name: "Known Family Pinot Noir", Producer: ""},
		{Name: "Ambiguous Reserve", Producer: "Estate A"},
		{Name: "Ambiguous Reserve", Producer: "Estate B"},
		{Name: "Ambiguous Reserve", Producer: ""},
		{Name: "Domaine Known Family Chardonnay", Producer: ""},
	}
	got := c.Normalize(wines)
	if got[0].Producer != "Jean-Louis Chave" || got[1].Producer != "Jean-Louis Chave" {
		t.Fatalf("explicit prefix reconciliation failed: %#v", got[:2])
	}
	if got[3].Producer != "Known Family" {
		t.Fatalf("unique sibling producer = %q", got[3].Producer)
	}
	if got[6].Producer != "" {
		t.Fatalf("ambiguous sibling producer = %q, want blank", got[6].Producer)
	}
	if got[7].Producer != "Known Family" {
		t.Fatalf("trusted current producer prefix = %q", got[7].Producer)
	}
}

func TestLegacyProducerPrefixesUseCurrentCanonicalIdentityAndRejectShortNames(t *testing.T) {
	dir := t.TempDir()
	taxonomyPath := filepath.Join(dir, "taxonomy.json")
	if err := os.WriteFile(taxonomyPath, []byte(`{"version":1,"aliases":{"region":{},"producer":{},"varietal":{}},"regions":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	profiles := []legacyProducerProfile{
		{Name: "Domaine Daniel Bouland", Prose: "Archived profile."},
		{Name: "Kracher", Prose: "Too short to infer safely."},
	}
	body, err := json.Marshal(profiles)
	if err != nil {
		t.Fatal(err)
	}
	profilesPath := filepath.Join(dir, "profiles.json")
	if err := os.WriteFile(profilesPath, body, 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := Load(taxonomyPath)
	if err != nil {
		t.Fatal(err)
	}
	c, err = c.WithLegacyProducerPrefixes(profilesPath)
	if err != nil {
		t.Fatal(err)
	}
	got := c.Normalize([]model.Wine{
		{Name: "Known", Producer: "Daniel Bouland"},
		{Name: "Domaine Daniel Bouland Morgon", Producer: ""},
		{Name: "Kracher Beerenauslese", Producer: ""},
	})
	if got[1].Producer != "Daniel Bouland" {
		t.Fatalf("legacy prefix producer = %q, want current canonical identity", got[1].Producer)
	}
	if got[2].Producer != "" {
		t.Fatalf("single-token legacy heading inferred %q", got[2].Producer)
	}
}

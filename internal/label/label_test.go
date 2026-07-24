package label

import (
	"bytes"
	"flag"
	"os"
	"strings"
	"testing"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

var update = flag.Bool("update", false, "rewrite golden files")

var fixture = salesforce.WineRaw{
	ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy",
	Name: "Saint-Aubin 1er Cru « Derrière chez Édouard »", Vintage: "2021",
	Varietal: "Chardonnay", Region: "Burgundy", Style: "White · Still",
}

func TestGenerateIsDeterministic(t *testing.T) {
	if !bytes.Equal(Generate(fixture), Generate(fixture)) {
		t.Fatal("same wine must produce identical SVG")
	}
}

func TestGenerateVariesBySKU(t *testing.T) {
	other := fixture
	other.SKU = "ZZ9999"
	if bytes.Equal(Generate(fixture), Generate(other)) {
		t.Fatal("different SKUs should pick different visual treatments")
	}
}

func TestGenerateMatchesGolden(t *testing.T) {
	got := Generate(fixture)
	golden := "testdata/AB1234.golden.svg"
	if *update {
		os.WriteFile(golden, got, 0o644)
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Error("SVG changed — review visually, then `go test ./internal/label -update` if intended")
	}
}

func TestGenerateNeverBrandsFineVines(t *testing.T) {
	svg := string(Generate(fixture))
	if strings.Contains(strings.ToLower(svg), "fine vines") {
		t.Fatal("labels must be wine-branded, never Fine-Vines-branded (spec §5)")
	}
	for _, want := range []string{"Hubert Lamy", "2021", "<svg"} {
		if !strings.Contains(svg, want) {
			t.Errorf("label missing %q", want)
		}
	}
}

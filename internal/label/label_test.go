package label

import (
	"bytes"
	"strings"
	"testing"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

var fixture = salesforce.WineRaw{
	ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy",
	Name: "Saint-Aubin 1er Cru DerriÃ¨re chez Ã‰douard", Vintage: "2021",
	Varietal: "Chardonnay", Region: "Burgundy", Style: "White Still",
}

func TestGenerateIsDeterministic(t *testing.T) {
	if !bytes.Equal(Generate(fixture), Generate(fixture)) {
		t.Fatal("same input must produce identical SVG")
	}
}

func TestGenerateDoesNotVaryByWine(t *testing.T) {
	other := fixture
	other.SKU = "ZZ9999"
	other.Producer = "Another Estate"
	other.Name = "Another Wine"
	other.Vintage = "1999"
	if !bytes.Equal(Generate(fixture), Generate(other)) {
		t.Fatal("the unavailable-image treatment must not imply product-specific packaging")
	}
}

func TestGenerateIsClearlyAnUnavailableImageNotProductPackaging(t *testing.T) {
	svg := string(Generate(fixture))
	for _, forbidden := range []string{fixture.Producer, fixture.Name, fixture.Vintage, fixture.SKU} {
		if strings.Contains(svg, forbidden) {
			t.Errorf("placeholder must not render catalog identity %q as packaging", forbidden)
		}
	}
	for _, want := range []string{"Product image unavailable", "Verified photography pending", "<svg"} {
		if !strings.Contains(svg, want) {
			t.Errorf("placeholder missing %q", want)
		}
	}
}

package enrich

import (
	"testing"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func TestSourceHashIsDeterministicAndSensitive(t *testing.T) {
	a := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy", StockQty: 14}
	b := a
	if SourceHash(a) != SourceHash(b) {
		t.Fatal("same input must hash identically")
	}
	b.StockQty = 15
	if SourceHash(a) == SourceHash(b) {
		t.Fatal("changed field must change hash")
	}
	if len(SourceHash(a)) != 64 {
		t.Fatalf("want hex sha256 (64 chars), got %d", len(SourceHash(a)))
	}
}

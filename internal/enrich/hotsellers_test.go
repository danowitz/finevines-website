package enrich

import (
	"reflect"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

func hsWine(id, slug, producer string, stock int) model.Wine {
	return model.Wine{
		ID: id, Slug: slug, Producer: producer, StockQty: stock,
		ImagePath: "assets/img/wines/" + slug + ".png",
	}
}

// TestRankHotSellersOrdersAndFilters pins the whole rule set: net-cases
// descending order, slug tiebreak, and exclusion of zero/negative movers,
// out-of-stock wines, and products with no sales at all.
func TestRankHotSellersOrdersAndFilters(t *testing.T) {
	wines := []model.Wine{
		hsWine("SF-1", "alpha", "Alpha", 10),
		hsWine("SF-2", "beta", "Beta", 10),
		hsWine("SF-3", "gamma", "Gamma", 0),  // out of stock — excluded
		hsWine("SF-4", "delta", "Delta", 10), // net-negative — excluded
		hsWine("SF-5", "epsilon", "Epsilon", 10),
		hsWine("SF-6", "zeta", "Zeta", 10), // no sales — excluded
	}
	totals := map[string]float64{
		"SF-1": 4.5,
		"SF-2": 12,
		"SF-3": 99, // hottest seller, but out of stock
		"SF-4": -2,
		"SF-5": 4.5, // ties SF-1 → slug ascending: alpha before epsilon
	}

	got := RankHotSellers(wines, totals, 6)
	want := []model.HotSeller{
		{Slug: "beta", Cases: 12},
		{Slug: "alpha", Cases: 4.5},
		{Slug: "epsilon", Cases: 4.5},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("RankHotSellers() = %#v, want %#v", got, want)
	}
}

// TestRankHotSellersOnePerProducer: the section is curation, not a
// leaderboard — a single hot brand must not fill every slot. The best wine of
// each producer wins its producer's single slot.
func TestRankHotSellersOnePerProducer(t *testing.T) {
	wines := []model.Wine{
		hsWine("SF-1", "big-red", "Hot House", 10),
		hsWine("SF-2", "big-white", "Hot House", 10),
		hsWine("SF-3", "quiet-rose", "Quiet Estate", 10),
	}
	totals := map[string]float64{"SF-1": 50, "SF-2": 40, "SF-3": 1}

	got := RankHotSellers(wines, totals, 3)
	want := []model.HotSeller{
		{Slug: "big-red", Cases: 50},
		{Slug: "quiet-rose", Cases: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("RankHotSellers() = %#v, want %#v", got, want)
	}
}

// TestRankHotSellersSkipsNonWineItems: logistics/fee rows that ride the
// product ledger (freight surcharges were literally the org's #4 mover on the
// first live pull) must never reach the homepage, however fast they "sell".
func TestRankHotSellersSkipsNonWineItems(t *testing.T) {
	freight := hsWine("SF-1", "midstate-six-pack-freight-surcharge", "", 10)
	freight.Name = "MIDSTATE SIX PACK FREIGHT SURCHARGE"
	wine := hsWine("SF-2", "real-wine", "Estate", 10)
	wine.Name = "Estate Sancerre"

	got := RankHotSellers([]model.Wine{freight, wine}, map[string]float64{"SF-1": 88, "SF-2": 1}, 6)
	want := []model.HotSeller{{Slug: "real-wine", Cases: 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("RankHotSellers() = %#v, want %#v", got, want)
	}
}

// TestRankHotSellersDedupesBlankProducerByNamePrefix: FV_Brand__c is blank on
// a long tail of rows, so the one-slot-per-producer rule falls back to the
// name's estate prefix — five Villaudière cuvées must still take one slot,
// while a DIFFERENT "Domaine de la …" estate keeps its own.
func TestRankHotSellersDedupesBlankProducerByNamePrefix(t *testing.T) {
	v1 := hsWine("SF-1", "villaudiere-sancerre", "", 10)
	v1.Name = "Domaine de la Villaudiere Sancerre la Villaudiere"
	v2 := hsWine("SF-2", "villaudiere-sauvignon", "", 10)
	v2.Name = "Domaine de la Villaudiere Sauvignon Blanc"
	other := hsWine("SF-3", "janasse-cdp", "", 10)
	other.Name = "Domaine de la Janasse Chateauneuf"

	got := RankHotSellers([]model.Wine{v1, v2, other}, map[string]float64{"SF-1": 93, "SF-2": 48, "SF-3": 2}, 6)
	want := []model.HotSeller{
		{Slug: "villaudiere-sancerre", Cases: 93},
		{Slug: "janasse-cdp", Cases: 2},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("RankHotSellers() = %#v, want %#v", got, want)
	}
}

// TestRankHotSellersLimit caps the ranking length.
func TestRankHotSellersLimit(t *testing.T) {
	wines := []model.Wine{
		hsWine("SF-1", "a", "P1", 1),
		hsWine("SF-2", "b", "P2", 1),
		hsWine("SF-3", "c", "P3", 1),
	}
	totals := map[string]float64{"SF-1": 3, "SF-2": 2, "SF-3": 1}

	if got := RankHotSellers(wines, totals, 2); len(got) != 2 {
		t.Fatalf("len(RankHotSellers(limit 2)) = %d, want 2", len(got))
	}
	if got := RankHotSellers(wines, totals, 0); got != nil {
		t.Fatalf("RankHotSellers(limit 0) = %#v, want nil", got)
	}
}

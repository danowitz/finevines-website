package catalog

import (
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

func w(name, vintage, sku string, stock int) model.Wine {
	return model.Wine{Slug: name + vintage + sku, Name: name, Vintage: vintage, SKU: sku, StockQty: stock}
}

func TestSizeParsing(t *testing.T) {
	for _, c := range []struct {
		name string
		want string
		why  string
	}{
		{"Napa Valley Brio Red Wine 12/750", "750ml", "pack/size is a case format, the size is the bottle"},
		{"Benjamin Leroux Batard Montrachet Grand Cru 3/1.5L", "1.5L", "three magnums"},
		{"Some Wine 6/375", "375ml", "half bottles"},
		{"Some Wine .5L", "500ml", "a bare half-litre"},
		{"Some Wine 3L", "3L", "a double magnum"},
		{"Plain Burgundy", "750ml", "no size stated means a standard bottle"},
		// The trap: a vintage RANGE looks exactly like a pack/size.
		{"Cuvee Speciale 2018/2019", "750ml", "a vintage range is not a case format"},
		{"Reserve 2019/2020 Selection", "750ml", "likewise"},
	} {
		if got := SizeOf(model.Wine{Name: c.name}); got.Label != c.want {
			t.Errorf("SizeOf(%q) = %q, want %q — %s", c.name, got.Label, c.want, c.why)
		}
	}
}

func TestExplicitSizeFieldWins(t *testing.T) {
	// Salesforce populates bottleSize on only 25 rows of 2,665, but where it
	// does it is authoritative over anything guessed from a name.
	got := SizeOf(model.Wine{Name: "Something 12/750", BottleSize: "375ml"})
	if got.Label != "375ml" {
		t.Errorf("explicit bottleSize ignored: got %q", got.Label)
	}
}

func TestCuveeNameStripsShipmentDetail(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"Domaine Pavelot Savigny les Beaune 1ER Cru 2019", "Domaine Pavelot Savigny les Beaune 1ER Cru"},
		{"Napa Valley Brio Red Wine 12/750", "Napa Valley Brio Red Wine"},
		{"Chateau Lilian Ladouys Saint Estephe 12/750 - Gm Hold", "Chateau Lilian Ladouys Saint Estephe"},
		{"Domaine Jouan Morey Saint Denis**", "Domaine Jouan Morey Saint Denis"},
	} {
		if got := CuveeName(model.Wine{Name: c.in}); got != c.want {
			t.Errorf("CuveeName(%q)\n got %q\nwant %q", c.in, got, c.want)
		}
	}
}

func TestVintagesCollapseIntoOneWine(t *testing.T) {
	// The real case: eight rows, five vintages, eight SKUs, one wine.
	rows := []model.Wine{
		w("Domaine Pavelot Savigny les Beaune 1ER Cru", "2018", "A1", 4),
		w("Domaine Pavelot Savigny les Beaune 1ER Cru", "2019", "A2", 6),
		w("Domaine Pavelot Savigny les Beaune 1ER Cru", "2020", "A3", 2),
		w("Domaine Pavelot Savigny les Beaune 1ER Cru", "2021", "A4", 0),
		w("Domaine Pavelot Savigny les Beaune 1ER Cru", "2022", "A5", 9),
	}
	g := Build(rows)
	if len(g) != 1 {
		t.Fatalf("expected one wine, got %d", len(g))
	}
	if len(g[0].Vintages) != 5 {
		t.Fatalf("expected 5 vintages, got %d", len(g[0].Vintages))
	}
	if g[0].Vintages[0].Year != "2022" {
		t.Errorf("newest vintage should lead, got %q", g[0].Vintages[0].Year)
	}
	if g[0].Stock != 21 {
		t.Errorf("stock should sum across vintages: got %d, want 21", g[0].Stock)
	}
}

func TestSameVintageDifferentSKUsCollapse(t *testing.T) {
	// The sharpest case, and the one the client explained: each shipment clears
	// at a different exchange rate and needs its own item code, and pre-tariff
	// stock must stay separate from post-tariff. Every SKU is real — and to a
	// buyer they are one indistinguishable bottle.
	rows := []model.Wine{
		w("Domaine Jf Mugnier Nuits Saint Georges 1er Cru", "2023", "M1", 3),
		w("Domaine Jf Mugnier Nuits Saint Georges 1er Cru", "2023", "M2", 5),
		w("Domaine Jf Mugnier Nuits Saint Georges 1er Cru", "2023", "M3", 1),
	}
	g := Build(rows)
	if len(g) != 1 || len(g[0].Vintages) != 1 {
		t.Fatalf("expected one wine with one vintage, got %d wines", len(g))
	}
	v := g[0].Vintages[0]
	if v.Stock != 9 {
		t.Errorf("stock should sum across the shipment SKUs: got %d, want 9", v.Stock)
	}
	if len(v.SKUs) != 3 {
		t.Errorf("all three SKUs must be kept underneath: got %v", v.SKUs)
	}
}

func TestSizesBecomeOptionsNotSeparateWines(t *testing.T) {
	rows := []model.Wine{
		w("Benjamin Leroux Batard Montrachet Grand Cru", "2022", "B1", 2),
		w("Benjamin Leroux Batard Montrachet Grand Cru 3/1.5L", "2022", "B2", 1),
		w("Benjamin Leroux Batard Montrachet Grand Cru 6/375", "2022", "B3", 4),
	}
	g := Build(rows)
	if len(g) != 1 {
		t.Fatalf("a magnum is the same wine, not another one: got %d wines", len(g))
	}
	if len(g[0].Sizes) != 3 {
		t.Fatalf("expected three sizes offered, got %v", g[0].Sizes)
	}
	// Smallest first, so a page reads 375ml / 750ml / 1.5L.
	if g[0].Sizes[0].Label != "375ml" || g[0].Sizes[2].Label != "1.5L" {
		t.Errorf("sizes out of order: %v", g[0].Sizes)
	}
}

func TestDifferentProducersNeverMerge(t *testing.T) {
	// Two estates on the same vineyard are two wines, however alike the names.
	rows := []model.Wine{
		{Slug: "a", Name: "Clos Vougeot Grand Cru", Producer: "Domaine Anne Gros", Vintage: "2022"},
		{Slug: "b", Name: "Clos Vougeot Grand Cru", Producer: "Gros Frere et Soeur", Vintage: "2022"},
	}
	if g := Build(rows); len(g) != 2 {
		t.Errorf("expected two wines, got %d", len(g))
	}
}

func TestDifferentCuveesNeverMerge(t *testing.T) {
	rows := []model.Wine{
		w("Domaine Pavelot Savigny les Beaune", "2020", "A", 1),
		w("Domaine Pavelot Savigny les Beaune 1ER Cru", "2020", "B", 1),
	}
	if g := Build(rows); len(g) != 2 {
		t.Errorf("a village wine and a 1er cru are different wines: got %d", len(g))
	}
}

func TestRepresentativeIsTheBestEnrichedRow(t *testing.T) {
	// One image and one set of tasting copy serve the wine, so the richest row
	// supplies them rather than whichever sorted first.
	a := w("Some Domaine Some Cuvee", "2021", "A", 1)
	b := w("Some Domaine Some Cuvee", "2020", "B", 1)
	b.MetadataScore = 90
	b.Description = "the enriched one"
	g := Build([]model.Wine{a, b})
	if len(g) != 1 {
		t.Fatalf("expected one wine")
	}
	if g[0].Representative.SKU != "B" {
		t.Errorf("representative = %q, want the better-enriched B", g[0].Representative.SKU)
	}
}

func TestOrderIsStable(t *testing.T) {
	// The build must be byte-identical for identical input, so grouping cannot
	// depend on map iteration.
	rows := []model.Wine{
		w("Wine A", "2020", "1", 1), w("Wine B", "2020", "2", 1),
		w("Wine C", "2020", "3", 1), w("Wine A", "2019", "4", 1),
	}
	first := Build(rows)
	for i := 0; i < 25; i++ {
		got := Build(rows)
		if len(got) != len(first) {
			t.Fatalf("group count differs between runs")
		}
		for j := range got {
			if got[j].Slug != first[j].Slug {
				t.Fatalf("order differs between runs at %d: %q vs %q", j, got[j].Slug, first[j].Slug)
			}
		}
	}
}

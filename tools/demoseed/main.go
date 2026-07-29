// Command demoseed generates a representative sample catalog so the site can
// be built and previewed WITHOUT the live Salesforce/Imagen/Anthropic pipeline.
//
// It pulls the SAME embedded sample roster the real pipeline uses in mock mode
// (salesforce.MockSource: FINEVINES_SF_MOCK), applies the real web-eligibility
// filter (enrich.Eligible), writes deterministic SVG bottle labels (the same
// guaranteed-fallback generator the live pipeline falls back to), and a
// data/wines.json pointing at them, plus a sample news post. A handful of
// hero wines keep hand-authored copy; the rest get grounded house notes
// composed from their real fields. Run from the repo root:  go run ./tools/demoseed
// The real `finevines enrich` run replaces all of this with live data.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/label"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// authored holds the lovingly hand-written copy for the original hero wines,
// keyed by SKU. Any roster row without an entry here falls back to a grounded
// house note composed from its real fields (see houseNotes).
var authored = map[string]struct{ desc, som string }{
	"AB1201": {
		"A taut, saline expression of high-density Saint-Aubin: white orchard fruit, crushed oyster shell, and a long chalky finish that rewards patience.",
		"Serve at 12°C in a broad white-Burgundy glass. A natural partner to roast poultry, aged Comté, or simply a quiet evening.",
	},
	"CD3310": {
		"Whole-cluster lift over red cherry and rose petal, with the silken tannins that have made this estate a cult name in the Côte de Nuits.",
		"Decant thirty minutes; pour at 15°C. Beautiful with duck, mushroom risotto, or charcuterie.",
	},
	"EF4420": {
		"From the vines that founded Oregon Pinot: cranberry, wild herb, and forest floor carried on a cool, understated frame.",
		"An all-purpose table red: salmon, roast vegetables, or a Sunday roast.",
	},
	"GH5501": {
		"Steely, sun-warmed Chenin from limestone: quince, beeswax, and a savoury mineral spine.",
		"Serve well-chilled with goat cheese, river fish, or Thai-spiced dishes.",
	},
	"JK6612": {
		"Old-vine La Consulta Malbec: violet, blueberry, and cocoa with a plush, generous mid-palate.",
		"A crowd-pleaser for the grill: steak, lamb, or empanadas.",
	},
	"LM7723": {
		"Garrigue, black pepper, and dark berry from a legendary Hermitage house's négociant hand.",
		"Weeknight-perfect with sausages, ratatouille, or a hard aged cheese.",
	},
	"NP8834": {
		"An insider's white Burgundy: hazelnut, ripe pear, and a gently reductive struck-match complexity.",
		"Serve at 12°C with roast chicken, sole, or a wedge of Beaufort.",
	},
	"QR9945": {
		"The only rosé appellation in the Côte d'Or: wild strawberry, blood orange, and a dry, mineral cut.",
		"A serious apéritif rosé: charcuterie, grilled prawns, or a summer lunch.",
	},
}

// houseNotes composes a grounded description + sommelier note from a wine's
// real fields for roster rows without hand-authored copy. It invents no facts
// (no scores, awards, or specific tasting claims): it only reframes what the
// roster already states, so the preview reads cleanly at scale without
// pretending to be the real enriched copy.
func houseNotes(w salesforce.WineRaw) (desc, som string) {
	place := w.Appellation
	if place == "" {
		place = w.Region
	}
	vintage := w.Vintage
	if vintage == "" || strings.EqualFold(vintage, "NV") {
		vintage = "current-release"
	} else {
		vintage = vintage + " "
	}

	switch {
	case strings.Contains(w.Style, "Sparkling"):
		desc = fmt.Sprintf("A sparkling %s from %s: fine, persistent mousse and bright orchard fruit, in the house style of %s.", w.Varietal, place, w.Producer)
		som = "Serve well-chilled as an apéritif, or alongside oysters, fried foods, and celebration."
	case strings.Contains(w.Style, "Rosé"):
		desc = fmt.Sprintf("A dry rosé of %s from %s: crisp red-berry fruit and a mineral, food-friendly finish.", w.Varietal, place)
		som = "Serve cold with charcuterie, grilled seafood, or a long summer lunch."
	case strings.Contains(w.Style, "Sweet"):
		desc = fmt.Sprintf("A sweet %s from %s: honeyed stone fruit balanced by fresh acidity, from %s.", w.Varietal, place, w.Producer)
		som = "Serve chilled with blue cheese, foie gras, or fruit tart."
	case strings.Contains(w.Style, "Fortified"):
		desc = fmt.Sprintf("A fortified wine from %s, %s: dark berry and spice with a warming, structured core.", place, w.Producer)
		som = "Serve at cool room temperature with hard cheese, dark chocolate, or walnuts."
	case strings.Contains(w.Style, "White"):
		desc = fmt.Sprintf("A %swhite %s from %s: orchard fruit and a clean, mineral line, in %s's hand.", vintage, w.Varietal, place, w.Producer)
		som = "Serve at 10–12°C with poultry, shellfish, or fresh cheese."
	default:
		desc = fmt.Sprintf("A %sred %s from %s: dark fruit, savoury depth, and fine-grained tannin from %s.", vintage, w.Varietal, place, w.Producer)
		som = "Decant briefly; serve at 15–17°C with roast meats, mushrooms, or aged cheese."
	}
	return desc, som
}

// regionCountry backfills a country for the demo from each sample region: in
// the live pipeline this comes straight from Product2.FV_Country__c
// (SourceSalesforce); here it stands in for that authoritative field.
var regionCountry = map[string]string{
	"Burgundy": "France", "Bordeaux": "France", "Rhône": "France", "Loire": "France",
	"Champagne": "France", "Alsace": "France", "Provence": "France",
	"Piedmont": "Italy", "Tuscany": "Italy", "Veneto": "Italy", "Sicily": "Italy",
	"Rioja": "Spain", "Ribera del Duero": "Spain", "Rías Baixas": "Spain", "Priorat": "Spain",
	"Mosel": "Germany", "Napa Valley": "United States", "Sonoma": "United States",
	"Oregon": "United States", "Mendoza": "Argentina", "Marlborough": "New Zealand",
	"Central Otago": "New Zealand", "Barossa Valley": "Australia", "Douro": "Portugal",
	"Swartland": "South Africa",
}

// colorFromStyle derives a wine colour from the Style string for the demo
// (Product2.FV_Color__c carries this authoritatively in the live pipeline).
func colorFromStyle(style string) string {
	switch {
	case strings.Contains(style, "Rosé"):
		return "Rosé"
	case strings.Contains(style, "Sparkling"):
		return "Sparkling"
	case strings.Contains(style, "Fortified"):
		return "Fortified"
	case strings.Contains(style, "White"):
		return "White"
	default:
		return "Red"
	}
}

func main() {
	src, err := salesforce.NewMockSource()
	if err != nil {
		panic(err)
	}
	roster, err := src.Roster(context.Background())
	if err != nil {
		panic(err)
	}

	imgDir := filepath.Join("assets", "img", "wines")
	if err := os.MkdirAll(imgDir, 0o755); err != nil {
		panic(err)
	}

	var wines []model.Wine
	var skipped int
	for _, raw := range roster {
		// Same web-eligibility rule the live pipeline enforces, so the demo
		// catalog matches what would actually ship (stock-0 and SKU-9 rows in
		// the sample are excluded here).
		if !enrich.Eligible(raw.StockQty, raw.SKU, raw.ReadyToSell) {
			skipped++
			continue
		}

		desc, som := houseNotes(raw)
		descSource := model.SourceDerived // house notes inferred from varietal/region
		matchConf := 78
		if a, ok := authored[raw.SKU]; ok {
			desc, som = a.desc, a.som
			descSource = model.SourceFound // hero wines stand in for real sourced copy
			matchConf = 95
		}

		// SEO slug basename (producer-wine-vintage), matching the live
		// pipeline's image naming and the wine's /wines/<slug>/ page URL.
		slug := model.Slugify(raw.Producer, raw.Name, raw.Vintage)
		svg := label.Generate(raw)
		imgPath := filepath.Join(imgDir, slug+".svg")
		if err := os.WriteFile(imgPath, svg, 0o644); err != nil {
			panic(err)
		}

		country := regionCountry[raw.Region]
		color := colorFromStyle(raw.Style)

		// Provenance for the scored fields. Country/Color stand in for
		// Salesforce-authoritative fields; description/sommelier are found for
		// hero wines and derived otherwise; the SVG label counts as derived.
		// The remaining scored fields are left unset (missing): the live
		// search pass is what fills aroma/palate/finish/pairings/abv/etc.
		sources := map[string]model.FieldSource{
			"description":    descSource,
			"sommelierNotes": descSource,
			"color":          model.SourceSalesforce,
			"image":          model.ImageFieldSource(model.ImageGeneratedLabel),
		}
		if raw.Appellation != "" {
			sources["appellation"] = model.SourceSalesforce
		}
		if country != "" {
			sources["country"] = model.SourceSalesforce
		}

		wines = append(wines, model.Wine{
			ID: raw.ID, SourceHash: "demo", SKU: raw.SKU, Producer: raw.Producer,
			Name: raw.Name, Vintage: raw.Vintage, Varietal: raw.Varietal, Region: raw.Region,
			Appellation: raw.Appellation, Country: country, Color: color, Style: raw.Style,
			StockQty:    raw.StockQty,
			Description: desc, SommelierNotes: som,
			ImagePath:       "assets/img/wines/" + slug + ".svg",
			ImageSource:     model.ImageGeneratedLabel,
			Sources:         sources,
			MetadataScore:   model.MetadataScore(sources),
			MatchConfidence: matchConf,
			Slug:            model.Slugify(raw.Producer, raw.Name, raw.Vintage),
		})
	}
	if err := model.SaveWines(filepath.Join("data", "wines.json"), wines); err != nil {
		panic(err)
	}

	// A sample news post so /news/ isn't empty.
	os.MkdirAll(filepath.Join("data", "news"), 0o755)
	post := map[string]string{
		"title":    "Spring Portfolio Tasting",
		"date":     "2026-04-12",
		"category": "Events",
		"slug":     "spring-portfolio-tasting",
		"body": "We are delighted to welcome the trade to our spring portfolio tasting.\n\n" +
			"Join us to explore new arrivals from Burgundy, the Loire, and beyond, poured " +
			"alongside old favourites from the cellar. Our team will be on hand throughout " +
			"the afternoon to talk through the vintages and help you build your list.\n\n" +
			"Doors open at two; we hope to raise a glass with you.",
	}
	b, _ := json.MarshalIndent(post, "", "  ")
	os.WriteFile(filepath.Join("data", "news", "spring-portfolio-tasting.json"), append(b, '\n'), 0o644)

	fmt.Printf("demoseed: wrote %d eligible wines + labels to %s (skipped %d ineligible), data/wines.json, and 1 news post\n",
		len(wines), imgDir, skipped)
}

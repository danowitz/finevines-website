// Command enrichprompts pulls the LIVE Salesforce roster, keeps the web-eligible
// wines not already enriched, and writes ChatGPT-sized batch files of enrichment
// prompts to data/enrichment-prompts/batch-NNN.md. Paste one batch into ChatGPT
// (browsing on) → it returns one JSON object keyed by SKU → tools/importenrichment
// splits it into data/enrichment/<SKU>.json for the real Run pipeline. No API cost.
//
//	go run ./tools/enrichprompts          # 25 wines per batch (default)
//	go run ./tools/enrichprompts 40       # 40 wines per batch
//
// Reads FINEVINES_SF_* from .env (live org). Skips SKUs already in data/enrichment/.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

const preamble = `# FineVines - Wine Enrichment (ChatGPT batch)

## Instructions - read once, apply to EVERY wine below

You are enriching a wine catalog for FineVines, a licensed Illinois wholesale
wine & spirits distributor. Voice: elegant, editorial, old-world wine trade,
never corporate-tech. Never use em dashes or en dashes anywhere in the copy;
use commas, colons, or periods instead.

### Reading the raw data
Each wine's **Item** is terse QuickBooks trade shorthand: a 2-digit vintage,
then brand + wine name, then a case/bottle pack (e.g. "12/750" = twelve 750ml
bottles; ignore the pack). **Brand** may be "LAST, FIRST". Work out the real
wine from these and search for it. When you write the output:
- Expand the 2-digit vintage (17 → 2017, 98 → 1998).
- Normalize the brand to natural order ("LAMY, HUBERT" → "Hubert Lamy").

### For EACH wine
1. Search the web for the EXACT wine: match brand, wine name, AND vintage.
   Prefer the producer/importer site and reputable references.
2. Write ORIGINAL trade tasting copy. NEVER copy tasting notes, reviews, or any
   other text verbatim. NEVER state critic scores, prices, or awards. If unsure
   of a fact, mark it "derived" or "missing" and keep the copy general.
3. Produce a JSON object with EXACTLY these keys:
   - "description":    2-3 original sentences of trade tasting copy
   - "sommelierNotes": 1-2 sentences of service/pairing guidance
   - "aroma","palate","finish": a short original phrase each ("" if unknown)
   - "foodPairings":   array of 2-5 short strings ([] if unknown)
   - "appellation","country","color","abv","bottleSize","drinkWindow":
                       factual strings, e.g. abv "13.5%", bottleSize "750ml" ("" if unknown)
   - "sources":        object mapping EACH of description, sommelierNotes, aroma,
                       palate, finish, foodPairings, appellation, country, color,
                       abv, bottleSize, drinkWindow to one of "found" (from a real
                       search result), "derived" (inferred from grape/region/style),
                       or "missing"
   - "matchConfidence": integer 0-100 (confidence it's THIS exact wine + vintage)
   - "imageUrl":       URL of a real bottle/label image you found, else ""
   - "imagePrompt":    a prompt for a photorealistic studio bottle photo

## Output format - IMPORTANT
Return ONE JSON object mapping each wine's SKU to its enrichment object, and
NOTHING else:

    { "<SKU>": { ...enrichment... }, "<SKU>": { ...enrichment... } }

## Wines
`

func main() {
	batchSize := 25
	if len(os.Args) > 1 {
		if n, err := strconv.Atoi(os.Args[1]); err == nil && n > 0 {
			batchSize = n
		}
	}

	cfg, err := config.Load(".env")
	if err != nil {
		fatal(err)
	}
	if cfg.SFBaseURL == "" || cfg.SFClientID == "" || cfg.SFClientSecret == "" {
		fatal(fmt.Errorf("FINEVINES_SF_* not set in .env (need the live org to generate real prompts)"))
	}
	client := salesforce.NewClient(salesforce.Config{
		BaseURL: cfg.SFBaseURL, ClientID: cfg.SFClientID,
		ClientSecret: cfg.SFClientSecret, APIVersion: cfg.SFAPIVersion,
	}, &http.Client{Timeout: 120 * time.Second})

	fmt.Printf("pulling live roster from %s…\n", cfg.SFBaseURL)
	roster, err := client.Roster(context.Background())
	if err != nil {
		fatal(err)
	}

	var wines []salesforce.WineRaw
	skipped := 0
	for _, w := range roster {
		if !enrich.Eligible(w.StockQty, w.SKU, w.ReadyToSell) {
			continue
		}
		if _, err := os.Stat(filepath.Join("data", "enrichment", w.SKU+".json")); err == nil {
			skipped++
			continue
		}
		wines = append(wines, w)
	}

	outDir := filepath.Join("data", "enrichment-prompts")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		fatal(err)
	}
	batches := (len(wines) + batchSize - 1) / batchSize
	for b := 0; b < batches; b++ {
		start := b * batchSize
		end := min(start+batchSize, len(wines))
		var sb strings.Builder
		sb.WriteString(preamble)
		for i, w := range wines[start:end] {
			fmt.Fprintf(&sb, "%d. SKU %s | Brand: %s | Item: %s | Vintage: %s | Varietal: %s | Region: %s | Country: %s\n",
				i+1, w.SKU, nz(w.Producer), w.Name, nz(w.Vintage), nz(w.Varietal), nz(w.Region), nz(w.Country))
		}
		path := filepath.Join(outDir, fmt.Sprintf("batch-%03d.md", b+1))
		if err := os.WriteFile(path, []byte(sb.String()), 0o644); err != nil {
			fatal(err)
		}
	}

	fmt.Printf("wrote %d prompts across %d batch files (%d wines/batch) to %s\n", len(wines), batches, batchSize, outDir)
	fmt.Printf("(%d eligible wines already enriched, skipped)\n", skipped)
}

func nz(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "enrichprompts:", err)
	os.Exit(1)
}

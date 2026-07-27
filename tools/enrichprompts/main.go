// Command enrichprompts emits a single hand-off file of enrichment prompts —
// one per web-eligible wine that isn't already enriched — so the batch can be
// pasted into ChatGPT (no API needed) while OpenAI billing is set up. ChatGPT
// returns one JSON object keyed by SKU, which tools/importenrichment then
// splits into data/enrichment/<SKU>.json for the real Run pipeline.
//
//	go run ./tools/enrichprompts            # -> data/enrichment-prompts.md
//	go run ./tools/enrichprompts out.md     # custom output path
//
// It reads the mock roster today; pointing it at the live roster later is a
// one-line swap, and it always skips SKUs already present in data/enrichment/.
package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

const preamble = `# FineVines — Wine Enrichment (ChatGPT batch)

## Instructions — read once, apply to EVERY wine below

You are enriching a wine catalog for FineVines, a licensed Illinois wholesale
wine & spirits distributor. Voice: elegant, editorial, old-world wine trade —
never corporate-tech.

For EACH wine in the list:
1. Search the web for the EXACT wine — match producer, wine name, AND vintage
   (watch for red/white or bottle-size variants of the same name). Prefer the
   producer/importer site and reputable references.
2. Write ORIGINAL trade tasting copy. NEVER copy tasting notes, reviews, or any
   other text verbatim. NEVER state critic scores, prices, or awards. If unsure
   of a fact, mark it "derived" or "missing" and keep the copy general.
3. Produce a JSON object with EXACTLY these keys:
   - "description":    2–3 original sentences of trade tasting copy
   - "sommelierNotes": 1–2 sentences of service/pairing guidance
   - "aroma","palate","finish": a short original phrase each ("" if unknown)
   - "foodPairings":   array of 2–5 short strings ([] if unknown)
   - "appellation","country","color","abv","bottleSize","drinkWindow":
                       factual strings, e.g. abv "13.5%", bottleSize "750ml"
                       ("" if unknown)
   - "sources":        object mapping EACH of the 12 fields above
                       (description, sommelierNotes, aroma, palate, finish,
                       foodPairings, appellation, country, color, abv,
                       bottleSize, drinkWindow) to one of:
                         "found"   — established from a real search result
                         "derived" — inferred from grape/region/style only
                         "missing" — could not determine
   - "matchConfidence": integer 0–100 (confidence it's THIS exact wine+vintage)
   - "imageUrl":       URL of a real bottle/label image you found, else ""
   - "imagePrompt":    a prompt for a photorealistic studio bottle photo
                       (region/style-appropriate bottle & label, neutral
                       warm-grey backdrop, soft light; no people/scenery/logos)

## Output format — IMPORTANT

Return ONE JSON object mapping each wine's SKU to its enrichment object, and
NOTHING else (no commentary):

    {
      "<SKU>": { ...enrichment object... },
      "<SKU>": { ...enrichment object... }
    }

If the list is long, you may split the output across multiple JSON objects of
the same shape — each keyed by SKU — and we will merge them.

## Wines
`

func main() {
	out := "data/enrichment-prompts.md"
	if len(os.Args) > 1 {
		out = os.Args[1]
	}

	src, err := salesforce.NewMockSource()
	if err != nil {
		fatal(err)
	}
	roster, err := src.Roster(context.Background())
	if err != nil {
		fatal(err)
	}

	var b strings.Builder
	b.WriteString(preamble)

	n, skipped := 0, 0
	for _, w := range roster {
		if !enrich.Eligible(w.StockQty, w.SKU, w.ReadyToSell) {
			continue
		}
		if _, err := os.Stat(filepath.Join("data", "enrichment", w.SKU+".json")); err == nil {
			skipped++ // already enriched — don't re-prompt
			continue
		}
		n++
		fmt.Fprintf(&b, "%d. **SKU %s** — %s · %s · %s%s%s%s\n",
			n, w.SKU, w.Producer, joinNonEmpty(" ", w.Name, paren(w.Vintage)),
			nz(w.Varietal, "varietal n/a"),
			field(" · ", w.Region), field(" · ", w.Appellation), field(" · ", w.Style))
	}

	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		fatal(err)
	}
	f, err := os.Create(out)
	if err != nil {
		fatal(err)
	}
	bw := bufio.NewWriter(f)
	bw.WriteString(b.String())
	if err := bw.Flush(); err != nil {
		fatal(err)
	}
	f.Close()

	fmt.Printf("enrichprompts: wrote %d prompts to %s (skipped %d already-enriched)\n", n, out, skipped)
}

func paren(s string) string {
	if strings.TrimSpace(s) == "" {
		return ""
	}
	return "(" + s + ")"
}

func field(sep, v string) string {
	if strings.TrimSpace(v) == "" {
		return ""
	}
	return sep + v
}

func nz(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

func joinNonEmpty(sep string, parts ...string) string {
	var kept []string
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, sep)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "enrichprompts:", err)
	os.Exit(1)
}

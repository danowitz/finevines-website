// Command imagedryrun exercises the gpt-image-1 provider (enrich.GPTImageClient)
// on a small representative sample of catalog wines WITHOUT touching the
// catalog: nothing under data/ or assets/ is written. It exists to judge
// generated-photo quality and per-image cost before approving a full batch
// run over the ~2,180 wines still on the SVG-label placeholder.
//
//	go run ./tools/imagedryrun                       # 12 representative placeholder wines, medium quality
//	go run ./tools/imagedryrun -quality low          # cheaper tier
//	go run ./tools/imagedryrun -skus AB1201,PM5030   # explicit SKUs instead
//
// Output goes to -out (default out-imagedryrun/, git-ignored): one <slug>.jpg
// per wine, a copy of the wine's current SVG placeholder for side-by-side
// comparison, and an index.html contact sheet with prompts, timings, and a
// cost extrapolation. Reads OPENAI_API_KEY from .env.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"html"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/model"
)

// outputTokensPerImage is gpt-image-1's published output-token cost of one
// portrait 1024x1536 image per quality tier; billed at $40 per 1M output
// tokens. Prompt-side input tokens add well under $0.001/image and are
// ignored here.
var outputTokensPerImage = map[string]int{"low": 408, "medium": 1584, "high": 6240}

const dollarsPerMillionOutputTokens = 40.0

type result struct {
	wine         model.Wine
	bucket       string
	prompt       string
	promptSource string // "stored" (data/enrichment/<SKU>.json) or "synthesized"
	jpgName      string
	svgName      string // copied current placeholder, "" if none found
	took         time.Duration
	err          error
}

func main() {
	fatal(fmt.Errorf("invented product-packaging generation is disabled; use verified real-photo cleanup or the neutral SVG fallback"))

	quality := flag.String("quality", "medium", "gpt-image-1 quality tier: low|medium|high")
	outDir := flag.String("out", "out-imagedryrun", "output directory (never data/ or assets/)")
	skusFlag := flag.String("skus", "", "comma-separated SKUs to render instead of the representative pick")
	modelName := flag.String("model", "gpt-image-1", "OpenAI image model")
	workers := flag.Int("workers", 3, "concurrent generations")
	flag.Parse()

	if _, ok := outputTokensPerImage[*quality]; !ok {
		fatal(fmt.Errorf("unknown -quality %q (want low, medium, or high)", *quality))
	}

	cfg, err := config.Load(".env")
	if err != nil {
		fatal(err)
	}
	if cfg.OpenAIAPIKey == "" {
		fatal(fmt.Errorf("OPENAI_API_KEY is not set in .env"))
	}

	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		fatal(err)
	}

	var sample []model.Wine
	if *skusFlag != "" {
		bySKU := map[string]model.Wine{}
		for _, w := range wines {
			bySKU[w.SKU] = w
		}
		for _, sku := range strings.Split(*skusFlag, ",") {
			w, ok := bySKU[strings.TrimSpace(sku)]
			if !ok {
				fatal(fmt.Errorf("SKU %q not in data/wines.json", sku))
			}
			sample = append(sample, w)
		}
	} else {
		sample = pickRepresentative(wines, map[string]int{
			"red": 4, "white": 3, "sparkling": 2, "spirits": 2, "rose": 1,
		})
	}
	if len(sample) == 0 {
		fatal(fmt.Errorf("no wines selected"))
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fatal(err)
	}

	provider := enrich.NewGPTImageClient(cfg.OpenAIAPIKey, *modelName, *quality, "",
		&http.Client{Timeout: 5 * time.Minute})

	fmt.Printf("imagedryrun: %d wines, model %s, quality %s -> %s\n", len(sample), *modelName, *quality, *outDir)

	results := make([]result, len(sample))
	sem := make(chan struct{}, *workers)
	var wg sync.WaitGroup
	for i, w := range sample {
		wg.Add(1)
		go func(i int, w model.Wine) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			r := result{wine: w, bucket: bucket(w)}
			r.prompt, r.promptSource = promptFor(w)

			start := time.Now()
			data, err := provider.GenerateJPEG(context.Background(), r.prompt)
			r.took = time.Since(start).Round(time.Second)
			if err != nil {
				r.err = err
				fmt.Printf("  ✗ %-55s %v\n", w.Slug, err)
			} else {
				r.jpgName = w.Slug + ".jpg"
				if err := os.WriteFile(filepath.Join(*outDir, r.jpgName), data, 0o644); err != nil {
					fatal(err)
				}
				fmt.Printf("  ✓ %-55s %-9s %5s  %3dKB\n", w.Slug, r.bucket, r.took, len(data)/1024)
			}

			// Side-by-side reference: copy the wine's current SVG placeholder
			// (or existing JPEG, for -skus picks that have a real photo).
			for _, ext := range []string{".svg", ".jpg"} {
				src := filepath.Join("assets", "img", "wines", w.Slug+ext)
				if data, err := os.ReadFile(src); err == nil {
					r.svgName = "current-" + w.Slug + ext
					if err := os.WriteFile(filepath.Join(*outDir, r.svgName), data, 0o644); err != nil {
						fatal(err)
					}
					break
				}
			}
			results[i] = r
		}(i, w)
	}
	wg.Wait()

	placeholders := 0
	for _, w := range wines {
		if w.ImageSource == model.ImageGeneratedLabel {
			placeholders++
		}
	}
	if err := writeContactSheet(filepath.Join(*outDir, "index.html"), results, *quality, placeholders); err != nil {
		fatal(err)
	}

	ok := 0
	for _, r := range results {
		if r.err == nil && r.jpgName != "" {
			ok++
		}
	}
	perImage := costPerImage(*quality)
	fmt.Printf("\n%d/%d generated. Estimated spend this run: $%.2f (%s quality, $%.4f/image)\n",
		ok, len(results), float64(ok)*perImage, *quality, perImage)
	fmt.Printf("Extrapolation to all %d placeholder wines: low $%.0f / medium $%.0f / high $%.0f\n",
		placeholders,
		float64(placeholders)*costPerImage("low"),
		float64(placeholders)*costPerImage("medium"),
		float64(placeholders)*costPerImage("high"))
	fmt.Printf("Contact sheet: %s\n", filepath.Join(*outDir, "index.html"))
}

func costPerImage(quality string) float64 {
	return float64(outputTokensPerImage[quality]) / 1e6 * dollarsPerMillionOutputTokens
}

// promptFor returns the wine's stored enrichment image prompt when one exists
// (data/enrichment/<SKU>.json — only ~28 SKUs have one; model.Wine never
// persisted imagePrompt), else a synthesized prompt from catalog fields.
func promptFor(w model.Wine) (prompt, source string) {
	path := filepath.Join("data", "enrichment", enrich.SKUFileBase(w.SKU)+".json")
	if data, err := os.ReadFile(path); err == nil {
		var stored struct {
			ImagePrompt string `json:"imagePrompt"`
		}
		if json.Unmarshal(data, &stored) == nil && strings.TrimSpace(stored.ImagePrompt) != "" {
			return stored.ImagePrompt, "stored"
		}
	}
	return synthesizePrompt(w), "synthesized"
}

func writeContactSheet(path string, results []result, quality string, placeholders int) error {
	var b strings.Builder
	b.WriteString(`<!doctype html><meta charset="utf-8"><title>gpt-image-1 dry run</title>
<style>
 body{font-family:Georgia,serif;margin:2rem;background:#faf7f2;color:#222}
 h1{font-weight:normal} .meta{color:#666}
 table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:.75rem;vertical-align:top;text-align:left}
 img{max-height:340px;max-width:260px;display:block;background:#fff}
 .prompt{font-family:Consolas,monospace;font-size:.8rem;color:#444;max-width:34rem}
 .err{color:#a00}
</style>`)
	fmt.Fprintf(&b, "<h1>gpt-image-1 dry run — %s quality</h1>\n", html.EscapeString(quality))
	fmt.Fprintf(&b, `<p class="meta">$%.4f/image at this tier. Catalog has %d SVG-placeholder wines: full batch ≈ low $%.0f / medium $%.0f / high $%.0f.</p>`,
		costPerImage(quality), placeholders,
		float64(placeholders)*costPerImage("low"),
		float64(placeholders)*costPerImage("medium"),
		float64(placeholders)*costPerImage("high"))
	b.WriteString("\n<table><tr><th>Wine</th><th>Current image</th><th>Generated</th><th>Prompt</th></tr>\n")
	for _, r := range results {
		fmt.Fprintf(&b, "<tr><td><strong>%s</strong><br>%s %s<br><span class=meta>%s · SKU %s · %s</span></td>",
			html.EscapeString(r.wine.Producer),
			html.EscapeString(r.wine.Name), html.EscapeString(r.wine.Vintage),
			html.EscapeString(r.bucket), html.EscapeString(r.wine.SKU), r.took)
		if r.svgName != "" {
			fmt.Fprintf(&b, "<td><img src=%q></td>", r.svgName)
		} else {
			b.WriteString("<td class=meta>none on disk</td>")
		}
		if r.err != nil {
			fmt.Fprintf(&b, "<td class=err>%s</td>", html.EscapeString(r.err.Error()))
		} else {
			fmt.Fprintf(&b, "<td><img src=%q></td>", r.jpgName)
		}
		fmt.Fprintf(&b, "<td class=prompt>%s<br><span class=meta>(%s)</span></td></tr>\n",
			html.EscapeString(r.prompt), r.promptSource)
	}
	b.WriteString("</table>\n")
	return os.WriteFile(path, []byte(b.String()), 0o644)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "imagedryrun:", err)
	os.Exit(1)
}

// Command tryenrich runs ONE live OpenAI enrichment against a wine from the
// mock roster and prints the structured result — a quick way to confirm the
// Responses API wiring end-to-end without a full enrich run (which also needs
// the image provider). Reads OPENAI_API_KEY from .env.
//
//	go run ./tools/tryenrich            # enriches the first roster wine
//	go run ./tools/tryenrich AB1201     # enriches a specific SKU
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func main() {
	cfg, err := config.Load(".env")
	if err != nil {
		fatal(err)
	}
	if cfg.OpenAIAPIKey == "" {
		fatal(fmt.Errorf("OPENAI_API_KEY is not set in .env"))
	}

	src, err := salesforce.NewMockSource()
	if err != nil {
		fatal(err)
	}
	roster, err := src.Roster(context.Background())
	if err != nil {
		fatal(err)
	}

	w := roster[0]
	if len(os.Args) > 1 {
		found := false
		for _, r := range roster {
			if r.SKU == os.Args[1] {
				w, found = r, true
				break
			}
		}
		if !found {
			fatal(fmt.Errorf("SKU %q not in mock roster", os.Args[1]))
		}
	}

	enr := enrich.NewOpenAIEnricher(cfg.OpenAIAPIKey, cfg.OpenAIModel, "", &http.Client{Timeout: 180 * time.Second})
	fmt.Printf("Enriching %s — %s %s (SKU %s)…\n", w.Producer, w.Name, w.Vintage, w.SKU)

	start := time.Now()
	res, err := enr.Enrich(context.Background(), w)
	if err != nil {
		fatal(err)
	}
	b, _ := json.MarshalIndent(res, "", "  ")
	fmt.Printf("\n✓ done in %s\n\n%s\n", time.Since(start).Round(time.Second), b)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "tryenrich:", err)
	os.Exit(1)
}

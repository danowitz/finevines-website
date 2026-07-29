// Command stocksync refreshes ONLY the inventory fields (StockQty, StockCases,
// CasePack) of every wine already in data/wines.json from the live org's
// roster, matched by Salesforce Id. No enrichment, no additions, no removals —
// adding/delisting wines is `finevines enrich`'s job (DiffRoster). This exists
// because stock moves daily while enrichment runs nightly at best, and because
// StockCases/CasePack were added after the catalog was first enriched: one run
// back-fills the case quantities the availability line renders from.
//
//	go run ./tools/stocksync
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func main() {
	cfg, err := config.Load(".env")
	if err != nil {
		fatal(err)
	}
	client := salesforce.NewClient(salesforce.Config{
		BaseURL:      cfg.SFBaseURL,
		ClientID:     cfg.SFClientID,
		ClientSecret: cfg.SFClientSecret,
		APIVersion:   cfg.SFAPIVersion,
	}, &http.Client{Timeout: 300 * time.Second})

	roster, err := client.Roster(context.Background())
	if err != nil {
		fatal(err)
	}
	byID := make(map[string]salesforce.WineRaw, len(roster))
	for _, r := range roster {
		byID[r.ID] = r
	}

	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		fatal(err)
	}
	updated, missing := 0, 0
	for i := range wines {
		raw, ok := byID[wines[i].ID]
		if !ok {
			// Row no longer in the org: zero its stock so the site stops
			// claiming availability; the next enrich pass delists it properly.
			wines[i].StockQty = 0
			wines[i].StockCases = 0
			missing++
			continue
		}
		wines[i].StockQty = raw.StockQty
		wines[i].StockCases = raw.StockCases
		wines[i].CasePack = raw.CasePack
		updated++
	}
	if err := model.SaveWines("data/wines.json", wines); err != nil {
		fatal(err)
	}
	fmt.Printf("✓ data/wines.json — stock refreshed on %d wines (%d no longer in the org, zeroed)\n",
		updated, missing)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "stocksync:", err)
	os.Exit(1)
}

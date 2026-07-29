// Command hotsellers refreshes data/hot-sellers.json from the live org's
// invoice ledger WITHOUT running a full enrich pass: pull net cases sold per
// product (salesforce.SalesTotals), rank against the current data/wines.json
// (enrich.RankHotSellers), save. The same refresh runs automatically at the
// end of every live `finevines enrich` (cmd/finevines refreshHotSellers) —
// this tool exists for ops/diagnostics: refreshing the ranking between enrich
// runs and eyeballing what it would publish.
//
//	go run ./tools/hotsellers          # 30-day window, keep 6
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// Same window/depth as cmd/finevines's nightly refresh (hotSellerWindowDays /
// hotSellerCount) — this tool must write the same file the pipeline would.
const (
	windowDays = 30
	keep       = 6
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
	}, &http.Client{Timeout: 90 * time.Second})

	totals, err := client.SalesTotals(context.Background(), windowDays)
	if err != nil {
		fatal(err)
	}
	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		fatal(err)
	}
	hs := model.HotSellers{
		Updated:    time.Now().UTC().Format(time.RFC3339),
		WindowDays: windowDays,
		Wines:      enrich.RankHotSellers(wines, totals, keep),
	}
	if err := model.SaveHotSellers("data/hot-sellers.json", hs); err != nil {
		fatal(err)
	}
	fmt.Printf("✓ data/hot-sellers.json — %d products with sales in the last %d days, kept %d:\n",
		len(totals), windowDays, len(hs.Wines))
	for i, h := range hs.Wines {
		fmt.Printf("  %d. %-60s %7.2f cs\n", i+1, h.Slug, h.Cases)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "hotsellers:", err)
	os.Exit(1)
}

// Command rehash migrates data/wines.json's stored SourceHash values after a
// hash-scheme change (2026-07-29: StockQty/ReadyToSell were removed from the
// hash so stock movement stops re-enriching the catalog).
//
// The stored hashes were computed from raw roster rows that were consumed
// in-flight and never persisted, and the stored wine fields are normalized —
// so the old hashes cannot be recomputed offline. Instead this tool makes ONE
// read-only live roster pull and, for every wine whose descriptive identity
// provably hasn't drifted (enrich.IdentityMatches), stamps the new-scheme
// hash. Wines that HAVE drifted keep their stale hash and re-enrich honestly
// on the next run — exactly what a real change deserves.
//
// Run this ONCE, before the first live `finevines enrich` after the hash
// change; without it, every wine hashes differently and the whole catalog
// re-enriches (full OpenAI spend) for no reason.
//
//	go run ./tools/rehash           # dry run: report what would change
//	go run ./tools/rehash --apply   # stamp the new hashes
//
// Reads FINEVINES_SF_* from .env. Unaffected by FINEVINES_SF_MOCK (always
// live, like tools/trysf). Writes nothing to Salesforce.
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

const winesPath = "data/wines.json"

func main() {
	apply := len(os.Args) > 1 && os.Args[1] == "--apply"

	cfg, err := config.Load(".env")
	if err != nil {
		fatal(err)
	}
	for _, req := range [][2]string{
		{"FINEVINES_SF_BASE_URL", cfg.SFBaseURL},
		{"FINEVINES_SF_CLIENT_ID", cfg.SFClientID},
		{"FINEVINES_SF_CLIENT_SECRET", cfg.SFClientSecret},
	} {
		if req[1] == "" {
			fatal(fmt.Errorf("%s is not set in .env", req[0]))
		}
	}

	wines, err := model.LoadWines(winesPath)
	if err != nil {
		fatal(err)
	}
	if len(wines) == 0 {
		fatal(fmt.Errorf("%s is empty — nothing to migrate", winesPath))
	}

	client := salesforce.NewClient(salesforce.Config{
		BaseURL:      cfg.SFBaseURL,
		ClientID:     cfg.SFClientID,
		ClientSecret: cfg.SFClientSecret,
		APIVersion:   cfg.SFAPIVersion,
	}, &http.Client{Timeout: 90 * time.Second})

	fmt.Printf("Pulling live roster from %s…\n", cfg.SFBaseURL)
	start := time.Now()
	roster, err := client.Roster(context.Background())
	if err != nil {
		fatal(err)
	}
	fmt.Printf("✓ %d Product2 rows in %s\n\n", len(roster), time.Since(start).Round(time.Millisecond))

	rawByID := make(map[string]salesforce.WineRaw, len(roster))
	for _, r := range roster {
		rawByID[r.ID] = r
	}

	var stamped, current, drifted, missing int
	for i, w := range wines {
		raw, ok := rawByID[w.ID]
		if !ok {
			// Sold out or delisted since the snapshot: the next enrich run
			// drops it regardless of its hash — nothing to migrate.
			missing++
			continue
		}
		newHash := enrich.SourceHash(raw)
		switch {
		case w.SourceHash == newHash:
			current++
		case enrich.IdentityMatches(raw, w):
			wines[i].SourceHash = newHash
			stamped++
		default:
			drifted++
			fmt.Printf("  drift %s (%s %s %s) — descriptive fields changed, will re-enrich\n",
				w.SKU, w.Producer, w.Name, w.Vintage)
		}
	}

	fmt.Printf("\n%d wines: %d re-stamped, %d already current, %d drifted (left to re-enrich), %d gone from roster\n",
		len(wines), stamped, current, drifted, missing)

	if !apply {
		fmt.Println("\nDry run — re-run with --apply to write.")
		return
	}
	if err := model.SaveWines(winesPath, wines); err != nil {
		fatal(err)
	}
	fmt.Printf("wrote %s\n", winesPath)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "rehash:", err)
	os.Exit(1)
}

// Command trysf makes ONE read-only call to the live Salesforce org — the
// paginated Product2 roster query — and prints a summary + a sample of rows.
// It's the first-connection probe: it confirms the OAuth Client Credentials
// Flow authenticates, the SOQL/field mapping is right (real producer/name/stock
// come back), and how many wines are web-eligible. It writes nothing.
//
//	go run ./tools/trysf
//
// Reads FINEVINES_SF_* from .env. Unaffected by FINEVINES_SF_MOCK (always live).
package main

import (
	"context"
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
	for _, req := range [][2]string{
		{"FINEVINES_SF_BASE_URL", cfg.SFBaseURL},
		{"FINEVINES_SF_CLIENT_ID", cfg.SFClientID},
		{"FINEVINES_SF_CLIENT_SECRET", cfg.SFClientSecret},
	} {
		if req[1] == "" {
			fatal(fmt.Errorf("%s is not set in .env", req[0]))
		}
	}

	client := salesforce.NewClient(salesforce.Config{
		BaseURL:      cfg.SFBaseURL,
		ClientID:     cfg.SFClientID,
		ClientSecret: cfg.SFClientSecret,
		APIVersion:   cfg.SFAPIVersion,
	}, &http.Client{Timeout: 90 * time.Second})

	fmt.Printf("Connecting to %s (API %s)…\n", cfg.SFBaseURL, cfg.SFAPIVersion)

	// Report the actual run-as user first, so a failure below is unambiguous
	// about WHICH user's permissions were in effect.
	ctx := context.Background()
	if who, err := client.Query(ctx, "SELECT Name, Username, Profile.Name FROM User WHERE Id = '"+mustUserID(ctx, client)+"'"); err == nil && len(who) == 1 {
		prof, _ := who[0]["Profile"].(map[string]any)
		fmt.Printf("running as: %v (%v) — profile %v\n", who[0]["Name"], who[0]["Username"], prof["Name"])
	}

	start := time.Now()
	roster, err := client.Roster(ctx)
	if err != nil {
		fatal(err)
	}
	fmt.Printf("✓ authenticated and pulled %d Product2 rows in %s\n\n", len(roster), time.Since(start).Round(time.Millisecond))

	n := 10
	if len(roster) < n {
		n = len(roster)
	}
	fmt.Println("Sample rows (confirms the FV_ field mapping):")
	for i := 0; i < n; i++ {
		w := roster[i]
		fmt.Printf("%2d. SKU %-12s stock=%-5d ready=%-5v  %s — %s %s\n",
			i+1, w.SKU, w.StockQty, w.ReadyToSell, w.Producer, w.Name, w.Vintage)
	}

	eligible := 0
	for _, w := range roster {
		if enrich.Eligible(w.StockQty, w.SKU, w.ReadyToSell) {
			eligible++
		}
	}
	fmt.Printf("\nWeb-eligible (stock>0 AND SKU not ^\"9\" AND ready-to-sell): %d of %d\n", eligible, len(roster))
}

// mustUserID forces authentication (a trivial User query all run-as users can
// run) and returns the id the token was issued for.
func mustUserID(ctx context.Context, c *salesforce.Client) string {
	_, _ = c.Query(ctx, "SELECT Id FROM User LIMIT 1")
	return c.RunningUserID()
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "trysf:", err)
	os.Exit(1)
}

// Command accountsserved refreshes data/accounts.json from the live org's
// invoice ledger WITHOUT running a full enrich pass: count distinct accounts
// with at least one invoice in the trailing year (salesforce.AccountsServed),
// save. The same refresh runs automatically at the end of every live
// `finevines enrich` (cmd/finevines refreshAccountsServed) — this tool exists
// for ops/diagnostics: bootstrapping the file and eyeballing the count the
// homepage ledger would floor.
//
//	go run ./tools/accountsserved          # 365-day window
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

// Same window as cmd/finevines's nightly refresh (accountsServedWindowDays) —
// this tool must write the same file the pipeline would.
const windowDays = 365

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

	n, err := client.AccountsServed(context.Background(), windowDays)
	if err != nil {
		fatal(err)
	}
	as := model.AccountsServed{
		Updated:    time.Now().UTC().Format(time.RFC3339),
		WindowDays: windowDays,
		Accounts:   n,
	}
	if err := model.SaveAccountsServed("data/accounts.json", as); err != nil {
		fatal(err)
	}
	fmt.Printf("✓ data/accounts.json — %d distinct accounts invoiced in the last %d days\n", n, windowDays)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "accountsserved:", err)
	os.Exit(1)
}

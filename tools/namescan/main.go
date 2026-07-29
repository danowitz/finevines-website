// Command namescan is a throwaway survey: one read-only roster pull, then a
// report of every web-eligible name where a pack-size token ("12/750") is NOT
// the final token — i.e. what text would be dropped by a strip-everything-
// after-the-pack-size rule. Used to validate that rule before widening
// normalize.packSuffix. Writes nothing.
//
//	go run ./tools/namescan
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

var packAnywhere = regexp.MustCompile(`\s+\d+/[\d.]+\*?`)

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

	roster, err := client.Roster(context.Background())
	if err != nil {
		fatal(err)
	}

	var eligible, withPack, midPack int
	for _, w := range roster {
		if !enrich.Eligible(w.StockQty, w.SKU, w.ReadyToSell) {
			continue
		}
		eligible++
		loc := packAnywhere.FindStringIndex(w.Name)
		if loc == nil {
			continue
		}
		withPack++
		tail := w.Name[loc[1]:]
		if regexp.MustCompile(`\S`).MatchString(tail) {
			midPack++
			fmt.Printf("SKU %-12s %-60q tail after pack: %q\n", w.SKU, w.Name, tail)
		}
	}
	fmt.Printf("\n%d eligible, %d names contain a pack token, %d have text AFTER the pack token\n",
		eligible, withPack, midPack)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "namescan:", err)
	os.Exit(1)
}

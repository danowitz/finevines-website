// Command sfquery runs an arbitrary SOQL query against the live org and prints
// the result (or the exact error). A diagnostic tool for confirming object/
// field access and discovering the real catalog object. Read-only.
//
//	go run ./tools/sfquery "SELECT Id, Name FROM Product2 LIMIT 3"
//	go run ./tools/sfquery "SELECT Id FROM User LIMIT 1"
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, `usage: sfquery "SELECT ... FROM ..."`)
		os.Exit(2)
	}
	soql := strings.Join(os.Args[1:], " ")

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

	fmt.Printf("› %s\n", soql)
	rows, err := client.Query(context.Background(), soql)
	if err != nil {
		fatal(err)
	}
	fmt.Printf("✓ %d row(s)\n", len(rows))
	max := 5
	for i, r := range rows {
		if i >= max {
			fmt.Printf("… (%d more)\n", len(rows)-max)
			break
		}
		b, _ := json.Marshal(r)
		fmt.Printf("  %s\n", b)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "sfquery:", err)
	os.Exit(1)
}

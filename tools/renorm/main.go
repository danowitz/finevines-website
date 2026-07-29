// Command renorm forces re-enrichment of wines whose stored catalog text is
// stale under a normalization change, without touching the rest of the
// catalog. Two triggers (2026-07-29):
//
//   - the widened pack-size rule in normalize.WineName (the pack token and
//     everything after it — hold notes, unit words, asterisks — now strips,
//     and a leading "NV " strips like a 2-digit vintage prefix), so the raw
//     Salesforce name normalizes to a different display name than the one
//     stored;
//   - non-breaking spaces (U+00A0/U+202F) that earlier enrichments let into
//     stored text fields (parseEnrichResult now folds them).
//
// It makes ONE read-only live roster pull, compares each stored wine against
// the freshly-normalized raw row, and CLEARS SourceHash on the affected wines
// — the next `finevines enrich` then sees a hash mismatch and re-enriches
// exactly those wines (with the clean name feeding the web search).
//
//	go run ./tools/renorm           # dry run: report what would be re-enriched
//	go run ./tools/renorm --apply   # clear the hashes
//
// Reads FINEVINES_SF_* from .env. Unaffected by FINEVINES_SF_MOCK (always
// live, like tools/rehash). Writes nothing to Salesforce.
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
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/normalize"
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
	roster, err := client.Roster(context.Background())
	if err != nil {
		fatal(err)
	}
	rawByID := make(map[string]salesforce.WineRaw, len(roster))
	for _, r := range roster {
		rawByID[r.ID] = r
	}
	fmt.Printf("✓ %d Product2 rows\n\n", len(roster))

	var renamed, nbsp, current, missing int
	for i, w := range wines {
		raw, ok := rawByID[w.ID]
		if !ok {
			missing++ // gone from roster: next enrich drops it regardless
			continue
		}
		switch {
		case normalize.WineName(raw.Name, raw.Producer) != w.Name:
			renamed++
			fmt.Printf("  rename %-9s %q\n      -> %q\n", w.SKU, w.Name, normalize.WineName(raw.Name, raw.Producer))
			wines[i].SourceHash = ""
		case hasNBSP(w):
			nbsp++
			fmt.Printf("  nbsp   %-9s %s %s %s\n", w.SKU, w.Producer, w.Name, w.Vintage)
			wines[i].SourceHash = ""
		default:
			current++
		}
	}

	fmt.Printf("\n%d wines: %d renamed, %d nbsp-tainted (both will re-enrich), %d current, %d gone from roster\n",
		len(wines), renamed, nbsp, current, missing)

	if !apply {
		fmt.Println("\nDry run — re-run with --apply to write.")
		return
	}
	if err := model.SaveWines(winesPath, wines); err != nil {
		fatal(err)
	}
	fmt.Printf("wrote %s\n", winesPath)
}

// hasNBSP reports whether any stored text field of w contains a non-breaking
// space (plain U+00A0 or narrow U+202F). Marshaling the whole wine and
// scanning the JSON covers every string field without enumerating them.
func hasNBSP(w model.Wine) bool {
	b, err := json.Marshal(w)
	if err != nil {
		return false
	}
	return strings.ContainsAny(string(b), "\u00a0\u202f")
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "renorm:", err)
	os.Exit(1)
}

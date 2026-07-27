// Command importenrichment ingests ChatGPT's batch output — one or more JSON
// objects keyed by SKU (see tools/enrichprompts) — and writes each wine's
// result to data/enrichment/<SKU>.json, the form the manual Run pipeline reads.
//
//	go run ./tools/importenrichment chatgpt-output.json [more.json ...]
//
// Each input file may contain a single JSON object {"<SKU>": {...}, ...} OR be
// wrapped in prose / a ```json fence — the outermost braces are extracted. Every
// result must have a non-empty "description"; malformed entries are reported and
// skipped, not written, so a bad line can't corrupt the catalog.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: importenrichment <file.json> [more.json ...]")
		os.Exit(2)
	}

	outDir := filepath.Join("data", "enrichment")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		fatal(err)
	}

	var wrote, skipped int
	for _, path := range os.Args[1:] {
		raw, err := os.ReadFile(path)
		if err != nil {
			fatal(err)
		}
		obj, err := extractObject(raw)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", path, err)
			continue
		}
		// Deterministic order for stable logs.
		skus := make([]string, 0, len(obj))
		for sku := range obj {
			skus = append(skus, sku)
		}
		sort.Strings(skus)

		for _, sku := range skus {
			var probe struct {
				Description string `json:"description"`
			}
			if err := json.Unmarshal(obj[sku], &probe); err != nil || strings.TrimSpace(probe.Description) == "" {
				fmt.Fprintf(os.Stderr, "  skip %s: missing/invalid description\n", sku)
				skipped++
				continue
			}
			// Re-indent for a clean, stable on-disk file.
			var pretty any
			json.Unmarshal(obj[sku], &pretty)
			data, _ := json.MarshalIndent(pretty, "", "  ")
			if err := os.WriteFile(filepath.Join(outDir, sku+".json"), append(data, '\n'), 0o644); err != nil {
				fatal(err)
			}
			wrote++
		}
	}
	fmt.Printf("importenrichment: wrote %d files to %s (skipped %d)\n", wrote, outDir, skipped)
}

// extractObject pulls the outermost JSON object out of raw (tolerating a
// ```json fence or surrounding prose) and returns it as a SKU->rawJSON map.
func extractObject(raw []byte) (map[string]json.RawMessage, error) {
	s := strings.TrimSpace(string(raw))
	if i, j := strings.IndexByte(s, '{'), strings.LastIndexByte(s, '}'); i >= 0 && j > i {
		s = s[i : j+1]
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(s), &obj); err != nil {
		return nil, fmt.Errorf("parse SKU->result object: %w", err)
	}
	return obj, nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "importenrichment:", err)
	os.Exit(1)
}

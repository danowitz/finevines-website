package model

import (
	"encoding/json"
	"log"
	"os"
)

// OldSiteQuote is one whole-paragraph quotation captured from the old
// finevines.com (data/oldsite-prose/extracted.json), with optional
// attribution. An unattributed quote is still a quotation, never FineVines'
// own words — build must always render it as one (see build's wineProse).
type OldSiteQuote struct {
	Quote       string `json:"quote"`
	Attribution string `json:"attribution,omitempty"`
}

// OldSiteProse is one entry of data/oldsite-prose/extracted.json: the old
// finevines.com's importer copy for one wine, captured once before the old
// site goes offline at cutover (see CLAUDE.md). It is joined against
// wines.json by SKU AT BUILD TIME (see build.loadSite) rather than merged
// into wines.json, because `enrich` rewrites wines.json from Salesforce +
// OpenAI every night and commits it back — anything merged into that file
// would be clobbered by a run that knows nothing about this side file.
//
//   - Facts is measurable detail keyed by a fixed vocabulary (vineyard, soil,
//     yield, vinification, aging, productionVolume, harvestMethod); any
//     subset may be present.
//   - TastingNote is third-person editorial prose, one paragraph per entry.
//   - ProducerCopy is the producer's own first-person voice.
//   - Quotes are whole-paragraph quotations, sometimes attributed.
type OldSiteProse struct {
	SKU          string            `json:"sku"`
	Slug         string            `json:"slug"`
	WineName     string            `json:"wineName"`
	SourceURL    string            `json:"sourceUrl"`
	Facts        map[string]string `json:"facts,omitempty"`
	ProducerCopy []string          `json:"producerCopy,omitempty"`
	Quotes       []OldSiteQuote    `json:"quotes,omitempty"`
	TastingNote  []string          `json:"tastingNote,omitempty"`
}

// LoadOldSiteProse reads path and indexes its entries by SKU for build's
// wine-detail join. Unlike LoadWines/LoadHotSellers/LoadAccountsServed, this
// loader deliberately never returns an error: the data is supplementary (an
// archival extra, not anything commercial or Salesforce-sourced), so a
// missing file OR one that fails to parse both degrade to an empty map —
// rendering no old-site-prose section — rather than failing the whole site
// build. A read or parse failure (missing file is normal and silent) is
// still logged so the problem is visible in build output.
func LoadOldSiteProse(path string) map[string]OldSiteProse {
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("model: old-site prose unavailable, rendering no section (%s): %v", path, err)
		}
		return map[string]OldSiteProse{}
	}
	var entries []OldSiteProse
	if err := json.Unmarshal(data, &entries); err != nil {
		log.Printf("model: old-site prose malformed, rendering no section (%s): %v", path, err)
		return map[string]OldSiteProse{}
	}
	out := make(map[string]OldSiteProse, len(entries))
	for _, e := range entries {
		if e.SKU == "" {
			continue
		}
		out[e.SKU] = e
	}
	return out
}

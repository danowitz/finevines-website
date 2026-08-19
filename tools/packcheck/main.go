// Command packcheck answers a specific question about the catalog: when two or
// more wines collapse to the same /wines/<slug>/ URL (because name
// normalization strips the pack/size suffix that made their descriptions
// differ), WHY do they duplicate? It reads data/wines.json for the colliding
// slug groups, pulls each member's raw Salesforce Description (which still
// carries the "12/750"-style pack suffix) plus on-hand qty and ready-to-sell
// flag, and sorts every group into one of three buckets:
//
//   - BOTTLE  — different bottle size (e.g. 12/750 vs 6/1500 magnums)
//   - CASE    — same bottle, different case pack (e.g. 6/750 vs 12/750)
//   - PURE    — identical pack, two item numbers (a genuine duplicate)
//
// It writes three deliverables into docs/:
//   - portfolio-slug-duplicates.txt  (plain text, ready to paste into an email)
//   - portfolio-slug-duplicates.md   (same data as tables)
//   - portfolio-slug-duplicates.csv  (one row per SKU, for a spreadsheet)
//
// Read-only against Salesforce.
//
//	go run ./tools/packcheck
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// packRe pulls the trailing pack/size token ("12/750", "6/1500", "1/3.0",
// "6/750*") off a raw trade description.
var packRe = regexp.MustCompile(`(\d+)/([\d.]+)\*?\s*$`)

// packOf returns the normalized pack ("12/750"), the case count ("12"), and the
// bottle size ("750"). All empty when no pack is present.
func packOf(desc string) (pack, count, size string) {
	if m := packRe.FindStringSubmatch(strings.TrimSpace(desc)); m != nil {
		return m[1] + "/" + m[2], m[1], m[2]
	}
	return "—", "", ""
}

const (
	catBottle = "BOTTLE" // different bottle size
	catCase   = "CASE"   // same bottle, different case pack
	catPure   = "PURE"   // identical pack — true duplicate
)

// classify buckets a group by its members' packs: any difference in bottle size
// ⇒ BOTTLE; else any difference in case count ⇒ CASE; else PURE.
func classify(sizes, counts map[string]bool, packs map[string]bool) string {
	if len(packs) == 1 {
		return catPure
	}
	if len(sizes) > 1 {
		return catBottle
	}
	return catCase
}

type sfRow struct {
	desc  string
	qty   float64
	ready bool
}

type member struct {
	sku, pack string
	qty       float64
	ready     bool
}

type group struct {
	slug, title, cat string
	members          []member
}

func main() {
	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		fatal(err)
	}
	bySlug := map[string][]model.Wine{}
	for _, w := range wines {
		bySlug[w.Slug] = append(bySlug[w.Slug], w)
	}
	var slugs []string
	skuSet := map[string]bool{}
	for s, ws := range bySlug {
		if len(ws) > 1 {
			slugs = append(slugs, s)
			for _, w := range ws {
				skuSet[w.SKU] = true
			}
		}
	}
	sort.Strings(slugs)
	var skus []string
	for s := range skuSet {
		skus = append(skus, s)
	}

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

	rowBySKU := map[string]sfRow{}
	for i := 0; i < len(skus); i += 200 {
		end := i + 200
		if end > len(skus) {
			end = len(skus)
		}
		quoted := make([]string, 0, end-i)
		for _, s := range skus[i:end] {
			quoted = append(quoted, "'"+strings.ReplaceAll(s, "'", "\\'")+"'")
		}
		soql := "SELECT Name, Description, FV_OnHand_Qty__c, FV_Ready_To_Sell__c FROM Product2 WHERE Name IN (" + strings.Join(quoted, ",") + ")"
		rows, err := client.Query(context.Background(), soql)
		if err != nil {
			fatal(err)
		}
		for _, r := range rows {
			name, _ := r["Name"].(string)
			desc, _ := r["Description"].(string)
			qty, _ := r["FV_OnHand_Qty__c"].(float64)
			ready, _ := r["FV_Ready_To_Sell__c"].(bool)
			rowBySKU[name] = sfRow{desc: desc, qty: qty, ready: ready}
		}
	}

	// Build classified groups.
	var groups []group
	counts := map[string]int{catBottle: 0, catCase: 0, catPure: 0}
	for _, s := range slugs {
		ws := bySlug[s]
		packs, sizes, cnts := map[string]bool{}, map[string]bool{}, map[string]bool{}
		var mem []member
		for _, w := range ws {
			r := rowBySKU[w.SKU]
			p, c, sz := packOf(r.desc)
			packs[p] = true
			if sz != "" {
				sizes[sz] = true
				cnts[c] = true
			}
			mem = append(mem, member{w.SKU, p, r.qty, r.ready})
		}
		cat := classify(sizes, cnts, packs)
		counts[cat]++
		groups = append(groups, group{s, titleOf(ws[0]), cat, mem})
	}

	writeTxt(groups, counts, len(skus))
	writeMd(groups, counts, len(skus))
	writeCsv(groups)

	fmt.Printf("groups=%d bottle=%d case=%d pure=%d | listings=%d\n",
		len(slugs), counts[catBottle], counts[catCase], counts[catPure], len(skus))
	fmt.Println("wrote docs/portfolio-slug-duplicates.{txt,md,csv}")
}

// titleOf builds a readable heading from a wine, folding in the producer and
// vintage only when they aren't already part of the normalized name.
func titleOf(w model.Wine) string {
	base := strings.TrimSpace(w.Name)
	if base == "" {
		base = w.Producer
	}
	if w.Vintage != "" && !strings.Contains(base, w.Vintage) {
		base += " " + w.Vintage
	}
	if w.Producer != "" && !strings.Contains(strings.ToLower(base), strings.ToLower(w.Producer)) {
		base = w.Producer + " — " + base
	}
	return strings.TrimSpace(base)
}

var catMeta = []struct {
	cat, heading, note string
}{
	{catBottle, "DIFFERENT BOTTLE SIZE (e.g. 750ml vs 1.5L magnum)", "these are different products — most likely keep both, labeled by size"},
	{catCase, "6-PACK vs 12-PACK (same bottle, different case pack)", "same bottle in a different case count — decide whether both should list"},
	{catPure, "PURE DUPLICATES (identical size and pack, two item numbers)", "genuinely the same product twice — safe to show once"},
}

func groupsIn(groups []group, cat string) []group {
	var out []group
	for _, g := range groups {
		if g.cat == cat {
			out = append(out, g)
		}
	}
	return out
}

// writeTxt renders the email-pasteable plain-text version.
func writeTxt(groups []group, counts map[string]int, listings int) {
	var b strings.Builder
	b.WriteString("FINEVINES — DUPLICATE CATALOG LISTINGS\n")
	b.WriteString(fmt.Sprintf("%d wines currently appear more than once in the online catalog (%d item numbers total).\n", len(groups), listings))
	b.WriteString("Every one of them is in stock and marked ready-to-sell. They fall into three cases:\n")
	for _, m := range catMeta {
		b.WriteString(fmt.Sprintf("  - %s: %d\n", strings.SplitN(m.heading, " (", 2)[0], counts[m.cat]))
	}
	b.WriteString("\nPack notation: cases/size, e.g. 12/750 = twelve 750ml bottles, 6/1500 = six 1.5L magnums.\n")

	for _, m := range catMeta {
		gs := groupsIn(groups, m.cat)
		b.WriteString("\n" + strings.Repeat("=", 66) + "\n")
		b.WriteString(fmt.Sprintf("%s — %d\n", m.heading, len(gs)))
		b.WriteString("(" + m.note + ")\n")
		b.WriteString(strings.Repeat("=", 66) + "\n")
		for _, g := range gs {
			b.WriteString("\n" + g.title + "\n")
			for _, mm := range g.members {
				b.WriteString(fmt.Sprintf("   SKU %-8s  %-8s  on-hand %.1f\n", mm.sku, mm.pack, mm.qty))
			}
		}
	}
	write("docs/portfolio-slug-duplicates.txt", b.String())
}

func writeMd(groups []group, counts map[string]int, listings int) {
	var b strings.Builder
	b.WriteString("# FineVines — duplicate catalog listings\n\n")
	b.WriteString(fmt.Sprintf("%d wines appear more than once in the online catalog (%d item numbers). ", len(groups), listings))
	b.WriteString("All are in stock and ready-to-sell. Pack notation is cases/size (`12/750` = twelve 750ml bottles, `6/1500` = six 1.5L magnums).\n\n")
	b.WriteString(fmt.Sprintf("- **Different bottle size:** %d · **6-pack vs 12-pack:** %d · **Pure duplicates:** %d\n\n",
		counts[catBottle], counts[catCase], counts[catPure]))
	for _, m := range catMeta {
		gs := groupsIn(groups, m.cat)
		b.WriteString(fmt.Sprintf("## %s — %d groups\n\n", strings.SplitN(m.heading, " (", 2)[0], len(gs)))
		b.WriteString("_" + m.note + "_\n\n")
		for _, g := range gs {
			b.WriteString(fmt.Sprintf("### %s\n\n`/wines/%s/`\n\n", g.title, g.slug))
			b.WriteString("| SKU | Pack | On-hand | Ready |\n|---|---|---|---|\n")
			for _, mm := range g.members {
				ready := "yes"
				if !mm.ready {
					ready = "**NO**"
				}
				b.WriteString(fmt.Sprintf("| %s | %s | %.1f | %s |\n", mm.sku, mm.pack, mm.qty, ready))
			}
			b.WriteString("\n")
		}
	}
	write("docs/portfolio-slug-duplicates.md", b.String())
}

func writeCsv(groups []group) {
	var b strings.Builder
	b.WriteString("category,wine,slug,sku,pack,on_hand,ready\n")
	for _, g := range groups {
		for _, mm := range g.members {
			b.WriteString(fmt.Sprintf("%s,%q,%s,%s,%s,%.2f,%t\n", g.cat, g.title, g.slug, mm.sku, mm.pack, mm.qty, mm.ready))
		}
	}
	write("docs/portfolio-slug-duplicates.csv", b.String())
}

func write(path, s string) {
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "packcheck:", err)
	os.Exit(1)
}

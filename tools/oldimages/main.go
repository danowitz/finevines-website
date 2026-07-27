// Command oldimages crawls the old finevines.com /portfolio grid and matches
// each wine's bottle photo to the live Salesforce roster, so we can reuse
// FineVines' OWN images (zero copyright). There's no shared key, so it matches
// on producer + name: a PRODUCER GATE (the old-site producer must share a
// significant token with the Salesforce brand) removes cross-producer false
// positives, then name-token containment scores the fit. It reports the match
// rate + samples and writes data/oldsite-images.json — the manifest the image
// chain downloads from. Read-only against both systems.
//
//	go run ./tools/oldimages
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

const oldSite = "https://www.finevines.com"

// manifestThreshold is the minimum name-containment score (with the producer
// gate satisfied) for a match to be written to the manifest / trusted.
const manifestThreshold = 0.55

var cardRe = regexp.MustCompile(`itemprop="image"><a href="(/portfolio/[^"]+)"[^>]*><img src="([^"]+)"`)

// stop drops connective words AND common producer prefixes ("domaine",
// "chateau", …) so the producer gate compares on distinguishing tokens only.
var stop = map[string]bool{
	"de": true, "du": true, "la": true, "le": true, "les": true, "des": true, "et": true,
	"and": true, "the": true, "of": true, "cd": true,
	"domaine": true, "dom": true, "chateau": true, "ch": true, "estate": true, "maison": true,
	"vineyard": true, "vineyards": true, "winery": true, "wine": true, "wines": true,
	"pere": true, "fils": true, "cellars": true, "weingut": true, "bodega": true, "bodegas": true,
}

type oldWine struct {
	producer, wine, image string
	prodTok, nameTok      map[string]bool
}

// match is one manifest entry: an SF SKU mapped to its old-site image.
type match struct {
	SKU        string  `json:"sku"`
	ImageURL   string  `json:"imageUrl"`
	OldSlug    string  `json:"oldSlug"`
	Confidence float64 `json:"confidence"`
}

func main() {
	client := &http.Client{Timeout: 30 * time.Second}

	// --- crawl the portfolio grid ---
	var cards []oldWine
	seen := map[string]bool{}
	for page := 0; page < 400; page++ {
		html, err := fetch(client, fmt.Sprintf("%s/portfolio?page=%d", oldSite, page))
		if err != nil {
			fmt.Fprintln(os.Stderr, "fetch page", page, ":", err)
			break
		}
		fresh := 0
		for _, m := range cardRe.FindAllStringSubmatch(html, -1) {
			href := m[1]
			parts := strings.SplitN(strings.TrimPrefix(href, "/portfolio/"), "/", 2)
			if len(parts) != 2 || parts[0] == "producer" || seen[href] {
				continue
			}
			seen[href] = true
			fresh++
			cards = append(cards, oldWine{
				producer: parts[0], wine: parts[1], image: originalImage(m[2]),
				prodTok: tokenize(parts[0]), nameTok: tokenize(parts[1]),
			})
		}
		if fresh == 0 {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	fmt.Printf("OLD SITE: %d unique wines with images\n", len(cards))

	// --- live Salesforce roster (eligible) ---
	cfg, err := config.Load(".env")
	if err != nil {
		fatal(err)
	}
	sf := salesforce.NewClient(salesforce.Config{
		BaseURL: cfg.SFBaseURL, ClientID: cfg.SFClientID,
		ClientSecret: cfg.SFClientSecret, APIVersion: cfg.SFAPIVersion,
	}, &http.Client{Timeout: 120 * time.Second})
	roster, err := sf.Roster(context.Background())
	if err != nil {
		fatal(err)
	}
	var eligible []salesforce.WineRaw
	for _, w := range roster {
		if enrich.Eligible(w.StockQty, w.SKU, w.ReadyToSell) {
			eligible = append(eligible, w)
		}
	}
	fmt.Printf("SALESFORCE: %d eligible wines\n\n", len(eligible))

	// --- producer-gated match ---
	thresholds := []float64{0.4, 0.5, 0.55, 0.6, 0.7}
	counts := make([]int, len(thresholds))
	var manifest []match
	var samples, misses []string
	for _, w := range eligible {
		best, score := bestMatch(tokenize(w.Producer), tokenize(w.Name), cards)
		for i, t := range thresholds {
			if score >= t {
				counts[i]++
			}
		}
		if score >= manifestThreshold {
			manifest = append(manifest, match{SKU: w.SKU, ImageURL: best.image, OldSlug: best.producer + "/" + best.wine, Confidence: round2(score)})
			if len(samples) < 18 {
				samples = append(samples, fmt.Sprintf("  %.2f  %-9s %q → %s", score, w.SKU, trim(w.Name), best.producer+"/"+best.wine))
			}
		} else if score < 0.3 && len(misses) < 8 {
			misses = append(misses, fmt.Sprintf("  %.2f  %-9s %q (best: %s)", score, w.SKU, trim(w.Name), best.wine))
		}
	}

	fmt.Println("MATCH RATE (producer-gated, of eligible SF wines):")
	for i, t := range thresholds {
		fmt.Printf("  ≥ %.0f%%: %d / %d  (%.1f%%)\n", t*100, counts[i], len(eligible), 100*float64(counts[i])/float64(len(eligible)))
	}

	sort.Slice(manifest, func(i, j int) bool { return manifest[i].SKU < manifest[j].SKU })
	out := filepath.Join("data", "oldsite-images.json")
	data, _ := json.MarshalIndent(manifest, "", "  ")
	if err := os.WriteFile(out, append(data, '\n'), 0o644); err != nil {
		fatal(err)
	}
	fmt.Printf("\nMANIFEST: wrote %d matches (≥%.0f%%) to %s\n", len(manifest), manifestThreshold*100, out)

	fmt.Println("\nSAMPLE MATCHES (eyeball accuracy):")
	for _, s := range samples {
		fmt.Println(s)
	}
	fmt.Println("\nSAMPLE MISSES (<0.30 — not on the old site):")
	for _, s := range misses {
		fmt.Println(s)
	}
}

// bestMatch returns the highest-scoring old-site card whose producer shares a
// significant token with the SF brand (the gate), scored by how much of the
// card's name is contained in the SF wine's tokens.
func bestMatch(sfProd, sfName map[string]bool, cards []oldWine) (oldWine, float64) {
	var best oldWine
	var bestScore float64
	for _, c := range cards {
		if len(c.nameTok) == 0 || !overlaps(sfProd, c.prodTok) {
			continue
		}
		hit := 0
		for t := range c.nameTok {
			if sfName[t] {
				hit++
			}
		}
		if score := float64(hit) / float64(len(c.nameTok)); score > bestScore {
			bestScore, best = score, c
		}
	}
	return best, bestScore
}

func overlaps(a, b map[string]bool) bool {
	for t := range a {
		if b[t] {
			return true
		}
	}
	return false
}

func fetch(c *http.Client, url string) (string, error) {
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (FineVines image-match)")
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var b strings.Builder
	buf := make([]byte, 32_000)
	for {
		n, err := resp.Body.Read(buf)
		b.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return b.String(), nil
}

func originalImage(src string) string {
	if i := strings.Index(src, "?"); i >= 0 {
		src = src[:i]
	}
	src = regexp.MustCompile(`/styles/[^/]+/public/`).ReplaceAllString(src, "/")
	if strings.HasPrefix(src, "/") {
		src = oldSite + src
	}
	return src
}

func tokenize(s string) map[string]bool {
	out := map[string]bool{}
	for _, t := range regexp.MustCompile(`[^a-z0-9]+`).Split(strings.ToLower(s), -1) {
		if len(t) < 2 || stop[t] || isAllDigits(t) {
			continue
		}
		out[t] = true
	}
	return out
}

func isAllDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return len(s) > 0
}

func round2(f float64) float64 { return float64(int(f*100+0.5)) / 100 }

func trim(s string) string {
	if len(s) > 44 {
		return s[:44] + "…"
	}
	return s
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "oldimages:", err)
	os.Exit(1)
}

// Command oldimages is a PROTOTYPE: it crawls the old finevines.com /portfolio
// grid, extracts each wine's detail slug + bottle-image URL, then fuzzy-matches
// those against the live Salesforce roster (there's no shared key — the old
// site has no SKU) and reports the match rate at several confidence thresholds,
// with sample matches to eyeball accuracy. Read-only; writes nothing. This is
// how we decide whether harvesting your own old-site images is worth building.
//
//	go run ./tools/oldimages
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

const oldSite = "https://www.finevines.com"

// cardRe pulls (detail href, image src) from each product teaser.
var cardRe = regexp.MustCompile(`itemprop="image"><a href="(/portfolio/[^"]+)"[^>]*><img src="([^"]+)"`)

var stop = map[string]bool{
	"de": true, "du": true, "la": true, "le": true, "les": true, "des": true,
	"et": true, "and": true, "the": true, "of": true, "cd": true, "cru": true,
}

type oldWine struct {
	producer, wine, image string
	tokens                map[string]bool
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
		ms := cardRe.FindAllStringSubmatch(html, -1)
		fresh := 0
		for _, m := range ms {
			href := m[1]
			parts := strings.SplitN(strings.TrimPrefix(href, "/portfolio/"), "/", 2)
			if len(parts) != 2 || parts[0] == "producer" || seen[href] {
				continue
			}
			seen[href] = true
			fresh++
			cards = append(cards, oldWine{
				producer: parts[0], wine: parts[1], image: originalImage(m[2]),
				tokens: tokenize(parts[0] + " " + parts[1]),
			})
		}
		if fresh == 0 {
			break
		}
		if page%10 == 0 {
			fmt.Printf("  crawled to page %d — %d wines so far\n", page, len(cards))
		}
		time.Sleep(150 * time.Millisecond)
	}
	fmt.Printf("\nOLD SITE: %d unique wines with images\n\n", len(cards))

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

	// --- match each SF wine to its best old-site card ---
	thresholds := []float64{0.5, 0.6, 0.7, 0.8}
	counts := make([]int, len(thresholds))
	var samples, misses []string
	for _, w := range eligible {
		sfTok := tokenize(w.Producer + " " + w.Name)
		best, score := bestMatch(sfTok, cards)
		for i, t := range thresholds {
			if score >= t {
				counts[i]++
			}
		}
		if score >= 0.6 && len(samples) < 12 {
			samples = append(samples, fmt.Sprintf("  %.2f  SF[%s] %q  →  OLD[%s/%s]", score, w.SKU, trim(w.Name), best.producer, best.wine))
		}
		if score < 0.4 && len(misses) < 8 {
			misses = append(misses, fmt.Sprintf("  %.2f  SF[%s] %q  (best: %s)", score, w.SKU, trim(w.Name), best.wine))
		}
	}

	fmt.Println("MATCH RATE (of eligible SF wines that find an old-site image):")
	for i, t := range thresholds {
		fmt.Printf("  ≥ %.0f%% confidence: %d / %d  (%.1f%%)\n", t*100, counts[i], len(eligible), 100*float64(counts[i])/float64(len(eligible)))
	}
	fmt.Println("\nSAMPLE MATCHES (≥0.60 — eyeball accuracy):")
	for _, s := range samples {
		fmt.Println(s)
	}
	fmt.Println("\nSAMPLE MISSES (<0.40 — likely not on the old site):")
	for _, s := range misses {
		fmt.Println(s)
	}
}

func fetch(c *http.Client, url string) (string, error) {
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (FineVines image-match prototype)")
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b := make([]byte, 0, 200_000)
	buf := make([]byte, 32_000)
	for {
		n, err := resp.Body.Read(buf)
		b = append(b, buf[:n]...)
		if err != nil {
			break
		}
	}
	return string(b), nil
}

// originalImage turns a styled teaser URL into the full-size original and makes
// it absolute: drops "styles/<style>/public/" and any "?itok=" query.
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

// bestMatch returns the old-site card whose name tokens are most contained in
// the SF wine's tokens, and that containment score (|old ∩ sf| / |old|).
func bestMatch(sfTok map[string]bool, cards []oldWine) (oldWine, float64) {
	var best oldWine
	var bestScore float64
	for _, c := range cards {
		if len(c.tokens) == 0 {
			continue
		}
		hit := 0
		for t := range c.tokens {
			if sfTok[t] {
				hit++
			}
		}
		score := float64(hit) / float64(len(c.tokens))
		if score > bestScore {
			bestScore, best = score, c
		}
	}
	return best, bestScore
}

func trim(s string) string {
	if len(s) > 48 {
		return s[:48] + "…"
	}
	return s
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "oldimages:", err)
	os.Exit(1)
}

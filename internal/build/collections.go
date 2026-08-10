package build

// Facet hub pages: /producers/, /regions/, /varietals/ and one page per value
// under each.
//
// Before these existed, the only way to see "every Benjamin Leroux we carry"
// was /portfolio/?producer=Benjamin+Leroux — a query string, applied by
// JavaScript, that search engines will not index as a landing page. So 307
// producers, 106 regions and 106 varietals were URLs the catalog knew about
// and never published, and the site's entire internal link graph was two
// levels deep: portfolio → wine, with nothing joining wines to each other.
//
// A hub is deliberately thin machinery over data that already exists: it
// renders the same cards the portfolio renders (one per wine, vintages
// collapsed), and its editorial value is the cut itself plus the links out to
// neighbouring cuts. Nothing here re-derives what a wine IS.
//
// Country is NOT published as a hub. France alone is 1,343 of 1,902 cards —
// a page that is simply the portfolio again — and the values are not
// normalized ("United States" and "USA" are both live), so the pages would
// compete with each other for the same query. It stays a portfolio facet.

import (
	"fmt"
	"html/template"
	"net/url"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
)

// hubKind is one facet dimension published as its own family of pages.
type hubKind struct {
	// Key is the portfolio facet key, which is also the ?query param name the
	// client engine round-trips — so a hub's "filter this live" link and
	// portfolio.js's FACET_KEYS cannot drift apart.
	Key string
	// Segment is the URL segment: /producers/, /regions/, /varietals/.
	Segment string
	// Singular and Plural label the kind in prose and headings.
	Singular string
	Plural   string
	// Value pulls this kind's value off a card.
	Value func(cardWine) string
	// lede renders the one-sentence summary at the top of a value's page.
	lede func(name string, n int) string
}

var hubKinds = []hubKind{
	{
		Key: "producer", Segment: "producers", Singular: "Producer", Plural: "Producers",
		Value: func(c cardWine) string { return c.Producer },
		lede: func(name string, n int) string {
			return fmt.Sprintf("%s %s from %s, currently in stock.", spellNum(n), wineWord(n), name)
		},
	},
	{
		Key: "region", Segment: "regions", Singular: "Region", Plural: "Regions",
		Value: func(c cardWine) string { return c.Region },
		lede: func(name string, n int) string {
			return fmt.Sprintf("%s %s from %s, currently in stock.", spellNum(n), wineWord(n), name)
		},
	},
	{
		Key: "varietal", Segment: "varietals", Singular: "Varietal", Plural: "Varietals",
		Value: func(c cardWine) string { return c.Varietal },
		lede: func(name string, n int) string {
			return fmt.Sprintf("%s %s made from %s, currently in stock.", spellNum(n), wineWord(n), name)
		},
	},
}

func wineWord(n int) string {
	if n == 1 {
		return "wine"
	}
	return "wines"
}

// hubValue is one published facet value and the cards that belong to it.
type hubValue struct {
	Name  string
	Slug  string
	Cards []cardWine
}

// buildHubValues groups cards by one facet's value, keyed by SLUG rather than
// by the raw string.
//
// Keying by slug is what merges the catalog's spelling variants. "Lignier
// Michelot" and "Lignier-Michelot" are one estate; "Burgundy - C d Nuits",
// "Burgundy, C d Nuits" and "Burgundy C d Nuits" are one region. Every
// collision in the live data is punctuation, so merging is the correct
// reading — and keying by the raw string instead would have the variants race
// to overwrite each other's index.html, publishing whichever rendered last.
//
// The displayed name is the variant carrying the most wines (ties broken
// alphabetically, so the choice is deterministic), and the result is sorted by
// name so the build stays byte-identical run to run.
func buildHubValues(kind hubKind, cards []cardWine) []hubValue {
	type acc struct {
		cards []cardWine
		spelt map[string]int // variant -> how many cards spell it that way
	}
	bySlug := map[string]*acc{}
	for _, c := range cards {
		name := strings.TrimSpace(kind.Value(c))
		if name == "" {
			continue // a wine with no producer/region/varietal joins no hub
		}
		slug := model.Slugify(name)
		if slug == "" {
			continue
		}
		a := bySlug[slug]
		if a == nil {
			a = &acc{spelt: map[string]int{}}
			bySlug[slug] = a
		}
		a.cards = append(a.cards, c)
		a.spelt[name]++
	}

	out := make([]hubValue, 0, len(bySlug))
	for slug, a := range bySlug {
		best, bestN := "", -1
		for name, n := range a.spelt {
			if n > bestN || (n == bestN && name < best) {
				best, bestN = name, n
			}
		}
		out = append(out, hubValue{Name: best, Slug: slug, Cards: a.cards})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Slug < out[j].Slug
	})
	return out
}

// hubLink is a link to another hub, used both for the index pages and for the
// cross-links that join one cut of the catalog to its neighbours.
type hubLink struct {
	Name  string
	URL   string
	Count int
}

// hubRelated is one group of cross-links on a value's page — "Regions",
// "Varietals" — naming the other cuts its wines belong to.
type hubRelated struct {
	Label string
	Links []hubLink
}

// hubPage is one facet value's landing page (or one page of it).
type hubPage struct {
	page
	Kind  hubKind
	Name  string
	Lede  string
	Total int
	Cards []cardWine // this page's slice

	PageNum   int
	PageCount int
	PrevURL   string
	NextURL   string

	// Related are the neighbouring cuts: a producer's page names its regions
	// and varietals, a region's page its producers and varietals. Uncapped on
	// purpose — every one is a real, relevant internal link, and the largest
	// realistic page (Pinot Noir) still lands well inside what a crawler
	// happily walks.
	Related []hubRelated
	// IndexURL is this kind's own index (/producers/), so a hub is never a
	// dead end even for a visitor who arrived on it cold from search.
	IndexURL string
	// FilterURL is the same cut on the portfolio, where the client engine can
	// refine it further. The static page ranks; the app filters.
	FilterURL string
}

// hubIndexGroup is one initial-letter block on an index page.
type hubIndexGroup struct {
	Letter  string
	Entries []hubLink
}

// hubIndexPage lists every value of one kind, grouped A–Z. With 307
// producers, an undifferentiated list is unreadable; the letter blocks make
// it scannable and give the page a shape a reader can navigate.
type hubIndexPage struct {
	page
	Kind   hubKind
	Groups []hubIndexGroup
	Total  int
}

// hubURL is the site-root path for one value's page n. Page 1 is the bare
// /producers/<slug>/ — no /page/1/ variant, which would be a second URL for
// identical content.
func hubURL(kind hubKind, slug string, n int) string {
	if n <= 1 {
		return "/" + kind.Segment + "/" + slug + "/"
	}
	return fmt.Sprintf("/%s/%s/page/%d/", kind.Segment, slug, n)
}

// hubIndexURL is the kind's index path, e.g. /producers/.
func hubIndexURL(kind hubKind) string { return "/" + kind.Segment + "/" }

// portfolioFilterURL is the live, refinable view of the same cut. The facet
// key doubles as the query param name (see hubKind.Key), so this URL is
// exactly what portfolio.js's readState() will parse back into a selection.
func portfolioFilterURL(kind hubKind, name string) string {
	return "/portfolio/?" + kind.Key + "=" + url.QueryEscape(name)
}

// relatedFor builds the cross-links from one value's cards: for every OTHER
// kind, the values those cards carry, ranked by how many of them do.
//
// This is what turns 519 separate pages into a graph. A visitor (or a
// crawler) landing on a producer can move sideways into its regions and
// varietals, and from there into every other producer working the same
// ground.
func relatedFor(kind hubKind, cards []cardWine, valuesByKind map[string][]hubValue) []hubRelated {
	var out []hubRelated
	for _, other := range hubKinds {
		if other.Key == kind.Key {
			continue
		}
		// Which slugs do these cards touch, and how often.
		count := map[string]int{}
		for _, c := range cards {
			name := strings.TrimSpace(other.Value(c))
			if name == "" {
				continue
			}
			if slug := model.Slugify(name); slug != "" {
				count[slug]++
			}
		}
		if len(count) == 0 {
			continue
		}
		// Resolve slugs against the published values so a cross-link always
		// carries the hub's own canonical spelling — never one of the
		// punctuation variants buildHubValues merged away.
		var links []hubLink
		for _, v := range valuesByKind[other.Key] {
			if n := count[v.Slug]; n > 0 {
				links = append(links, hubLink{Name: v.Name, URL: hubURL(other, v.Slug, 1), Count: n})
			}
		}
		sort.SliceStable(links, func(i, j int) bool {
			if links[i].Count != links[j].Count {
				return links[i].Count > links[j].Count
			}
			return links[i].Name < links[j].Name
		})
		out = append(out, hubRelated{Label: other.Plural, Links: links})
	}
	return out
}

// indexGroups buckets values by first letter for the index page. Anything not
// starting A–Z (a numbered cuvée, a producer written in a non-Latin script)
// collects under "#" so no value is ever silently dropped from the index.
func indexGroups(kind hubKind, values []hubValue) []hubIndexGroup {
	order := []string{}
	byLetter := map[string][]hubLink{}
	for _, v := range values {
		letter := "#"
		if r := []rune(strings.ToUpper(v.Name)); len(r) > 0 && r[0] >= 'A' && r[0] <= 'Z' {
			letter = string(r[0])
		}
		if _, seen := byLetter[letter]; !seen {
			order = append(order, letter)
		}
		byLetter[letter] = append(byLetter[letter], hubLink{
			Name: v.Name, URL: hubURL(kind, v.Slug, 1), Count: len(v.Cards),
		})
	}
	sort.Strings(order) // "#" sorts before "A", which is where it reads best
	groups := make([]hubIndexGroup, 0, len(order))
	for _, l := range order {
		groups = append(groups, hubIndexGroup{Letter: l, Entries: byLetter[l]})
	}
	return groups
}

// hubValuesByKind computes every kind's published values in one pass.
//
// It is computed once and shared, because the hub graph is mutually
// recursive at the data level even though the pages are independent: a
// producer page cross-links regions, a region page cross-links producers, and
// the wine pages link up into all three.
func hubValuesByKind(cards []cardWine) map[string][]hubValue {
	out := map[string][]hubValue{}
	for _, kind := range hubKinds {
		out[kind.Key] = buildHubValues(kind, cards)
	}
	return out
}

// publishedHubs is the set of hub slugs that were actually written, per kind.
//
// It exists because hubs and detail pages count different things. A hub is
// built from CARDS — one per wine, whose region and varietal come from the
// group's best-enriched row — while a detail page is per ROW. So a row can
// carry a region that no card carries, which means no hub was published for
// it. Linking a wine's own field verbatim would put a 404 on the most
// numerous page type on the site; every wine→hub link is resolved through
// this set instead, and simply isn't rendered when the hub does not exist.
type publishedHubs map[string]map[string]bool

func newPublishedHubs(valuesByKind map[string][]hubValue) publishedHubs {
	p := publishedHubs{}
	for key, values := range valuesByKind {
		slugs := make(map[string]bool, len(values))
		for _, v := range values {
			slugs[v.Slug] = true
		}
		p[key] = slugs
	}
	return p
}

// urlFor returns the hub URL for a raw catalog value, or "" when no hub was
// published for it — which the templates read as "show the value as text".
func (p publishedHubs) urlFor(kind hubKind, name string) string {
	slug := model.Slugify(strings.TrimSpace(name))
	if slug == "" || !p[kind.Key][slug] {
		return ""
	}
	return hubURL(kind, slug, 1)
}

// hubKindByKey looks up a kind by its facet key, so callers outside this file
// can ask for "the producer kind" without importing the slice's order.
func hubKindByKey(key string) hubKind {
	for _, k := range hubKinds {
		if k.Key == key {
			return k
		}
	}
	return hubKind{}
}

// renderHubs renders every hub page and index, returning their site-root
// paths for the sitemap — the same contract renderPortfolio has, so the
// sitemap is always a record of what was actually written.
func renderHubs(tmpl *template.Template, distDir string, s *site, valuesByKind map[string][]hubValue) ([]string, error) {
	var paths []string
	for _, kind := range hubKinds {
		values := valuesByKind[kind.Key]

		for _, v := range values {
			related := relatedFor(kind, v.Cards, valuesByKind)
			total := len(v.Cards)
			pageCount := (total + portfolioPageSize - 1) / portfolioPageSize
			if pageCount < 1 {
				pageCount = 1
			}
			for n := 1; n <= pageCount; n++ {
				start := (n - 1) * portfolioPageSize
				end := start + portfolioPageSize
				if end > total {
					end = total
				}

				title := fmt.Sprintf("%s - FineVines", v.Name)
				if n > 1 {
					title = fmt.Sprintf("%s - Page %d of %d - FineVines", v.Name, n, pageCount)
				}
				rel := kind.Segment + "/" + v.Slug
				if n > 1 {
					rel = fmt.Sprintf("%s/%s/page/%d", kind.Segment, v.Slug, n)
				}
				prevURL, nextURL := "", ""
				if n > 1 {
					prevURL = hubURL(kind, v.Slug, n-1)
				}
				if n < pageCount {
					nextURL = hubURL(kind, v.Slug, n+1)
				}

				data := hubPage{
					page: page{
						site:  s,
						Title: title,
						Description: fmt.Sprintf("%s %s from %s in the FineVines portfolio. Browse current availability by vintage, region, and varietal.",
							comma(total), wineWord(total), v.Name),
						Path: hubURL(kind, v.Slug, n),
					},
					Kind:      kind,
					Name:      v.Name,
					Lede:      kind.lede(v.Name, total),
					Total:     total,
					Cards:     v.Cards[start:end],
					PageNum:   n,
					PageCount: pageCount,
					PrevURL:   prevURL,
					NextURL:   nextURL,
					Related:   related,
					IndexURL:  hubIndexURL(kind),
					FilterURL: portfolioFilterURL(kind, v.Name),
				}
				if err := renderPage(tmpl, distDir, rel, "hub", data); err != nil {
					return nil, err
				}
				paths = append(paths, data.Path)
			}
		}

		index := hubIndexPage{
			page: page{
				site:  s,
				Title: kind.Plural + " - FineVines",
				Description: fmt.Sprintf("Every %s in the FineVines portfolio — %s in all, each with the wines currently in stock.",
					strings.ToLower(kind.Singular), fmt.Sprintf("%s", comma(len(values)))),
				Path: hubIndexURL(kind),
			},
			Kind:   kind,
			Groups: indexGroups(kind, values),
			Total:  len(values),
		}
		if err := renderPage(tmpl, distDir, kind.Segment, "hubindex", index); err != nil {
			return nil, err
		}
		paths = append(paths, index.Path)
	}
	return paths, nil
}

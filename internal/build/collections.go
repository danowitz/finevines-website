package build

// Collection pages: /producers/, /regions/, /varietals/, and one page per
// value under each. Named for schema.org's CollectionPage, which is what they
// are — a page whose subject is a set of other pages.
//
// They cut the catalog along the same dimensions the portfolio's facet
// sidebar does, but as standing, indexable URLs rather than a filter state.
// The distinction is worth keeping in the vocabulary: a FACET is a filter on
// the portfolio (facetGroup, facetValue, portfolio.js's FACET_KEYS); a
// COLLECTION is a published page.
//
// Before these existed, the only way to see "every Benjamin Leroux we carry"
// was /portfolio/?producer=Benjamin+Leroux — a query string, applied by
// JavaScript, that search engines will not index as a landing page. So 307
// producers, 106 regions and 106 varietals were URLs the catalog knew about
// and never published, and the site's entire internal link graph was two
// levels deep: portfolio → wine, with nothing joining wines to each other.
//
// A collection is deliberately thin machinery over data that already exists:
// it renders the same cards the portfolio renders (one per wine, vintages
// collapsed), and its editorial value is the cut itself plus the links out to
// neighbouring cuts. Nothing here re-derives what a wine IS.
//
// Country is NOT published. France alone is 1,343 of 1,902 cards — a page
// that is simply the portfolio again — and the values are not normalized
// ("United States" and "USA" are both live), so the pages would compete with
// each other for the same query. It stays a portfolio facet only.

import (
	"fmt"
	"html/template"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/collectioneditorial"
	"github.com/gritautomation/finevines-website/internal/model"
)

// collectionKind is one dimension of the catalog published as its own family
// of collection pages.
type collectionKind struct {
	// Key is the portfolio facet key, which is also the ?query param name the
	// client engine round-trips — so a collection's "filter this live" link
	// and portfolio.js's FACET_KEYS cannot drift apart.
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

var collectionKinds = []collectionKind{
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

// collection is one published facet value and the cards that belong to it.
type collection struct {
	Name  string
	Slug  string
	Cards []cardWine
}

// buildCollections groups cards by one facet's value, keyed by SLUG rather
// than by the raw string.
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
func buildCollections(kind collectionKind, cards []cardWine) []collection {
	type acc struct {
		cards []cardWine
		spelt map[string]int // variant -> how many cards spell it that way
	}
	bySlug := map[string]*acc{}
	for _, c := range cards {
		name := strings.TrimSpace(kind.Value(c))
		if name == "" {
			continue // a wine with no producer/region/varietal joins no collection
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

	out := make([]collection, 0, len(bySlug))
	for slug, a := range bySlug {
		best, bestN := "", -1
		for name, n := range a.spelt {
			if n > bestN || (n == bestN && name < best) {
				best, bestN = name, n
			}
		}
		out = append(out, collection{Name: best, Slug: slug, Cards: a.cards})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Slug < out[j].Slug
	})
	return out
}

// collectionLink is a link to another collection — used both by the index
// pages and by the cross-links that join one cut of the catalog to its
// neighbours.
type collectionLink struct {
	Name  string
	URL   string
	Count int
}

// prominentCollectionLinks selects the largest standing collections for
// contextual links on high-authority pages such as the homepage. Size is the
// honest signal of prominence; alphabetical ties keep output deterministic.
func prominentCollectionLinks(kind collectionKind, values []collection, limit int) []collectionLink {
	if limit <= 0 || len(values) == 0 {
		return nil
	}
	ranked := append([]collection(nil), values...)
	sort.Slice(ranked, func(i, j int) bool {
		if len(ranked[i].Cards) != len(ranked[j].Cards) {
			return len(ranked[i].Cards) > len(ranked[j].Cards)
		}
		if ranked[i].Name != ranked[j].Name {
			return ranked[i].Name < ranked[j].Name
		}
		return ranked[i].Slug < ranked[j].Slug
	})
	if len(ranked) > limit {
		ranked = ranked[:limit]
	}
	links := make([]collectionLink, 0, len(ranked))
	for _, value := range ranked {
		links = append(links, collectionLink{
			Name: value.Name, URL: collectionURL(kind, value.Slug, 1), Count: len(value.Cards),
		})
	}
	return links
}

// collectionRelated is one group of cross-links on a value's page — "Regions",
// "Varietals" — naming the other cuts its wines belong to.
type collectionRelated struct {
	Label string
	Links []collectionLink
}

// collectionPage is one facet value's landing page (or one page of it).
type collectionPage struct {
	page
	Kind  collectionKind
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
	Related []collectionRelated
	// Editorial renders on page one only so pagination never duplicates the
	// article. Every collection gets a catalog-derived view; a validated library
	// entry replaces its prose and can add curated photography.
	Editorial *collectionEditorialView
	Peers     []collectionLink
	// RegionHierarchy and Intersections are published only on page one.
	RegionHierarchy []collectionLink
	Intersections   []collectionLink
	Crumbs          []crumb
	// IndexURL is this kind's own index (/producers/), so a collection is
	// never a dead end even for a visitor who arrived on it cold from search.
	IndexURL string
	// FilterURL is the same cut on the portfolio, where the client engine can
	// refine it further. The static page ranks; the app filters.
	FilterURL string
}

func collectionCrumbs(s *site, kind collectionKind, value collection, pageNum int, published []collection) []crumb {
	crumbs := []crumb{{Name: "Portfolio", URL: "/portfolio/"}, {Name: kind.Plural, URL: collectionIndexURL(kind)}}
	if kind.Key == "region" {
		publishedSlugs := map[string]bool{}
		for _, item := range published {
			publishedSlugs[item.Slug] = true
		}
		trail := s.Taxonomy.RegionTrail(value.Name)
		for _, name := range trail[:max(0, len(trail)-1)] {
			slug := model.Slugify(name)
			if publishedSlugs[slug] {
				crumbs = append(crumbs, crumb{Name: name, URL: collectionURL(kind, slug, 1)})
			}
		}
	}
	crumbs = append(crumbs, crumb{Name: value.Name, URL: collectionURL(kind, value.Slug, pageNum)})
	return crumbs
}

type collectionEditorialImage struct {
	Path      string
	Alt       string
	Caption   string
	Credit    string
	SourceURL string
	License   string
	Href      string
	Curated   bool
}

type collectionEditorialView struct {
	Eyebrow    string
	Heading    string
	Paragraphs []string
	Images     []collectionEditorialImage
	Sources    []collectioneditorial.Source
}

// collectionIndexGroup is one initial-letter block on an index page.
type collectionIndexGroup struct {
	Letter  string
	Entries []collectionLink
}

// collectionIndexPage lists every value of one kind, grouped A–Z. With 307
// producers, an undifferentiated list is unreadable; the letter blocks make
// it scannable and give the page a shape a reader can navigate.
type collectionIndexPage struct {
	page
	Kind   collectionKind
	Groups []collectionIndexGroup
	Total  int
}

// collectionURL is the site-root path for one value's page n. Page 1 is the
// bare /producers/<slug>/ — no /page/1/ variant, which would be a second URL
// for identical content.
func collectionURL(kind collectionKind, slug string, n int) string {
	if n <= 1 {
		return "/" + kind.Segment + "/" + slug + "/"
	}
	return fmt.Sprintf("/%s/%s/page/%d/", kind.Segment, slug, n)
}

// collectionIndexURL is the kind's index path, e.g. /producers/.
func collectionIndexURL(kind collectionKind) string { return "/" + kind.Segment + "/" }

// portfolioFilterURL is the live, refinable view of the same cut. The facet
// key doubles as the query param name (see collectionKind.Key), so this URL is
// exactly what portfolio.js's readState() will parse back into a selection.
func portfolioFilterURL(kind collectionKind, name string) string {
	return "/portfolio/?" + kind.Key + "=" + url.QueryEscape(name)
}

// relatedFor builds the cross-links from one value's cards: for every OTHER
// kind, the values those cards carry, ranked by how many of them do.
//
// This is what turns 519 separate pages into a graph. A visitor (or a
// crawler) landing on a producer can move sideways into its regions and
// varietals, and from there into every other producer working the same
// ground.
func relatedFor(kind collectionKind, cards []cardWine, valuesByKind map[string][]collection) []collectionRelated {
	var out []collectionRelated
	for _, other := range collectionKinds {
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
		// carries the collection's own canonical spelling — never one of the
		// punctuation variants buildCollections merged away.
		var links []collectionLink
		for _, v := range valuesByKind[other.Key] {
			if n := count[v.Slug]; n > 0 {
				links = append(links, collectionLink{Name: v.Name, URL: collectionURL(other, v.Slug, 1), Count: n})
			}
		}
		sort.SliceStable(links, func(i, j int) bool {
			if links[i].Count != links[j].Count {
				return links[i].Count > links[j].Count
			}
			return links[i].Name < links[j].Name
		})
		out = append(out, collectionRelated{Label: other.Plural, Links: links})
	}
	return out
}

func peerCollections(kind collectionKind, current collection, values []collection, pinned []collectioneditorial.Link, limit int) []collectionLink {
	if limit <= 0 {
		return nil
	}
	bySlug := make(map[string]collection, len(values))
	for _, value := range values {
		bySlug[value.Slug] = value
	}
	links := make([]collectionLink, 0, limit)
	seen := map[string]bool{current.Slug: true}
	for _, requested := range pinned {
		if value, ok := bySlug[requested.Slug]; ok && !seen[value.Slug] {
			links = append(links, collectionLink{Name: requested.Label, URL: collectionURL(kind, value.Slug, 1), Count: len(value.Cards)})
			seen[value.Slug] = true
			if len(links) == limit {
				return links
			}
		}
	}

	tokens := collectionTokens(kind, current.Cards)
	type scored struct {
		value   collection
		overlap int
		score   int
	}
	var candidates []scored
	for _, value := range values {
		if seen[value.Slug] {
			continue
		}
		other := collectionTokens(kind, value.Cards)
		overlap := 0
		for token := range tokens {
			if other[token] {
				overlap++
			}
		}
		if overlap == 0 {
			continue
		}
		union := len(tokens) + len(other) - overlap
		candidates = append(candidates, scored{value: value, overlap: overlap, score: overlap * 10000 / union})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		if candidates[i].overlap != candidates[j].overlap {
			return candidates[i].overlap > candidates[j].overlap
		}
		if len(candidates[i].value.Cards) != len(candidates[j].value.Cards) {
			return len(candidates[i].value.Cards) > len(candidates[j].value.Cards)
		}
		return candidates[i].value.Name < candidates[j].value.Name
	})
	for _, candidate := range candidates {
		links = append(links, collectionLink{Name: candidate.value.Name, URL: collectionURL(kind, candidate.value.Slug, 1), Count: len(candidate.value.Cards)})
		if len(links) == limit {
			break
		}
	}
	return links
}

func collectionTokens(kind collectionKind, cards []cardWine) map[string]bool {
	tokens := map[string]bool{}
	for _, card := range cards {
		for _, other := range collectionKinds {
			if other.Key == kind.Key {
				continue
			}
			if slug := model.Slugify(strings.TrimSpace(other.Value(card))); slug != "" {
				tokens[other.Key+"/"+slug] = true
			}
		}
	}
	return tokens
}

func editorialForCollection(kind collectionKind, value collection, related []collectionRelated, entry collectioneditorial.Entry, hasEntry bool, distDir string) *collectionEditorialView {
	view := &collectionEditorialView{
		Eyebrow:    collectionEyebrow(kind),
		Heading:    "Explore " + value.Name + " through the FineVines portfolio",
		Paragraphs: []string{catalogEditorialParagraph(kind, value, related)},
	}
	if hasEntry {
		view.Eyebrow = entry.Eyebrow
		view.Heading = entry.Heading
		view.Paragraphs = entry.Paragraphs
		view.Sources = entry.Sources
		for _, image := range entry.Images {
			view.Images = append(view.Images, collectionEditorialImage{
				Path: image.Path, Alt: image.Alt, Caption: image.Caption, Credit: image.Credit,
				SourceURL: image.SourceURL, License: image.License, Curated: true,
			})
		}
	}
	if len(view.Images) == 0 {
		view.Images = bottleEditorialImages(value.Cards, distDir, 3)
	}
	return view
}

func bottleEditorialImages(cards []cardWine, distDir string, limit int) []collectionEditorialImage {
	seen := map[string]bool{}
	var images []collectionEditorialImage
	for _, card := range cards {
		if card.ImagePath == "" || seen[card.ImagePath] {
			continue
		}
		imageFile := filepath.Join(distDir, filepath.FromSlash(strings.TrimLeft(card.ImagePath, "/")))
		if info, err := os.Stat(imageFile); err != nil || info.IsDir() {
			continue
		}
		seen[card.ImagePath] = true
		caption := strings.TrimSpace(strings.Join([]string{card.Producer, card.Name, card.Vintage}, " "))
		images = append(images, collectionEditorialImage{Path: card.ImagePath, Alt: "Bottle of " + caption, Caption: caption, Href: "/wines/" + card.Slug + "/"})
		if len(images) == limit {
			break
		}
	}
	return images
}

func regionHierarchyLinks(s *site, current collection, regions []collection) []collectionLink {
	published := map[string]collection{}
	for _, region := range regions {
		published[region.Name] = region
	}
	var out []collectionLink
	trail := s.Taxonomy.RegionTrail(current.Name)
	for _, name := range trail[:max(0, len(trail)-1)] {
		if region, ok := published[name]; ok {
			out = append(out, collectionLink{Name: name, URL: collectionURL(collectionKindByKey("region"), region.Slug, 1), Count: len(region.Cards)})
		}
	}
	for _, name := range s.Taxonomy.RegionChildren(current.Name) {
		if region, ok := published[name]; ok {
			out = append(out, collectionLink{Name: name, URL: collectionURL(collectionKindByKey("region"), region.Slug, 1), Count: len(region.Cards)})
		}
	}
	return out
}

func withoutDuplicateLinks(links, claimed []collectionLink) []collectionLink {
	seen := map[string]bool{}
	for _, link := range claimed {
		seen[link.URL] = true
	}
	out := make([]collectionLink, 0, len(links))
	for _, link := range links {
		if !seen[link.URL] {
			out = append(out, link)
		}
	}
	return out
}

func collectionEyebrow(kind collectionKind) string {
	switch kind.Key {
	case "producer":
		return "Meet the Producer"
	case "varietal":
		return "Explore the Varietal"
	default:
		return "Inside the Region"
	}
}

func catalogEditorialParagraph(kind collectionKind, value collection, related []collectionRelated) string {
	links := func(label string, limit int) []string {
		for _, group := range related {
			if group.Label == label {
				var names []string
				for i, link := range group.Links {
					if i == limit {
						break
					}
					names = append(names, link.Name)
				}
				return names
			}
		}
		return nil
	}
	producers, regions, varietals := links("Producers", 4), links("Regions", 4), links("Varietals", 4)
	switch kind.Key {
	case "producer":
		return fmt.Sprintf("The current FineVines selection from %s includes %s across %s. The portfolio spans %s, with each bottle below linked to its vintage and full wine details.", value.Name, countedWines(len(value.Cards)), describedList("region", regions), describedList("varietal", varietals))
	case "varietal":
		return fmt.Sprintf("The FineVines %s selection brings together %s from %s. Producers including %s show how the grape changes with place, vintage, and cellar approach.", value.Name, countedWines(len(value.Cards)), describedList("region", regions), naturalList(producers))
	default:
		return fmt.Sprintf("The FineVines selection from %s currently brings together %s from %s. The bottles below span %s, offering a direct way to explore the region through the producers and wines available now.", value.Name, countedWines(len(value.Cards)), describedList("producer", producers), describedList("varietal", varietals))
	}
}

func countedWines(count int) string {
	return fmt.Sprintf("%d %s", count, wineWord(count))
}

func describedList(singular string, values []string) string {
	if len(values) == 0 {
		return "the current catalog"
	}
	word := singular
	if len(values) != 1 {
		word += "s"
	}
	return word + " including " + naturalList(values)
}

func naturalList(values []string) string {
	switch len(values) {
	case 0:
		return "the current selection"
	case 1:
		return values[0]
	case 2:
		return values[0] + " and " + values[1]
	default:
		return strings.Join(values[:len(values)-1], ", ") + ", and " + values[len(values)-1]
	}
}

// indexGroups buckets values by first letter for the index page. Anything not
// starting A–Z (a numbered cuvée, a producer written in a non-Latin script)
// collects under "#" so no value is ever silently dropped from the index.
func indexGroups(kind collectionKind, values []collection) []collectionIndexGroup {
	order := []string{}
	byLetter := map[string][]collectionLink{}
	for _, v := range values {
		letter := "#"
		if r := []rune(strings.ToUpper(v.Name)); len(r) > 0 && r[0] >= 'A' && r[0] <= 'Z' {
			letter = string(r[0])
		}
		if _, seen := byLetter[letter]; !seen {
			order = append(order, letter)
		}
		byLetter[letter] = append(byLetter[letter], collectionLink{
			Name: v.Name, URL: collectionURL(kind, v.Slug, 1), Count: len(v.Cards),
		})
	}
	sort.Strings(order) // "#" sorts before "A", which is where it reads best
	groups := make([]collectionIndexGroup, 0, len(order))
	for _, l := range order {
		groups = append(groups, collectionIndexGroup{Letter: l, Entries: byLetter[l]})
	}
	return groups
}

// collectionsByKind computes every kind's published values in one pass.
//
// It is computed once and shared, because the collection graph is mutually
// recursive at the data level even though the pages are independent: a
// producer page cross-links regions, a region page cross-links producers, and
// the wine pages link up into all three.
func collectionsByKind(cards []cardWine) map[string][]collection {
	out := map[string][]collection{}
	for _, kind := range collectionKinds {
		out[kind.Key] = buildCollections(kind, cards)
	}
	return out
}

// publishedCollections is the set of collection slugs that were actually
// written, per kind.
//
// It exists because collections and detail pages count different things.
// A collection is built from CARDS — one per wine, whose region and varietal
// come from the group's best-enriched row — while a detail page is per ROW.
// So a row can
// carry a region that no card carries, which means no collection was published for
// it. Linking a wine's own field verbatim would put a 404 on the most
// numerous page type on the site; every wine→collection link is resolved through
// this set instead, and simply isn't rendered when the collection does not exist.
type publishedCollections map[string]map[string]bool

func newPublishedCollections(valuesByKind map[string][]collection) publishedCollections {
	p := publishedCollections{}
	for key, values := range valuesByKind {
		slugs := make(map[string]bool, len(values))
		for _, v := range values {
			slugs[v.Slug] = true
		}
		p[key] = slugs
	}
	return p
}

// urlFor returns the collection URL for a raw catalog value, or "" when no
// collection was published for it — which the templates read as "show the
// value as text".
func (p publishedCollections) urlFor(kind collectionKind, name string) string {
	slug := model.Slugify(strings.TrimSpace(name))
	if slug == "" || !p[kind.Key][slug] {
		return ""
	}
	return collectionURL(kind, slug, 1)
}

// collectionKindByKey looks up a kind by its facet key, so callers outside
// this file can ask for "the producer kind" without importing the slice's
// order.
func collectionKindByKey(key string) collectionKind {
	for _, k := range collectionKinds {
		if k.Key == key {
			return k
		}
	}
	return collectionKind{}
}

// renderCollections renders every collection page and index, returning their
// site-root paths for the sitemap — the same contract renderPortfolio has, so
// the
// sitemap is always a record of what was actually written.
func renderCollections(tmpl *template.Template, distDir string, s *site, valuesByKind map[string][]collection, intersections []intersection) ([]string, error) {
	var paths []string
	for _, kind := range collectionKinds {
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
					prevURL = collectionURL(kind, v.Slug, n-1)
				}
				if n < pageCount {
					nextURL = collectionURL(kind, v.Slug, n+1)
				}

				var editorial *collectionEditorialView
				var peers []collectionLink
				if n == 1 {
					entry, hasEntry := s.Editorials.Lookup(collectioneditorial.Kind(kind.Key), v.Slug)
					editorial = editorialForCollection(kind, v, related, entry, hasEntry, distDir)
					peers = peerCollections(kind, v, values, entry.Related, 6)
				}
				var hierarchy, intersectionLinks []collectionLink
				if n == 1 && kind.Key == "region" {
					hierarchy = regionHierarchyLinks(s, v, valuesByKind["region"])
					peers = withoutDuplicateLinks(peers, hierarchy)
				}
				if n == 1 {
					intersectionLinks = intersectionsForCollection(kind, v, intersections)
				}
				description := fmt.Sprintf("%s %s from %s in the FineVines portfolio. Browse current availability by vintage, region, and varietal.",
					comma(total), wineWord(total), v.Name)
				ogImage := ""
				if editorial != nil && len(editorial.Paragraphs) > 0 {
					description = editorial.Paragraphs[0]
				}
				if editorial != nil && len(editorial.Images) > 0 {
					ogImage = editorial.Images[0].Path
				}

				data := collectionPage{
					page: page{
						site:        s,
						Title:       title,
						Description: description,
						Path:        collectionURL(kind, v.Slug, n),
						OGImage:     ogImage,
					},
					Kind:            kind,
					Name:            v.Name,
					Lede:            kind.lede(v.Name, total),
					Total:           total,
					Cards:           v.Cards[start:end],
					PageNum:         n,
					PageCount:       pageCount,
					PrevURL:         prevURL,
					NextURL:         nextURL,
					Related:         related,
					Editorial:       editorial,
					Peers:           peers,
					RegionHierarchy: hierarchy,
					Intersections:   intersectionLinks,
					Crumbs:          collectionCrumbs(s, kind, v, n, valuesByKind[kind.Key]),
					IndexURL:        collectionIndexURL(kind),
					FilterURL:       portfolioFilterURL(kind, v.Name),
				}
				if err := renderPage(tmpl, distDir, rel, "collection", data); err != nil {
					return nil, err
				}
				paths = append(paths, data.Path)
			}
		}

		index := collectionIndexPage{
			page: page{
				site:  s,
				Title: kind.Plural + " - FineVines",
				Description: fmt.Sprintf("Every %s in the FineVines portfolio — %s in all, each with the wines currently in stock.",
					strings.ToLower(kind.Singular), fmt.Sprintf("%s", comma(len(values)))),
				Path: collectionIndexURL(kind),
			},
			Kind:   kind,
			Groups: indexGroups(kind, values),
			Total:  len(values),
		}
		if err := renderPage(tmpl, distDir, kind.Segment, "collectionindex", index); err != nil {
			return nil, err
		}
		paths = append(paths, index.Path)
	}
	return paths, nil
}

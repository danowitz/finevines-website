// Package build renders data/*.json into a complete static site in dist/.
// It is a pure function of its inputs: no network, no clocks, no randomness —
// the same data must produce a byte-identical dist/ (tested in Task 9).
package build

import (
	"encoding/json"
	"fmt"
	"html/template"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
)

// site is the seam between loadSite (producer) and every page template
// (consumer): the full data set behind one build run. Tasks 6-8 read
// Wines/News/Team from here to add the portfolio, wine-detail, news, and
// about pages without changing this struct's shape.
type site struct {
	Wines   []model.Wine
	News    []model.NewsPost
	Team    []model.TeamMember
	BaseURL string
}

// page is the template data shared by every page: the site's data plus this
// page's own metadata. Embedding *site promotes Wines/News/Team/BaseURL so
// the head/header/footer templates can reach them through a single dot,
// alongside Title/Description/Path for this specific page. Page types that
// need extra data (see homePage below) embed page the same way.
type page struct {
	*site
	Title       string
	Description string
	Path        string // absolute path from the site root, e.g. "/" or "/contact/"
}

// pagePath returns this page's site-root-relative Path. Because every page
// data type (homePage, portfolioPage, winePage, ...) embeds page rather
// than naming it as a field, Go's method promotion gives all of them this
// method for free — so Run can collect the exact path each page was
// rendered with (for the sitemap) straight from the same value that page's
// own <link rel="canonical"> used, instead of re-deriving or hand-listing
// URLs elsewhere.
func (p page) pagePath() string { return p.Path }

// homePage adds the homepage's own derived data (its latest-news digest) on
// top of the shared page contract.
type homePage struct {
	page
	LatestNews []model.NewsPost
}

// winePage carries one wine plus the shared page contract (Title/Description/
// Path/BaseURL) that base.html.tmpl's head/header/footer require. Because it
// embeds page (which embeds *site), the wine template reaches BaseURL as
// .BaseURL and this wine's own fields as .Wine.*.
type winePage struct {
	page
	Wine model.Wine
}

// facetGroup is one filter group in the portfolio sidebar: a facet key and
// its distinct values across the current wine list, sorted for determinism.
// Facet must exactly match one of portfolio.js's `active` map keys
// (producer/varietal/region/vintage/style) — the template emits it as each
// checkbox's data-facet attribute, which is how the JS groups selections.
type facetGroup struct {
	Facet  string
	Label  string
	Values []string
}

// newsPage carries the full news list (already newest-first, from loadSite)
// plus the shared page contract for the news landing page.
type newsPage struct {
	page
	Posts []model.NewsPost
}

// newsPostPage carries one post plus the shared page contract (Title/
// Description/Path/BaseURL) that base.html.tmpl's head/header/footer
// require. Because it embeds page, each post gets its own unique title,
// meta description, and canonical URL — that per-post uniqueness is the
// entire SEO point of the News & Events skill (see the design spec).
type newsPostPage struct {
	page
	Post model.NewsPost
}

// portfolioPage carries the full wine list plus its computed facet groups
// for the portfolio's server-rendered grid and sidebar, alongside the
// shared page contract. The wine list here (and the search-index.json
// written alongside it) is the SEO surface: every wine is real HTML in the
// page, not assembled by JS — portfolio.js only hides/shows what's already
// rendered.
type portfolioPage struct {
	page
	Facets []facetGroup
	Wines  []model.Wine
}

// indexEntry is one row of dist/search-index.json, the compact per-wine
// record portfolio.js fetches to drive client-side filtering. Field names
// are the JS↔Go contract (portfolio.js reads w.producer, w.varietal, etc.
// by these exact lowercase keys) — do not rename without updating both
// sides.
type indexEntry struct {
	Slug     string `json:"slug"`
	Producer string `json:"producer"`
	Name     string `json:"name"`
	Vintage  string `json:"vintage"`
	Varietal string `json:"varietal"`
	Region   string `json:"region"`
	Style    string `json:"style"`
	Img      string `json:"img"`
}

func Run(dataDir, assetsDir, templatesDir, distDir, baseURL string) error {
	s, err := loadSite(dataDir, baseURL)
	if err != nil {
		return err
	}
	tmpl, err := template.New("").Funcs(template.FuncMap{
		"paragraphs": paragraphs,
	}).ParseGlob(filepath.Join(templatesDir, "*.tmpl"))
	if err != nil {
		return err
	}
	if err := copyTree(assetsDir, filepath.Join(distDir, "assets")); err != nil {
		return err
	}

	latestNews := s.News
	if len(latestNews) > 3 {
		latestNews = latestNews[:3]
	}

	pages := []struct {
		rel, tmpl string
		data      any
	}{
		{"", "home", homePage{
			page: page{
				site:  s,
				Title: "Fine Vines — Wholesale Wine & Spirits, Chicagoland",
				Description: "Fine Vines is a licensed wholesale distributor of wine and spirits, pouring " +
					"elegance with a sommelier's touch across Chicagoland's restaurants and retailers.",
				Path: "/",
			},
			LatestNews: latestNews,
		}},
		{"contact", "contact", page{
			site:  s,
			Title: "Contact — Fine Vines",
			Description: "Reach the Fine Vines trade team — wholesale wine and spirits distribution for " +
				"licensed Illinois retailers, restaurants, and hospitality accounts.",
			Path: "/contact/",
		}},
		{"portfolio", "portfolio", portfolioPage{
			page: page{
				site:  s,
				Title: "Portfolio — Fine Vines",
				Description: "Browse the full Fine Vines wholesale portfolio — filter by producer, varietal, " +
					"region, vintage, or style across every wine currently in stock.",
				Path: "/portfolio/",
			},
			Facets: buildFacets(s.Wines),
			Wines:  s.Wines,
		}},
		{"news", "news", newsPage{
			page: page{
				site:        s,
				Title:       "News & Events — Fine Vines",
				Description: "Tastings, allocations, and news from the Fine Vines trade team.",
				Path:        "/news/",
			},
			Posts: s.News,
		}},
		// About does NOT wrap page in a bigger type — .Team is already
		// reachable through the embedded *site, and head/header/footer only
		// need Title/Description/Path, which page supplies directly. Passing
		// a bare *site here would break head/header/footer (see Task 5's
		// page-embedding contract in the doc comment above).
		{"about", "about", page{
			site:  s,
			Title: "About — Fine Vines",
			Description: "A service company, first and last — meet the Fine Vines sales, warehouse, and " +
				"support team.",
			Path: "/about/",
		}},
	}
	// paths collects every rendered page's site-root-relative Path, in
	// render order, so sitemap.xml can be built from what Run actually
	// produced rather than a second, independently-maintained URL list.
	var paths []string
	for _, p := range pages {
		if err := renderPage(tmpl, distDir, p.rel, p.tmpl, p.data); err != nil {
			return err
		}
		if pd, ok := p.data.(pathed); ok {
			paths = append(paths, pd.pagePath())
		}
	}

	if err := writeSearchIndex(distDir, s.Wines); err != nil {
		return err
	}

	for _, w := range s.Wines {
		data := winePage{
			page: page{
				site:        s,
				Title:       fmt.Sprintf("%s %s %s — Fine Vines", w.Producer, w.Name, w.Vintage),
				Description: firstNonEmpty(w.Description, w.Producer+" "+w.Name),
				Path:        "/wines/" + w.Slug + "/",
			},
			Wine: w,
		}
		if err := renderPage(tmpl, distDir, "wines/"+w.Slug, "wine", data); err != nil {
			return err
		}
		paths = append(paths, data.pagePath())
	}

	for _, n := range s.News {
		data := newsPostPage{
			page: page{
				site:        s,
				Title:       n.Title + " — Fine Vines",
				Description: excerpt(n.Body, 160),
				Path:        "/news/" + n.Slug + "/",
			},
			Post: n,
		}
		if err := renderPage(tmpl, distDir, "news/"+n.Slug, "newspost", data); err != nil {
			return err
		}
		paths = append(paths, data.pagePath())
	}

	if err := writeSitemap(distDir, s.BaseURL, paths); err != nil {
		return err
	}
	if err := writeRobots(distDir, s.BaseURL); err != nil {
		return err
	}
	return nil
}

// pathed is implemented by every page data type via page's promoted
// pagePath method (see page.pagePath's doc comment). Used to collect the
// sitemap's URL list from the same values each page rendered with.
type pathed interface{ pagePath() string }

// paragraphs splits a news post's body into paragraphs on blank lines and
// trims each. The news skill writes plain prose separated by "\n\n" — no
// markdown engine (YAGNI); this is the full extent of body formatting.
// Exposed to templates via template.FuncMap in Run.
func paragraphs(body string) []string {
	parts := strings.Split(body, "\n\n")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// excerpt returns a short plain-text summary of a news post's body for its
// meta description: the first paragraph, truncated to maxLen runes at a
// word boundary with a trailing ellipsis if cut.
func excerpt(body string, maxLen int) string {
	first := body
	if paras := paragraphs(body); len(paras) > 0 {
		first = paras[0]
	}
	runes := []rune(first)
	if len(runes) <= maxLen {
		return first
	}
	cut := string(runes[:maxLen])
	if i := strings.LastIndex(cut, " "); i > 0 {
		cut = cut[:i]
	}
	return strings.TrimSpace(cut) + "…"
}

// firstNonEmpty returns s if it is non-empty, else fallback. Used for a
// page's meta description when the wine record itself has none.
func firstNonEmpty(s, fallback string) string {
	if s != "" {
		return s
	}
	return fallback
}

// buildFacets computes, for each portfolio facet, the distinct values
// present across wines — sorted for determinism (build's output must be
// byte-identical for the same input; iterating a map without sorting would
// break that). Order of the returned groups is the sidebar's display order.
func buildFacets(wines []model.Wine) []facetGroup {
	specs := []struct {
		facet, label string
		get          func(model.Wine) string
	}{
		{"producer", "Producer", func(w model.Wine) string { return w.Producer }},
		{"varietal", "Varietal", func(w model.Wine) string { return w.Varietal }},
		{"region", "Region", func(w model.Wine) string { return w.Region }},
		{"vintage", "Vintage", func(w model.Wine) string { return w.Vintage }},
		{"style", "Style", func(w model.Wine) string { return w.Style }},
	}
	groups := make([]facetGroup, len(specs))
	for i, sp := range specs {
		seen := make(map[string]bool)
		var values []string
		for _, w := range wines {
			v := sp.get(w)
			if v == "" || seen[v] {
				continue
			}
			seen[v] = true
			values = append(values, v)
		}
		sort.Strings(values)
		groups[i] = facetGroup{Facet: sp.facet, Label: sp.label, Values: values}
	}
	return groups
}

// writeSearchIndex writes dist/search-index.json, the browser-fetched index
// portfolio.js filters against. Marshaled compact (json.Marshal, not
// MarshalIndent) since it's fetched on every /portfolio/ visit: at catalog
// scale (~5-10k wines) that's roughly 1-2MB, which is acceptable and
// cacheable; if the catalog grows past ~3MB, Bunny's gzip handles it without
// changes here. Entries follow wines' existing order (loadSite's file order,
// not re-sorted) so the index lines up 1:1 with the portfolio grid's
// server-rendered card order.
func writeSearchIndex(distDir string, wines []model.Wine) error {
	entries := make([]indexEntry, len(wines))
	for i, w := range wines {
		entries[i] = indexEntry{
			Slug:     w.Slug,
			Producer: w.Producer,
			Name:     w.Name,
			Vintage:  w.Vintage,
			Varietal: w.Varietal,
			Region:   w.Region,
			Style:    w.Style,
			Img:      "/" + w.ImagePath,
		}
	}
	data, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(distDir, "search-index.json"), data, 0o644)
}

func loadSite(dataDir, baseURL string) (*site, error) {
	wines, err := model.LoadWines(filepath.Join(dataDir, "wines.json"))
	if err != nil {
		return nil, err
	}
	s := &site{Wines: wines, BaseURL: baseURL}
	// team.json is optional until seeded
	if data, err := os.ReadFile(filepath.Join(dataDir, "team.json")); err == nil {
		if err := jsonUnmarshal(data, &s.Team); err != nil {
			return nil, err
		}
	}
	newsDir := filepath.Join(dataDir, "news")
	entries, _ := os.ReadDir(newsDir)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(newsDir, e.Name()))
		if err != nil {
			return nil, err
		}
		var post model.NewsPost
		if err := jsonUnmarshal(data, &post); err != nil {
			return nil, err
		}
		s.News = append(s.News, post)
	}
	sort.Slice(s.News, func(i, j int) bool { return s.News[i].Date > s.News[j].Date }) // newest first
	return s, nil
}

func renderPage(tmpl *template.Template, distDir, rel, name string, data any) error {
	outDir := filepath.Join(distDir, filepath.FromSlash(rel))
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	f, err := os.Create(filepath.Join(outDir, "index.html"))
	if err != nil {
		return err
	}
	defer f.Close()
	return tmpl.ExecuteTemplate(f, name, data)
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

// jsonUnmarshal is a thin wrapper over encoding/json.Unmarshal so error
// messages can carry the source filename in a later task without touching
// every call site.
func jsonUnmarshal(data []byte, v any) error {
	return json.Unmarshal(data, v)
}

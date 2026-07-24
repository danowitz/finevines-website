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

func Run(dataDir, assetsDir, templatesDir, distDir, baseURL string) error {
	s, err := loadSite(dataDir, baseURL)
	if err != nil {
		return err
	}
	tmpl, err := template.ParseGlob(filepath.Join(templatesDir, "*.tmpl"))
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
	}
	for _, p := range pages {
		if err := renderPage(tmpl, distDir, p.rel, p.tmpl, p.data); err != nil {
			return err
		}
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
	}
	return nil
}

// firstNonEmpty returns s if it is non-empty, else fallback. Used for a
// page's meta description when the wine record itself has none.
func firstNonEmpty(s, fallback string) string {
	if s != "" {
		return s
	}
	return fallback
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

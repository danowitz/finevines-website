package build

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"sort"
)

// sitemapURLSet and sitemapURL model the minimal subset of the sitemap
// protocol (https://www.sitemaps.org/protocol.html) Run emits: one <loc>
// per page. Deliberately no <lastmod> — a "when was this built" timestamp
// would make dist/ different on every run, breaking the byte-identical
// build guarantee that TestBuildIsDeterministic enforces.
type sitemapURLSet struct {
	XMLName xml.Name     `xml:"urlset"`
	Xmlns   string       `xml:"xmlns,attr"`
	URLs    []sitemapURL `xml:"url"`
}

type sitemapURL struct {
	Loc string `xml:"loc"`
}

// writeSitemap emits dist/sitemap.xml listing every page Run rendered.
// paths are the site-root-relative paths collected in Run (the same Path
// value each page template used for its own <link rel="canonical">) — this
// function does not re-derive the page list, it only formats it, so the
// sitemap can never drift from what was actually built. paths are sorted
// before writing so output is stable regardless of build order (wines/news
// render in file-load order, not URL order).
func writeSitemap(distDir, baseURL string, paths []string) error {
	sorted := append([]string(nil), paths...)
	sort.Strings(sorted)

	set := sitemapURLSet{Xmlns: "http://www.sitemaps.org/schemas/sitemap/0.9"}
	for _, p := range sorted {
		set.URLs = append(set.URLs, sitemapURL{Loc: baseURL + p})
	}

	body, err := xml.MarshalIndent(set, "", "  ")
	if err != nil {
		return err
	}
	out := append([]byte(xml.Header), body...)
	out = append(out, '\n')
	return os.WriteFile(filepath.Join(distDir, "sitemap.xml"), out, 0o644)
}

// writeRobots emits dist/robots.txt: allow every crawler on every path, and
// point them at the sitemap so URLs don't need individual discovery.
func writeRobots(distDir, baseURL string) error {
	content := "User-agent: *\nAllow: /\n\nSitemap: " + baseURL + "/sitemap.xml\n"
	return os.WriteFile(filepath.Join(distDir, "robots.txt"), []byte(content), 0o644)
}

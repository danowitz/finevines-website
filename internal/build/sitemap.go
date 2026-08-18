package build

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"sort"

	"github.com/gritautomation/finevines-website/internal/config"
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

// isProductionHost reports whether baseURL points at the real public
// domain — finevines.com or its www alias — the only host this build should
// ever let search engines index. It fails safe: an unset, malformed, or any
// other host (finevines.biz, the *.b-cdn.net staging zones, localhost,
// whatever) all come back false. writeRobots and every page's noindex meta
// (see site.NoIndex in build.go) derive from this single function, so
// indexability is never a manual pre-launch step — it flips automatically
// the moment `finevines build` runs with FINEVINES_SITE_BASE_URL set to the
// production domain.
//
// Hostname normalisation (lowercased, trailing-dot-stripped) mirrors
// cmd/finevines/main.go's validateClientContentForDeploy host check, so
// "is this production" means the same thing everywhere in the codebase.
func isProductionHost(baseURL string) bool {
	return config.IsProductionSiteURL(baseURL)
}

// writeRobots emits dist/robots.txt. On the production host this allows
// every crawler on every path and points them at the sitemap, exactly as
// before. On any other host — every staging/CDN hostname this build has
// ever been reachable at — it disallows everything, so a pre-launch or
// review build never competes with the real domain in search results.
//
// The Sitemap: directive is deliberately omitted on non-production builds.
// Per the Robots Exclusion Protocol, Sitemap: is independent of
// Allow/Disallow — some crawlers read and follow it even when the whole
// site is disallowed — so publishing it here would still be handing search
// engines a complete URL list for a host we are actively telling them not
// to index. The meta noindex tag (see build.go's site.NoIndex) is what
// actually keeps already-known staging URLs out of the index; robots.txt's
// job here is only to stop NEW crawling, and a sitemap line works against
// that.
func writeRobots(distDir, baseURL string) error {
	var content string
	if isProductionHost(baseURL) {
		content = "User-agent: *\nAllow: /\n\nSitemap: " + baseURL + "/sitemap.xml\n"
	} else {
		content = "User-agent: *\nDisallow: /\n"
	}
	return os.WriteFile(filepath.Join(distDir, "robots.txt"), []byte(content), 0o644)
}

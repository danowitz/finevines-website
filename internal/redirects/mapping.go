package redirects

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
)

// minHeuristicSegmentLen guards the best-effort wine/news slug match
// (matchBySlug) against degenerate short segments — an old path whose last
// segment slugifies to "" or a couple of characters (an index page, a
// numeric ID) would trivially substring-match almost every slug in the
// catalog via strings.Contains and produce a nonsense redirect.
const minHeuristicSegmentLen = 4

// MapURLs maps every old-site path to its new-site URL, trying four tiers
// in order (highest precedence first) and taking the first hit:
//
//  1. overrides — the manual redirect-overrides.json list. Always wins;
//     this is how a human corrects or short-circuits anything the
//     automatic tiers below get wrong.
//  2. well-known root pages ("/", "/about*", "/contact*") — these pages
//     have no meaningful sub-resources on the new site, so a plain prefix
//     match is safe and unambiguous.
//  3. best-effort wine/news matching (matchBySlug) — the slugified last
//     path segment is tested for substring containment (either direction)
//     against every wine slug, then every news slug; a hit redirects
//     straight to that item's new page. This is explicitly a "reasonable
//     heuristic" (task 19 brief), not an exact match — a miss just falls
//     through rather than failing.
//  4. the /portfolio*, /products*, /wines* prefixes as a landing
//     fallback — anything under those old paths tier 3 could NOT pin to a
//     specific wine (a discontinued SKU, a category or listing page)
//     still lands somewhere useful instead of unmatched.
//
// Tier 4 deliberately runs AFTER tier 3, not before, even though the brief
// lists the well-known-pages tier and the products/portfolio/wines prefix
// rule together: a concrete old URL like
// "/products/hubert-lamy-saint-aubin.html" must resolve to that wine's own
// page, not the generic portfolio landing page, and the brief itself calls
// the prefix rule "a landing fallback" — i.e. last resort, not first
// match.
//
// Anything matching none of the tiers lands in unmatched, in the order it
// appeared in oldPaths.
func MapURLs(oldPaths []string, wines []model.Wine, news []model.NewsPost, overrides map[string]string) (mapped map[string]string, unmatched []string) {
	mapped = map[string]string{}

	for _, old := range oldPaths {
		if newURL, ok := overrides[old]; ok {
			mapped[old] = newURL
			continue
		}
		if newURL, ok := matchWellKnownRoot(old); ok {
			mapped[old] = newURL
			continue
		}
		if newURL, ok := matchBySlug(old, wines, news); ok {
			mapped[old] = newURL
			continue
		}
		if newURL, ok := matchLandingFallback(old); ok {
			mapped[old] = newURL
			continue
		}
		unmatched = append(unmatched, old)
	}

	return mapped, unmatched
}

// matchWellKnownRoot handles the pages whose new-site location never
// depends on anything beyond the path prefix itself.
func matchWellKnownRoot(oldPath string) (string, bool) {
	p := strings.ToLower(withoutQuery(oldPath))
	switch {
	case p == "/":
		return "/", true
	case strings.HasPrefix(p, "/about"):
		return "/about/", true
	case strings.HasPrefix(p, "/contact"):
		return "/contact/", true
	default:
		return "", false
	}
}

// matchLandingFallback is the last-resort tier for the wine/product/
// portfolio family of old paths: anything here that matchBySlug didn't
// already resolve to a specific wine/news page.
func matchLandingFallback(oldPath string) (string, bool) {
	p := strings.ToLower(withoutQuery(oldPath))
	if strings.HasPrefix(p, "/portfolio") || strings.HasPrefix(p, "/products") || strings.HasPrefix(p, "/wines") {
		return "/portfolio/", true
	}
	return "", false
}

// matchBySlug is the best-effort heuristic: slugify the old path's last
// segment and test it for substring containment (either direction) against
// every wine slug, then every news slug.
func matchBySlug(oldPath string, wines []model.Wine, news []model.NewsPost) (string, bool) {
	seg := lastSegmentSlug(oldPath)
	if len(seg) < minHeuristicSegmentLen {
		return "", false
	}
	for _, w := range wines {
		if w.Slug == "" {
			continue
		}
		if strings.Contains(w.Slug, seg) || strings.Contains(seg, w.Slug) {
			return "/wines/" + w.Slug + "/", true
		}
	}
	for _, n := range news {
		if n.Slug == "" {
			continue
		}
		if strings.Contains(n.Slug, seg) || strings.Contains(seg, n.Slug) {
			return "/news/" + n.Slug + "/", true
		}
	}
	return "", false
}

// lastSegmentSlug extracts the final path segment (e.g. "hubert-lamy-
// saint-aubin" out of "/products/hubert-lamy-saint-aubin.html"), strips
// any file extension, and slugifies it with the same rule build/enrich use
// for wine/news slugs (model.Slugify) so the comparison in matchBySlug is
// apples-to-apples regardless of how the old site capitalized or
// punctuated its URLs.
func lastSegmentSlug(oldPath string) string {
	p := strings.TrimSuffix(withoutQuery(oldPath), "/")
	seg := path.Base(p)
	if seg == "." || seg == "/" {
		return ""
	}
	seg = strings.TrimSuffix(seg, path.Ext(seg))
	return model.Slugify(seg)
}

// withoutQuery strips a "?query" suffix a discovered path may carry
// (Discover keeps query strings because they're distinct redirect
// targets) so prefix/segment matching only ever looks at the path itself.
func withoutQuery(p string) string {
	if i := strings.IndexByte(p, '?'); i >= 0 {
		return p[:i]
	}
	return p
}

// Save writes mapped as pretty-printed JSON to filePath — redirects.json, the
// generated-but-git-tracked old-URL-to-new-URL map (design spec §7).
// encoding/json sorts map[string]string keys when marshaling (documented
// stdlib behavior — see deploy.SaveManifest for the same reliance), so the
// output is naturally sorted and re-runs are git-diffable without any
// extra bookkeeping here.
func Save(filePath string, mapped map[string]string) error {
	data, err := json.MarshalIndent(mapped, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filePath, append(data, '\n'), 0o644)
}

// LoadOverrides reads the manual redirect-overrides.json list (old path ->
// new path) that always wins in MapURLs. A missing file is not an error —
// the repo ships a committed-but-empty {} starter, and a from-scratch
// checkout or a fresh clone before that file exists shouldn't fail —
// LoadOverrides returns an empty, non-nil map instead.
func LoadOverrides(filePath string) (map[string]string, error) {
	data, err := os.ReadFile(filePath)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	m := map[string]string{}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return m, nil
}

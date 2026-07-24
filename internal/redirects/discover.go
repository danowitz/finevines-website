// Package redirects discovers every URL currently live on the old
// finevines.com site (sitemap.xml plus a polite same-host crawl) and maps
// each one to its corresponding URL on the rebuilt site, so launch can 301
// the entire old footprint and Google's existing index of finevines.com
// carries over rather than resetting (design spec §7).
package redirects

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"golang.org/x/net/html"
)

// Crawl politeness limits (task 19 brief / design spec §7). These are vars,
// not consts, so tests can shrink them to exercise the depth/page caps (and
// skip the inter-fetch delay) without waiting on real wall-clock time or
// building a 500-page fixture site; production callers (main.go's
// runRedirects) get these exact defaults.
var (
	crawlMaxDepth = 4
	crawlMaxPages = 500
	crawlDelay    = 200 * time.Millisecond
)

// httpTimeout bounds a single fetch so one hung old-site page can't stall
// discovery forever.
const httpTimeout = 15 * time.Second

// sitemapURLSet / sitemapURLEntry model the minimal subset of the sitemap
// protocol (https://www.sitemaps.org/protocol.html) Discover reads: one
// <loc> per page.
type sitemapURLSet struct {
	XMLName xml.Name          `xml:"urlset"`
	URLs    []sitemapURLEntry `xml:"url"`
}

type sitemapURLEntry struct {
	Loc string `xml:"loc"`
}

// Discover finds every distinct same-host path currently reachable on the
// site at baseURL: it fetches {baseURL}/sitemap.xml if one exists, and
// separately runs a breadth-first crawl starting from "/", following <a
// href> links extracted with golang.org/x/net/html. The two sources are
// merged into one deduplicated, sorted set and returned.
//
// A discovered path includes its query string when the link had one
// (e.g. "/search.html?varietal=chardonnay") — a page reached only via a
// particular query string is still a distinct redirect target, and that
// count matters for the Task 20 gate (≤20 total → Bunny Edge Rules, more
// → Edge Scripting). Off-host links, mailto:/tel:/javascript: links, and
// pure #fragment references are all excluded — none of them are same-host
// paths a redirect map needs to cover, and fragments in particular never
// even reach the server.
//
// The crawl is bounded (crawlMaxDepth hops from "/", crawlMaxPages fetches
// total) and paced (crawlDelay between fetches) so it doesn't hammer the
// old site. Discovery keeps going past individual failures: a missing or
// unparsable sitemap.xml is logged and skipped (plenty of sites don't have
// one), and a fetch/parse failure on one queued page during the crawl is
// likewise logged and skipped rather than aborting discovery of the rest
// of the site. Discover only returns a non-nil error for something that
// makes the whole call meaningless, such as an unparsable baseURL.
func Discover(ctx context.Context, baseURL string, log func(string, ...any)) ([]string, error) {
	if log == nil {
		log = func(string, ...any) {}
	}
	base, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("redirects: parse base URL %q: %w", baseURL, err)
	}

	client := &http.Client{Timeout: httpTimeout}

	// Real sites commonly 301 their entry host to a canonical one — an
	// apex domain to "www.", or http to https (finevines.com itself does
	// exactly this, redirecting to www.finevines.com). http.Client follows
	// that transparently for any individual fetch, but the same-host
	// checks in fetchSitemap/resolveSameHostPath compare against base.Host
	// literally — left unresolved, every ABSOLUTE link or <loc> pointing
	// at the canonical host (which real pages do constantly once they've
	// moved there) would be misjudged as "off-host" and silently dropped.
	// Resolving once, up front, against wherever baseURL actually redirects
	// to fixes that for both the sitemap and the crawl.
	base = resolveCanonicalBase(ctx, client, base)

	seen := map[string]bool{}

	sitemapPaths, sitemapErr := fetchSitemap(ctx, client, base)
	if sitemapErr != nil {
		log("redirects: sitemap.xml unavailable at %s (%v) — continuing with crawl only", baseURL, sitemapErr)
	}
	for _, p := range sitemapPaths {
		seen[p] = true
	}

	for _, p := range crawl(ctx, client, base, log) {
		seen[p] = true
	}

	paths := make([]string, 0, len(seen))
	for p := range seen {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths, nil
}

// resolveCanonicalBase follows any redirect chain from base+"/" — a common
// pattern being an apex domain 301-redirecting to its "www." subdomain, or
// http to https — and returns the scheme+host that actually serves
// content there. http.Client already follows redirects transparently for
// any one fetch, but the same-host filtering elsewhere in this package
// needs to know the REAL host up front to correctly classify absolute
// links/sitemap entries that point at it. On any failure to resolve
// (network error, etc.) it returns base unchanged: the crawl still
// proceeds, it just risks under-collecting if the entry URL genuinely
// redirects elsewhere.
func resolveCanonicalBase(ctx context.Context, client *http.Client, base *url.URL) *url.URL {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String()+"/", nil)
	if err != nil {
		return base
	}
	resp, err := client.Do(req)
	if err != nil {
		return base
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.Request == nil || resp.Request.URL == nil || resp.Request.URL.Host == "" {
		return base
	}
	canonical := *base
	canonical.Scheme = resp.Request.URL.Scheme
	canonical.Host = resp.Request.URL.Host
	return &canonical
}

// crawlItem is one entry in the BFS queue: a same-host path (possibly with
// a query string) and how many hops it is from "/".
type crawlItem struct {
	path  string
	depth int
}

// crawl runs the breadth-first same-host walk from "/" and returns every
// distinct path it observed — either by fetching a page directly, or by
// finding it linked from a page that WAS fetched. Depth/page caps bound how
// far the walk recurses, not what counts as "observed": a path linked from
// the last page fetched before a cap is hit is still returned even though
// crawl never fetches it itself, exactly like a sitemap entry never gets
// fetched either.
func crawl(ctx context.Context, client *http.Client, base *url.URL, log func(string, ...any)) []string {
	queue := []crawlItem{{"/", 0}}
	enqueued := map[string]bool{"/": true}
	observed := map[string]bool{}
	fetched := 0

	for len(queue) > 0 && fetched < crawlMaxPages {
		select {
		case <-ctx.Done():
			return keysOf(observed)
		default:
		}

		cur := queue[0]
		queue = queue[1:]

		observed[cur.path] = true
		links, err := fetchLinks(ctx, client, base, cur.path)
		fetched++
		if err != nil {
			log("redirects: crawl %s: %v", cur.path, err)
		} else {
			for _, href := range links {
				resolved, ok := resolveSameHostPath(base, cur.path, href)
				if !ok {
					continue
				}
				observed[resolved] = true
				if cur.depth+1 <= crawlMaxDepth && !enqueued[resolved] {
					enqueued[resolved] = true
					queue = append(queue, crawlItem{resolved, cur.depth + 1})
				}
			}
		}

		if len(queue) > 0 && fetched < crawlMaxPages {
			time.Sleep(crawlDelay)
		}
	}

	return keysOf(observed)
}

func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// fetchLinks fetches base+p and extracts every <a href> attribute value
// found on the page. It returns a non-nil error (never panics) on any
// transport/status/parse failure so crawl can log-and-continue past one bad
// page without losing the rest of the walk.
func fetchLinks(ctx context.Context, client *http.Client, base *url.URL, p string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String()+p, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: unexpected status %s", p, resp.Status)
	}

	doc, err := html.Parse(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("%s: parse HTML: %w", p, err)
	}

	var hrefs []string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "a" {
			for _, attr := range n.Attr {
				if attr.Key == "href" {
					hrefs = append(hrefs, attr.Val)
					break
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return hrefs, nil
}

// fetchSitemap fetches base's /sitemap.xml and returns every <loc> entry
// that resolves to the same host as base, as a path (with query string, if
// any). A missing sitemap (any non-200, any transport error) or malformed
// XML is a normal, expected outcome, not a hard failure — Discover logs
// whatever error comes back and moves on.
func fetchSitemap(ctx context.Context, client *http.Client, base *url.URL) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String()+"/sitemap.xml", nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("sitemap.xml: unexpected status %s", resp.Status)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("sitemap.xml: read body: %w", err)
	}

	var set sitemapURLSet
	if err := xml.Unmarshal(data, &set); err != nil {
		return nil, fmt.Errorf("sitemap.xml: parse XML: %w", err)
	}

	var paths []string
	for _, entry := range set.URLs {
		loc, err := url.Parse(strings.TrimSpace(entry.Loc))
		if err != nil {
			continue
		}
		resolved := base.ResolveReference(loc)
		if resolved.Host != base.Host {
			continue
		}
		paths = append(paths, pathWithQuery(resolved))
	}
	return paths, nil
}

// resolveSameHostPath resolves href — as found in an <a href> on the page
// at currentPath — against base, and reports the resulting same-host path
// (query string kept, fragment dropped) plus whether href is one Discover
// should record/follow at all.
//
// href is rejected (ok=false) when it's empty, a pure #fragment reference
// (resolves to the current page itself — fragments never reach the
// server), or resolves to a different host or a non-http(s) scheme.
// mailto:/tel:/javascript: links fall out of the same-host check
// automatically: they have no host component at all, so they can never
// equal base.Host.
func resolveSameHostPath(base *url.URL, currentPath, href string) (string, bool) {
	href = strings.TrimSpace(href)
	if href == "" || strings.HasPrefix(href, "#") {
		return "", false
	}

	parsed, err := url.Parse(href)
	if err != nil {
		return "", false
	}

	current := *base
	current.Path, current.RawQuery = splitPathQuery(currentPath)
	resolved := current.ResolveReference(parsed)

	if resolved.Scheme != "" && resolved.Scheme != "http" && resolved.Scheme != "https" {
		return "", false
	}
	if resolved.Host != base.Host {
		return "", false
	}
	return pathWithQuery(resolved), true
}

// pathWithQuery returns u's path plus, when present, its query string. The
// fragment is always dropped — see resolveSameHostPath's doc comment.
func pathWithQuery(u *url.URL) string {
	p := u.Path
	if p == "" {
		p = "/"
	}
	if u.RawQuery != "" {
		p += "?" + u.RawQuery
	}
	return p
}

// splitPathQuery splits a "path?query" string (the shape Discover's own
// output and internal queue entries use) back into its two parts, for
// re-hydrating a url.URL's Path/RawQuery fields.
func splitPathQuery(p string) (path, query string) {
	if i := strings.IndexByte(p, '?'); i >= 0 {
		return p[:i], p[i+1:]
	}
	return p, ""
}

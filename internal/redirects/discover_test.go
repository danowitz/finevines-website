package redirects

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
)

// TestMain zeroes the inter-fetch politeness delay for the whole suite.
// Nothing in this package tests crawlDelay's actual duration — only that
// the depth/page caps in withCrawlLimits are honored — so paying
// production's real 200ms-per-fetch default here would only slow the
// suite down for no assertion benefit.
func TestMain(m *testing.M) {
	crawlDelay = 0
	m.Run()
}

// withCrawlLimits overrides the package's crawl politeness vars for the
// duration of a test, restoring the previous values on cleanup — lets a
// test exercise the max-depth/max-pages caps deterministically and fast
// instead of building a 500-page fixture site.
func withCrawlLimits(t *testing.T, maxDepth, maxPages int) {
	t.Helper()
	oldDepth, oldPages := crawlMaxDepth, crawlMaxPages
	crawlMaxDepth, crawlMaxPages = maxDepth, maxPages
	t.Cleanup(func() { crawlMaxDepth, crawlMaxPages = oldDepth, oldPages })
}

func sortedStrings(ss []string) []string {
	out := append([]string(nil), ss...)
	sort.Strings(out)
	return out
}

// TestDiscover_SitemapPlusCrawlIgnoresOffHostMailtoTelJavascript is the
// brief's core scenario: a sitemap.xml listing 2 URLs, a homepage linking 2
// more on-host pages plus off-host/mailto/tel/javascript links that must
// all be ignored. Discover must return exactly the 4 distinct on-host
// paths, sorted.
func TestDiscover_SitemapPlusCrawlIgnoresOffHostMailtoTelJavascript(t *testing.T) {
	var srv *httptest.Server
	mux := http.NewServeMux()

	mux.HandleFunc("/sitemap.xml", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml")
		fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>%s/</loc></url>
  <url><loc>%s/about.html</loc></url>
</urlset>`, srv.URL, srv.URL)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `<html><body>
			<a href="/contact.html">Contact</a>
			<a href="/portfolio.html">Portfolio</a>
			<a href="https://off-host.example/elsewhere">Off host</a>
			<a href="mailto:info@finevines.com">Email</a>
			<a href="tel:+13125551234">Call</a>
			<a href="javascript:void(0)">JS</a>
		</body></html>`)
	})
	mux.HandleFunc("/contact.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<html><body>no further links</body></html>`)
	})
	mux.HandleFunc("/portfolio.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<html><body>no further links</body></html>`)
	})

	srv = httptest.NewServer(mux)
	defer srv.Close()

	got, err := Discover(context.Background(), srv.URL, nil)
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}

	want := []string{"/", "/about.html", "/contact.html", "/portfolio.html"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Discover() = %#v, want %#v", got, want)
	}
}

// TestDiscover_SitemapEntriesOffHostAreFiltered proves the sitemap parser
// keeps only same-host <loc> entries, not just the crawl.
func TestDiscover_SitemapEntriesOffHostAreFiltered(t *testing.T) {
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/sitemap.xml", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml")
		fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>%s/</loc></url>
  <url><loc>https://a-different-host.example/somewhere</loc></url>
</urlset>`, srv.URL)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<html><body>no links</body></html>`)
	})

	srv = httptest.NewServer(mux)
	defer srv.Close()

	got, err := Discover(context.Background(), srv.URL, nil)
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}
	for _, p := range got {
		if p == "https://a-different-host.example/somewhere" || p == "/somewhere" {
			t.Errorf("off-host sitemap entry leaked into result: %#v", got)
		}
	}
	want := []string{"/"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Discover() = %#v, want %#v", got, want)
	}
}

// TestDiscover_QueryStringsPreserved proves a linked URL's query string
// survives into the discovered path — it's a distinct redirect target and
// matters for the Task 20 ≤20 gate.
func TestDiscover_QueryStringsPreserved(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `<html><body><a href="/search.html?varietal=chardonnay">Search</a></body></html>`)
	})
	mux.HandleFunc("/search.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<html><body>no further links</body></html>`)
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	got, err := Discover(context.Background(), srv.URL, nil)
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}

	want := "/search.html?varietal=chardonnay"
	found := false
	for _, p := range got {
		if p == want {
			found = true
		}
	}
	if !found {
		t.Errorf("Discover() = %#v, want it to contain %q", got, want)
	}
}

// TestDiscover_FragmentsStrippedFromLinks proves a link with a #fragment
// resolves to its path only — the fragment never reaches the server, so it
// must not appear in the discovered path and must not produce a duplicate
// entry distinct from the plain path.
func TestDiscover_FragmentsStrippedFromLinks(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `<html><body>
			<a href="/team.html#leadership">Leadership</a>
			<a href="#top">Back to top</a>
		</body></html>`)
	})
	mux.HandleFunc("/team.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<html><body>no further links</body></html>`)
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	got, err := Discover(context.Background(), srv.URL, nil)
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}

	want := []string{"/", "/team.html"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Discover() = %#v, want %#v", got, want)
	}
	for _, p := range got {
		if contains := (func() bool {
			for _, c := range p {
				if c == '#' {
					return true
				}
			}
			return false
		})(); contains {
			t.Errorf("discovered path retained a fragment: %q", p)
		}
	}
}

// TestDiscover_SkipsCdnCgiArtifacts proves an href pointing at Cloudflare's
// "/cdn-cgi/" email-obfuscation artifact (found linked on the live
// finevines.com homepage as "/cdn-cgi/l/email-protection"; it 404s and is
// never real content) is neither enqueued for the crawl nor collected in
// the result, while an ordinary same-host link on the same page still is.
func TestDiscover_SkipsCdnCgiArtifacts(t *testing.T) {
	var fetchedCdnCgi bool
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `<html><body>
			<a href="/cdn-cgi/l/email-protection">Email</a>
			<a href="/contact.html">Contact</a>
		</body></html>`)
	})
	mux.HandleFunc("/cdn-cgi/l/email-protection", func(w http.ResponseWriter, r *http.Request) {
		fetchedCdnCgi = true
		http.NotFound(w, r)
	})
	mux.HandleFunc("/contact.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<html><body>no further links</body></html>`)
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	got, err := Discover(context.Background(), srv.URL, nil)
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}

	want := []string{"/", "/contact.html"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Discover() = %#v, want %#v", got, want)
	}
	for _, p := range got {
		if strings.HasPrefix(strings.ToLower(p), "/cdn-cgi/") {
			t.Errorf("Discover() = %#v, should not contain a /cdn-cgi/ path", got)
		}
	}
	if fetchedCdnCgi {
		t.Errorf("Discover fetched the /cdn-cgi/ artifact — it should have been skipped before enqueueing, never fetched")
	}
}

// TestDiscover_MissingSitemapIsNotFatal proves a 404 sitemap.xml (common —
// plenty of sites don't have one) doesn't fail Discover; the crawl half
// still runs and returns its results.
func TestDiscover_MissingSitemapIsNotFatal(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `<html><body><a href="/contact.html">Contact</a></body></html>`)
	})
	mux.HandleFunc("/contact.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<html><body>no further links</body></html>`)
	})
	// No /sitemap.xml handler registered — ServeMux 404s it.

	srv := httptest.NewServer(mux)
	defer srv.Close()

	var loggedSitemapIssue bool
	logf := func(format string, args ...any) { loggedSitemapIssue = true }

	got, err := Discover(context.Background(), srv.URL, logf)
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}
	want := []string{"/", "/contact.html"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Discover() = %#v, want %#v", got, want)
	}
	if !loggedSitemapIssue {
		t.Errorf("expected Discover to log the missing sitemap via the provided log func")
	}
}

// TestDiscover_RespectsMaxDepth proves the crawl stops following links past
// crawlMaxDepth hops from "/", even though it still RECORDS any path it saw
// linked from the last page it fetched (Discover reports every distinct
// path it observed, it just doesn't recurse indefinitely to find more).
func TestDiscover_RespectsMaxDepth(t *testing.T) {
	withCrawlLimits(t, 2, 500) // depths 0,1,2 get fetched; a depth-3 link is seen but never fetched

	var fetches int32
	mux := http.NewServeMux()
	// Chain: / -> /l0 -> /l1 -> /l2 -> /l3 -> /l4 ...
	for i := 0; i < 6; i++ {
		next := fmt.Sprintf("/l%d", i+1)
		mux.HandleFunc(fmt.Sprintf("/l%d", i), func(next string) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				atomic.AddInt32(&fetches, 1)
				fmt.Fprintf(w, `<html><body><a href="%s">next</a></body></html>`, next)
			}
		}(next))
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		atomic.AddInt32(&fetches, 1)
		fmt.Fprint(w, `<html><body><a href="/l0">next</a></body></html>`)
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	got, err := Discover(context.Background(), srv.URL, nil)
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}

	// Fetched pages: 1 canonicalization probe of "/" (resolveCanonicalBase)
	// + the crawl's own "/" (depth0), /l0 (depth1), /l1 (depth2) = 4
	// fetches total. /l2 is discovered (linked from /l1) but never fetched
	// (would be depth3).
	if got := atomic.LoadInt32(&fetches); got != 4 {
		t.Errorf("server received %d fetches, want exactly 4 (depth cap not honored)", got)
	}

	mustContain := []string{"/", "/l0", "/l1", "/l2"}
	for _, p := range mustContain {
		found := false
		for _, g := range got {
			if g == p {
				found = true
			}
		}
		if !found {
			t.Errorf("Discover() = %#v, want it to contain %q", got, p)
		}
	}
	for _, p := range got {
		if p == "/l3" || p == "/l4" {
			t.Errorf("Discover() = %#v, should not contain %q (beyond depth cap + one)", got, p)
		}
	}
}

// TestDiscover_RespectsMaxPages proves the crawl stops fetching once
// crawlMaxPages fetches have happened, regardless of how many more pages
// remain queued.
func TestDiscover_RespectsMaxPages(t *testing.T) {
	withCrawlLimits(t, 10, 2) // allow deep enough traversal, but cap total fetches at 2

	var fetches int32
	mux := http.NewServeMux()
	for i := 0; i < 6; i++ {
		next := fmt.Sprintf("/p%d", i+1)
		mux.HandleFunc(fmt.Sprintf("/p%d", i), func(next string) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				atomic.AddInt32(&fetches, 1)
				fmt.Fprintf(w, `<html><body><a href="%s">next</a></body></html>`, next)
			}
		}(next))
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		atomic.AddInt32(&fetches, 1)
		fmt.Fprint(w, `<html><body><a href="/p0">next</a></body></html>`)
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	if _, err := Discover(context.Background(), srv.URL, nil); err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}

	// 1 canonicalization probe of "/" (resolveCanonicalBase, not gated by
	// crawlMaxPages — it's outside the crawl loop entirely) + 2 from the
	// capped crawl itself.
	if got := atomic.LoadInt32(&fetches); got != 3 {
		t.Errorf("server received %d fetches, want exactly 3 (max-pages cap not honored)", got)
	}
}

// TestDiscover_CrawlErrorOnOnePageDoesNotAbortTheRest proves a fetch
// failure on one queued page (a 500, say) is logged and skipped rather than
// failing the whole Discover call.
func TestDiscover_CrawlErrorOnOnePageDoesNotAbortTheRest(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `<html><body>
			<a href="/broken.html">Broken</a>
			<a href="/fine.html">Fine</a>
		</body></html>`)
	})
	mux.HandleFunc("/broken.html", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	mux.HandleFunc("/fine.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<html><body>no further links</body></html>`)
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	var logs []string
	logf := func(format string, args ...any) { logs = append(logs, fmt.Sprintf(format, args...)) }

	got, err := Discover(context.Background(), srv.URL, logf)
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}
	want := sortedStrings([]string{"/", "/broken.html", "/fine.html"})
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Discover() = %#v, want %#v", got, want)
	}
	if len(logs) == 0 {
		t.Errorf("expected the /broken.html fetch failure to be logged")
	}
}

// TestDiscover_CanonicalizesEntryHostThatRedirects proves the fix for a
// real-world case found while validating this task against the actual
// finevines.com: an entry host that 301-redirects to a different canonical
// host (finevines.com -> www.finevines.com, in real life) must not cause
// Discover to misjudge ABSOLUTE links pointing at that canonical host as
// off-host. Without resolving the canonical host up front, base.Host would
// stay pinned to the entry server, and a page's absolute self-links
// (which naturally point at wherever the site actually lives) would all be
// wrongly excluded.
func TestDiscover_CanonicalizesEntryHostThatRedirects(t *testing.T) {
	var canonicalSrv *httptest.Server
	canonicalMux := http.NewServeMux()
	canonicalMux.HandleFunc("/contact.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<html><body>no further links</body></html>`)
	})
	canonicalMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		// An absolute self-link, as a real page naturally has once it's
		// the canonical host — this is exactly what must NOT be excluded.
		fmt.Fprintf(w, `<html><body><a href="%s/contact.html">Contact</a></body></html>`, canonicalSrv.URL)
	})
	canonicalSrv = httptest.NewServer(canonicalMux)
	defer canonicalSrv.Close()

	entryMux := http.NewServeMux()
	entryMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, canonicalSrv.URL+"/", http.StatusMovedPermanently)
	})
	entrySrv := httptest.NewServer(entryMux)
	defer entrySrv.Close()

	got, err := Discover(context.Background(), entrySrv.URL, nil)
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}

	want := []string{"/", "/contact.html"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Discover() = %#v, want %#v (the absolute link to the canonical host was likely misjudged off-host)", got, want)
	}
}

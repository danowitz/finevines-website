package deploy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeHome(t *testing.T, dist, canonical string) {
	t.Helper()
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "<!doctype html><html><head><title>x</title>\n"
	if canonical != "" {
		body += `<link rel="canonical" href="` + canonical + `">` + "\n"
	}
	body += "</head><body></body></html>\n"
	if err := os.WriteFile(filepath.Join(dist, "index.html"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestCheckBuiltBaseURL_MatchingHostPasses: the ordinary case — dist/ was
// built with the base URL the deploy is configured for, so the deploy runs.
func TestCheckBuiltBaseURL_MatchingHostPasses(t *testing.T) {
	dist := t.TempDir()
	writeHome(t, dist, "https://finevines.com/")
	if err := CheckBuiltBaseURL(dist, "https://finevines.com"); err != nil {
		t.Errorf("matching base URL must pass, got %v", err)
	}
	// A configured value with a trailing slash is the same base URL.
	if err := CheckBuiltBaseURL(dist, "https://finevines.com/"); err != nil {
		t.Errorf("trailing slash must not matter, got %v", err)
	}
}

// TestCheckBuiltBaseURL_StaleBuildIsRefused is the cutover accident this
// exists to prevent.
//
// The site's own address is compiled into every page at BUILD time — the
// canonical link, og:url, the JSON-LD item URLs, sitemap.xml and robots.txt
// — not served at request time. So switching FINEVINES_SITE_BASE_URL to the
// production domain and deploying WITHOUT rebuilding ships 3,099 pages that
// still name the staging CDN as their canonical home. Google would index the
// staging hostname, Search Console would reject the sitemap as outside the
// property, and every share would resolve off-domain. Nothing about the
// uploaded bytes looks wrong, which is exactly why a machine has to catch it.
func TestCheckBuiltBaseURL_StaleBuildIsRefused(t *testing.T) {
	dist := t.TempDir()
	writeHome(t, dist, "https://finevines-com.b-cdn.net/")

	err := CheckBuiltBaseURL(dist, "https://finevines.com")
	if err == nil {
		t.Fatal("deploying a tree built for another host must be refused")
	}
	// The message has to name both hosts and say what to do — an operator
	// mid-cutover should not have to read this source file to act on it.
	for _, want := range []string{"finevines-com.b-cdn.net", "finevines.com", "finevines build"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error must mention %q, got: %v", want, err)
		}
	}
}

// TestCheckBuiltBaseURL_UnverifiableTreeIsRefused: a dist/ with no home page,
// or a home page carrying no canonical, cannot be checked. It fails closed —
// the whole point is to make the mistake impossible, and "we could not tell"
// is not evidence that the tree is right.
func TestCheckBuiltBaseURL_UnverifiableTreeIsRefused(t *testing.T) {
	empty := t.TempDir()
	if err := CheckBuiltBaseURL(empty, "https://finevines.com"); err == nil {
		t.Error("a dist/ with no index.html must be refused, not assumed correct")
	}

	noCanonical := t.TempDir()
	writeHome(t, noCanonical, "")
	if err := CheckBuiltBaseURL(noCanonical, "https://finevines.com"); err == nil {
		t.Error("a home page with no canonical must be refused")
	}
}

// TestCheckBuiltBaseURL_HostOnlyComparison: only the scheme and host decide.
// The canonical of the home page is the base URL plus "/", and a build could
// reasonably render it with or without the trailing slash; neither is a
// reason to block a deploy.
func TestCheckBuiltBaseURL_HostOnlyComparison(t *testing.T) {
	dist := t.TempDir()
	writeHome(t, dist, "https://finevines.com")
	if err := CheckBuiltBaseURL(dist, "https://finevines.com"); err != nil {
		t.Errorf("canonical without a trailing slash must pass, got %v", err)
	}

	// Scheme is part of the identity: http:// and https:// are different
	// canonical homes and Google treats them as different sites.
	insecure := t.TempDir()
	writeHome(t, insecure, "http://finevines.com/")
	if err := CheckBuiltBaseURL(insecure, "https://finevines.com"); err == nil {
		t.Error("a scheme mismatch must be refused")
	}
}

package deploy

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// canonicalLink pulls the href out of the home page's
// <link rel="canonical" href="…">. Attribute order is fixed by
// base.html.tmpl, so a tolerant-but-simple pattern is enough here — this
// reads one file the build itself wrote moments earlier, not arbitrary HTML
// from the web.
var canonicalLink = regexp.MustCompile(`(?i)<link\s+rel="canonical"\s+href="([^"]+)"`)

// CheckBuiltBaseURL verifies that the tree in distDir was built for
// wantBaseURL, and refuses the deploy if it was not.
//
// The site's own address is compiled in at BUILD time, not served at request
// time: it is the canonical link on all 3,099 pages, og:url, every JSON-LD
// item URL, sitemap.xml's <loc> entries and robots.txt's Sitemap line. So
// pointing FINEVINES_SITE_BASE_URL at the production domain and deploying
// WITHOUT rebuilding ships a site that names the staging CDN as its canonical
// home — Google indexes the wrong hostname, Search Console rejects the
// sitemap as outside the property, and shares resolve off-domain.
//
// Nothing about the uploaded bytes looks wrong when this happens, and the
// site serves perfectly. That is why it is checked mechanically rather than
// left to whoever is running the cutover to remember.
//
// The home page's canonical is the witness: it is the base URL the build
// used, written by the same code path every other URL on the site came from.
// Only scheme and host are compared — http and https are genuinely different
// canonical homes, but a trailing slash is not a difference.
//
// It fails CLOSED. A dist/ with no home page, or a home page with no
// canonical, cannot be verified, and "we could not tell" is not evidence the
// tree is right.
func CheckBuiltBaseURL(distDir, wantBaseURL string) error {
	home := filepath.Join(distDir, "index.html")
	body, err := os.ReadFile(home)
	if err != nil {
		return fmt.Errorf("deploy: cannot verify what %s was built for: %w — run `finevines build` first", home, err)
	}

	m := canonicalLink.FindSubmatch(body)
	if m == nil {
		return fmt.Errorf("deploy: %s carries no <link rel=\"canonical\">, so the base URL it was built for cannot be verified — run `finevines build` first", home)
	}

	builtFor, err := originOf(string(m[1]))
	if err != nil {
		return fmt.Errorf("deploy: %s has an unparseable canonical %q: %w", home, m[1], err)
	}
	want, err := originOf(wantBaseURL)
	if err != nil {
		return fmt.Errorf("deploy: FINEVINES_SITE_BASE_URL %q is not a usable base URL: %w", wantBaseURL, err)
	}

	if builtFor != want {
		return fmt.Errorf(
			"deploy: refusing to publish a stale build.\n"+
				"  dist/ was built for %s\n"+
				"  but FINEVINES_SITE_BASE_URL is %s\n"+
				"The site's address is compiled into every canonical link, og:url, JSON-LD URL,\n"+
				"sitemap entry and robots.txt line — deploying now would tell search engines the\n"+
				"catalog lives at %s. Run `finevines build` and deploy again.",
			builtFor, want, builtFor)
	}
	return nil
}

// originOf reduces a URL to the scheme://host that identifies a site,
// discarding path, query and any trailing slash.
func originOf(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	if u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("missing scheme or host in %q", raw)
	}
	return strings.ToLower(u.Scheme + "://" + u.Host), nil
}

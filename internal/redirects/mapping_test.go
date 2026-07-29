package redirects

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

// fixtureWines/fixtureNews back every MapURLs test — a small, realistic
// slice rather than one wine per test, so each test only asserts what it
// cares about.
func fixtureWines() []model.Wine {
	return []model.Wine{
		{SKU: "AB1234", Slug: "hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021"},
		{SKU: "CD5678", Slug: "chateau-something-cabernet-sauvignon-2019"},
	}
}

func fixtureNews() []model.NewsPost {
	return []model.NewsPost{
		{Slug: "spring-2026-tasting-event"},
	}
}

func TestMapURLs_OverrideWinsOverWellKnownAndHeuristic(t *testing.T) {
	overrides := map[string]string{
		// This path would otherwise well-known-match "/about/" — the
		// override must win anyway.
		"/about-us.html": "/manual-about-target/",
		// This path would otherwise heuristic-match the Hubert Lamy wine —
		// the override must win anyway.
		"/products/hubert-lamy-saint-aubin.html": "/manual-wine-target/",
	}

	mapped, unmatched := MapURLs(
		[]string{"/about-us.html", "/products/hubert-lamy-saint-aubin.html"},
		fixtureWines(), fixtureNews(), overrides,
	)

	want := map[string]string{
		"/about-us.html":                         "/manual-about-target/",
		"/products/hubert-lamy-saint-aubin.html": "/manual-wine-target/",
	}
	if !reflect.DeepEqual(mapped, want) {
		t.Errorf("mapped = %#v, want %#v", mapped, want)
	}
	if len(unmatched) != 0 {
		t.Errorf("unmatched = %#v, want empty", unmatched)
	}
}

// TestMapURLs_IdentityMappingsAreDropped: an old path that maps to itself
// ("/" → "/", "/news/" → "/news/") means the URL is already correct on the
// new site — there is nothing to redirect. Emitting it anyway would make
// the deployed middleware 301 the path to its own Location in an infinite
// loop, taking that page down entirely. Identity pairs are dropped from the
// map, and they are NOT unmatched either (unmatched means "needs a human to
// write an override"; an already-correct URL needs nothing).
func TestMapURLs_IdentityMappingsAreDropped(t *testing.T) {
	oldPaths := []string{"/", "/about/", "/contact/", "/news/", "/portfolio/"}

	mapped, unmatched := MapURLs(oldPaths, fixtureWines(), fixtureNews(), nil)

	if len(mapped) != 0 {
		t.Errorf("mapped = %#v, want empty — every input is already its own new-site URL", mapped)
	}
	if len(unmatched) != 0 {
		t.Errorf("unmatched = %#v, want empty — identity paths are resolved, not unmatched", unmatched)
	}
}

// TestMapURLs_IdentityOverrideIsDropped: the drop applies to the override
// tier too — a hand-written redirect-overrides.json entry pointing a path
// at itself would be just as much of a 301 loop as a heuristic one.
func TestMapURLs_IdentityOverrideIsDropped(t *testing.T) {
	overrides := map[string]string{"/legacy-page.html": "/legacy-page.html"}

	mapped, unmatched := MapURLs([]string{"/legacy-page.html"}, nil, nil, overrides)

	if _, ok := mapped["/legacy-page.html"]; ok {
		t.Errorf("mapped = %#v — an identity override must not produce a self-redirect", mapped)
	}
	if len(unmatched) != 0 {
		t.Errorf("unmatched = %#v, want empty", unmatched)
	}
}

func TestMapURLs_WellKnownRootPages(t *testing.T) {
	cases := []struct {
		old  string
		want string
	}{
		{"/about.html", "/about/"},
		{"/About-Us.html", "/about/"}, // case-insensitive prefix match
		{"/contact", "/contact/"},
		{"/contact.html", "/contact/"},
	}

	var oldPaths []string
	for _, c := range cases {
		oldPaths = append(oldPaths, c.old)
	}

	mapped, unmatched := MapURLs(oldPaths, fixtureWines(), fixtureNews(), nil)

	for _, c := range cases {
		if got := mapped[c.old]; got != c.want {
			t.Errorf("mapped[%q] = %q, want %q", c.old, got, c.want)
		}
	}
	if len(unmatched) != 0 {
		t.Errorf("unmatched = %#v, want empty", unmatched)
	}
}

// TestMapURLs_NewsWellKnownRoot proves the well-known-root-pages tier
// covers "/news*" the same way it already covers "/about*" and "/contact*"
// (task 19 follow-up: the live finevines.com crawl found "/news" falling
// through to unmatched even though the new site has a "/news/" landing
// page — a lost SEO redirect). fixtureNews' only slug
// ("spring-2026-tasting-event") does not contain "news" as a substring, so
// this also proves the well-known tier wins BEFORE the heuristic ever gets
// a chance to (mis)fire, not merely that it produces the same answer.
func TestMapURLs_NewsWellKnownRoot(t *testing.T) {
	cases := []struct {
		old  string
		want string
	}{
		{"/news", "/news/"},
		{"/news?x=1", "/news/"},
		{"/News.html", "/news/"}, // case-insensitive prefix match
	}

	var oldPaths []string
	for _, c := range cases {
		oldPaths = append(oldPaths, c.old)
	}

	mapped, unmatched := MapURLs(oldPaths, fixtureWines(), fixtureNews(), nil)

	for _, c := range cases {
		if got := mapped[c.old]; got != c.want {
			t.Errorf("mapped[%q] = %q, want %q", c.old, got, c.want)
		}
	}
	if len(unmatched) != 0 {
		t.Errorf("unmatched = %#v, want empty", unmatched)
	}
}

// TestMapURLs_WineHeuristicMatchesBySlugSubstring is the brief's named
// scenario: a `/products/<slug-ish-name>.html` old URL maps to the wine
// whose slug contains that name, even though the old URL doesn't carry the
// wine's full slug (vintage, appellation, etc.).
func TestMapURLs_WineHeuristicMatchesBySlugSubstring(t *testing.T) {
	mapped, unmatched := MapURLs(
		[]string{"/products/hubert-lamy-saint-aubin.html"},
		fixtureWines(), fixtureNews(), nil,
	)

	want := "/wines/hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021/"
	if got := mapped["/products/hubert-lamy-saint-aubin.html"]; got != want {
		t.Errorf("mapped[...] = %q, want %q", got, want)
	}
	if len(unmatched) != 0 {
		t.Errorf("unmatched = %#v, want empty", unmatched)
	}
}

// TestMapURLs_NewsHeuristicMatchesBySlugSubstring exercises matchBySlug's
// news-matching loop directly. It deliberately uses an old path OUTSIDE
// "/news" (e.g. "/press/...") rather than under it: since "/news*" is now a
// well-known-root tier (see TestMapURLs_NewsWellKnownRoot), any
// "/news"-prefixed old URL is intercepted by tier 2 before the heuristic in
// tier 3 ever runs — matching the brief's explicit intent that every old
// "/news/..." URL collapses onto the "/news/" landing rather than a
// specific post. The heuristic itself still applies to a slug-bearing old
// URL living under some OTHER prefix.
func TestMapURLs_NewsHeuristicMatchesBySlugSubstring(t *testing.T) {
	mapped, unmatched := MapURLs(
		[]string{"/press/spring-2026-tasting.html"},
		fixtureWines(), fixtureNews(), nil,
	)

	want := "/news/spring-2026-tasting-event/"
	if got := mapped["/press/spring-2026-tasting.html"]; got != want {
		t.Errorf("mapped[...] = %q, want %q", got, want)
	}
	if len(unmatched) != 0 {
		t.Errorf("unmatched = %#v, want empty", unmatched)
	}
}

// TestMapURLs_ProductPrefixFallsBackToPortfolioWhenNoWineMatches proves the
// /products*|/portfolio*|/wines* "landing fallback" tier only kicks in for
// paths the wine heuristic could NOT resolve to a specific wine — a
// discontinued SKU with no fixture-catalog match still lands on the
// portfolio instead of 404ing.
func TestMapURLs_ProductPrefixFallsBackToPortfolioWhenNoWineMatches(t *testing.T) {
	mapped, unmatched := MapURLs(
		[]string{"/products/discontinued-sku.html", "/portfolio/index.html", "/wines/"},
		fixtureWines(), fixtureNews(), nil,
	)

	for _, old := range []string{"/products/discontinued-sku.html", "/portfolio/index.html", "/wines/"} {
		if got := mapped[old]; got != "/portfolio/" {
			t.Errorf("mapped[%q] = %q, want %q", old, got, "/portfolio/")
		}
	}
	if len(unmatched) != 0 {
		t.Errorf("unmatched = %#v, want empty", unmatched)
	}
}

func TestMapURLs_UnmatchedWhenNothingMatches(t *testing.T) {
	mapped, unmatched := MapURLs(
		[]string{"/random-page"},
		fixtureWines(), fixtureNews(), nil,
	)

	if _, ok := mapped["/random-page"]; ok {
		t.Errorf("mapped unexpectedly contains /random-page: %#v", mapped)
	}
	want := []string{"/random-page"}
	if !reflect.DeepEqual(unmatched, want) {
		t.Errorf("unmatched = %#v, want %#v", unmatched, want)
	}
}

// TestMapURLs_ShortSegmentGuardAvoidsFalsePositive proves the heuristic
// doesn't fire on a degenerate short last segment that would otherwise
// substring-match almost anything (e.g. an empty/very short segment is
// trivially "contained in" every slug).
func TestMapURLs_ShortSegmentGuardAvoidsFalsePositive(t *testing.T) {
	mapped, unmatched := MapURLs(
		[]string{"/x.html"},
		fixtureWines(), fixtureNews(), nil,
	)

	if _, ok := mapped["/x.html"]; ok {
		t.Errorf("mapped unexpectedly matched a short segment: %#v", mapped)
	}
	if len(unmatched) != 1 || unmatched[0] != "/x.html" {
		t.Errorf("unmatched = %#v, want [\"/x.html\"]", unmatched)
	}
}

func TestMapURLs_QueryStringIgnoredForPrefixAndSlugMatching(t *testing.T) {
	mapped, _ := MapURLs(
		[]string{"/about.html?ref=email", "/products/hubert-lamy-saint-aubin.html?src=old-menu"},
		fixtureWines(), fixtureNews(), nil,
	)

	if got := mapped["/about.html?ref=email"]; got != "/about/" {
		t.Errorf("mapped[about?ref] = %q, want /about/", got)
	}
	want := "/wines/hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021/"
	if got := mapped["/products/hubert-lamy-saint-aubin.html?src=old-menu"]; got != want {
		t.Errorf("mapped[wine?src] = %q, want %q", got, want)
	}
}

func TestSave_WritesSortedIndentedJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "redirects.json")

	mapped := map[string]string{
		"/zzz.html":   "/portfolio/",
		"/about.html": "/about/",
		"/mmm.html":   "/portfolio/",
	}

	if err := Save(path, mapped); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading saved file: %v", err)
	}

	var roundTrip map[string]string
	if err := json.Unmarshal(data, &roundTrip); err != nil {
		t.Fatalf("saved file is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(roundTrip, mapped) {
		t.Errorf("round-tripped = %#v, want %#v", roundTrip, mapped)
	}

	// Assert key order in the raw bytes is sorted (git-diffable requirement) —
	// find each key's byte offset and check they're increasing.
	content := string(data)
	keys := []string{"/about.html", "/mmm.html", "/zzz.html"}
	lastIdx := -1
	for _, k := range keys {
		idx := indexOf(content, `"`+k+`"`)
		if idx < 0 {
			t.Fatalf("key %q not found in output:\n%s", k, content)
		}
		if idx < lastIdx {
			t.Errorf("key %q appears out of sorted order in output:\n%s", k, content)
		}
		lastIdx = idx
	}
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

func TestLoadOverrides_MissingFileReturnsEmptyMap(t *testing.T) {
	m, err := LoadOverrides(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if err != nil {
		t.Fatalf("LoadOverrides returned error: %v", err)
	}
	if len(m) != 0 {
		t.Errorf("LoadOverrides() = %#v, want empty map", m)
	}
}

func TestLoadOverrides_ReadsExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "redirect-overrides.json")
	want := map[string]string{"/old.html": "/new/"}
	data, _ := json.Marshal(want)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("writing fixture: %v", err)
	}

	got, err := LoadOverrides(path)
	if err != nil {
		t.Fatalf("LoadOverrides returned error: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("LoadOverrides() = %#v, want %#v", got, want)
	}
}

# Delisting Lifecycle + Slug-Rename Redirects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Out-of-stock wines keep their pages (marked unavailable, hidden from browse/sitemap) instead of 404ing; deliberately-withheld or long-gone wines drop with a 301; slug renames emit 301s — so search equity survives stock churn once the real domain is crawled.

**Architecture:** The enrich pass gains a pure classification step (`Delist`) that decides, for every stored wine missing from the eligible roster, whether it is retained as `unavailable` (fails *only* the stock clause), dropped now (withheld/non-wine/gone from org), or dropped after a 180-day grace period — emitting `/wines/<slug>/ → /portfolio/` redirect entries for drops and `old → new` entries for slug renames. Redirects persist append-only in `data/lifecycle-redirects.json` and are merged into `dist/redirects.json` at build time, where the existing Bunny Edge middleware already serves the map as 301s. Build renders unavailable wines as detail pages with an OutOfStock state but excludes them from the portfolio, facets, search index, sitemap, and hot-sellers.

**Tech Stack:** Go stdlib only (repo rule — no new dependencies). Existing packages: `internal/model`, `internal/enrich`, `internal/build`, `internal/redirects`, Go `text/template` HTML templates.

## Global Constraints

- **Go stdlib only** — this repo has zero third-party Go dependencies; keep it that way.
- **TDD** — every behavior lands red → green; run the named test before and after each implementation step.
- **Concurrent-session hazard:** other Claude sessions may share this checkout. Before EVERY commit: re-check `git branch --show-current` (expect `master`) and commit with explicit pathspecs (`git commit -m "..." -- <files>`), never bare `git commit` after `git add`, so another session's staged files are never swept in.
- **Never run live `enrich`/`deploy` during implementation** — enrich bills OpenAI against the live org (`FINEVINES_SF_MOCK=0` in `.env`). All tasks verify via `go test` only. A final live enrich+build+deploy is a separate, user-approved acceptance step.
- **Line numbers drift** (active repo). Every "Modify" reference below anchors by function name / distinctive string, not line number. Re-locate with the given grep before editing.
- **Semantics to preserve (client-confirmed):** `ready-to-sell = false` wines and non-wine/fee/placeholder rows must NOT get an "unavailable" page — they are removed entirely, exactly as today. Only the transient out-of-stock case earns retention.
- Grace period: **180 days** unavailable → page dropped + redirected. Redirect target for dropped wines: **`/portfolio/`**.

## File Structure

- `internal/model/model.go` — `Wine` gains `Status` + `DelistedAt` (both `omitempty`, so existing JSON round-trips unchanged); new `StatusUnavailable` const.
- `internal/enrich/delist.go` (new) — pure classification: retained-unavailable vs dropped, grace expiry, redirect emission.
- `internal/enrich/delist_test.go` (new)
- `internal/enrich/lifecycle.go` (new) — load/save/merge/collapse of `data/lifecycle-redirects.json`.
- `internal/enrich/lifecycle_test.go` (new)
- `internal/enrich/diff.go` — Keep path clears `Status`/`DelistedAt` (reactivation).
- `internal/enrich/run.go` — wires `Delist` + slug-rename capture + lifecycle persistence into `Run`.
- `internal/build/build.go` — split unavailable wines out of `site.Wines`; render their detail pages sans sitemap entry; merge lifecycle redirects into `dist/redirects.json`.
- `templates/wine.html.tmpl` — unavailable banner + conditional JSON-LD availability.
- `assets/css/site.css` — one rule for the banner.
- `docs/operations.md` — lifecycle documented for the operator.

---

### Task 1: Wine status fields

**Files:**
- Modify: `internal/model/model.go` (the `Wine` struct — grep `Slug string`)
- Test: `internal/model/model_test.go`

**Interfaces:**
- Produces: `model.StatusUnavailable = "unavailable"` (string const), `Wine.Status string`, `Wine.DelistedAt string` (RFC3339). `Status == ""` means active — every existing caller keeps working unchanged.

- [ ] **Step 1: Write the failing test** (append to `internal/model/model_test.go`)

```go
func TestWineStatusRoundTripAndOmitEmpty(t *testing.T) {
	// An active wine must serialize WITHOUT status/delistedAt keys, so the
	// on-disk format of the existing 2,664-wine catalog is unchanged.
	active, err := json.Marshal(Wine{ID: "SF-1", Slug: "a-wine"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(active), "status") || strings.Contains(string(active), "delistedAt") {
		t.Errorf("active wine must omit status fields, got %s", active)
	}

	// An unavailable wine round-trips both fields.
	w := Wine{ID: "SF-2", Status: StatusUnavailable, DelistedAt: "2026-07-29T12:00:00Z"}
	b, _ := json.Marshal(w)
	var got Wine
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusUnavailable || got.DelistedAt != "2026-07-29T12:00:00Z" {
		t.Errorf("round-trip lost status: %+v", got)
	}
}
```

(Add `"strings"` to the test file's imports if absent.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/model/ -run TestWineStatusRoundTrip`
Expected: FAIL — `undefined: StatusUnavailable` / unknown fields.

- [ ] **Step 3: Implement.** In `internal/model/model.go`, directly above `type Wine struct`:

```go
// StatusUnavailable marks a wine retained in the catalog data but currently
// out of stock: its detail page stays published (preserving any search
// ranking) while it is hidden from the portfolio, facets, search index, and
// sitemap. An empty Status means active. Wines withheld on purpose
// (ready-to-sell = false) or gone from the org are never retained — see
// enrich.Delist.
const StatusUnavailable = "unavailable"
```

Inside `Wine`, immediately after the `Slug string` field:

```go
	// Lifecycle. Empty Status = active. DelistedAt is the RFC3339 UTC time
	// the wine was last seen going out of stock; enrich.Delist drops the
	// page entirely once this exceeds the grace period.
	Status     string `json:"status,omitempty"`
	DelistedAt string `json:"delistedAt,omitempty"`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/model/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(model): wine lifecycle status fields" -- internal/model/model.go internal/model/model_test.go
```

---

### Task 2: The Delist classifier

**Files:**
- Create: `internal/enrich/delist.go`
- Test: `internal/enrich/delist_test.go`

**Interfaces:**
- Consumes: `Eligible(stockQty int, sku, producer, name string, readyToSell bool) bool` (internal/enrich/rules.go), `model.StatusUnavailable`, `model.Wine`, `salesforce.WineRaw`.
- Produces: `Delist(existing []model.Wine, roster []salesforce.WineRaw, eligibleIDs map[string]bool, now time.Time) (unavailable []model.Wine, drops map[string]string)`. `drops` maps a site-root path (`/wines/<slug>/`) to its 301 target. `delistGraceDays = 180`.

- [ ] **Step 1: Write the failing tests** — create `internal/enrich/delist_test.go`:

```go
package enrich

import (
	"testing"
	"time"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

var delistNow = time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)

func TestDelist_OutOfStockIsRetainedUnavailable(t *testing.T) {
	// In the roster, would be eligible if it had stock -> retain, stamped.
	raw := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Name: "Alpha Reserve", StockQty: 0, ReadyToSell: true}
	w := model.Wine{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve", StockQty: 14, StockCases: 2.5}

	unavailable, drops := Delist([]model.Wine{w}, []salesforce.WineRaw{raw}, map[string]bool{}, delistNow)

	if len(drops) != 0 {
		t.Errorf("no drops expected, got %v", drops)
	}
	if len(unavailable) != 1 {
		t.Fatalf("want 1 retained wine, got %d", len(unavailable))
	}
	got := unavailable[0]
	if got.Status != model.StatusUnavailable || got.DelistedAt != "2026-07-29T12:00:00Z" {
		t.Errorf("not stamped unavailable: status=%q delistedAt=%q", got.Status, got.DelistedAt)
	}
	if got.StockQty != 0 || got.StockCases != 0 {
		t.Errorf("stock must be zeroed, got qty=%d cases=%v", got.StockQty, got.StockCases)
	}
}

func TestDelist_AlreadyUnavailableKeepsOriginalStamp(t *testing.T) {
	raw := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Name: "Alpha Reserve", ReadyToSell: true}
	w := model.Wine{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve",
		Status: model.StatusUnavailable, DelistedAt: "2026-06-01T00:00:00Z"}

	unavailable, drops := Delist([]model.Wine{w}, []salesforce.WineRaw{raw}, map[string]bool{}, delistNow)

	if len(drops) != 0 || len(unavailable) != 1 {
		t.Fatalf("want 1 retained / 0 drops, got %d / %d", len(unavailable), len(drops))
	}
	if unavailable[0].DelistedAt != "2026-06-01T00:00:00Z" {
		t.Errorf("DelistedAt must not be re-stamped, got %q", unavailable[0].DelistedAt)
	}
}

func TestDelist_GraceExpiryDropsWithRedirect(t *testing.T) {
	raw := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Name: "Alpha Reserve", ReadyToSell: true}
	w := model.Wine{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve",
		Status: model.StatusUnavailable, DelistedAt: "2026-01-01T00:00:00Z"} // 209 days ago

	unavailable, drops := Delist([]model.Wine{w}, []salesforce.WineRaw{raw}, map[string]bool{}, delistNow)

	if len(unavailable) != 0 {
		t.Errorf("expired wine must not be retained: %+v", unavailable)
	}
	if drops["/wines/alpha-reserve/"] != "/portfolio/" {
		t.Errorf("expired wine must redirect to /portfolio/, got %v", drops)
	}
}

func TestDelist_WithheldAndGoneDropImmediately(t *testing.T) {
	// ready-to-sell = false -> deliberate withholding, no unavailable page.
	withheld := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Name: "Alpha Reserve", StockQty: 5, ReadyToSell: false}
	// SF-2 has no roster row at all (deleted from the org).
	existing := []model.Wine{
		{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve"},
		{ID: "SF-2", SKU: "CD5678", Slug: "beta-blanc"},
	}

	unavailable, drops := Delist(existing, []salesforce.WineRaw{withheld}, map[string]bool{}, delistNow)

	if len(unavailable) != 0 {
		t.Errorf("withheld/gone wines must not be retained: %+v", unavailable)
	}
	if drops["/wines/alpha-reserve/"] != "/portfolio/" || drops["/wines/beta-blanc/"] != "/portfolio/" {
		t.Errorf("both must redirect, got %v", drops)
	}
}

func TestDelist_EligibleWinesAreUntouched(t *testing.T) {
	w := model.Wine{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve"}
	unavailable, drops := Delist([]model.Wine{w}, nil, map[string]bool{"SF-1": true}, delistNow)
	if len(unavailable) != 0 || len(drops) != 0 {
		t.Errorf("eligible wine must pass through Delist untouched, got %v / %v", unavailable, drops)
	}
}

func TestDelist_UnparseableStampIsRestamped(t *testing.T) {
	// A corrupt DelistedAt must not crash or silently drop the page — treat
	// the wine as freshly delisted so the grace clock restarts.
	raw := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Name: "Alpha Reserve", ReadyToSell: true}
	w := model.Wine{ID: "SF-1", SKU: "AB1234", Slug: "alpha-reserve",
		Status: model.StatusUnavailable, DelistedAt: "not-a-time"}

	unavailable, _ := Delist([]model.Wine{w}, []salesforce.WineRaw{raw}, map[string]bool{}, delistNow)
	if len(unavailable) != 1 || unavailable[0].DelistedAt != "2026-07-29T12:00:00Z" {
		t.Fatalf("corrupt stamp must be re-stamped to now, got %+v", unavailable)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/enrich/ -run TestDelist`
Expected: FAIL — `undefined: Delist`.

- [ ] **Step 3: Implement** — create `internal/enrich/delist.go`:

```go
package enrich

import (
	"time"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// delistGraceDays is how long an out-of-stock wine keeps its published
// (but hidden) page before it is dropped and 301-redirected. Wholesale
// stock oscillates — most zero-stock wines are reordered within weeks, and
// deleting the page each time would throw away its search ranking. Half a
// year of silence means the vintage is realistically gone.
const delistGraceDays = 180

// delistRedirectTarget is where a dropped wine's URL points. The portfolio
// landing page is the safest generic target: it always exists and carries
// the visitor to the browsable catalog.
const delistRedirectTarget = "/portfolio/"

// Delist classifies every stored wine that is NOT in the eligible roster.
// Three outcomes:
//
//   - retained unavailable: the roster row exists and would be eligible if
//     it had stock (fails ONLY the stock clause). The wine keeps its page —
//     Status/DelistedAt stamped, stock zeroed — and build hides it from
//     browse surfaces. First seen now → stamped now; already stamped →
//     stamp preserved.
//   - dropped after grace: already unavailable for more than delistGraceDays
//     → removed, and its URL added to drops for a 301.
//   - dropped now: everything else (ready-to-sell = false, non-wine row,
//     deleted from the org). Deliberate withholding must not leave even an
//     "unavailable" breadcrumb, so no page survives.
//
// Wines whose ID is in eligibleIDs are skipped entirely — they flow through
// DiffRoster as usual. Delist is pure: no I/O, inputs unmutated.
func Delist(existing []model.Wine, roster []salesforce.WineRaw, eligibleIDs map[string]bool, now time.Time) (unavailable []model.Wine, drops map[string]string) {
	rosterByID := make(map[string]salesforce.WineRaw, len(roster))
	for _, r := range roster {
		rosterByID[r.ID] = r
	}
	drops = make(map[string]string)

	drop := func(w model.Wine) {
		if w.Slug != "" {
			drops["/wines/"+w.Slug+"/"] = delistRedirectTarget
		}
	}

	for _, w := range existing {
		if eligibleIDs[w.ID] {
			continue
		}
		raw, inRoster := rosterByID[w.ID]
		// Would this row be eligible if stock were the only problem?
		stockOnly := inRoster && Eligible(1, raw.SKU, raw.Producer, raw.Name, raw.ReadyToSell)
		if !stockOnly {
			drop(w)
			continue
		}

		if w.Status == model.StatusUnavailable {
			since, err := time.Parse(time.RFC3339, w.DelistedAt)
			if err == nil && now.Sub(since) > delistGraceDays*24*time.Hour {
				drop(w)
				continue
			}
			if err != nil {
				w.DelistedAt = now.Format(time.RFC3339) // corrupt stamp: restart the clock
			}
		} else {
			w.Status = model.StatusUnavailable
			w.DelistedAt = now.Format(time.RFC3339)
		}
		w.StockQty = 0
		w.StockCases = 0
		unavailable = append(unavailable, w)
	}
	return unavailable, drops
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/enrich/ -run TestDelist`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(enrich): Delist classifies out-of-stock retention vs drops" -- internal/enrich/delist.go internal/enrich/delist_test.go
```

---

### Task 3: Lifecycle-redirects persistence

**Files:**
- Create: `internal/enrich/lifecycle.go`
- Test: `internal/enrich/lifecycle_test.go`

**Interfaces:**
- Produces:
  - `LoadLifecycleRedirects(path string) (map[string]string, error)` — missing file → empty map, nil error.
  - `SaveLifecycleRedirects(path string, m map[string]string) error` — sorted-key JSON (Go's `json.Marshal` sorts map keys already; use `json.MarshalIndent` for reviewable diffs).
  - `CollapseRedirects(m map[string]string, liveSlugs map[string]bool) map[string]string` — resolves chains (A→B, B→C ⇒ A→C), removes entries whose SOURCE is a live wine page again (reactivation), removes self-loops.
- Task 4 consumes all three. Task 7 consumes `LoadLifecycleRedirects`.

- [ ] **Step 1: Write the failing tests** — create `internal/enrich/lifecycle_test.go`:

```go
package enrich

import (
	"path/filepath"
	"testing"
)

func TestLifecycleRedirects_RoundTripAndMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lifecycle-redirects.json")

	got, err := LoadLifecycleRedirects(path)
	if err != nil || len(got) != 0 {
		t.Fatalf("missing file must load as empty map, got %v / %v", got, err)
	}

	m := map[string]string{"/wines/old-slug/": "/wines/new-slug/"}
	if err := SaveLifecycleRedirects(path, m); err != nil {
		t.Fatal(err)
	}
	got, err = LoadLifecycleRedirects(path)
	if err != nil || got["/wines/old-slug/"] != "/wines/new-slug/" {
		t.Fatalf("round-trip failed: %v / %v", got, err)
	}
}

func TestCollapseRedirects_ChainsSelfLoopsAndReactivation(t *testing.T) {
	m := map[string]string{
		"/wines/a/": "/wines/b/", // chain head
		"/wines/b/": "/wines/c/", // chain middle
		"/wines/d/": "/wines/d/", // self-loop -> removed
		"/wines/e/": "/portfolio/",
	}
	live := map[string]bool{"b": true} // wine b is back in the catalog

	got := CollapseRedirects(m, live)

	if got["/wines/a/"] != "/wines/c/" {
		t.Errorf("chain a->b->c must collapse to a->c, got %q", got["/wines/a/"])
	}
	if _, ok := got["/wines/b/"]; ok {
		t.Error("reactivated wine b must lose its redirect (its page exists again)")
	}
	if _, ok := got["/wines/d/"]; ok {
		t.Error("self-loop must be removed")
	}
	if got["/wines/e/"] != "/portfolio/" {
		t.Errorf("plain entry must survive, got %q", got["/wines/e/"])
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/enrich/ -run 'TestLifecycleRedirects|TestCollapseRedirects'`
Expected: FAIL — undefined functions.

- [ ] **Step 3: Implement** — create `internal/enrich/lifecycle.go`:

```go
package enrich

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"strings"
)

// Lifecycle redirects are the 301 map the SITE ITSELF generates as wines are
// renamed or delisted, as opposed to the old-finevines.com crawl map built by
// the `redirects` subcommand. They persist append-only in
// data/lifecycle-redirects.json (sibling of wines.json) and are merged into
// dist/redirects.json at build time, which the Bunny Edge middleware already
// serves as 301s.

// LoadLifecycleRedirects reads the map at path. A missing file is a normal
// first run: empty map, nil error.
func LoadLifecycleRedirects(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
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

// SaveLifecycleRedirects writes the map as indented JSON (map keys marshal
// sorted, so the file diffs cleanly in review).
func SaveLifecycleRedirects(path string, m map[string]string) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

// CollapseRedirects normalizes the accumulated map:
//
//   - an entry whose SOURCE is a live wine page again (reactivated slug) is
//     removed — the page exists, redirecting it would shadow real content;
//   - chains are flattened (a→b, b→c ⇒ a→c) so no visitor ever hops twice;
//   - self-loops are removed.
//
// liveSlugs holds bare wine slugs (no /wines/ prefix). The input map is not
// mutated.
func CollapseRedirects(m map[string]string, liveSlugs map[string]bool) map[string]string {
	out := make(map[string]string, len(m))
	for from, to := range m {
		if slug, ok := strings.CutPrefix(from, "/wines/"); ok {
			if liveSlugs[strings.TrimSuffix(slug, "/")] {
				continue // page is back — no redirect
			}
		}
		// Follow the chain, bounded by map size to survive cycles.
		for i := 0; i < len(m); i++ {
			next, ok := m[to]
			if !ok {
				break
			}
			to = next
		}
		if from == to {
			continue // self-loop (possibly after collapsing a cycle)
		}
		out[from] = to
	}
	return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/enrich/ -run 'TestLifecycleRedirects|TestCollapseRedirects'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(enrich): lifecycle-redirects persistence and chain collapse" -- internal/enrich/lifecycle.go internal/enrich/lifecycle_test.go
```

---

### Task 4: Wire the lifecycle into the enrich pass

**Files:**
- Modify: `internal/enrich/diff.go` (the Keep branch of `DiffRoster` — grep `prev.StockQty = raw.StockQty`)
- Modify: `internal/enrich/run.go` (`Run` — grep `diff := DiffRoster(eligible, existing)`, the results loop's `default:` case, the `save :=` closure, and the final `log("enrich: complete`)
- Test: `internal/enrich/diff_test.go`, `internal/enrich/run_test.go`

**Interfaces:**
- Consumes: `Delist`, `LoadLifecycleRedirects`, `SaveLifecycleRedirects`, `CollapseRedirects` (Tasks 2–3), `nowUTC` (existing package var), `buildSnapshot` (existing, unchanged).
- Produces: `Run` now (a) persists unavailable wines into `dataPath` alongside active ones, (b) maintains `<dir-of-dataPath>/lifecycle-redirects.json`. The completion log line becomes: `enrich: complete — enriched %d, kept %d, unavailable %d, delisted %d, dropped %d, label-fallbacks %d`.

- [ ] **Step 1: Failing test — reactivation clears status in DiffRoster.** Append to `internal/enrich/diff_test.go`:

```go
func TestDiffRoster_KeepClearsUnavailableStatus(t *testing.T) {
	// A wine that went unavailable and is now back in the eligible roster
	// must come back ACTIVE: status and stamp cleared, stock refreshed.
	raw := salesforce.WineRaw{ID: "SF-9", SKU: "ZZ9999", StockQty: 6}
	prev := model.Wine{ID: "SF-9", SKU: "ZZ9999", SourceHash: SourceHash(raw),
		Status: model.StatusUnavailable, DelistedAt: "2026-06-01T00:00:00Z"}

	d := DiffRoster([]salesforce.WineRaw{raw}, []model.Wine{prev})

	if len(d.Keep) != 1 {
		t.Fatalf("want 1 kept, got %+v", d)
	}
	if d.Keep[0].Status != "" || d.Keep[0].DelistedAt != "" {
		t.Errorf("reactivated wine must be active again, got status=%q delistedAt=%q",
			d.Keep[0].Status, d.Keep[0].DelistedAt)
	}
	if d.Keep[0].StockQty != 6 {
		t.Errorf("stock not refreshed: %d", d.Keep[0].StockQty)
	}
}
```

- [ ] **Step 2: Run it** — `go test ./internal/enrich/ -run TestDiffRoster_KeepClears` — expected FAIL (status survives).

- [ ] **Step 3: Implement** — in `DiffRoster`'s Keep branch, after `prev.CasePack = raw.CasePack` add:

```go
			// Back in the eligible roster ⇒ active again, whatever its past.
			prev.Status = ""
			prev.DelistedAt = ""
```

- [ ] **Step 4: Run it** — `go test ./internal/enrich/ -run TestDiffRoster` — expected PASS.

- [ ] **Step 5: Failing test — Run retains, drops, and records renames.** Append to `internal/enrich/run_test.go` (it already has `fakeSource`, `fakeTexts`, `fakeImages` helpers — reuse them; read the file's existing `TestRun_FullPipeline` first to copy its setup idioms exactly):

```go
func TestRun_DelistLifecycle(t *testing.T) {
	dir := t.TempDir()
	dataPath := filepath.Join(dir, "wines.json")
	imgDir := filepath.Join(dir, "img")

	// Roster: SF-OOS is out of stock but otherwise fine; SF-HIDE is
	// withheld (ready-to-sell false); SF-RENAME is in stock with a CHANGED
	// name (hash mismatch -> re-enriched -> new slug).
	rawOOS := salesforce.WineRaw{ID: "SF-OOS", SKU: "AA1111", Producer: "Alpha", Name: "Old Vine Red", StockQty: 0, ReadyToSell: true}
	rawHide := salesforce.WineRaw{ID: "SF-HIDE", SKU: "BB2222", Producer: "Beta", Name: "Hidden Cuvee", StockQty: 9, ReadyToSell: false}
	rawRename := salesforce.WineRaw{ID: "SF-REN", SKU: "CC3333", Producer: "Gamma", Name: "New Name Blanc", Vintage: "2021", StockQty: 4, ReadyToSell: true}

	seed := []model.Wine{
		{ID: "SF-OOS", SKU: "AA1111", Slug: "alpha-old-vine-red", SourceHash: SourceHash(rawOOS), Description: "keep me"},
		{ID: "SF-HIDE", SKU: "BB2222", Slug: "beta-hidden-cuvee", SourceHash: "whatever", Description: "hide me"},
		{ID: "SF-REN", SKU: "CC3333", Slug: "gamma-old-name-blanc-2021", SourceHash: "stale", Description: "rename me"},
	}
	if err := model.SaveWines(dataPath, seed); err != nil {
		t.Fatal(err)
	}

	src := &fakeSource{roster: []salesforce.WineRaw{rawOOS, rawHide, rawRename}}
	if err := Run(context.Background(), src, &fakeTexts{}, &fakeImages{}, nil, dataPath, imgDir, t.Logf); err != nil {
		t.Fatalf("Run: %v", err)
	}

	got, err := model.LoadWines(dataPath)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]model.Wine{}
	for _, w := range got {
		byID[w.ID] = w
	}

	// SF-OOS survives as unavailable with its enrichment intact.
	oos, ok := byID["SF-OOS"]
	if !ok || oos.Status != model.StatusUnavailable || oos.Description != "keep me" {
		t.Errorf("SF-OOS must be retained unavailable with text intact, got %+v", oos)
	}
	// SF-HIDE is gone entirely.
	if _, ok := byID["SF-HIDE"]; ok {
		t.Error("withheld SF-HIDE must be dropped from the catalog")
	}

	redirects, err := LoadLifecycleRedirects(filepath.Join(dir, "lifecycle-redirects.json"))
	if err != nil {
		t.Fatal(err)
	}
	if redirects["/wines/beta-hidden-cuvee/"] != "/portfolio/" {
		t.Errorf("dropped wine must gain a portfolio redirect, got %v", redirects)
	}
	// SF-REN was re-enriched under a new slug; the old URL must 301 to it.
	ren := byID["SF-REN"]
	if ren.Slug == "" || ren.Slug == "gamma-old-name-blanc-2021" {
		t.Fatalf("SF-REN should have a new slug, got %q", ren.Slug)
	}
	if redirects["/wines/gamma-old-name-blanc-2021/"] != "/wines/"+ren.Slug+"/" {
		t.Errorf("slug rename must 301 old->new, got %v", redirects)
	}
}
```

- [ ] **Step 6: Run it** — `go test ./internal/enrich/ -run TestRun_DelistLifecycle` — expected FAIL (SF-OOS vanishes; no redirects file).

- [ ] **Step 7: Implement in `Run`.** Four edits, all inside `internal/enrich/run.go`:

(a) After the `eligible` filter loop, build the ID set (the diff call needs `existing` first, so place this right after `existing` is loaded):

```go
	eligibleIDs := make(map[string]bool, len(eligible))
	for _, w := range eligible {
		eligibleIDs[w.ID] = true
	}
```

(b) After `diff := DiffRoster(eligible, existing)` and its log line:

```go
	unavailable, drops := Delist(existing, rawRoster, eligibleIDs, nowUTC())

	redirectsPath := filepath.Join(filepath.Dir(dataPath), "lifecycle-redirects.json")
	lifecycle, err := LoadLifecycleRedirects(redirectsPath)
	if err != nil {
		return fmt.Errorf("enrich: load %s: %w", redirectsPath, err)
	}
	for from, to := range drops {
		lifecycle[from] = to
	}
```

(add `"path/filepath"` to run.go's imports.)

(c) In the results loop's `default:` case, before `enriched = append(...)`:

```go
			// A re-enriched wine whose slug changed leaves a 301 behind so
			// the old URL keeps working (and keeps its search ranking).
			if prev, ok := existingByID[res.raw.ID]; ok && prev.Slug != "" && prev.Slug != res.wine.Slug {
				lifecycle["/wines/"+prev.Slug+"/"] = "/wines/" + res.wine.Slug + "/"
			}
```

(d) The `save` closure appends the retained wines, and after the final save the lifecycle map is collapsed against the final live slugs and written:

```go
	save := func() error {
		snap := buildSnapshot(enriched, diff, existingByID, attempted)
		return model.SaveWines(dataPath, append(snap, unavailable...))
	}
```

…and after the final `if err := save(); err != nil { ... }` block:

```go
	finalWines := append(buildSnapshot(enriched, diff, existingByID, attempted), unavailable...)
	liveSlugs := make(map[string]bool, len(finalWines))
	for _, w := range finalWines {
		liveSlugs[w.Slug] = true
	}
	if err := SaveLifecycleRedirects(redirectsPath, CollapseRedirects(lifecycle, liveSlugs)); err != nil {
		return fmt.Errorf("enrich: save %s: %w", redirectsPath, err)
	}
```

(e) Update the completion log line:

```go
	log("enrich: complete — enriched %d, kept %d, unavailable %d, delisted %d, dropped %d, label-fallbacks %d",
		enrichedCount, len(diff.Keep), len(unavailable), len(drops), droppedCount, labelFallbacks)
```

Note: the results loop runs concurrently with nothing else touching `lifecycle` (the loop body is the single coordinating goroutine), so no mutex is needed — same reasoning as `enriched`.

- [ ] **Step 8: Run the whole package** — `go test ./internal/enrich/` — expected PASS, including all pre-existing `TestRun_*` tests (they assert exact log/snapshot behavior; if `TestRun_FullPipeline` breaks on the changed log format, update ONLY its expected log string, nothing else).

- [ ] **Step 9: Commit**

```bash
git commit -m "feat(enrich): out-of-stock wines are retained unavailable; drops and renames leave 301s" -- internal/enrich/diff.go internal/enrich/diff_test.go internal/enrich/run.go internal/enrich/run_test.go
```

---

### Task 5: Build hides unavailable wines from every browse surface

**Files:**
- Modify: `internal/build/build.go`
- Test: `internal/build/build_test.go`

**Interfaces:**
- Consumes: `model.StatusUnavailable`, `Wine.Status`.
- Produces: the `site` struct (grep `Wines []model.Wine` inside build.go) gains `Delisted []model.Wine`. `site.Wines` remains ACTIVE-only — every existing consumer (portfolio, facets, catalog index, search, sitemap, featured, hot-sellers rendering) is untouched by construction. The wine-detail render loop iterates both lists; `winePage` gains `Unavailable bool`; only active pages join the sitemap.

**Anchors (verify with grep before editing — this file is under active development):**
- Load-time filtering: the comment `Filtering here — once` marks where wines with empty slugs are dropped; split active/delisted at the same spot.
- Detail-page loop: `for _, w := range s.Wines {` containing `renderPage(tmpl, distDir, "wines/"+w.Slug, "wine", data)`.

- [ ] **Step 1: Failing test.** Append to `internal/build/build_test.go`, following the file's existing fixture style (it builds a temp `dataDir` with `wines.json` — copy the setup of the nearest existing `TestRun_*` build test):

```go
func TestBuild_UnavailableWineHasPageButIsHiddenFromBrowse(t *testing.T) {
	// Fixture: one active wine, one unavailable wine.
	wines := []model.Wine{
		{ID: "SF-1", SKU: "AA1111", Producer: "Alpha", Name: "Active Red", Vintage: "2021",
			Slug: "alpha-active-red-2021", Description: "d", ImagePath: "assets/img/wines/a.svg"},
		{ID: "SF-2", SKU: "BB2222", Producer: "Beta", Name: "Gone Blanc", Vintage: "2020",
			Slug: "beta-gone-blanc-2020", Description: "d", ImagePath: "assets/img/wines/b.svg",
			Status: model.StatusUnavailable, DelistedAt: "2026-07-01T00:00:00Z"},
	}
	distDir := buildFixtureSite(t, wines) // reuse/extract the package's existing fixture helper

	// 1. The unavailable wine still gets a page…
	page := readFile(t, filepath.Join(distDir, "wines", "beta-gone-blanc-2020", "index.html"))
	if !strings.Contains(page, "currently unavailable") {
		t.Error("unavailable page must say so")
	}
	if !strings.Contains(page, `"availability": "https://schema.org/OutOfStock"`) {
		t.Error("unavailable page must carry OutOfStock JSON-LD")
	}

	// 2. …but is absent from sitemap, portfolio, and the catalog index.
	sitemap := readFile(t, filepath.Join(distDir, "sitemap.xml"))
	if strings.Contains(sitemap, "beta-gone-blanc-2020") {
		t.Error("unavailable wine must not be in the sitemap")
	}
	if strings.Contains(sitemap, "alpha-active-red-2021") == false {
		t.Error("active wine must still be in the sitemap")
	}
	portfolio := readFile(t, filepath.Join(distDir, "portfolio", "index.html"))
	if strings.Contains(portfolio, "beta-gone-blanc-2020") {
		t.Error("unavailable wine must not appear on the portfolio grid")
	}
	// The compact catalog index feeds client-side search/filters.
	idx := globOne(t, filepath.Join(distDir, "assets", "catalog-index*.json"))
	if strings.Contains(readFile(t, idx), "beta-gone-blanc-2020") {
		t.Error("unavailable wine must not be in the catalog index")
	}
	// 3. Active wine's page asserts InStock unchanged.
	active := readFile(t, filepath.Join(distDir, "wines", "alpha-active-red-2021", "index.html"))
	if !strings.Contains(active, `"availability": "https://schema.org/InStock"`) {
		t.Error("active page must remain InStock")
	}
}
```

`buildFixtureSite`, `readFile`, `globOne`: the package almost certainly has equivalents (its tests already build fixture sites and read dist output — grep `func TestRun` in build_test.go). Reuse the existing helpers verbatim; only add `globOne` (find exactly one file matching a pattern via `filepath.Glob`) if nothing equivalent exists. Adjust the catalog-index filename pattern to whatever `writeCatalogIndex` actually emits (grep `writeCatalogIndex` for the hashed name format).

- [ ] **Step 2: Run it** — `go test ./internal/build/ -run TestBuild_Unavailable` — expected FAIL.

- [ ] **Step 3: Implement in build.go.**

(a) At the load-time filter (`Filtering here — once` comment), split:

```go
	// Unavailable wines keep a published detail page (their search ranking
	// survives the stock-out) but appear on NO browse surface: s.Wines is
	// active-only, so the portfolio, facets, catalog index, search, featured
	// picks, hot-sellers, and sitemap all exclude them by construction.
	var active, delisted []model.Wine
	for _, w := range cleaned { // `cleaned` = whatever the existing filter's output slice is named
		if w.Status == model.StatusUnavailable {
			delisted = append(delisted, w)
			continue
		}
		active = append(active, w)
	}
```

Wire `active` into the field the site struct previously received and add `Delisted: delisted`.

(b) Add `Delisted []model.Wine` to the `site` struct, next to `Wines`.

(c) Add `Unavailable bool` to the `winePage` struct (grep `type winePage`).

(d) Replace the detail-page loop's range so both lists render but only active pages join the sitemap:

```go
	renderWine := func(w model.Wine, unavailable bool) error {
		data := winePage{
			page: page{
				site:        s,
				Title:       fmt.Sprintf("%s %s %s - FineVines", w.Producer, w.Name, w.Vintage),
				Description: firstNonEmpty(w.Description, w.Producer+" "+w.Name),
				Path:        "/wines/" + w.Slug + "/",
			},
			Wine:        w,
			Unavailable: unavailable,
		}
		if isRasterImage(w.ImagePath) {
			data.OGImage = w.ImagePath
		}
		if err := renderPage(tmpl, distDir, "wines/"+w.Slug, "wine", data); err != nil {
			return err
		}
		if !unavailable {
			paths = append(paths, data.pagePath()) // sitemap: active pages only
		}
		return nil
	}
	for _, w := range s.Wines {
		if err := renderWine(w, false); err != nil {
			return err
		}
	}
	for _, w := range s.Delisted {
		if err := renderWine(w, true); err != nil {
			return err
		}
	}
```

- [ ] **Step 4: Template.** In `templates/wine.html.tmpl`:
  - Locate `"availability": "https://schema.org/InStock"` and replace with:

```
"availability": "https://schema.org/{{if .Unavailable}}OutOfStock{{else}}InStock{{end}}"
```

  - Locate the availability/stock line in the visible page body (grep `Avail` in the template; match how the template renders it) and wrap:

```html
{{if .Unavailable}}
<p class="wine-unavailable">This wine is currently unavailable. Contact your FineVines representative about upcoming vintages and allocations.</p>
{{else}}
<!-- existing availability markup stays here, untouched -->
{{end}}
```

  - In `assets/css/site.css`, add one rule alongside the other wine-page styles (match the file's existing custom-property palette — grep `--` variables used by nearby rules):

```css
.wine-unavailable {
  font-style: italic;
  opacity: 0.75;
  border-left: 3px solid currentColor;
  padding-left: 1rem;
}
```

- [ ] **Step 5: Run it** — `go test ./internal/build/` — expected PASS (full package; existing tests must stay green — `s.Wines` semantics did not change for them).

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(build): unavailable wines keep their page, vanish from browse and sitemap" -- internal/build/build.go internal/build/build_test.go templates/wine.html.tmpl assets/css/site.css
```

---

### Task 6: Build merges lifecycle redirects into dist/redirects.json

**Files:**
- Modify: `internal/build/build.go` (the function reading `redirectsJSONName` — grep `redirectsJSONName` for the copy-to-dist function)
- Test: `internal/build/build_test.go`

**Interfaces:**
- Consumes: `enrich.LoadLifecycleRedirects` — **no**: `internal/build` must not import `internal/enrich` (check the import graph first; if build already imports enrich, reuse `LoadLifecycleRedirects`; otherwise inline a local tolerant reader as below — it is 10 lines and avoids a new edge in the dependency graph).
- Produces: `dist/redirects.json` = crawl map ∪ lifecycle map, lifecycle entries winning on key conflicts.

- [ ] **Step 1: Failing test.** Append to `internal/build/build_test.go`:

```go
func TestBuild_MergesLifecycleRedirectsIntoDist(t *testing.T) {
	// Fixture: a crawl-era redirects.json at the repo-root location the build
	// reads, plus data/lifecycle-redirects.json, with one overlapping key.
	// Follow the existing fixture helper's convention for where the build
	// run's working directory / dataDir live.
	crawl := map[string]string{"/old-page.html": "/portfolio/", "/wines/shared/": "/crawl-target/"}
	lifecycle := map[string]string{"/wines/renamed-old/": "/wines/renamed-new/", "/wines/shared/": "/wines/lifecycle-wins/"}
	distDir := buildFixtureSiteWithRedirects(t, crawl, lifecycle) // extend the fixture helper

	var got map[string]string
	if err := json.Unmarshal([]byte(readFile(t, filepath.Join(distDir, "redirects.json"))), &got); err != nil {
		t.Fatal(err)
	}
	if got["/old-page.html"] != "/portfolio/" {
		t.Error("crawl entries must survive the merge")
	}
	if got["/wines/renamed-old/"] != "/wines/renamed-new/" {
		t.Error("lifecycle entries must be merged in")
	}
	if got["/wines/shared/"] != "/wines/lifecycle-wins/" {
		t.Error("on conflict the lifecycle entry must win (it is newer knowledge)")
	}
}
```

- [ ] **Step 2: Run it** — `go test ./internal/build/ -run TestBuild_MergesLifecycle` — expected FAIL.

- [ ] **Step 3: Implement.** In the function that currently copies `redirectsJSONName` into dist (it reads the file, tolerates absence, writes `filepath.Join(distDir, redirectsJSONName)`), replace the verbatim copy with a merge. Keep its missing-file tolerance for BOTH inputs:

```go
	// dist/redirects.json = old-site crawl map ∪ lifecycle map (renames and
	// delistings emitted by enrich). Lifecycle wins on conflict: it is newer
	// knowledge about OUR OWN urls, while the crawl map only speculates
	// about old-site paths. Either file may be absent (first runs).
	merged := map[string]string{}
	for _, src := range []string{redirectsJSONName, filepath.Join(dataDir, "lifecycle-redirects.json")} {
		data, err := os.ReadFile(src)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		m := map[string]string{}
		if err := json.Unmarshal(data, &m); err != nil {
			return fmt.Errorf("parse %s: %w", src, err)
		}
		for k, v := range m {
			merged[k] = v
		}
	}
	if len(merged) == 0 {
		return nil // nothing to publish — same behavior as the old copy on a missing file
	}
	data, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(distDir, redirectsJSONName), append(data, '\n'), 0o644)
```

(`dataDir` must be threaded into this function if it doesn't already receive it — `build.Run` has it as its first parameter.)

- [ ] **Step 4: Middleware sanity check (read-only).** Read `internal/redirects/middleware.ts.tmpl` and confirm the middleware consults the map for every request path (not only origin-404s) and 301s on hit. If it only fires on 404s, that is still correct for our case (dropped pages 404 at origin) — note which in the commit message.

- [ ] **Step 5: Run it** — `go test ./internal/build/` — expected PASS.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(build): dist/redirects.json = crawl map merged with lifecycle 301s" -- internal/build/build.go internal/build/build_test.go
```

---

### Task 7: Operator docs + full verification

**Files:**
- Modify: `docs/operations.md` (append a "Wine lifecycle" section)
- Test: full suite

- [ ] **Step 1: Document.** Append to `docs/operations.md`:

```markdown
## Wine lifecycle: out of stock vs delisted

- **Out of stock** (stock hits 0, everything else fine): the wine's page
  stays published so its search ranking survives, marked "currently
  unavailable", with OutOfStock structured data. It disappears from the
  portfolio, filters, search, and the sitemap. The moment stock returns,
  the next `enrich` reactivates it everywhere automatically.
- **Withheld** (ready-to-sell unchecked in Salesforce) and non-wine rows:
  removed entirely, page 301s to /portfolio/. Unchanged from before.
- **Gone for good**: after 180 days continuously unavailable, the page is
  dropped and 301s to /portfolio/.
- **Renamed wines** (Salesforce name/producer edits that change the URL):
  the old URL 301s to the new one automatically.

The 301 map accumulates in `data/lifecycle-redirects.json` (committed with
the catalog) and ships inside `dist/redirects.json`, which the Bunny Edge
middleware serves. No operator action is ever required.
```

- [ ] **Step 2: Full suite** — `go build ./... ; go test ./...` — expected: every package PASS.

- [ ] **Step 3: Mock-mode end-to-end smoke (no billing).** Temporarily run with `FINEVINES_SF_MOCK=1 go run ./cmd/finevines enrich` is **not** possible without touching `.env` (it is set to 0) — instead set the env var for the single process: PowerShell `$env:FINEVINES_SF_MOCK='1'; go run ./cmd/finevines enrich; Remove-Item Env:FINEVINES_SF_MOCK`. Confirm the run completes, then `git checkout -- data/` to discard the mock-roster catalog before committing anything. (The mock roster differs from live; this smoke only proves wiring, not data.)

- [ ] **Step 4: Commit**

```bash
git commit -m "docs: wine delisting lifecycle for operators" -- docs/operations.md
```

---

## Acceptance (separate, user-approved step — NOT part of implementation)

1. `go run ./cmd/finevines enrich` (live; expect ~0 enrichments — retention/rename logic only reshuffles existing data).
2. Inspect `data/wines.json` diff: newly-retained unavailable wines (if any are currently out of stock in the org) and `data/lifecycle-redirects.json`.
3. `build` + `deploy`; spot-check an unavailable wine's URL (200 + OutOfStock), a dropped URL (301), sitemap absence.

## Self-review notes

- Spec coverage: retention (T2/T4), withheld-removal preserved (T2), grace expiry (T2), reactivation (T4 diff), slug-rename 301s (T4), browse/sitemap exclusion + OutOfStock page (T5), redirect publication (T6), docs (T7). Hot-sellers needs no change: `RankHotSellers` already rejects `OnHandCases < 1`, and retained wines are stock-zeroed (noted, not tasked).
- Types are consistent: `Delist` returns `([]model.Wine, map[string]string)`; lifecycle helpers all use `map[string]string`; `winePage.Unavailable bool` used by template and build.
- Known execution-time unknowns (flagged in-task, deliberately not guessed): exact fixture-helper names in `build_test.go`, the catalog-index filename pattern, the site-struct field wiring names, and the current shape of the redirects-copy function — the file is being actively developed by a concurrent session, so anchors are by grep, and the implementer must re-read those functions first.

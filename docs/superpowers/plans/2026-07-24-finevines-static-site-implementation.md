# FineVines Static Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the confirmed-scope FineVines site: a single Go binary (`finevines.exe`) with `enrich` / `build` / `redirects` / `deploy` subcommands, plus two Claude skills (`finevines-news`, `finevines-team`), culminating in a launched finevines.com.

**Architecture:** One Go module compiled to a single Windows `.exe`. `enrich` reads Salesforce (OAuth client-credentials), roster-diffs against `data/wines.json`, enriches new/changed wines with Claude (text) and Imagen 4 (bottle photo, deterministic SVG label as fallback). `build` is a pure function `data/*.json → dist/`. `deploy` hash-diff-uploads `dist/` to a Bunny.net Storage Zone and purges the Pull Zone. `redirects` crawls the old site and publishes a 301 map (Edge Rules if ≤20 URLs, Edge Scripting middleware otherwise). The Claude skills only write `data/news/*.json` / `data/team.json` — they never touch Salesforce or the enrich pipeline.

**Tech Stack:** Go 1.22+ (windows/amd64 target, developed/tested anywhere), `github.com/anthropics/anthropic-sdk-go`, `golang.org/x/net/html` (crawler only), Go `html/template`, vanilla JS (~5KB) for faceted search, Bunny.net Storage + Pull Zone APIs, Gemini API (Imagen 4), Claude Code skills (markdown, no code).

## Global Constraints

- **Confirmed scope only** (spec §1). Anything in the spec's "Explicitly out of scope" list (knowledge hub, prospecting, email skills, analytics setup, credit-app PDF, Salesforce retirement, e-commerce) is **not built** — flag and stop if a task seems to need it.
- **Web-eligibility rule (verbatim):** a wine is shown when `stockQty > 0 && !strings.HasPrefix(sku, "9")`. Compiled constant in `internal/enrich/rules.go` — **not** runtime config (decision 2026-07-24).
- **Image provider decision (2026-07-24):** Google **Imagen 4 Standard** via the Gemini API is the first integrated provider; the model name is a config value (`FINEVINES_IMAGE_MODEL`), never hardcoded in the pipeline logic.
- **Salesforce auth decision (2026-07-24):** OAuth 2.0 **Client Credentials Flow** via a connected app + integration user. JWT Bearer is the documented fallback if their org edition blocks client credentials.
- **Redirect mechanism decision (2026-07-24):** crawl-gated — Bunny **Edge Rules** if the discovered old-URL map has ≤20 entries (hard platform cap), Bunny **Edge Scripting** middleware otherwise.
- **Images are generated, never scraped.** The label fallback is wine-branded, **never Fine-Vines-branded**. Producer-supplied images (`imageSource: "producer-supplied"`) are never overwritten by `enrich`.
- **Claude API usage:** official Go SDK (`anthropic-sdk-go`), model `claude-opus-4-8`, no `thinking` parameter (defaults off on Opus 4.8; enrichment copy doesn't need it), no `temperature`/`top_p`/`top_k` (rejected with 400 on Opus 4.8).
- **Brand voice:** elegant, editorial, old-world wine trade. Tagline: `Pouring elegance with a sommelier's touch`. About-page copy keeps FineVines' existing voice ("A service company, first and last..."). No corporate-tech phrasing.
- **Real team roster** (seed `data/team.json` with these, no placeholders): George Molitor (Founder & President), Connie Molitor (Operations), Jeff Barbour, Trish Earley, Tim Freehan, Heather Malpass, Richie Ribando, Dan Pilkey, Steven Fladung (all Sales), Barbara Fultz (Office Manager).
- **Secrets** only via environment variables / git-ignored `.env`. Never committed.
- **`build` is deterministic:** same input → byte-identical `dist/` (no timestamps in output).
- **Commits:** one commit per task (or tighter), message style `feat:`/`test:`/`chore:`, each ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

### Documented spec deviations (agreed at plan time — do not "fix" back)

1. **Image formats:** spec §3 says `assets/img/wines/<sku>.webp`. Go's stdlib cannot *encode* WebP. Generated photos are stored as **`.jpg`** (stdlib `image/jpeg`, quality 85, re-encoded from Imagen's PNG); label fallbacks are stored as **`.svg`** (native output, tiny, crisp). `imagePath` carries the real extension, so the data contract is otherwise unchanged. WebP delivery can later come free from Bunny Optimizer without touching this pipeline.
2. **Source interface:** spec §4 sketches `Roster() []RosterEntry; Fetch(id)`. Because the wine fields are small, one paginated SOQL query returns *all* raw fields for the whole catalog in a handful of round trips, and the hash is computed locally. The implemented interface is `Roster(ctx) ([]WineRaw, error)` — 1 + N/2000 requests instead of 1 + N. Swappability for a future QuickBooks-direct source is preserved.
3. **Label generator "port":** spec §5 says port `build.js`'s `label()`/`bottle3d()`. That file no longer exists (see CLAUDE.md — do not search for it). The generator is **re-implemented in Go** using (a) the spec's taxonomy (frames: double/single/oval/deco/minimal; crests: ring/medallion/shield/fleuron/fan) and (b) the rendered inline SVGs inside the surviving `index.html` proposal as the visual reference.

### Client-side action items (request from George / FineVines NOW — they gate Phases D–F and Launch, not Phases A–C)

| # | Item | Gates | Who |
|---|------|-------|-----|
| C1 | Salesforce: admin creates a **connected app** with *Client Credentials Flow* enabled, run-as **integration user** with read access to the product/inventory object; deliver Consumer Key + Secret + My Domain URL. Confirm the object & field API names holding SKU, producer, name, vintage, varietal, region, appellation, style, stock qty (the QuickBooks-synced fields). | Task 11 checkpoint, Task 16 | FineVines SF admin |
| C2 | **Gemini API key** (Google AI Studio) on a billing-enabled account — initial run ≈ $200–400 at Imagen 4 Standard $0.04/image. | Task 14 | FineVines (or GRIT, billed through) |
| C3 | **Anthropic API key** for text enrichment (initial run ≈ $75–150 at Opus 4.8 rates) — separate from the Claude Code subscription Barbara will use for the skills. | Task 13 | FineVines (or GRIT) |
| C4 | **Bunny.net account**: one Storage Zone + one Pull Zone (staging), later a production pair; API key + storage AccessKey. | Tasks 17–20, Launch | GRIT sets up, FineVines pays |
| C5 | **DNS access** for finevines.com (registrar/DNS host login or delegated access). | Launch | FineVines |
| C6 | Current-site inventory aid: any known inbound links / old URLs George wants preserved (marketing emails, printed materials). | Task 19 | FineVines |

---

## Phase A — Foundations

### Task 1: Go module scaffold + subcommand dispatch + config loading

**Files:**
- Create: `go.mod`, `cmd/finevines/main.go`, `internal/config/config.go`, `internal/config/config_test.go`, `.gitignore` (append), `.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.Load() (config.Config, error)` reading env vars with `.env` fallback; `main.go` dispatching `enrich|build|redirects|deploy` to stub `run<Cmd>(cfg) error` functions that later tasks fill in. `config.Config` fields: `SFBaseURL, SFClientID, SFClientSecret, SFAPIVersion, AnthropicAPIKey, GeminiAPIKey, ImageModel, BunnyStorageZone, BunnyStorageKey, BunnyStorageEndpoint, BunnyAPIKey, BunnyPullZoneID, SiteBaseURL string`.

- [ ] **Step 1: Init module and write the failing config test**

```powershell
go mod init github.com/gritautomation/finevines-website
```

`internal/config/config_test.go`:

```go
package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadReadsEnvFile(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	os.WriteFile(envPath, []byte("FINEVINES_SF_BASE_URL=https://finevines.my.salesforce.com\n# comment\nFINEVINES_IMAGE_MODEL=imagen-4.0-generate-001\n"), 0o644)

	cfg, err := Load(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SFBaseURL != "https://finevines.my.salesforce.com" {
		t.Errorf("SFBaseURL = %q", cfg.SFBaseURL)
	}
	if cfg.ImageModel != "imagen-4.0-generate-001" {
		t.Errorf("ImageModel = %q", cfg.ImageModel)
	}
}

func TestEnvVarOverridesEnvFile(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	os.WriteFile(envPath, []byte("FINEVINES_IMAGE_MODEL=from-file\n"), 0o644)
	t.Setenv("FINEVINES_IMAGE_MODEL", "from-env")

	cfg, _ := Load(envPath)
	if cfg.ImageModel != "from-env" {
		t.Errorf("ImageModel = %q, want from-env", cfg.ImageModel)
	}
}

func TestLoadMissingFileIsNotAnError(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "nope.env")); err != nil {
		t.Fatalf("missing .env should be fine (env-vars-only mode): %v", err)
	}
}
```

- [ ] **Step 2: Run to verify failure** — `go test ./internal/config/` → FAIL (`Load` undefined).

- [ ] **Step 3: Implement `internal/config/config.go`**

```go
// Package config loads finevines settings from environment variables with an
// optional git-ignored .env file as fallback. Real env vars always win.
package config

import (
	"bufio"
	"os"
	"strings"
)

type Config struct {
	SFBaseURL, SFClientID, SFClientSecret, SFAPIVersion string
	AnthropicAPIKey                                     string
	GeminiAPIKey, ImageModel                            string
	BunnyStorageZone, BunnyStorageKey                   string
	BunnyStorageEndpoint                                string // e.g. https://ny.storage.bunnycdn.com
	BunnyAPIKey, BunnyPullZoneID                        string
	SiteBaseURL                                         string // e.g. https://finevines.com
}

func Load(envPath string) (Config, error) {
	fileVals := map[string]string{}
	if f, err := os.Open(envPath); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			if k, v, ok := strings.Cut(line, "="); ok {
				fileVals[strings.TrimSpace(k)] = strings.TrimSpace(v)
			}
		}
	}
	get := func(key string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return fileVals[key]
	}
	return Config{
		SFBaseURL:            get("FINEVINES_SF_BASE_URL"),
		SFClientID:           get("FINEVINES_SF_CLIENT_ID"),
		SFClientSecret:       get("FINEVINES_SF_CLIENT_SECRET"),
		SFAPIVersion:         orDefault(get("FINEVINES_SF_API_VERSION"), "v61.0"),
		AnthropicAPIKey:      get("ANTHROPIC_API_KEY"),
		GeminiAPIKey:         get("FINEVINES_GEMINI_API_KEY"),
		ImageModel:           orDefault(get("FINEVINES_IMAGE_MODEL"), "imagen-4.0-generate-001"),
		BunnyStorageZone:     get("FINEVINES_BUNNY_STORAGE_ZONE"),
		BunnyStorageKey:      get("FINEVINES_BUNNY_STORAGE_KEY"),
		BunnyStorageEndpoint: orDefault(get("FINEVINES_BUNNY_STORAGE_ENDPOINT"), "https://storage.bunnycdn.com"),
		BunnyAPIKey:          get("FINEVINES_BUNNY_API_KEY"),
		BunnyPullZoneID:      get("FINEVINES_BUNNY_PULL_ZONE_ID"),
		SiteBaseURL:          orDefault(get("FINEVINES_SITE_BASE_URL"), "https://finevines.com"),
	}, nil
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
```

- [ ] **Step 4: Write `cmd/finevines/main.go` dispatch**

```go
package main

import (
	"fmt"
	"os"

	"github.com/gritautomation/finevines-website/internal/config"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cfg, err := config.Load(".env")
	if err != nil {
		fatal(err)
	}
	var runErr error
	switch os.Args[1] {
	case "enrich":
		runErr = runEnrich(cfg)
	case "build":
		runErr = runBuild(cfg)
	case "redirects":
		runErr = runRedirects(cfg)
	case "deploy":
		runErr = runDeploy(cfg)
	default:
		usage()
		os.Exit(2)
	}
	if runErr != nil {
		fatal(runErr)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: finevines <enrich|build|redirects|deploy>")
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "finevines:", err)
	os.Exit(1)
}

// Stubs — replaced by later tasks (16, 9, 20, 18 respectively).
func runEnrich(cfg config.Config) error    { return fmt.Errorf("enrich: not implemented yet") }
func runBuild(cfg config.Config) error     { return fmt.Errorf("build: not implemented yet") }
func runRedirects(cfg config.Config) error { return fmt.Errorf("redirects: not implemented yet") }
func runDeploy(cfg config.Config) error    { return fmt.Errorf("deploy: not implemented yet") }
```

- [ ] **Step 5: `.env.example` + `.gitignore`**

`.env.example` (committed; every key from Config, empty values, one comment per section). Append to `.gitignore`:

```
.env
dist/
.bunny-manifest.json
```

- [ ] **Step 6: Verify + commit**

Run: `go test ./...` → PASS. `go build ./cmd/finevines && ./finevines build` → prints `finevines: build: not implemented yet`, exit 1.

```powershell
git add -A; git commit -m "feat: scaffold finevines binary with subcommand dispatch and config loading"
```

---

### Task 2: Data model + slugify

**Files:**
- Create: `internal/model/model.go`, `internal/model/slug.go`, `internal/model/slug_test.go`, `internal/model/model_test.go`

**Interfaces:**
- Produces: `model.Wine`, `model.NewsPost`, `model.TeamMember` structs matching spec §3 exactly (JSON tags are the contract with the skills and `build`); `model.Slugify(parts ...string) string`; `model.LoadWines(path) ([]Wine, error)` / `model.SaveWines(path, []Wine) error` (pretty-printed, sorted by slug — deterministic file for clean git diffs).

- [ ] **Step 1: Write failing tests**

`internal/model/slug_test.go`:

```go
package model

import "testing"

func TestSlugify(t *testing.T) {
	cases := []struct {
		parts []string
		want  string
	}{
		{[]string{"Hubert Lamy", "Saint-Aubin 1er Cru « Derrière chez Édouard »", "2021"},
			"hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021"},
		{[]string{"Château d'Yquem", "Sauternes", "2015"}, "chateau-d-yquem-sauternes-2015"},
		{[]string{"Weingut Müller", "Riesling", ""}, "weingut-muller-riesling"},
		{[]string{"  spaces  "}, "spaces"},
	}
	for _, c := range cases {
		if got := Slugify(c.parts...); got != c.want {
			t.Errorf("Slugify(%v) = %q, want %q", c.parts, got, c.want)
		}
	}
}
```

`internal/model/model_test.go`:

```go
package model

import (
	"path/filepath"
	"testing"
)

func TestWineJSONRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wines.json")
	in := []Wine{
		{ID: "SF-2", SKU: "ZZ1", Slug: "b-wine", StockQty: 3, ImageSource: "generated-label"},
		{ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy", Slug: "a-wine", StockQty: 14,
			ImageSource: "generated-photo", ImagePath: "assets/img/wines/AB1234.jpg"},
	}
	if err := SaveWines(path, in); err != nil {
		t.Fatal(err)
	}
	out, err := LoadWines(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out[0].Slug != "a-wine" { // sorted by slug on save
		t.Fatalf("got %+v", out)
	}
	if out[1].SKU != "ZZ1" {
		t.Errorf("round-trip lost data: %+v", out[1])
	}
}

func TestLoadWinesMissingFileReturnsEmpty(t *testing.T) {
	out, err := LoadWines(filepath.Join(t.TempDir(), "wines.json"))
	if err != nil || len(out) != 0 {
		t.Fatalf("want empty slice + nil err on first run, got %v, %v", out, err)
	}
}
```

- [ ] **Step 2: Run to verify failure** — `go test ./internal/model/` → FAIL.

- [ ] **Step 3: Implement `model.go` + `slug.go`**

`internal/model/model.go`:

```go
// Package model holds the shared data contract between enrich (producer),
// the Claude skills (producers), and build (consumer). JSON tags are the
// contract from the design spec §3 — do not rename without a spec change.
package model

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"sort"
)

const (
	ImageGeneratedPhoto    = "generated-photo"
	ImageGeneratedLabel    = "generated-label"
	ImageProducerSupplied  = "producer-supplied"
)

type Wine struct {
	ID             string `json:"id"`
	SourceHash     string `json:"sourceHash"`
	SKU            string `json:"sku"`
	Producer       string `json:"producer"`
	Name           string `json:"name"`
	Vintage        string `json:"vintage"`
	Varietal       string `json:"varietal"`
	Region         string `json:"region"`
	Appellation    string `json:"appellation"`
	Style          string `json:"style"`
	StockQty       int    `json:"stockQty"`
	Description    string `json:"description"`
	SommelierNotes string `json:"sommelierNotes"`
	ImagePath      string `json:"imagePath"`
	ImageSource    string `json:"imageSource"`
	Slug           string `json:"slug"`
}

type NewsPost struct {
	Title    string `json:"title"`
	Date     string `json:"date"` // YYYY-MM-DD
	Category string `json:"category"`
	Body     string `json:"body"`
	Image    string `json:"image,omitempty"`
	Slug     string `json:"slug"`
}

type TeamMember struct {
	Name      string `json:"name"`
	Role      string `json:"role"`
	Email     string `json:"email"`
	PhotoPath string `json:"photoPath,omitempty"`
	Note      string `json:"note,omitempty"`
}

func LoadWines(path string) ([]Wine, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return []Wine{}, nil
	}
	if err != nil {
		return nil, err
	}
	var wines []Wine
	if err := json.Unmarshal(data, &wines); err != nil {
		return nil, err
	}
	return wines, nil
}

func SaveWines(path string, wines []Wine) error {
	sort.Slice(wines, func(i, j int) bool { return wines[i].Slug < wines[j].Slug })
	data, err := json.MarshalIndent(wines, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}
```

`internal/model/slug.go`:

```go
package model

import "strings"

var foldTable = map[rune]string{
	'à': "a", 'á': "a", 'â': "a", 'ã': "a", 'ä': "a", 'å': "a", 'æ': "ae",
	'ç': "c", 'è': "e", 'é': "e", 'ê': "e", 'ë': "e",
	'ì': "i", 'í': "i", 'î': "i", 'ï': "i",
	'ñ': "n", 'ò': "o", 'ó': "o", 'ô': "o", 'õ': "o", 'ö': "o", 'ø': "o", 'œ': "oe",
	'ù': "u", 'ú': "u", 'û': "u", 'ü': "u", 'ý': "y", 'ÿ': "y", 'ß': "ss",
}

// Slugify joins parts into a lowercase URL slug: accented Latin characters
// fold to ASCII, every other non-alphanumeric run collapses to one hyphen.
func Slugify(parts ...string) string {
	var b strings.Builder
	for _, part := range parts {
		for _, r := range strings.ToLower(part) {
			switch {
			case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
				b.WriteRune(r)
			default:
				if folded, ok := foldTable[r]; ok {
					b.WriteString(folded)
				} else {
					b.WriteByte('-')
				}
			}
		}
		b.WriteByte('-')
	}
	slug := b.String()
	for strings.Contains(slug, "--") {
		slug = strings.ReplaceAll(slug, "--", "-")
	}
	return strings.Trim(slug, "-")
}
```

- [ ] **Step 4: Verify** — `go test ./internal/model/` → PASS.

- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: shared data model, JSON persistence, and diacritic-folding slugify"`

---

### Task 3: Eligibility rule + source hash

**Files:**
- Create: `internal/enrich/rules.go`, `internal/enrich/rules_test.go`, `internal/salesforce/source.go`, `internal/enrich/hash.go`, `internal/enrich/hash_test.go`

**Interfaces:**
- Produces: `salesforce.WineRaw` struct (`ID, SKU, Producer, Name, Vintage, Varietal, Region, Appellation, Style string; StockQty int`); `salesforce.Source` interface `{ Roster(ctx context.Context) ([]WineRaw, error) }`; `enrich.Eligible(stockQty int, sku string) bool`; `enrich.SourceHash(w salesforce.WineRaw) string` (hex sha256).
- Consumed by: Tasks 11–16.

- [ ] **Step 1: Write failing tests**

`internal/enrich/rules_test.go`:

```go
package enrich

import "testing"

func TestEligible(t *testing.T) {
	cases := []struct {
		qty  int
		sku  string
		want bool
	}{
		{14, "AB1234", true},
		{0, "AB1234", false},   // out of stock
		{-2, "AB1234", false},  // negative stock
		{14, "9X1234", false},  // SKU starts with 9 → never on the web
		{14, "A91234", true},   // 9 elsewhere is fine
		{1, "", true},          // empty SKU doesn't start with 9
	}
	for _, c := range cases {
		if got := Eligible(c.qty, c.sku); got != c.want {
			t.Errorf("Eligible(%d, %q) = %v, want %v", c.qty, c.sku, got, c.want)
		}
	}
}
```

`internal/enrich/hash_test.go`:

```go
package enrich

import (
	"testing"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func TestSourceHashIsDeterministicAndSensitive(t *testing.T) {
	a := salesforce.WineRaw{ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy", StockQty: 14}
	b := a
	if SourceHash(a) != SourceHash(b) {
		t.Fatal("same input must hash identically")
	}
	b.StockQty = 15
	if SourceHash(a) == SourceHash(b) {
		t.Fatal("changed field must change hash")
	}
	if len(SourceHash(a)) != 64 {
		t.Fatalf("want hex sha256 (64 chars), got %d", len(SourceHash(a)))
	}
}
```

- [ ] **Step 2: Run to verify failure** — `go test ./internal/enrich/ ./internal/salesforce/` → FAIL.

- [ ] **Step 3: Implement**

`internal/salesforce/source.go`:

```go
// Package salesforce reads the wine roster from the Salesforce org that
// mirrors QuickBooks. Source is an interface so a future QuickBooks-direct
// implementation can replace it without touching enrich orchestration.
package salesforce

import "context"

type WineRaw struct {
	ID          string
	SKU         string
	Producer    string
	Name        string
	Vintage     string
	Varietal    string
	Region      string
	Appellation string
	Style       string
	StockQty    int
}

type Source interface {
	// Roster returns raw rows for every candidate wine (eligibility is
	// applied by the caller via enrich.Eligible).
	Roster(ctx context.Context) ([]WineRaw, error)
}
```

`internal/enrich/rules.go`:

```go
package enrich

import "strings"

// Eligible implements the confirmed web-eligibility rule (compiled constant
// by decision 2026-07-24): a wine is shown on the site when it is in stock
// and its SKU does not start with "9".
func Eligible(stockQty int, sku string) bool {
	return stockQty > 0 && !strings.HasPrefix(sku, "9")
}
```

`internal/enrich/hash.go`:

```go
package enrich

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// SourceHash fingerprints the raw Salesforce fields for roster-diffing.
// json.Marshal of a struct emits fields in declaration order, so the hash
// is deterministic for a given WineRaw value.
func SourceHash(w salesforce.WineRaw) string {
	payload, _ := json.Marshal(w)
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}
```

- [ ] **Step 4: Verify** — `go test ./...` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: web-eligibility rule and source-hash fingerprint"`

---

## Phase B — `build`: JSON → static site

*Pure, no network, fully testable with fixtures. Building this first gives a viewable site (with fixture wines) before any Salesforce/API access exists.*

### Task 4: Static assets — fonts, CSS design system, seed data

**Files:**
- Create: `tools/extractfonts/main.go`, `assets/fonts/*.woff2` (extracted), `assets/css/site.css`, `data/team.json`, `data/news/.gitkeep`
- Reference (read-only): `index.html` (proposal — fonts embedded as base64, design system in its `<style>`)

**Interfaces:**
- Produces: self-hosted `@font-face` files (Cormorant Garamond, EB Garamond, Archivo) + `assets/css/site.css` with the design tokens `build` templates link to.

- [ ] **Step 1: Write the font extractor**

`tools/extractfonts/main.go` (throwaway, run with `go run`, committed for reproducibility):

```go
// Extracts base64-embedded woff2 fonts from the proposal index.html into
// assets/fonts/. The proposal is the only surviving artifact carrying the
// licensed-for-self-hosting brand webfonts (all Google Fonts / OFL).
package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"regexp"
)

var faceRe = regexp.MustCompile(
	`font-family:\s*'([^']+)'[^}]*?font-weight:\s*(\d+)[^}]*?` +
		`url\(data:font/woff2;base64,([A-Za-z0-9+/=]+)\)`)

func main() {
	src, err := os.ReadFile("index.html")
	if err != nil {
		panic(err)
	}
	os.MkdirAll("assets/fonts", 0o755)
	for _, m := range faceRe.FindAllSubmatch(src, -1) {
		family, weight, b64 := string(m[1]), string(m[2]), m[3]
		raw, err := base64.StdEncoding.DecodeString(string(b64))
		if err != nil {
			panic(fmt.Errorf("%s/%s: %w", family, weight, err))
		}
		name := fmt.Sprintf("assets/fonts/%s-%s.woff2",
			regexp.MustCompile(`\s+`).ReplaceAllString(family, ""), weight)
		os.WriteFile(name, raw, 0o644)
		fmt.Println("wrote", name, len(raw), "bytes")
	}
}
```

Run: `go run ./tools/extractfonts` from repo root. Expected: several `assets/fonts/*.woff2` files listed. **If the regex finds zero faces** (the proposal's `@font-face` blocks are ordered differently), open `index.html`, locate the actual `@font-face` structure, and adjust the regex — the fonts are definitely in there as `data:font/woff2;base64,` URIs. Fallback if extraction proves unworkable: download the same three families from Google Fonts (all OFL-licensed) and subset with any woff2 tool; note which route was taken in the commit message.

- [ ] **Step 2: Write `assets/css/site.css`**

Design tokens transcribed from the proposal's `<style>` (open `index.html` and copy the real values — colors, type scale). Structure:

```css
/* FineVines design system — tokens transcribed from the approved proposal. */
:root {
  --wine: #5e1224;        /* deep burgundy — replace with the exact value from index.html */
  --cream: #f5efe4;       /* page background — ditto */
  --ink: #2b2320;
  --gold: #b08d3f;
  --serif-display: 'Cormorant Garamond', Georgia, serif;
  --serif-text: 'EB Garamond', Georgia, serif;
  --sans: 'Archivo', system-ui, sans-serif;
}
@font-face { font-family: 'Cormorant Garamond'; src: url('/assets/fonts/CormorantGaramond-600.woff2') format('woff2'); font-weight: 600; font-display: swap; }
/* ...one @font-face per extracted file... */

/* base layout, header/footer, wine-card grid, wine-detail page, facet sidebar,
   news list, team grid, responsive breakpoints at 640/960px */
```

The full stylesheet is written here (not generated) — port the proposal's visual language: cream background, burgundy accents, generous serif headings, thin gold rules. Keep it under ~400 lines; no framework.

- [ ] **Step 3: Seed `data/team.json`** with the confirmed roster (Global Constraints list), roles as given, emails in whatever format FineVines uses (`first@finevines.com` placeholder pattern is acceptable **only until C1 contact confirms real addresses** — mark with a `note` field `"confirm email"` so the team skill surfaces it).

- [ ] **Step 4: Verify** — fonts exist (`ls assets/fonts`), `python -m http.server` or open a scratch HTML linking site.css to eyeball tokens. No Go tests for this task (assets).

- [ ] **Step 5: Commit** — `git commit -am "feat: brand fonts extracted from proposal, site stylesheet, seed team roster"`

---

### Task 5: Build engine core — load data, base template, homepage + contact

**Files:**
- Create: `internal/build/build.go`, `internal/build/build_test.go`, `templates/base.html.tmpl`, `templates/home.html.tmpl`, `templates/contact.html.tmpl`, `internal/build/testdata/wines.json`, `internal/build/testdata/team.json`, `internal/build/testdata/news/spring-tasting.json`

**Interfaces:**
- Produces: `build.Run(dataDir, assetsDir, templatesDir, distDir, baseURL string) error` — the single entry point `runBuild` calls; internal `site` struct `{ Wines []model.Wine; News []model.NewsPost; Team []model.TeamMember; BaseURL string }`; `renderPage(dist, relPath, tmplName string, data any)` helper writing `dist/<relPath>/index.html`.
- Consumes: `model.LoadWines`, `model.NewsPost`, `model.TeamMember`.

- [ ] **Step 1: Create fixtures.** `testdata/wines.json`: 3 wines (one with French diacritics in name, one `generated-label` `.svg` image, one `producer-supplied`). `testdata/team.json`: 2 members. `testdata/news/spring-tasting.json`: `{"title":"Spring Portfolio Tasting","date":"2026-04-12","category":"Events","body":"Join us...","slug":"spring-portfolio-tasting"}`.

- [ ] **Step 2: Write the failing test**

```go
package build

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunGeneratesHomeAndContact(t *testing.T) {
	dist := t.TempDir()
	err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com")
	if err != nil {
		t.Fatal(err)
	}
	home, err := os.ReadFile(filepath.Join(dist, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"<title>FineVines",
		"Pouring elegance with a sommelier", // tagline present
		`rel="canonical" href="https://finevines.com/"`,
		`href="/assets/css/site.css"`,
	} {
		if !strings.Contains(string(home), want) {
			t.Errorf("home missing %q", want)
		}
	}
	if _, err := os.Stat(filepath.Join(dist, "contact", "index.html")); err != nil {
		t.Error("contact page missing")
	}
	if _, err := os.Stat(filepath.Join(dist, "assets", "css", "site.css")); err != nil {
		t.Error("assets not copied into dist")
	}
}
```

- [ ] **Step 3: Run to verify failure**, then implement `build.go`:

```go
// Package build renders data/*.json into a complete static site in dist/.
// It is a pure function of its inputs: no network, no clocks, no randomness —
// the same data must produce a byte-identical dist/ (tested in Task 9).
package build

import (
	"html/template"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
)

type site struct {
	Wines   []model.Wine
	News    []model.NewsPost
	Team    []model.TeamMember
	BaseURL string
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
	pages := []struct {
		rel, tmpl string
		data      any
	}{
		{"", "home", s},
		{"contact", "contact", s},
	}
	for _, p := range pages {
		if err := renderPage(tmpl, distDir, p.rel, p.tmpl, p.data); err != nil {
			return err
		}
	}
	return nil
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
```

(`jsonUnmarshal` = thin wrapper over `encoding/json` — add the import; helper exists so error messages can carry the filename later.)

- [ ] **Step 4: Write templates.** `base.html.tmpl` defines `head` (charset, viewport, `<title>`, meta description, canonical using `.BaseURL`, css link), `header` (logo text "FineVines", nav: Portfolio / News & Events / About / Contact), `footer` (tagline, license line, contact info). `home.html.tmpl` defines `home`: hero with tagline `Pouring elegance with a sommelier's touch`, intro copy in brand voice, featured-region links into the portfolio, latest 3 news posts. `contact.html.tmpl`: address, phone, email, wholesale-inquiry framing (voice: old-world wine trade, no web forms — this is a licensed distributor's trade contact page).

- [ ] **Step 5: Verify** — `go test ./internal/build/` → PASS. Also `go run ./cmd/finevines build` still errors (wired in Task 9 — fine).

- [ ] **Step 6: Commit** — `git commit -am "feat: build engine core with base/home/contact templates"`

---

### Task 6: Wine detail pages with JSON-LD

**Files:**
- Create: `templates/wine.html.tmpl`
- Modify: `internal/build/build.go` (add per-wine page loop), `internal/build/build_test.go`

**Interfaces:**
- Produces: `dist/wines/<slug>/index.html` per wine; JSON-LD `Product` + `Offer` schema; unique title/meta; `alt` text on images.

- [ ] **Step 1: Extend the test**

```go
func TestWineDetailPages(t *testing.T) {
	dist := t.TempDir()
	if err := Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com"); err != nil {
		t.Fatal(err)
	}
	page, err := os.ReadFile(filepath.Join(dist, "wines",
		"hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)
	for _, want := range []string{
		`<script type="application/ld+json">`,
		`"@type": "Product"`,
		`"@type": "Offer"`,
		`"availability": "https://schema.org/InStock"`,
		"<title>Hubert Lamy",                       // unique title
		`alt="Bottle of Hubert Lamy`,               // real alt text
		`rel="canonical" href="https://finevines.com/wines/hubert-lamy-`,
	} {
		if !strings.Contains(html, want) {
			t.Errorf("wine page missing %q", want)
		}
	}
}
```

- [ ] **Step 2: Run to verify failure**, then implement. **Template-data contract (established by Task 5, binding on every page):** the base template's `head`/`header`/`footer` reference `.Title`, `.Description`, `.Path`, and `.BaseURL`, so every page's template data MUST embed Task 5's `page` struct (`page{ *site; Title, Description, Path string }`) and set a unique title/description/path — this is exactly what the per-wine SEO requirement (unique `<title>`/meta/canonical) needs anyway. Define a wine page type that embeds `page`, and in `Run`, after the static pages:

```go
	// winePage carries this wine plus the shared page contract (Title/Description/
	// Path/BaseURL) that base.html.tmpl's head/header/footer require.
	type winePage struct {
		page
		Wine model.Wine
	}
	for _, w := range s.Wines {
		data := winePage{
			page: page{
				site:        s,
				Title:       fmt.Sprintf("%s %s %s — FineVines", w.Producer, w.Name, w.Vintage),
				Description: firstNonEmpty(w.Description, w.Producer+" "+w.Name),
				Path:        "/wines/" + w.Slug + "/",
			},
			Wine: w,
		}
		if err := renderPage(tmpl, distDir, "wines/"+w.Slug, "wine", data); err != nil {
			return err
		}
	}
```

(`firstNonEmpty` is a tiny local helper; or inline the fallback. `Title`/`Description`/`Path` may instead be defined as a small constructor if `Run` gets crowded — see Task 5's Minor note.)

`templates/wine.html.tmpl`: two-column layout (bottle image left, copy right) — producer eyebrow, name + vintage as display heading, region/appellation/varietal/style as a spec table, `Description` paragraph, `SommelierNotes` in a bordered aside. Because `winePage` embeds `page` (which embeds `*site`), `BaseURL` is reachable directly as `.BaseURL`; the wine's own fields are under `.Wine`. JSON-LD block:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": {{printf "%s %s %s" .Wine.Producer .Wine.Name .Wine.Vintage}},
  "image": {{printf "%s/%s" .BaseURL .Wine.ImagePath}},
  "description": {{.Wine.Description}},
  "sku": {{.Wine.SKU}},
  "brand": {"@type": "Brand", "name": {{.Wine.Producer}}},
  "offers": {
    "@type": "Offer",
    "availability": "https://schema.org/InStock",
    "seller": {"@type": "Organization", "name": "FineVines Ltd."}
  }
}
</script>
```

(No price — wholesale; availability is always InStock because ineligible wines never reach `wines.json`. `html/template` auto-JSON-escapes inside `<script type="application/ld+json">` context. The wine detail `<title>`/canonical come from the embedded `page`, so no per-page title logic lives in the template.)

- [ ] **Step 3: Verify** — `go test ./internal/build/` → PASS.
- [ ] **Step 4: Commit** — `git commit -am "feat: per-wine detail pages with Product/Offer JSON-LD"`

---

### Task 7: Portfolio page + search index + client-side faceted filter

**Files:**
- Create: `templates/portfolio.html.tmpl`, `assets/js/portfolio.js`
- Modify: `internal/build/build.go` (portfolio page + `dist/search-index.json`), `internal/build/build_test.go`

**Interfaces:**
- Produces: `dist/portfolio/index.html` (pre-rendered full wine list — crawlable without JS), `dist/search-index.json` (compact array the filter JS fetches), facets: producer / varietal / region / vintage / style.

- [ ] **Step 1: Extend the test** — assert `dist/portfolio/index.html` contains all three fixture wine names as links (`href="/wines/<slug>/"`), and `dist/search-index.json` parses as JSON with 3 entries each having keys `slug, producer, name, vintage, varietal, region, style, img`.

- [ ] **Step 2: Run to verify failure**, then implement. Search index entry struct in `build.go`:

```go
type indexEntry struct {
	Slug     string `json:"slug"`
	Producer string `json:"producer"`
	Name     string `json:"name"`
	Vintage  string `json:"vintage"`
	Varietal string `json:"varietal"`
	Region   string `json:"region"`
	Style    string `json:"style"`
	Img      string `json:"img"`
}
```

Marshal with `json.Marshal` (compact — this file is fetched by browsers; ~5–10k wines ≈ 1–2 MB, acceptable and cacheable; note in code comment that if it grows past ~3 MB, gzip via Bunny handles it). The portfolio page's template data must embed Task 5's `page` struct (title e.g. "Portfolio — FineVines", path `/portfolio/`) alongside the facet groups and wine list — define a `portfolioPage` type embedding `page` (same pattern as `homePage`/`winePage`), so `head`/`header`/`footer` resolve. Portfolio template: facet sidebar (`<details>` groups per facet, checkbox per distinct value — computed in Go, sorted), pre-rendered `<ul class="wine-grid">` of every wine (server-rendered = the SEO surface), `<script src="/assets/js/portfolio.js" defer>`.

- [ ] **Step 3: Write `assets/js/portfolio.js`** (~120 lines, no framework):

```js
// Faceted filter for /portfolio/. Progressive enhancement: the full list is
// server-rendered; this script only hides non-matching cards and updates counts.
(async function () {
  const grid = document.querySelector('.wine-grid');
  if (!grid) return;
  const res = await fetch('/search-index.json');
  const wines = await res.json();
  const bySlug = new Map(wines.map(w => [w.slug, w]));
  const active = { producer: new Set(), varietal: new Set(), region: new Set(), vintage: new Set(), style: new Set() };
  const searchBox = document.querySelector('#portfolio-search');

  function matches(w) {
    for (const [facet, sel] of Object.entries(active)) {
      if (sel.size && !sel.has(w[facet])) return false;
    }
    const q = (searchBox?.value || '').trim().toLowerCase();
    if (q && !`${w.producer} ${w.name} ${w.region} ${w.varietal}`.toLowerCase().includes(q)) return false;
    return true;
  }

  function apply() {
    let shown = 0;
    for (const card of grid.children) {
      const w = bySlug.get(card.dataset.slug);
      const ok = w ? matches(w) : true;
      card.hidden = !ok;
      if (ok) shown++;
    }
    const counter = document.querySelector('#portfolio-count');
    if (counter) counter.textContent = `${shown} wines`;
  }

  document.querySelectorAll('.facet input[type=checkbox]').forEach(box => {
    box.addEventListener('change', () => {
      const set = active[box.dataset.facet];
      box.checked ? set.add(box.value) : set.delete(box.value);
      apply();
    });
  });
  searchBox?.addEventListener('input', apply);
  apply();
})();
```

(Cards carry `data-slug`; template adds `id="portfolio-count"` and `id="portfolio-search"`. Facet checkboxes carry `data-facet` + `value`.)

- [ ] **Step 4: Verify** — `go test ./internal/build/` → PASS. Manual: `go test` fixture build into a temp dir, `python -m http.server` in it, click facets in a browser.
- [ ] **Step 5: Commit** — `git commit -am "feat: portfolio page with search index and vanilla-JS faceted filter"`

---

### Task 8: News landing + per-post pages, About page

**Files:**
- Create: `templates/news.html.tmpl`, `templates/newspost.html.tmpl`, `templates/about.html.tmpl`
- Modify: `internal/build/build.go`, `internal/build/build_test.go`

**Interfaces:**
- Produces: `dist/news/index.html` (posts newest-first), `dist/news/<slug>/index.html` per post (indexable, own title/meta/canonical — the whole point of the News skill's SEO value), `dist/about/index.html` (team grid from `team.json` + FineVines' own About copy).

- [ ] **Step 1: Extend tests** — assert: news landing lists the fixture post title linking to `/news/spring-portfolio-tasting/`; the post page exists with `<title>Spring Portfolio Tasting` and an `Article` JSON-LD block (`"@type": "NewsArticle"`, `datePublished`); about page contains both fixture team members' names and roles.

- [ ] **Step 2: Run to verify failure**, then implement — same `renderPage` pattern, honoring Task 5's template-data contract: **every page's data embeds the `page` struct**. The news landing embeds `page` (title "News & Events — FineVines", path `/news/`) with the posts list; each news post embeds `page` (title = post title, description = a body excerpt, path `/news/<slug>/`) plus its `NewsPost` (define a `newsPostPage` type like `winePage`); the about page embeds `page` (title "About — FineVines", path `/about/`) — it does NOT pass bare `s`, because `head`/`header`/`footer` need `.Title`/`.Path`. The per-post unique title/meta/canonical IS the SEO point of the news skill, so this is required, not optional. Post body: the skill writes plain paragraphs separated by blank lines; convert in Go with a tiny helper `paragraphs(body string) []string` (split on `\n\n`) exposed to the template via `template.FuncMap` — **no** markdown engine (YAGNI; the news skill writes prose paragraphs).

- [ ] **Step 3: About copy.** Use FineVines' existing About text verbatim (from the current site / proposal — the "A service company, first and last..." copy). This is a durable decision: do not rewrite it. Store it directly in `about.html.tmpl`.

- [ ] **Step 4: Verify** — `go test ./internal/build/` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: news landing, per-post pages, and about page with team roster"`

---

### Task 9: Sitemap, robots, build determinism, wire `finevines build`

**Files:**
- Create: `internal/build/sitemap.go`
- Modify: `internal/build/build.go`, `internal/build/build_test.go`, `cmd/finevines/main.go` (replace `runBuild` stub)

**Interfaces:**
- Produces: `dist/sitemap.xml` (every page URL, no `<lastmod>` — determinism), `dist/robots.txt` (`Sitemap:` line, allow all), working `finevines build` command reading `data/`, `assets/`, `templates/` from the working directory into `dist/`.

- [ ] **Step 1: Extend tests**

```go
func TestSitemapListsEveryPage(t *testing.T) {
	dist := t.TempDir()
	Run("testdata", "../../assets", "../../templates", dist, "https://finevines.com")
	sm, _ := os.ReadFile(filepath.Join(dist, "sitemap.xml"))
	for _, want := range []string{
		"<loc>https://finevines.com/</loc>",
		"<loc>https://finevines.com/portfolio/</loc>",
		"<loc>https://finevines.com/wines/hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021/</loc>",
		"<loc>https://finevines.com/news/spring-portfolio-tasting/</loc>",
	} {
		if !strings.Contains(string(sm), want) {
			t.Errorf("sitemap missing %q", want)
		}
	}
	if strings.Contains(string(sm), "<lastmod>") {
		t.Error("sitemap must not contain lastmod (breaks determinism)")
	}
}

func TestBuildIsDeterministic(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	Run("testdata", "../../assets", "../../templates", a, "https://finevines.com")
	Run("testdata", "../../assets", "../../templates", b, "https://finevines.com")
	if diff := treeDiff(t, a, b); diff != "" { // helper: walk both, compare bytes
		t.Fatalf("non-deterministic build:\n%s", diff)
	}
}
```

(`treeDiff`: `filepath.WalkDir` both roots, collect relpath→sha256, report mismatches/missing.)

- [ ] **Step 2: Run to verify failure**, implement `sitemap.go` (string-building with `encoding/xml` or plain templates — keep URLs sorted), `robots.txt` write, and the page-list plumbing (`Run` already knows every rendered page — collect rel-paths into a slice as pages render, then emit sitemap from it).

- [ ] **Step 3: Wire the real command** in `main.go`:

```go
func runBuild(cfg config.Config) error {
	return build.Run("data", "assets", "templates", "dist", cfg.SiteBaseURL)
}
```

- [ ] **Step 4: Verify** — `go test ./...` → PASS; then a real run: copy `internal/build/testdata/wines.json` → `data/wines.json` temporarily, `go run ./cmd/finevines build`, open `dist/index.html` in a browser, spot-check; delete the temp `data/wines.json` (or keep a small demo set until enrich lands — either way note it).
- [ ] **Step 5: Commit** — `git commit -am "feat: sitemap+robots, determinism test, working finevines build command"`

---

## Phase C — Label fallback generator

### Task 10: Deterministic SVG label/bottle generator

**Files:**
- Create: `internal/label/label.go`, `internal/label/label_test.go`, `internal/label/testdata/AB1234.golden.svg`
- Reference (read-only): `index.html` — the rendered château-style label SVGs embedded in the proposal are the visual reference (the JS that generated them is gone; see spec deviation #3).

**Interfaces:**
- Produces: `label.Generate(w salesforce.WineRaw) []byte` — a complete standalone SVG (bottle silhouette + label), deterministic per SKU. Consumed by Task 15's provider chain as the guaranteed-success fallback.

- [ ] **Step 1: Study the reference.** Open `index.html`, find the inline label SVGs (search for `<svg` near the wine-card sections). Note the structural system: frame variant, crest variant, palette, type arrangement (producer eyebrow / name / appellation / vintage). Write the taxonomy into code as data:

```go
var frames = []string{"double", "single", "oval", "deco", "minimal"}
var crests = []string{"ring", "medallion", "shield", "fleuron", "fan"}
var palettes = [10]palette{ /* transcribed from the proposal's rendered variants */ }
```

- [ ] **Step 2: Write the failing tests**

```go
package label

import (
	"bytes"
	"flag"
	"os"
	"strings"
	"testing"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

var update = flag.Bool("update", false, "rewrite golden files")

var fixture = salesforce.WineRaw{
	ID: "SF-1", SKU: "AB1234", Producer: "Hubert Lamy",
	Name: "Saint-Aubin 1er Cru « Derrière chez Édouard »", Vintage: "2021",
	Varietal: "Chardonnay", Region: "Burgundy", Style: "White · Still",
}

func TestGenerateIsDeterministic(t *testing.T) {
	if !bytes.Equal(Generate(fixture), Generate(fixture)) {
		t.Fatal("same wine must produce identical SVG")
	}
}

func TestGenerateVariesBySKU(t *testing.T) {
	other := fixture
	other.SKU = "ZZ9999"
	if bytes.Equal(Generate(fixture), Generate(other)) {
		t.Fatal("different SKUs should pick different visual treatments")
	}
}

func TestGenerateMatchesGolden(t *testing.T) {
	got := Generate(fixture)
	golden := "testdata/AB1234.golden.svg"
	if *update {
		os.WriteFile(golden, got, 0o644)
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Error("SVG changed — review visually, then `go test ./internal/label -update` if intended")
	}
}

func TestGenerateNeverBrandsFineVines(t *testing.T) {
	svg := string(Generate(fixture))
	if strings.Contains(strings.ToLower(svg), "finevines") {
		t.Fatal("labels must be wine-branded, never Fine-Vines-branded (spec §5)")
	}
	for _, want := range []string{"Hubert Lamy", "2021", "<svg"} {
		if !strings.Contains(svg, want) {
			t.Errorf("label missing %q", want)
		}
	}
}
```

- [ ] **Step 3: Run to verify failure**, then implement `label.go`:

```go
// Package label renders a deterministic château-style bottle SVG for wines
// where photo generation failed or is unavailable. Visual system re-created
// from the approved proposal's rendered labels (the original JS generator no
// longer exists). Zero cost, always succeeds — the guaranteed image floor.
package label

import (
	"bytes"
	"fmt"
	"hash/fnv"
	"text/template"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)
```

Core: `seed := fnv64(w.SKU)`; pick `frame := frames[seed%5]`, `crest := crests[(seed/5)%5]`, `pal := palettes[(seed/25)%10]`. Assemble with `text/template` (SVG is XML — `text/template` + manual `xmlEscape` on the wine fields; write the escape helper, 5 entities). Layout: 480×720 viewBox, bottle silhouette path (dark glass, from proposal), label rect ~y 380–620, frame ornament per variant, crest per variant above the producer line, text stack (producer small-caps → name display serif, wrapped at ~22 chars/line with a simple word-wrap helper → appellation italic → vintage). Palette drives label bg / ink / accent. ~250 lines total.

- [ ] **Step 4: Generate the golden + eyeball it** — `go test ./internal/label -update`, then open `internal/label/testdata/AB1234.golden.svg` in a browser. Iterate on coordinates until it reads as elegant against the proposal reference. This step is done when the SVG would not embarrass the brand on a wine-detail page.

- [ ] **Step 5: Verify + commit** — `go test ./internal/label/` → PASS. `git commit -am "feat: deterministic chateau-style SVG label generator (image floor)"`

---

## Phase D — `enrich`: Salesforce → wines.json

### Task 11: Salesforce client (client-credentials auth + paginated roster)

**Files:**
- Create: `internal/salesforce/client.go`, `internal/salesforce/client_test.go`

**Interfaces:**
- Produces: `salesforce.NewClient(cfg Config) *Client` implementing `Source`; `Config{BaseURL, ClientID, ClientSecret, APIVersion string}`.
- Consumes: `WineRaw`, `Source` from Task 3.

- [ ] **Step 1: Write the failing test** — an `httptest.Server` that (a) serves `POST /services/oauth2/token` returning `{"access_token":"tok123","instance_url":"<server url>","token_type":"Bearer"}`, asserting `grant_type=client_credentials` and the client id/secret in the form body; (b) serves `GET /services/data/v61.0/query` returning page 1 (`{"totalSize":3,"done":false,"nextRecordsUrl":"/services/data/v61.0/query/01g-2","records":[...2 records...]}`) and the follow-up URL returning the final record with `"done":true`; asserts `Authorization: Bearer tok123` on query calls. Test asserts `Roster` returns all 3 rows with fields mapped, in API order.

- [ ] **Step 2: Run to verify failure**, then implement:

```go
package salesforce

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type Config struct {
	BaseURL, ClientID, ClientSecret, APIVersion string
}

type Client struct {
	cfg  Config
	http *http.Client
	tok  string
}

func NewClient(cfg Config) *Client { return &Client{cfg: cfg, http: http.DefaultClient} }

// rosterSOQL pulls every candidate wine row in one paginated query.
// ⚠ CHECKPOINT (client action item C1): the object and field API names below
// are provisional guesses against a standard Product2 layout. Before the
// first live run, list the real org's objects/fields (Workbench or
// `sf sobject describe`) and correct them — including which field carries
// the QuickBooks-synced stock quantity.
const rosterSOQL = `SELECT Id, StockKeepingUnit, Producer__c, Name, Vintage__c,
 Varietal__c, Region__c, Appellation__c, Style__c, Stock_Qty__c FROM Product2`

func (c *Client) Roster(ctx context.Context) ([]WineRaw, error) {
	if err := c.authenticate(ctx); err != nil {
		return nil, err
	}
	var out []WineRaw
	next := fmt.Sprintf("/services/data/%s/query?q=%s", c.cfg.APIVersion,
		url.QueryEscape(strings.Join(strings.Fields(rosterSOQL), " ")))
	for next != "" {
		var page struct {
			Done           bool             `json:"done"`
			NextRecordsURL string           `json:"nextRecordsUrl"`
			Records        []map[string]any `json:"records"`
		}
		if err := c.getJSON(ctx, next, &page); err != nil {
			return nil, err
		}
		for _, r := range page.Records {
			out = append(out, WineRaw{
				ID:          str(r["Id"]),
				SKU:         str(r["StockKeepingUnit"]),
				Producer:    str(r["Producer__c"]),
				Name:        str(r["Name"]),
				Vintage:     str(r["Vintage__c"]),
				Varietal:    str(r["Varietal__c"]),
				Region:      str(r["Region__c"]),
				Appellation: str(r["Appellation__c"]),
				Style:       str(r["Style__c"]),
				StockQty:    intval(r["Stock_Qty__c"]),
			})
		}
		next = ""
		if !page.Done {
			next = page.NextRecordsURL
		}
	}
	return out, nil
}

func (c *Client) authenticate(ctx context.Context) error {
	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {c.cfg.ClientID},
		"client_secret": {c.cfg.ClientSecret},
	}
	req, _ := http.NewRequestWithContext(ctx, "POST",
		c.cfg.BaseURL+"/services/oauth2/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("salesforce auth: HTTP %d (check connected app / client credentials setup — fallback is JWT Bearer flow, see plan Task 11 notes)", resp.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return err
	}
	c.tok = body.AccessToken
	return nil
}

func (c *Client) getJSON(ctx context.Context, path string, v any) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", c.cfg.BaseURL+path, nil)
	req.Header.Set("Authorization", "Bearer "+c.tok)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("salesforce query %s: HTTP %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func intval(v any) int {
	f, _ := v.(float64) // Salesforce numbers arrive as JSON numbers
	return int(f)
}
```

(Test injects the server URL as `BaseURL` and, for the httptest server, sets `c.http` via an exported-for-test setter or by making `NewClient` accept `*http.Client` — pick the latter: `NewClient(cfg Config, hc *http.Client)`, pass `http.DefaultClient` in production wiring.)

- [ ] **Step 3: Verify** — `go test ./internal/salesforce/` → PASS.

- [ ] **Step 4: JWT-fallback note.** Add a doc comment on `authenticate`: if the org's edition/policy blocks client credentials, the fallback is the JWT Bearer flow (cert-based; `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`) — an isolated change inside this one function.

- [ ] **Step 5: Commit** — `git commit -am "feat: salesforce client-credentials client with paginated roster query"`

---

### Task 12: Roster diff

**Files:**
- Create: `internal/enrich/diff.go`, `internal/enrich/diff_test.go`

**Interfaces:**
- Produces: `enrich.Diff{Enrich []salesforce.WineRaw; Keep []model.Wine}` and `enrich.DiffRoster(eligible []salesforce.WineRaw, existing []model.Wine) Diff`. Semantics: new ID or changed hash → `Enrich`; unchanged → `Keep` (carried verbatim, zero API cost); absent from eligible roster → dropped (removal falls out for free — "new product" and "sold out" are the same diff, spec §4).
- Consumes: `SourceHash`, `Eligible` (caller applies `Eligible` *before* diffing).

- [ ] **Step 1: Write failing tests** — four cases: (new) raw not in existing → in `Enrich`; (changed) raw whose hash ≠ stored `SourceHash` → in `Enrich`; (unchanged) hash matches → in `Keep` with all enrichment fields intact; (removed) existing wine absent from eligible → in neither. Plus: a `producer-supplied` wine with a *changed* hash lands in `Enrich` (text refresh) — the image-preservation behavior is asserted in Task 15, not here.

- [ ] **Step 2: Run to verify failure**, implement:

```go
package enrich

import (
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

type Diff struct {
	Enrich []salesforce.WineRaw // new or changed — needs text + image work
	Keep   []model.Wine         // unchanged — carried over verbatim, no cost
}

// DiffRoster compares the eligible Salesforce roster against the current
// wines.json. Wines missing from `eligible` simply don't appear in the
// result — sold-out and delisted wines drop off the site on the next build.
func DiffRoster(eligible []salesforce.WineRaw, existing []model.Wine) Diff {
	byID := make(map[string]model.Wine, len(existing))
	for _, w := range existing {
		byID[w.ID] = w
	}
	var d Diff
	for _, raw := range eligible {
		if prev, ok := byID[raw.ID]; ok && prev.SourceHash == SourceHash(raw) {
			d.Keep = append(d.Keep, prev)
		} else {
			d.Enrich = append(d.Enrich, raw)
		}
	}
	return d
}
```

- [ ] **Step 3: Verify + commit** — `go test ./internal/enrich/` → PASS. `git commit -am "feat: roster-diff engine (new/changed/unchanged/removed in one pass)"`

---

### Task 13: Claude text enrichment (+ image prompt in the same call)

**Files:**
- Create: `internal/enrich/text.go`, `internal/enrich/text_test.go`
- Modify: `go.mod` (`go get github.com/anthropics/anthropic-sdk-go`)

**Interfaces:**
- Produces: `enrich.TextEnricher` with `Enrich(ctx, w salesforce.WineRaw) (TextResult, error)`; `TextResult{Description, SommelierNotes, ImagePrompt string}`. One Claude call per wine returns all three (the image prompt rides along free instead of a second call).
- Consumes: `salesforce.WineRaw`.

- [ ] **Step 1: Write the failing test** — `httptest.Server` mimicking `POST /v1/messages` returning a fixed Messages response whose single text block is the JSON `{"description":"...","sommelierNotes":"...","imagePrompt":"..."}`; construct the SDK client with `option.WithBaseURL(server.URL)` + `option.WithAPIKey("test-key")`. Assert: the request body's `model` is `claude-opus-4-8`; the user prompt contains the producer, region, varietal, vintage (grounding check); the parsed `TextResult` round-trips. Second test: a response with malformed JSON in the text block → `Enrich` retries once (server counts calls) and errors after the second failure.

- [ ] **Step 2: Run to verify failure**, then implement:

```go
package enrich

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	"github.com/gritautomation/finevines-website/internal/salesforce"
)

type TextResult struct {
	Description    string `json:"description"`
	SommelierNotes string `json:"sommelierNotes"`
	ImagePrompt    string `json:"imagePrompt"`
}

type TextEnricher struct {
	client anthropic.Client
}

func NewTextEnricher(apiKey string, opts ...option.RequestOption) *TextEnricher {
	return &TextEnricher{client: anthropic.NewClient(append([]option.RequestOption{option.WithAPIKey(apiKey)}, opts...)...)}
}

const textSystem = `You write catalog copy for FineVines, a licensed Illinois
wholesale wine distributor. Voice: elegant, editorial, old-world wine trade —
never corporate-tech. You will receive the known facts about one wine. Write:
1. "description": a 2–3 sentence tasting description for the trade.
2. "sommelierNotes": 1–2 sentences of service/pairing guidance.
3. "imagePrompt": a prompt for a photorealistic studio product photograph of
   this bottle — describe bottle shape and glass color typical for the region
   and style, a classic label consistent with the producer and appellation,
   neutral warm-grey studio backdrop, soft key light. Never include people,
   scenery, or brand logos other than plausible label text.
STRICT GROUNDING: use only the provided facts. Never invent scores, prices,
vintages, awards, or provenance. If a field is empty, omit that aspect.
Respond with a single JSON object with exactly those three string keys and
nothing else.`

func (t *TextEnricher) Enrich(ctx context.Context, w salesforce.WineRaw) (TextResult, error) {
	prompt := fmt.Sprintf(
		"Producer: %s\nWine: %s\nVintage: %s\nVarietal: %s\nRegion: %s\nAppellation: %s\nStyle: %s",
		w.Producer, w.Name, w.Vintage, w.Varietal, w.Region, w.Appellation, w.Style)

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		resp, err := t.client.Messages.New(ctx, anthropic.MessageNewParams{
			Model:     anthropic.ModelClaudeOpus4_8,
			MaxTokens: 1024,
			System:    []anthropic.TextBlockParam{{Text: textSystem}},
			Messages: []anthropic.MessageParam{
				anthropic.NewUserMessage(anthropic.NewTextBlock(prompt)),
			},
		})
		if err != nil {
			return TextResult{}, err // SDK already retried 429/5xx
		}
		var text strings.Builder
		for _, block := range resp.Content {
			if b, ok := block.AsAny().(anthropic.TextBlock); ok {
				text.WriteString(b.Text)
			}
		}
		var out TextResult
		raw := strings.TrimSpace(text.String())
		raw = strings.TrimPrefix(raw, "```json")
		raw = strings.Trim(raw, "` \n")
		if err := json.Unmarshal([]byte(raw), &out); err == nil &&
			out.Description != "" && out.ImagePrompt != "" {
			return out, nil
		} else {
			lastErr = fmt.Errorf("unparseable enrichment for %s (attempt %d): %w", w.SKU, attempt+1, err)
		}
	}
	return TextResult{}, lastErr
}
```

*Implementation note:* the SDK also supports structured outputs (`output_config` json_schema), which would remove the parse-and-retry. At implementation time check the installed `anthropic-sdk-go` version for the `OutputConfig`/`JSONOutputFormatParam` binding; if present, use it and delete the retry loop — the test's malformed-JSON case then becomes a schema-enforced non-case. Don't guess the binding name; check the SDK source, and keep the prompt-enforced version above as the working fallback.

- [ ] **Step 3: Verify + commit** — `go test ./internal/enrich/` → PASS. `git commit -am "feat: claude text enrichment with grounded prompt and image-prompt piggyback"`

---

### Task 14: Imagen 4 provider

**Files:**
- Create: `internal/enrich/imagen.go`, `internal/enrich/imagen_test.go`

**Interfaces:**
- Produces: `enrich.ImageProvider` interface `{ GenerateJPEG(ctx, prompt string) ([]byte, error) }`; `enrich.NewImagenClient(apiKey, model, baseURL string, hc *http.Client) *ImagenClient`. Returns **JPEG bytes** (re-encoded from the API's PNG at quality 85 — spec deviation #1).
- Consumes: config values `GeminiAPIKey`, `ImageModel`.

- [ ] **Step 1: Verify the current wire format.** WebFetch `https://ai.google.dev/gemini-api/docs/imagen` (Gemini API image generation docs) and confirm: endpoint path (`/v1beta/models/{model}:predict`), auth header (`x-goog-api-key`), request shape (`{"instances":[{"prompt":...}],"parameters":{"sampleCount":1,"aspectRatio":"3:4"}}`), response shape (`predictions[0].bytesBase64Encoded`, mime type). Adjust the code below to whatever the docs say **today** — this API is the newest, most-likely-to-change piece (spec §5), which is exactly why the model name is config.

- [ ] **Step 2: Write the failing test** — `httptest.Server` asserting the auth header and prompt appear in the request, returning a base64 1×1 PNG; assert `GenerateJPEG` returns bytes that `image/jpeg`-decode successfully. Second test: HTTP 400 from the API (safety block) → typed error `ErrImageRejected` (the pipeline treats it as "fall back to label", not a run-failure).

- [ ] **Step 3: Implement** (~90 lines): POST JSON, decode base64 → `png.Decode` → `jpeg.Encode(quality 85)`. Map non-200 or empty predictions to `ErrImageRejected` (wrapped sentinel `var ErrImageRejected = errors.New(...)`); network errors pass through as real errors.

- [ ] **Step 4: One real smoke call (needs C2, skippable until key arrives)** — tiny `tools/imagensmoke/main.go` or a `go test -tags=live` that generates one bottle from a hand-written prompt and writes `scratch-bottle.jpg` for eyeballing. Not part of CI.

- [ ] **Step 5: Verify + commit** — `go test ./internal/enrich/` → PASS. `git commit -am "feat: imagen 4 provider returning JPEG with safety-rejection sentinel"`

---

### Task 15: Image pipeline — provider chain with fallback + producer-supplied protection

**Files:**
- Create: `internal/enrich/images.go`, `internal/enrich/images_test.go`

**Interfaces:**
- Produces: `enrich.ResolveImage(ctx, provider ImageProvider, w salesforce.WineRaw, prompt, imgDir string, prev *model.Wine) (imagePath, imageSource string, err error)`.
- Chain (spec §5, first success wins): (1) if `prev != nil && prev.ImageSource == model.ImageProducerSupplied` → return prev's path/source untouched, **never regenerate**; (2) Imagen photo → `assets/img/wines/<sku>.jpg`, `generated-photo`; (3) on `ErrImageRejected` *or any provider error* → `label.Generate` → `assets/img/wines/<sku>.svg`, `generated-label`. The label floor means `ResolveImage` only errors on filesystem failures.

- [ ] **Step 1: Write failing tests** with a fake provider (`func(ctx, prompt) ([]byte, error)` adapter): (a) success → `.jpg` written, source `generated-photo`; (b) provider returns `ErrImageRejected` → `.svg` written, source `generated-label`, no error; (c) provider returns a network error → still label fallback (run must not die mid-catalog for one flaky call), and the error is *returned alongside* success info? — No: keep the signature simple, log-and-fallback, return nil. Assert a warning is emitted via an injected `func(format string, args ...any)` logger; (d) `prev` is producer-supplied → provider is **never called** (fake counts calls), path/source preserved.

- [ ] **Step 2: Run to verify failure**, implement (~70 lines). File writes: `os.MkdirAll(imgDir)`, write to `<sku>.jpg` / `<sku>.svg`; also **delete the sibling extension** (a wine that flips photo↔label must not leave a stale file behind).

- [ ] **Step 3: Verify + commit** — `go test ./internal/enrich/` → PASS. `git commit -am "feat: image pipeline chain — producer-supplied guard, imagen, label floor"`

---

### Task 16: Enrich orchestration + wire `finevines enrich`

**Files:**
- Create: `internal/enrich/run.go`, `internal/enrich/run_test.go`
- Modify: `cmd/finevines/main.go` (replace `runEnrich` stub)

**Interfaces:**
- Produces: `enrich.Run(ctx, src salesforce.Source, texts *TextEnricher, imgs ImageProvider, dataPath, imgDir string, log func(string, ...any)) error`:
  1. `src.Roster(ctx)` → filter with `Eligible` → `DiffRoster` against `model.LoadWines(dataPath)`.
  2. For each `Diff.Enrich` wine, **sequentially with bounded concurrency 4** (worker pool; both APIs tolerate it, and the initial 5–10k run finishes in hours not days): text-enrich → resolve image → assemble `model.Wine` (slug = `Slugify(Producer, Name, Vintage)`, hash = `SourceHash`).
  3. **Checkpoint every 50 completions**: merge done-so-far + `Keep` + not-yet-done previous entries and `SaveWines` — a crash or Ctrl-C mid-initial-run loses ≤50 wines of paid API work, and re-running resumes via the hash diff (already-enriched wines now match and land in `Keep`).
  4. Final `SaveWines`. Log a summary: `enriched N, kept M, dropped K, label-fallbacks L`.
- Consumes: everything from Tasks 3, 11–15.

- [ ] **Step 1: Write the failing test** — fake `Source` (fixed roster incl. one ineligible SKU `9…` and one out-of-stock), fake `TextEnricher`? — `TextEnricher` is concrete; refactor: define `type Texts interface { Enrich(ctx, WineRaw) (TextResult, error) }` in `run.go` and let the real `TextEnricher` satisfy it. Fake texts + fake provider; run against a temp `wines.json` pre-seeded with one unchanged wine (must appear untouched in output — same `Description` the fake would *not* produce) and one stale wine (absent from roster — must be gone). Assert output file: correct wine count, slugs, `sourceHash` set, ineligible wines absent, checkpoint file exists mid-run (call with a fake that blocks after 1 wine? — simpler: set checkpoint interval to 1 via a package-level `checkpointEvery` var the test lowers).

- [ ] **Step 2: Run to verify failure**, implement (~120 lines: worker pool with `errgroup`-style channel fan-out — stdlib only: `sync.WaitGroup` + results channel; collect, checkpoint, save).

- [ ] **Step 3: Wire `runEnrich`** in `main.go`:

```go
func runEnrich(cfg config.Config) error {
	for _, missing := range map[string]string{
		"FINEVINES_SF_BASE_URL": cfg.SFBaseURL, "FINEVINES_SF_CLIENT_ID": cfg.SFClientID,
		"FINEVINES_SF_CLIENT_SECRET": cfg.SFClientSecret, "ANTHROPIC_API_KEY": cfg.AnthropicAPIKey,
		"FINEVINES_GEMINI_API_KEY": cfg.GeminiAPIKey,
	} { /* return a "set X in .env" error naming the first empty key */ _ = missing }

	src := salesforce.NewClient(salesforce.Config{BaseURL: cfg.SFBaseURL, ClientID: cfg.SFClientID,
		ClientSecret: cfg.SFClientSecret, APIVersion: cfg.SFAPIVersion}, http.DefaultClient)
	texts := enrich.NewTextEnricher(cfg.AnthropicAPIKey)
	imgs := enrich.NewImagenClient(cfg.GeminiAPIKey, cfg.ImageModel, "", http.DefaultClient)
	return enrich.Run(context.Background(), src, texts, imgs,
		"data/wines.json", "assets/img/wines", log.Printf)
}
```

- [ ] **Step 4: Verify** — `go test ./...` → PASS. **Live checkpoint (blocked on C1–C3):** when credentials exist, run `finevines enrich` against the real org with a temporary `LIMIT 25` added to the SOQL, eyeball `data/wines.json` + generated images, **confirm the real field names** (Task 11 checkpoint), remove the limit.
- [ ] **Step 5: Commit** — `git commit -am "feat: enrich orchestration with bounded concurrency and crash-safe checkpoints"`

---

## Phase E — `deploy`: dist → Bunny.net

### Task 17: Bunny storage client + hash-diff planner

**Files:**
- Create: `internal/deploy/plan.go`, `internal/deploy/plan_test.go`, `internal/deploy/bunny.go`, `internal/deploy/bunny_test.go`

**Interfaces:**
- Produces:
  - `deploy.Plan(distDir string, oldManifest map[string]string) (uploads []string, deletes []string, newManifest map[string]string, err error)` — pure; manifest maps rel-path → sha256.
  - `deploy.BunnyClient` with `Upload(ctx, relPath string, data []byte) error` (PUT `{endpoint}/{zone}/{relPath}`, header `AccessKey`), `Delete(ctx, relPath) error`, `Purge(ctx) error` (POST `https://api.bunny.net/pullzone/{id}/purgeCache`, header `AccessKey` with the account API key).
  - Manifest persistence: `LoadManifest/SaveManifest` on `.bunny-manifest.json` (git-ignored, lives next to `dist/`).

- [ ] **Step 1: Write failing tests.** `plan_test.go`: temp dist with 3 files + old manifest where 1 matches, 1 differs, 1 is new, and the manifest has 1 entry with no file → expect uploads = [changed, new], deletes = [orphan], newManifest = exactly current tree. `bunny_test.go`: httptest server asserting method/path/AccessKey header for upload, delete, purge; non-2xx → error containing status and path.

- [ ] **Step 2: Run to verify failure**, implement. `Plan` walks `distDir`, sha256 per file, set-compare. `BunnyClient` ~80 lines of plain `net/http`.

- [ ] **Step 3: Verify + commit** — `go test ./internal/deploy/` → PASS. `git commit -am "feat: bunny storage client and pure hash-diff deploy planner"`

---

### Task 18: Deploy orchestration + wire `finevines deploy`

**Files:**
- Create: `internal/deploy/run.go`, `internal/deploy/run_test.go`
- Modify: `cmd/finevines/main.go` (replace `runDeploy` stub)

**Interfaces:**
- Produces: `deploy.Run(ctx, client Uploader, distDir, manifestPath string, workers int, log func(string, ...any)) error` where `Uploader` is the interface the real `BunnyClient` satisfies (`Upload/Delete/Purge`). Flow: load manifest → `Plan` → concurrent uploads (worker pool, default 16 — 10k files must not go one-at-a-time, spec §8) → deletes → **save manifest only after all uploads succeed** → purge. On any upload failure: abort before manifest save (next run re-diffs and retries).

- [ ] **Step 1: Write failing test** with a fake Uploader recording calls + injectable failure: (a) happy path uploads only the diff, purges once, manifest saved; (b) one upload fails → manifest not saved, purge not called, error returned; (c) empty diff → no purge (skip cache churn on no-op deploys), logs "nothing to deploy".

- [ ] **Step 2: Run to verify failure**, implement (~90 lines).

- [ ] **Step 3: Wire `runDeploy`** — construct `BunnyClient` from cfg (validate the four Bunny keys are set, same pattern as `runEnrich`), `deploy.Run(ctx, client, "dist", ".bunny-manifest.json", 16, log.Printf)`.

- [ ] **Step 4: Verify** — `go test ./...` → PASS. **Live checkpoint (blocked on C4):** deploy the fixture-data site to the **staging** zone, load it via the staging Pull Zone URL in a browser, confirm pages + assets + purge behavior (edit one file, redeploy, verify only 1 upload logged).
- [ ] **Step 5: Commit** — `git commit -am "feat: deploy orchestration — concurrent diff upload, manifest, purge"`

---

## Phase F — `redirects`

### Task 19: Old-site URL discovery + mapping

**Files:**
- Create: `internal/redirects/discover.go`, `internal/redirects/discover_test.go`, `internal/redirects/mapping.go`, `internal/redirects/mapping_test.go`, `redirect-overrides.json` (committed, starts `{}`)
- Modify: `go.mod` (`go get golang.org/x/net/html`)

**Interfaces:**
- Produces:
  - `redirects.Discover(ctx, baseURL string, log func(string, ...any)) ([]string, error)` — fetch `/sitemap.xml` if present, plus same-host BFS crawl from `/` (max depth 4, max 500 pages, 200ms politeness delay), collecting every distinct *path* (query strings recorded too — they matter for the ≤20 gate). Hash-fragment routes never reach the server and are ignored.
  - `redirects.MapURLs(oldPaths []string, wines []model.Wine, news []model.NewsPost, overrides map[string]string) (mapped map[string]string, unmatched []string)` — override list wins; then exact well-known pages (`/about.html→/about/`, `/contact*→/contact/`, `/portfolio*|/products*|/wines*→/portfolio/`, `/`→`/`); then best-effort wine matching (slugified last path segment contained in a wine slug → that wine page); everything else unmatched.
  - `redirects.Save(path string, mapped map[string]string) error` → `redirects.json`, sorted keys (git-diffable, spec: generated but git-tracked).

- [ ] **Step 1: Write failing tests.** Discover: httptest server with a tiny site (sitemap listing 2 URLs, homepage linking 2 more incl. one off-host link that must be ignored and one `mailto:` that must be ignored) → expect exactly the 4 on-host paths. MapURLs: overrides win over heuristics; `/products/hubert-lamy-saint-aubin.html` maps to the fixture wine; `/random-page` lands in unmatched.

- [ ] **Step 2: Run to verify failure**, implement. Discover uses `golang.org/x/net/html` for link extraction (`<a href>`), `encoding/xml` for the sitemap.

- [ ] **Step 3: Wire `runRedirects` (discovery half)** in `main.go`: `Discover` against the *current live* finevines.com → `MapURLs` with `data/wines.json` + `redirect-overrides.json` → write `redirects.json` → **print the unmatched list and the count** with the gate verdict: `"N redirects → Edge Rules"` (N≤20) or `"N redirects → Edge Scripting"` (N>20). Unmatched paths get manual entries added to `redirect-overrides.json` (or a deliberate decision to let them 404 → Bunny serves the custom 404 page; add `templates/404.html.tmpl` + `dist/404.html` to Task 9's page set if not already trivial — one-line addition).

- [ ] **Step 4: Run discovery for real** (needs only the public internet, no credentials): `finevines redirects` against `https://finevines.com` (the old site). Record the verdict in the task's commit message — **this resolves the crawl-gate decision** for Task 20.

- [ ] **Step 5: Commit** — `git commit -am "feat: old-site URL discovery, redirect mapping with overrides, redirects.json"`

---

### Task 20: Redirect publishing — Edge Rules (≤20) or Edge Scripting (>20)

**Files:**
- Create: `internal/redirects/publish_rules.go` + test, **or** `internal/redirects/publish_script.go` + `internal/redirects/middleware.ts.tmpl` + test — build the branch Task 19's verdict selected; stub the other with a clear "not needed, see plan Task 20" comment.
- Modify: `cmd/finevines/main.go` (`runRedirects` gains `--publish` flag behavior: without it, discovery+mapping only)

**Branch A — Edge Rules (map ≤ 20):**

- [ ] **Step A1: Verify the API.** WebFetch `https://docs.bunny.net/` API reference for `POST https://api.bunny.net/pullzone/{id}/edgerules/addOrUpdate` — confirm the request shape (`ActionType` for redirect = 301, `TriggerMatchingType`, trigger `PatternMatches` on `RequestUrl`) and the per-zone rule limit.
- [ ] **Step A2: Failing test** — httptest server capturing posted rules; given a 3-entry map, expect 3 addOrUpdate calls with correct old-URL pattern and 301 target; idempotency: rules carry a deterministic GUID derived from the old path (Bunny upserts by GUID) so re-runs update rather than duplicate.
- [ ] **Step A3: Implement + verify + publish to the staging pull zone; curl each old URL against staging expecting `301` + correct `Location`.**

**Branch B — Edge Scripting (map > 20):**

- [ ] **Step B1: Verify the surface.** WebFetch Bunny Edge Scripting docs (`https://docs.bunny.net/scripting/...`) for: middleware attachment to a Pull Zone, the `servePullZone`/`onOriginRequest` API, and the compute-script deploy API endpoint. Middleware can return a custom `Response` — a 301 with `Location` — before origin fetch.
- [ ] **Step B2: Failing test for script generation** — `GenerateMiddleware(mapped map[string]string) ([]byte, error)` renders `middleware.ts.tmpl`: the map embedded as a `const REDIRECTS: Record<string,string>` (sorted keys), lookup on `new URL(request.url).pathname + search`, hit → `new Response(null, {status: 301, headers: {Location: target}})`, miss → pass through. Test asserts the emitted TS contains the entries and compiles conceptually (string assertions; optionally run `deno check` if available locally — not in CI).
- [ ] **Step B3: Implement generation + publish** — deploy the script via Bunny's API (endpoint confirmed in B1); if the API proves awkward, the documented manual fallback is pasting the generated file into the Bunny dashboard (script is committed at `redirects.middleware.ts` so the dashboard copy is reproducible). Then curl-verify 301s against staging as in A3.

- [ ] **Step: Commit** — `git commit -am "feat: publish 301 map via bunny <edge rules|edge scripting> (crawl-gated)"`

---

## Phase G — Claude skills

### Task 21: Marketplace manifest + `finevines-news` skill

**Files:**
- Create: `.claude-plugin/marketplace.json`, `plugins/finevines-news/.claude-plugin/plugin.json`, `plugins/finevines-news/skills/finevines-news/SKILL.md`

**Interfaces:**
- Produces: an installable private marketplace (same pattern as existing GRIT plugins — mirror the structure of a working GRIT marketplace repo, e.g. the one CLAUDE.md's skills came from). The skill writes `data/news/<slug>.json` matching `model.NewsPost` exactly.

- [ ] **Step 1: Write `marketplace.json`**

```json
{
  "name": "finevines",
  "owner": { "name": "FineVines" },
  "plugins": [
    { "name": "finevines-news", "source": "./plugins/finevines-news",
      "description": "Post news & events to finevines.com" },
    { "name": "finevines-team", "source": "./plugins/finevines-team",
      "description": "Manage the finevines.com team roster" }
  ]
}
```

(Before committing, diff this structure against one of the working GRIT marketplace repos and match its exact field set — the format must load in Barbara's Claude Code, not just look right.)

- [ ] **Step 2: Write `SKILL.md`** — frontmatter `name: finevines-news`, `description: Use when posting a tasting, new arrival, or event to the FineVines website — interviews for the details, writes the post in the FineVines voice, and offers to publish.` Body instructs Claude to:
  1. Interview conversationally for: title, date (default today), category (`Events` / `New Arrivals` / `News`), location if an event, and the substance (2–5 short paragraphs). One question at a time; Barbara is the user — plain language, no jargon.
  2. Write the body in the FineVines voice: elegant, editorial, old-world wine trade; tagline energy without repeating the tagline; never invent facts not given in the interview.
  3. Compute `slug` (lowercase, hyphens, from the title), write `data/news/<slug>.json` with exactly the keys `title, date, category, body, image (optional), slug` — `date` as `YYYY-MM-DD`, `body` paragraphs separated by blank lines.
  4. Show the drafted JSON, get approval, then offer: *"Publish now? I'll run `finevines build` and `finevines deploy`."* — on yes, run `./finevines.exe build` then `./finevines.exe deploy` from the repo root and report the summary lines.
  5. Never touch `data/wines.json`, Salesforce, or anything else.

- [ ] **Step 3: Verify** — install the marketplace into a Claude Code session (`/plugin marketplace add <path>` per the GRIT pattern), invoke the skill, dry-run an interview, confirm the JSON lands in `data/news/` and `finevines build` renders it (fixture-level check: run build, see the post page).

- [ ] **Step 4: Commit** — `git commit -am "feat: private marketplace and finevines-news skill"`

---

### Task 22: `finevines-team` skill

**Files:**
- Create: `plugins/finevines-team/.claude-plugin/plugin.json`, `plugins/finevines-team/skills/finevines-team/SKILL.md`

- [ ] **Step 1: Write `SKILL.md`** — frontmatter `name: finevines-team`, `description: Use when adding, removing, or editing a team member on the FineVines About page.` Body: read `data/team.json`; for **add**: ask for name, role, email, optional photo (if a photo file is provided, copy it to `assets/img/team/<slugified-name>.jpg` and set `photoPath`), optional note; for **remove**: confirm by name, delete the entry; for **edit**: show current entry, apply the change. Always show the resulting JSON diff, get approval, write the file (array order = roster order; new members append), then offer the same build-and-deploy step as the news skill. Never touch any other file.

- [ ] **Step 2: Verify** — same live-session dry run: add a fake member, see them render on `/about/` after `finevines build`, remove them.

- [ ] **Step 3: Commit** — `git commit -am "feat: finevines-team skill for about-page roster management"`

---

## Phase H — Ops & Launch

### Task 23: `deploy.bat`, ops docs, Windows packaging

**Files:**
- Create: `deploy.bat`, `docs/operations.md`
- Modify: `README.md` (replace proposal-era content with project README: what this repo is, the four subcommands, how to build the exe, link to operations doc)

- [ ] **Step 1: `deploy.bat`**

```bat
@echo off
REM FineVines nightly/on-demand pipeline. Run from the repo root.
finevines.exe enrich || goto :fail
finevines.exe build || goto :fail
finevines.exe deploy || goto :fail
echo Done.
exit /b 0
:fail
echo FAILED — see output above. The site was NOT updated.
exit /b 1
```

- [ ] **Step 2: `docs/operations.md`** — written for the FineVines machine, not for developers: install location, `.env` setup (every key, where each credential comes from — cross-reference C1–C4), how to run `deploy.bat` manually, Task Scheduler setup (nightly 2:00 AM, "run whether user is logged on or not", working directory = repo root), what the summary output means, what to do when it fails (call GRIT), and the rule that `data/news/` + `data/team.json` are Barbara's via the skills while `data/wines.json` is machine-owned.

- [ ] **Step 3: Build the release exe** — `$env:GOOS="windows"; $env:GOARCH="amd64"; go build -ldflags "-s -w" -o finevines.exe ./cmd/finevines` — confirm single-file, no DLLs, runs on a clean Windows box (or at minimum a clean directory).

- [ ] **Step 4: Commit** — `git commit -am "feat: deploy.bat, operations runbook, release build instructions"`

---

### Task 24: Staging E2E, initial full run, cutover (maps spec §11)

*This task is a checklist executed with the client, not code. Blocked on C1–C5 complete and Tasks 1–23 done.*

- [ ] **Step 1: Full staging rehearsal** — on the FineVines machine (or GRIT's, pointed at staging zones): real `finevines enrich` over the **full** catalog (5–10k wines; expect hours; checkpointing means interruptions are safe). Monitor the label-fallback rate — if >15% of images fall back, review a sample of Imagen rejections before launch (prompt tweak in Task 13's system prompt is the lever).
- [ ] **Step 2: `finevines build` + manual QA** — spot-check ~20 wine pages across regions (copy quality, no invented facts — compare against SF fields; images present; diacritics render), portfolio facets with the real distribution, news, about (real roster, real emails per C1 contact), mobile viewport, Lighthouse pass on home + one wine page (target: no red).
- [ ] **Step 3: `finevines redirects`** — regenerate against the live old site, resolve every unmatched path (override or deliberate 404), publish to staging, verify a sample of 301s incl. any URLs George supplied (C6).
- [ ] **Step 4: `finevines deploy`** to staging; full-site click-through on the staging URL.
- [ ] **Step 5: Production cutover** — create/point the production Pull Zone at the production Storage Zone; deploy dist + redirects to production zones; lower DNS TTL a day ahead; point `finevines.com` (+ `www`) at the production Pull Zone hostname; enable Bunny's free SSL for the domain; verify `https://finevines.com` serves the new site and old URLs 301 correctly from the public internet.
- [ ] **Step 6: Post-launch checks** — `site:finevines.com` in Google over the following days (existing index carries over — GSC *setup* is out of scope, but don't regress existing indexing: confirm `robots.txt` and sitemap are reachable); Task Scheduler nightly job enabled and observed green once; hand Barbara the skills walkthrough (install marketplace, post one real news item as the training exercise).
- [ ] **Step 7: Tag** — `git tag v1.0.0 && git push --tags` (if a remote exists); deliver per the fixed-fee milestone.

---

## Self-review (completed at plan time)

- **Spec coverage:** §1 scope items 1–7 → Tasks 5–9 (site), 13–16 (enrichment), 11–18 (sync+deploy), 19–20 (redirects), 22 (team skill), 21 (news skill), 24 (launch). §2 architecture/repo layout → Tasks 1, layout matches spec tree (plus `internal/config`, `tools/` — additive). §3 data contract → Task 2 (deviation #1 noted: image extensions). §4 → Tasks 3, 11, 12, 16. §5 → Tasks 10, 13–15. §6 → Tasks 4–9. §7 → Tasks 19–20. §8 → Tasks 17–18. §9 → Tasks 21–22. §10 testing → every task is test-first; E2E in Task 24. §11 launch → Task 24. Open assumptions → all four resolved 2026-07-24 (Global Constraints).
- **Placeholder scan:** the two intentional look-up-at-implementation points (Imagen wire format Step 14.1, Bunny Edge Rules/Scripting API Steps 20.A1/B1) are explicit verification *steps with named URLs*, not TBDs; Salesforce field names are marked as a checkpoint tied to client action C1 — unavoidable until org access exists, and the code compiles/tests without it.
- **Type consistency:** `salesforce.WineRaw`/`Source` (T3) consumed by T11–T16 with matching signatures; `model.Wine` JSON tags identical across T2/T6/T21; `enrich.TextResult.ImagePrompt` (T13) feeds `ResolveImage(… prompt …)` (T15); `deploy.Plan` manifest type `map[string]string` consistent across T17–T18; `NewClient(cfg, *http.Client)` two-arg form used in both T11 and T16 wiring.

# Fine Vines Static Site — Design Spec

Status: confirmed for build. Scope: **Full build, Core** ($12,000) **+ News & Events skill** ($900).

## 1. Confirmed scope

**In scope:**
1. Website & catalog rebuild — home, portfolio/catalog (faceted search), wine detail, news & events, about, contact. Fully responsive, refined from the existing prototype's design system.
2. Wine enrichment (text & imagery) — one AI pass per wine: tasting description + sommelier notes (Claude API), plus a generated bottle image.
3. Sync program & deploy — Go binary: reads Salesforce, applies eligibility rules, incremental (roster-diff) runs, deploys to Bunny.net with cache purge.
4. Redirects from the current site — every existing finevines.com URL 301s to its new location; Google footprint carries over.
5. About-page team skill — Claude skill (marketplace plugin) to add/remove team members (name, role, email).
6. News & Events skill — Claude skill (marketplace plugin) to post tastings/arrivals/events; generates a landing page **and** an individual indexable page per post.
7. Launch — initial 5,000–10,000-wine enrichment run, QA, go-live on the finevines.com domain.

**Explicitly out of scope (not purchased — do not build):**
- Wine-knowledge hub (tasting guides / pairings content section)
- Statewide prospecting engine (AI-scraped lead list + auto cold-email)
- Customer email blasts skill
- Cold outreach & lead-gen skill
- Analytics & Search Console setup (GA4 / GSC)
- Credit Application PDF + download button
- Retiring Salesforce (QuickBooks-direct integration) — future, unscoped
- E-commerce / online ordering, customer logins

If any of these come up during implementation, treat them as out of scope and flag rather than build.

## 2. Architecture

One dependency-free Go binary (`finevines`), compiled to a single `.exe`, run from a Windows machine at Fine Vines. Four subcommands; each is independently runnable and testable.

```
finevines enrich    Salesforce → data/wines.json + assets/img/wines/*  (network, slow, incremental)
finevines build     data/*.json → dist/*                                (pure, deterministic, no network)
finevines redirects dist/_redirects (or per-page <meta> + server rules) from a discovered URL map
finevines deploy    dist/ → Bunny.net Storage Zone + Pull Zone purge    (network, hash-diff upload)
```

`deploy.bat`: `finevines.exe enrich && finevines.exe build && finevines.exe deploy`, runnable on demand or via Windows Task Scheduler (nightly).

### Repository layout

```
finevines-website/
  .claude-plugin/marketplace.json      marketplace manifest
  plugins/
    finevines-news/                    News & Events Claude skill
    finevines-team/                    About-page team Claude skill
  cmd/finevines/                       main.go, subcommand wiring
  internal/
    salesforce/                        Source interface + Salesforce implementation
    enrich/                            roster-diff, text enrichment, image pipeline
    label/                             deterministic SVG label/bottle generator
    build/                             site generator (html/template)
    redirects/                         URL discovery + redirect map generation
    deploy/                            Bunny.net client, hash-diff upload
    model/                             shared structs: Wine, NewsPost, TeamMember
  data/
    wines.json                         machine-generated cache + build input (git-tracked)
    news/<slug>.json                   one file per post, human-authored via skill
    team.json                          team roster, human-authored via skill
  assets/
    img/wines/<sku>.webp               generated or sourced bottle images
    fonts/, css/                       self-hosted brand fonts + design system
  templates/                           Go html/template files
  dist/                                build output (git-ignored) — what deploys
  redirects.json                       old-URL → new-URL map (generated, git-tracked)
  deploy.bat
```

## 3. Data contract

`data/wines.json` — array of:
```json
{
  "id": "SF-00123",
  "sourceHash": "sha256 of raw SF fields, for roster-diff",
  "sku": "AB1234",
  "producer": "Hubert Lamy",
  "name": "Saint-Aubin 1er Cru « Derrière chez Édouard »",
  "vintage": "2021",
  "varietal": "Chardonnay",
  "region": "Burgundy",
  "appellation": "Saint-Aubin 1er Cru",
  "style": "White · Still",
  "stockQty": 14,
  "description": "AI-generated tasting description",
  "sommelierNotes": "AI-generated notes",
  "imagePath": "assets/img/wines/AB1234.webp",
  "imageSource": "generated-photo | generated-label | producer-supplied",
  "slug": "hubert-lamy-saint-aubin-1er-cru-derriere-chez-edouard-2021"
}
```

`data/news/<slug>.json` — one file per post: `{ title, date, category, body, image?, slug }`.

`data/team.json` — array of: `{ name, role, email, photoPath?, note? }`.

These three JSON shapes are the seam between the Claude skills / enrich pipeline (producers) and `build` (consumer). `build` never talks to Salesforce or Claude directly — it only reads these files.

## 4. `enrich` — Salesforce → wines.json

- **Source interface**: `type Source interface { Roster() []RosterEntry; Fetch(id string) (WineRaw, error) }`, implemented by `salesforce.Client`. Keeps QuickBooks-direct pluggable later without touching `enrich`'s orchestration.
- **Salesforce is the read source** (confirmed: QuickBooks is authoritative in principle, but already syncs to Salesforce, so `enrich` reads the synced layer — no new QuickBooks integration).
- **Web-eligibility rule**: `stockQty > 0 AND !strings.HasPrefix(sku, "9")`. Encode as a small `rules.go` (or `rules.yaml` if we want it editable without recompiling — default to Go const unless the user asks for runtime config).
- **Roster-diff (incremental)**:
  1. Query Salesforce roster: eligible IDs + a cheap change signal (`LastModifiedDate` or similar) — no full record fetch.
  2. Diff against `data/wines.json` (keyed by Salesforce ID, comparing `sourceHash`).
  3. New ID → enrich. Changed hash → re-enrich. Missing from roster → remove from `wines.json` (drops off the site). Unchanged → skip entirely (no API/LLM/image cost).
  4. This makes "new product" and "sold out" both fall out of the same diff — no special-casing.
- **Runs**: on-demand (manual invocation) and nightly (Windows Task Scheduler). Initial run enriches the full 5–10k catalog; every run after is a delta.
- **Text enrichment**: Claude API (Anthropic Go SDK or REST), grounded prompt using only real fields (producer, region, varietal, vintage, style) → tasting description + sommelier notes. Never invents facts not in the source data.

## 5. Image pipeline

Provider chain per wine, first success wins, result cached by `sourceHash` so it only ever runs once per wine version:

1. **AI-generated photorealistic bottle** — Claude writes a per-wine image prompt (producer, region, vintage, varietal, style → prompt), sent to an image-generation model. Store the model/provider choice as a config value (not hardcoded) since this is the newest, most likely-to-change piece.
2. **Deterministic vector label/bottle fallback** — the Go-native SVG generator prototyped for the proposal (château-style label: frame/crest/ornament/palette system, ~10 visual treatments, wine-branded — never Fine Vines–branded). Always succeeds, zero cost, on-brand. This is the guaranteed floor: no wine ever ships with a broken image.
3. **Producer-supplied photography** — manual override slot; if Fine Vines later supplies real photos, they drop in and `imageSource` flips to `producer-supplied`, which `enrich` should never overwrite.

Port the label-generation logic from the proposal's prototype JS (`build.js`'s `label()`/`bottle3d()` functions) to Go, preserving the same visual system (frame styles: double/single/oval/deco/minimal; crest styles: ring/medallion/shield/fleuron/fan). This is a straight logic port, not a redesign.

## 6. `build` — JSON → static site

Pure function of `data/*.json` → `dist/`. No network calls. Deterministic (same input → byte-identical output, aside from any timestamp fields — avoid those where possible for clean diffs).

**Pages generated:**
- `/` — homepage
- `/portfolio/` — catalog list page, pre-rendered, plus a generated compact search index (`dist/search-index.json`) for the client-side faceted filter (producer/varietal/region/vintage/size/style). ~5KB vanilla JS, no framework.
- `/wines/<slug>/` — one page per wine. JSON-LD `Product`/`Offer` schema, unique `<title>`/meta description, canonical URL, real `alt` text on the image.
- `/news/` — news & events landing page.
- `/news/<slug>/` — one page per post (mirrors the wine-detail pattern: same JSON-driven, pre-rendered approach).
- `/about/` — team roster from `team.json`.
- `/contact/`
- `/sitemap.xml`, `/robots.txt` — auto-generated from the full page set.

**SEO baseline**: every content page is real, crawlable HTML (not client-assembled JS) — this is the entire point of the rebuild vs. the current single-JS-file prototype. Self-hosted webfonts (Cormorant Garamond, EB Garamond, Archivo — already extracted during the proposal work) — no Google Fonts CDN dependency.

## 7. Redirects

- `finevines redirects` crawls/catalogs every URL currently live on finevines.com (sitemap + crawl fallback), and maps each to its corresponding new URL under the rebuilt site's structure (best-effort automatic matching by slug/producer, manual override list for anything ambiguous).
- Output: `redirects.json` (old → new), consumed by `deploy` to publish as Bunny.net edge-rule redirects (or static `_redirects`-style rules, depending on what Bunny.net's Storage/Pull Zone supports — confirm mechanism during implementation).
- Goal: zero broken links, Google's existing index of finevines.com carries over rather than resets.

## 8. `deploy` — Bunny.net

- Concurrent upload to a Bunny.net Storage Zone, **hash-diff**: only upload files whose content hash changed since the last deploy (manifest stored alongside `dist/`, or recomputed from Bunny's own file listing).
- After upload, purge the Pull Zone cache.
- Config (zone name, API key, pull zone ID) via environment variables / a git-ignored `.env` — never committed.
- Must handle the 5–10k-wine scale without naive one-file-at-a-time sequential upload (this is why it's a real subcommand, not a shell loop).

## 9. Claude skills (marketplace plugins)

Both live in this repo under `plugins/`, installable via `.claude-plugin/marketplace.json` as a private marketplace (same pattern as other GRIT plugins).

**`finevines-news`**: interviews for title/date/location/category/body/optional image → writes `data/news/<slug>.json` in the Fine Vines voice → offers to run `build && deploy`.

**`finevines-team`**: add/remove a team member (name, role, email, optional photo/note) → edits `data/team.json` → offers to run `build && deploy`.

Neither skill touches Salesforce or the enrich pipeline — they only write their own JSON file. This keeps the machine-generated (wines) and human-authored (news, team) halves of the site fully decoupled.

## 10. Testing / QA

- `enrich`: unit-test the eligibility rule and roster-diff logic against fixture data (no live Salesforce calls in tests).
- `build`: golden-file tests — fixed sample `wines.json`/`news/*.json`/`team.json` → assert generated HTML matches expected output (structure, JSON-LD presence, sitemap entries).
- `deploy`: test the hash-diff logic in isolation (given a manifest + a `dist/`, assert the correct upload/skip set) without hitting the real Bunny.net API in CI.
- End-to-end: a full `enrich && build && deploy` dry run against a Bunny.net staging/test zone before the real `finevines.com` cutover.

## 11. Launch checklist (maps to the "Launch" line item)

1. Full initial `enrich` run across the confirmed 5–10k-wine catalog.
2. `build` the complete site; manual QA pass (spot-check wine pages, portfolio search, news, about, mobile).
3. `redirects` generated and verified against a sample of real inbound links.
4. `deploy` to a staging Bunny.net zone first; verify.
5. Point `finevines.com` DNS at the production Bunny.net zone; deploy for real.
6. Confirm redirects live, spot-check Google Search Console coverage isn't broken (even though GSC *setup* itself is out of scope, don't accidentally regress whatever indexing already exists).

## Open assumptions to confirm before/at plan time

- **Image-generation provider**: which model/API for the photorealistic bottle image (cost + integration approach) — not yet chosen.
- **Bunny.net redirect mechanism**: exact feature used for the 301 map (edge rules vs. static config) — confirm against current Bunny.net product capabilities.
- **Salesforce auth**: connected-app / OAuth setup details, and exact fields available on the synced QuickBooks data — need read access confirmed before `enrich` can be built against the real org.
- **`rules.yaml` vs. compiled constant** for the eligibility rule — default to a compiled constant unless the user wants it runtime-editable.

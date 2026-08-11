# Catalog bottle photography — problem statement and handoff

Written 2026-08-10. For an engineer or agent picking up the image pipeline.

## The situation in one paragraph

FineVines publishes a static wine catalog of ~2,640 rows (1,894 cards once
vintages collapse). Roughly half the cards show a neutral "Product image
unavailable" placeholder instead of a bottle photograph. An existing pipeline
(`tools/labelfetch/`) searches the web for real bottle photos, verifies their
identity, and imports them. It has been running for weeks and had converged at a
~0.7% hit rate, which everyone read as "the open web simply has no photograph of
these wines." That conclusion was wrong, and the reasons are now understood and
measured. This document states them so the fix can be built without repeating
the investigation.

## What is actually wrong

### 1. Google discovery was silently dead (now fixed)

`FINEVINES_GOOGLE_CSE_KEY` was restricted in Google Cloud Console to **HTTP
referrers**, which only permits browser-originated calls. Every server-side call
returned:

```
HTTP 403 — "Requests from referer <empty> are blocked."
```

The pipeline swallowed the error and fell back to DuckDuckGo alone. The client
changed the restriction to "None" on 2026-08-10 and Google discovery now works.
**Verify this still holds before doing anything else** — a single query against
the Custom Search API is enough.

### 2. Dead results were cached as permanent verdicts

Two layers turned that outage into a settled fact:

- `data/fetched-images/manifest.json` recorded every wine already tried. The
  pipeline skips anything present, so 2,623 wines were permanently skipped on
  the strength of a search that never ran. (Moved aside to
  `data/fetched-images-preGoogle/` on 2026-08-10.)
- `data/image-attempts.json` gives every `miss` a 30-day backoff. 956 wines were
  benched by verdicts reached without Google. (Cleared 2026-08-10; the prior
  state is at `data/image-attempts.preGoogle.json` and in git history.)

**Lesson worth keeping:** when a discovery source fails, the pipeline should
record "could not search" rather than "nothing found". The current design cannot
distinguish them, and that is what made a config error look like a fact about
the world.

### 3. The real bug: it searches for PAGES, then scrapes them

This is the important one and it is not yet fixed.

`tools/labelfetch/pipeline.mjs` asks Google Custom Search for **web results**,
then fetches each page and tries to extract a bottle image from the HTML. That
fails constantly for reasons that have nothing to do with whether a photograph
exists:

| Failure | Example |
|---|---|
| Site is a JS app; product links are `#` | `regalwine.com` — the importer's own site. Scraper retrieved `Regal-Logo-White.png` six times and a map of the Rhône. |
| Site blocks automation | `wine.com` returns **403 to real Chrome**, not just to fetch. Do not attempt to defeat this. |
| Page has the image but not in parseable HTML | many retailers |

**Google Custom Search has an image mode — `&searchType=image` — that returns
direct image URLs, dimensions, and the host.** No page parsing at all. It was
never used.

### Measured result

Sampled 30 wines that the current pipeline had **just failed on**, queried the
image endpoint, excluded blocked hosts, and kept results ≥400px tall with a
height:width ratio ≥1.3:

```
with any allowed-host image : 29 of 30
with a bottle-shaped image  : 29 of 30   (97%)
```

Examples of what it found that page-scraping missed — note these are the
*importer's and producer's own* images, the best provenance available:

```
Domaine Jean Royer Chateauneuf du Pape Cuvee Prestige
    www.regalwine.com     188x700   Domaine-Jean-Royer-Chateauneuf-du-Pape-Prestige…
Cider Farm Oak Aged Cider
    www.theciderfarm.com  480x800   TCF_Cider_OakAged.png
```

## The task

Add image-mode discovery to the pipeline as a first-class source, feeding the
**existing** verification gates unchanged. Do not weaken the gates: they exist
because 551 wrong photographs reached the live site in August and had to be
pulled.

Specifically:

1. Query `searchType=image` for each wine alongside the current web search.
2. Filter by the existing host allowlist (`tools/labelfetch/sources.mjs`).
3. Feed surviving candidates into the same chain: `imgcheck` identity
   verification → `watermarksweep.mjs` → `prepublish.mjs --clean-only` →
   `import.mjs --apply --clean-only`.
4. Keep the attempt ledger honest — see the lesson in §2.

## Hard constraints — do not relax these

**Blocked hosts stay blocked.** `tools/labelfetch/sources.mjs` excludes Vivino,
Wine-Searcher, iDealwine and others. This is NOT a copyright question — the
client already accepted that risk in writing. It is that those hosts burn their
own brand into the pixels, and publishing them means FineVines' product pages
advertise a competitor. Decided 2026-07-28. A watermark survives resizing, and
nobody reviewing 2,000 thumbnails will catch it, so the block is enforced by
host rather than by inspecting pixels.

**Do not circumvent bot protection.** `wine.com` returns 403 to a real browser.
That is their access control, deliberately set. Reading a page a site serves you
is fine; defeating a block is not. Skip those hosts.

**Identity verification is not optional.** The gates reject: a label naming a
different wine, multiple bottles, a magnum or gift carton, and a visible vintage
that contradicts the row. A "hit" is not a verified identity. Watch for the
known blind spot — right producer, wrong cuvée (a village Pommard photo on a 1er
Cru Les Epenots). Matching must be bidirectional and exact; edit-distance
tolerance reads "Genevrieres Dessus" and "Genevrieres Dessous" as one vineyard,
and they are two.

**Beware synthetic images.** A retailer candidate came back named
`ChatGPTImageApr20_2026_05_1…`. AI-generated bottle shots are appearing on
retail sites. Prefer producer and importer hosts over retailers.

## Two more findings worth acting on

**The spirits exclusion is obsolete.** `pipeline.mjs` skips anything matching a
spirits regex, justified by "Vivino is wine-only, so a spirit will never resolve
there." Vivino has been blocked since July. This costs 46 wines — 13 of them
from The Cider Farm, whose own site carries the photographs (verified). Remove
the skip; the identity gates already protect against bad matches.

**Vision spend is avoidable on Windows.** `imgcheck` reads labels with the OCR
built into Windows (`tools/imgcheck/ocr.ps1`, `Windows.Media.Ocr`) — local, free,
no API key. The nightly CI runner is `ubuntu-latest`, which cannot use it, so CI
passes `--vision-first` and pays OpenAI (`gpt-4.1-nano`) for every candidate
image instead. The repo is public, so GitHub Actions minutes are free on any
runner OS. Whether `Windows.Media.Ocr` works on GitHub's Windows Server image is
**unverified** — one throwaway workflow run would settle it.

## How to check your work

- `go test ./...` and `npm run test:unit` must stay green.
- Import is deliberate and separate from fetching. `data/fetched-images/` is
  staging; nothing reaches the catalog until `import.mjs --apply --clean-only`.
- **Read a built page, not just the test output.** Three separate defects this
  week passed tests and were only caught by reading rendered HTML: a truncated
  404, a content block printed three times, and a quote stuttering against the
  prose it duplicated.
- Coverage is measured by `node tools/coverage/report.mjs`. Quote the **card**
  number, not the row number — a card is what a visitor sees, and vintages
  collapse into one.

## Where things stood at handoff

- 990 of 1,894 cards (52.3%) carry a real photograph.
- 1,145 wines have none. Of those, only 458 have an importer named in
  Salesforce; see `docs/importer-photo-requests.md` for who to ask.
- The old finevines.com is fully mirrored at `data/oldsite-full/` (1,219 pages,
  2,980 assets) before it goes offline at DNS cutover. It is exhausted as an
  image source — measured three independent ways.

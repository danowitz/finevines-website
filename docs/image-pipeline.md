# How catalog bottle images are produced

The complete path from a Salesforce row to a photograph on the site.

```
data/wines.json
      │
      ▼  tools/labelfetch/pipeline.mjs          (Node + real Chrome)
  ┌───────────────────────────────────────────────────────────────┐
  │ 1  DISCOVER     search → candidate product pages              │
  │ 2  EXTRACT      load page → download image candidates         │
  │ 3  SOURCE GATE  reject watermarked hosts          sources.mjs │
  │ 4  VERIFY       is it one bottle? is it THIS wine? imgcheck   │
  │ 5  STAGE        data/fetched-images/ + manifest.json          │
  └───────────────────────────────────────────────────────────────┘
      │
      ▼  (a human looks at the staged images)
      │
      ▼  tools/labelfetch/import.mjs --apply
  ┌───────────────────────────────────────────────────────────────┐
  │ 6  NORMALISE    re-compose onto one canvas         imgnorm    │
  │ 7  IMPORT       assets/img/wines/ + wines.json provenance     │
  └───────────────────────────────────────────────────────────────┘
      │
      ▼  finevines build  →  dist/
```

## Running it

```sh
go build -o imgcheck.exe ./tools/imgcheck     # verifier
go build -o imgnorm.exe  ./tools/imgnorm      # normaliser

node tools/labelfetch/pipeline.mjs --n 20 --missing   # try 20 wines
node tools/labelfetch/pipeline.mjs --all --missing    # every wine lacking a photo
node tools/labelfetch/pipeline.mjs --slug <slug>      # one wine, verbose

node tools/labelfetch/import.mjs                      # dry run
node tools/labelfetch/import.mjs --apply              # write
```

Fetching never writes to `data/wines.json` or `assets/`. Import is a separate,
deliberate, dry-run-by-default step. A single command that fetched two thousand
images and rewrote the catalog would be very hard to unpick if one producer's
matches turned out wrong.

## Measured

On a 20-wine sample of the catalog's un-photographed wines: **13/20 accepted
(65%)**, all 13 confirmed by eye to be the correct wine, single bottle, clean
background, no watermark.

Progression while building it, each step a fix to a specific defect:

| | accepted | what changed |
|---|---|---|
| first run | 25% | — |
| | 35% | stopped fetching images through a canvas (see below) |
| | 40% | accepted square images; verified every candidate, not just the largest |
| | **65%** | transcoded non-JPEG/PNG; widened from 3 candidate pages to 5 |

Rejections on the final run, all correct: 19 photographed scenes, 13 subjects
too wide for a bottle, 8 multipacks, 10 labels that named a different wine.

## Why each stage is the way it is

**Discovery uses a general search engine, not a wine site.** Site search pages
serve small thumbnails and lazy-load unpredictably — six of eight yielded
nothing usable. General search returns *product* pages, and often the
producer's own domain (`brunoclair.com`, `gruaud-larose.com`,
`susanaesteban.com`), which is the best source available: authoritative,
unbranded, and incapable of showing a different grower's bottle. Those are
sorted first.

**Vivino is blocked** (`sources.mjs`). It was the first source that worked and
its photography is ideal — normalised, cut out, consistently framed. Every file
carries a burned-in watermark. Publishing those on a licensed distributor's
catalog is not "we used someone's photo", it is "our product pages advertise
Vivino". The block throws rather than returning a flag, because the failure is
silent: a watermark survives resizing, nobody reviewing 2,000 thumbnails will
catch it, and the images are attractive enough that a future run would reach for
them again.

**Verification looks at the image, not the page.** Search ranks by relevance and
never returns nothing. Asking for FX Pichler's Kellerberg returns Max Ferd.
Richter Mosels on pages whose text is entirely consistent — because they
genuinely are Richter listings. Trusting the top hit put the wrong producer's
bottle on 2 of 6 wines in an early check. Only the label settles it. See
`tools/imgcheck` for the two stages and the OCR thresholds, each of which
exists because of a specific observed failure.

**Normalisation happens at import.** Verified images are correct but wildly
inconsistent: 500x650 through 1200x1200, bottles at every scale. A grid of
those jostles, which is the original complaint about the catalog. Every image is
re-composed onto one 600x900 canvas with the bottle at a fixed height, so a
Bordeaux and a Burgundy sit at the same scale.

## Traps, all of which cost real accuracy

- **Never fetch an image through a canvas.** Setting `crossOrigin='anonymous'`
  makes any host without CORS headers fail to load *entirely*; leaving it unset
  taints the canvas so `toDataURL` throws. This silently cost 13 of 20 wines.
  Navigate to the image and take the response body instead. A canvas is only
  for transcoding bytes you already hold, via a same-origin `data:` URL.
- **Square images are product shots.** An aspect-ratio filter of 1.05 at the
  extraction stage discarded the producers' own 500x500 bottle shots before
  anything looked at them. `imgcheck` measures the *subject's* proportions, not
  the canvas's, so let it decide.
- **An undecodable candidate is a rejection, not a crash.** Retailers serve
  AVIF, SVG and truncated files.
- **A "hit rate" is not an accuracy rate.** The first measurement of this work
  reported 90% found and was 67% correct. Always confirm what was found is the
  wine that was asked for.

## Known gaps

- **Spirits are excluded.** 46 catalog items are whisky, gin, cider and the
  like; wine search will not find them and they need a different source.
- **7 of 20 still miss.** Mostly pages where no candidate downloaded at all.
  More candidate pages would raise it further at the cost of run time.
- **A few sources shoot on cream rather than white**, so the normalised canvas
  shows a slightly different ground. Visible only side by side.
- **Copyright.** The client accepted the risk of sourcing images by web search
  (see `CLAUDE.md`, 2026-07-26). That decision does not extend to watermark
  removal, which is refused. The best long-term answer remains supplier and
  importer asset libraries, which exist precisely so distributors can use them.

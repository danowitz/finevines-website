# Catalog image pipeline

Fine Vines publishes a verified source photograph when one is available. When
one is not available, the site uses a product-neutral “Product image
unavailable” SVG. It does not invent bottle, label, closure, or packaging
artwork.

## Publication path

1. `tools/labelfetch/pipeline.mjs` sends the exact catalog identity to Google's
   image endpoint, downloads only the first ten permitted direct images, and
   groups bottle/label designs locally. One readable anchor validates a repeated
   design; the cleanest highest-resolution member wins. At most three images are
   transcribed in one `gpt-4.1-nano` request, with no escalation.
2. The selector records an explicit identity-success bit only after its blind
   transcription and deterministic conflict gates accept the repeated design.
3. `tools/labelfetch/watermarksweep.mjs --apply` is a separate hard gate.
   Watermarked or unevaluated files cannot publish.
4. `tools/labelfetch/import.mjs --apply --clean-only` normalizes and imports
   only clean candidates that passed both gates.
5. `finevines build` creates the static site and generates the same neutral SVG
   for any missing fallback asset.

Fetching and verification stage files under `data/fetched-images/`; they do not
change the public catalog. Import is the deliberate write step.

## Running a reviewed batch

```sh
go build -o imgcheck.exe ./tools/imgcheck
go build -o imgnorm.exe ./tools/imgnorm

node tools/labelfetch/pipeline.mjs --n 20 --missing
node tools/labelfetch/watermarksweep.mjs --apply
node tools/labelfetch/import.mjs --clean-only          # dry run
node tools/labelfetch/import.mjs --apply --clean-only
```

The unattended entrypoint is:

```sh
node tools/labelfetch/autonomous.mjs --apply --search-provider brave
```

It performs a live configured image-endpoint health check before touching a wine,
then owns the fixed order: fetch/verify â†’ two-source auto-approval â†’ watermark
gate â†’ clean-only import â†’ exception review. It writes an atomic run receipt
to `.run/image-workflow.json` before and after every stage. A missing credential,
disabled API, failed perceptual hash, failed child process, or missing verdict
stops publication rather than being converted to â€œnothing found.â€

`tools/labelfetch/cistage.sh` remains only as a compatibility entrypoint and
delegates to that command. For a non-publishing probe, use
`node tools/labelfetch/autonomous.mjs --canary --n 20`.

Two-source approval is intentionally narrower than visual similarity alone:
the matching files must come from independent permitted hosts, both source
pages must identify the requested product, explicit identity conflicts are
vetoes, and a vintage-specific row selects an exact-vintage or genuinely
vintage-neutral source. Flagged and ambiguous candidates remain staged for
human review; the absence of a verdict fails closed.

The scheduled GitHub workflow runs the complete Node unit suite and Go suite
before taking its before-state snapshot or invoking any catalog-writing stage.
The image runner is therefore autonomous only after the checked-out revision
passes the same rule, ledger, import, and deploy regression coverage used by
ordinary CI. GitHub retains the stage receipt as a 30-day workflow artifact,
including failed runs; it is not mixed into the catalog commit.

## Source and cleanup rules

- Prefer producer and importer asset libraries, then reputable retailer product
  pages. Keep the source URL in `imageSourceUrl`.
- Never fetch from a search-results page and never publish watermarked imagery.
  Watermark removal is not an allowed cleanup operation.
- Deterministic cleanup may crop excess canvas, remove a simple background, and
  normalize scale without redrawing the bottle or label. `bgcut.py` followed by
  `imgnorm` is the supported path for a reviewed source file.
- Visible contradictory producer, cuvee, or vintage information is a rejection.
  A “hit” is not a verified identity.
- A Google permission, quota, transport, or credential failure is unavailable,
  never an empty result. The wine stays due and receives no miss/backoff entry.
- Generated bottle-photo tools are disabled. Earlier generated-photo catalog
  entries were migrated to the neutral fallback.

## Known gaps

- Spirits and uncommon back vintages often lack usable open-web photography and
  may remain on the neutral fallback until supplier media is obtained.
- The client accepted the copyright risk of sourcing real product imagery by web
  search. That does not extend to watermark removal or invented packaging.

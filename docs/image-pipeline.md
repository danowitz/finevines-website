# Catalog image pipeline

Fine Vines publishes a verified source photograph when one is available. When
one is not available, the site uses a product-neutral “Product image
unavailable” SVG. It does not invent bottle, label, closure, or packaging
artwork.

## Publication path

1. `tools/labelfetch/pipeline.mjs` discovers product pages, downloads candidate
   images, rejects blocked sources, and checks that the image depicts one bottle
   matching the requested producer and cuvee.
2. `tools/labelfetch/consensus.mjs --apply` can corroborate candidates found on
   different hosts.
3. `tools/labelfetch/watermarksweep.mjs --apply` is a hard gate. Watermarked or
   unevaluated files cannot publish.
4. `tools/labelfetch/prepublish.mjs --clean-only --apply` independently reads
   the full-resolution staged file. Only a literal affirmative verdict for the
   exact producer and cuvee passes; a contradictory visible vintage fails.
5. `tools/labelfetch/import.mjs --apply --clean-only` normalizes and imports
   only clean candidates that passed both hard gates.
6. `finevines build` creates the static site and generates the same neutral SVG
   for any missing fallback asset.

Fetching and verification stage files under `data/fetched-images/`; they do not
change the public catalog. Import is the deliberate write step.

## Running a reviewed batch

```sh
go build -o imgcheck.exe ./tools/imgcheck
go build -o imgnorm.exe ./tools/imgnorm

node tools/labelfetch/pipeline.mjs --n 20 --missing --vision-first
node tools/labelfetch/consensus.mjs --apply
node tools/labelfetch/watermarksweep.mjs --apply
node tools/labelfetch/prepublish.mjs --clean-only --apply
node tools/labelfetch/import.mjs --clean-only          # dry run
node tools/labelfetch/import.mjs --apply --clean-only
```

The unattended equivalent is `tools/labelfetch/cistage.sh`. It uses the same
watermark, independent identity, and clean-only publication gates. Flagged
candidates remain staged for human review; the absence of a verdict fails
closed.

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
- Generated bottle-photo tools are disabled. Earlier generated-photo catalog
  entries were migrated to the neutral fallback.

## Known gaps

- Spirits and uncommon back vintages often lack usable open-web photography and
  may remain on the neutral fallback until supplier media is obtained.
- The client accepted the copyright risk of sourcing real product imagery by web
  search. That does not extend to watermark removal or invented packaging.

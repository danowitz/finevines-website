#!/usr/bin/env bash
# The nightly image stage, in the one order that is safe.
#
#   fetch + verify  ->  watermark sweep  ->  import survivors
#
# Deliberately incremental: a bounded slice of the wines still lacking a
# photograph each night, not all of them (see the fetch step). The coverage figure
# climbs a little every night rather than in one run that cannot finish.
#
# What carries between nights is the attempt LEDGER (data/image-attempts.json,
# committed) and the imported images themselves. The staging directory and its
# manifest do not — data/fetched-images/ is gitignored, so every run starts with an
# empty staging area and anything not imported tonight is re-fetched from scratch
# whenever the wine next comes due. That is why a wine whose image was verified but
# could not be watermark-swept is recorded 'unevaluated' rather than 'miss': there
# is no staged file for a later sweep to pick up, so the only recovery is redoing
# the search, and a 30-day backoff would prevent it.
#
# Both verification stages are HARD GATES with no override path (design spec §A
# step 3). An image that fails the shape check or whose label does not name the
# wine never reaches the manifest as ok; an image carrying a Vivino or stock
# watermark is flagged on the manifest and importrules.mjs refuses it
# unconditionally, even if every other signal is clean.
#
# The sweep MUST run between fetch and import, not after it. The host gate
# cannot catch a re-hosted copy — clean retailer hosts have served images with
# Vivino's mark burned into the pixels — so the sweep is the only thing standing
# between a watermarked file and the public site, and once import has written it
# to assets/img/wines/ the horse has left.
set -euo pipefail

# Fail loudly rather than silently sourcing no images: every stage here needs the
# vision model, and a missing key would otherwise look like "no images found".
: "${OPENAI_API_KEY:?the image stage needs OPENAI_API_KEY}"

echo "::group::Build the image helpers"
go build -o imgcheck ./tools/imgcheck
go build -o imgnorm ./tools/imgnorm
go build -o imghash ./tools/imghash
echo "::endgroup::"

echo "::group::Fetch and verify (imageless + due only, up to WINES_PER_RUN)"
# --missing        : only wines still on the SVG label fallback
# --due-only       : and only those the attempt ledger says are due (30-day backoff)
# --n              : at most this many wines tonight (see the budget note below)
# --budget-minutes : and no longer than this, whatever happens
# --vision-first   : read the label with the vision model, then apply imgcheck's
#                    identity rules to that text. Required on Linux: imgcheck's
#                    local OCR is a PowerShell shell-out (tools/imgcheck/ocr.ps1).
#
# THIS STAGE IS BOUNDED, and that is the whole design. On night one every one of
# the ~1,700 imageless wines is due (the seeded ledger holds only 'imported'
# records), and an unbounded run over that set cannot finish inside the
# workflow's timeout-minutes. A killed job is not a slow night: the per-wine
# ledger writes are lost, because the commit-back step never runs, so the
# following night re-searches exactly the same wines and dies exactly the same
# way — for ever.
#
# Bounded, the stage CONVERGES instead. Every wine it reaches is recorded, found
# or not; a recorded miss is not due again for 30 days; so the due set shrinks by
# roughly WINES_PER_RUN a night and coverage climbs run over run. Clearing the
# night-one backlog takes a couple of weeks, and no single night can wedge it.
#
# Overridable from the workflow if the numbers need tuning against real runner
# timings; the defaults are sized for the 300-minute job timeout with enrich,
# build and deploy still to come after this.
node tools/labelfetch/pipeline.mjs \
  --n "${WINES_PER_RUN:-150}" \
  --budget-minutes "${IMAGE_BUDGET_MINUTES:-120}" \
  --missing --due-only --vision-first
echo "::endgroup::"

# Nothing staged means nothing to sweep or import, and that is a normal night —
# the fetch step exits 0 having found no wine due (see pipeline.mjs's
# empty-selection guard), which is what every night looks like once the backlog is
# worked through. The staging directory is gitignored, so a fresh runner starts
# with no manifest at all: without this guard the sweep would ENOENT and import
# would exit 2, and `set -e` would take build, deploy, commit-back and notify down
# with them on the very nights the image stage had nothing left to do.
if [ ! -f data/fetched-images/manifest.json ]; then
  echo "no images staged this run — nothing to sweep or import"
  echo "image stage complete"
  exit 0
fi

echo "::group::Cross-source consensus"
# Two candidates fetched from DIFFERENT hosts showing the same bottle artwork
# is strong evidence the search converged on the right product — independent
# retailers photograph what they actually sell, and two wrong candidates
# rarely agree. This corroborates vision-only accepts (flag lifted) and
# promotes a cross-host twin pair's better half where nothing was accepted.
# MUST run before the sweep: a promoted file has never been swept, and the
# sweep below is the hard gate that clears it for import.
node tools/labelfetch/consensus.mjs --apply
echo "::endgroup::"

echo "::group::Watermark sweep (hard gate)"
# --apply records each verdict on the manifest record: hit or clean, the record
# is marked watermarkSwept so a re-run does not pay for it twice, and a hit also
# gains the watermark flag import refuses. An image the sweep could NOT reach a
# verdict on stays unswept, and import refuses it too — see importrules.mjs. The
# gate is "the sweep has looked", not "the sweep has condemned".
node tools/labelfetch/watermarksweep.mjs --apply
echo "::endgroup::"

echo "::group::Independent full-resolution identity gate"
# A second model must affirm the exact producer/cuvee identity from the staged
# full-resolution file. Missing, unavailable, or negative verdicts fail closed.
node tools/labelfetch/prepublish.mjs --clean-only --apply
echo "::endgroup::"

echo "::group::Import survivors"
# Only unflagged candidates that passed both hard gates publish automatically.
# Flagged candidates remain staged for human review.
node tools/labelfetch/import.mjs --apply --clean-only
echo "::endgroup::"

echo "image stage complete"

#!/usr/bin/env bash
# The nightly image stage, in the one order that is safe.
#
#   fetch + verify  ->  watermark sweep  ->  import survivors
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
echo "::endgroup::"

echo "::group::Fetch and verify (imageless + due only)"
# --missing     : only wines still on the SVG label fallback
# --due-only    : and only those the attempt ledger says are due (30-day backoff)
# --all         : no sampling — the whole due set
# --vision-first: read the label with the vision model, then apply imgcheck's
#                 identity rules to that text. Required on Linux: imgcheck's
#                 local OCR is a PowerShell shell-out (tools/imgcheck/ocr.ps1).
node tools/labelfetch/pipeline.mjs --all --missing --due-only --vision-first
echo "::endgroup::"

echo "::group::Watermark sweep (hard gate)"
# --apply records each verdict on the manifest record: a hit becomes a watermark
# flag import refuses, a clean becomes watermarkSwept so a re-run does not pay
# for it twice.
node tools/labelfetch/watermarksweep.mjs --apply
echo "::endgroup::"

echo "::group::Import survivors"
# NOT --clean-only. Review flags ("low resolution", "vintage on label is 2019")
# are informational, not gates, and in CI there is no human to clear them — so
# holding flagged-but-verified images back would mean they never publish at all.
# The digest email lists every newly imported image with its flags so a reader
# can catch a bad one, and the console can swap it. This is the risk Joel
# accepted on 2026-07-29 (spec §Risks 1), recorded here so it is not re-decided
# by accident.
node tools/labelfetch/import.mjs --apply
echo "::endgroup::"

echo "image stage complete"

#!/usr/bin/env bash
# Compatibility entrypoint for operators and older runbooks. The autonomous
# Node workflow owns preflight, stage ordering, receipts, and failure handling.
set -euo pipefail
exec node tools/labelfetch/autonomous.mjs --apply "$@"

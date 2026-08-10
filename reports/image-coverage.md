# Catalog image coverage

Regenerate with `node tools/coverage/report.mjs`.

| Metric | Value |
|---|---|
| Wines | 2642 |
| Wines with a photograph | 1282 (48.5%) |
| Portfolio cards | 1955 |
| Cards with a photograph | 916 (46.9%) |
| Cards on the neutral placeholder | 1039 |

## Why the rest are missing

| Ledger outcome | Wines |
|---|---|
| searched, nothing usable found | 1033 |
| verified but never evaluated | 84 |
| imported then withdrawn on audit | 172 |
| not yet searched | 71 |

"Searched, nothing usable found" is the ceiling the nightly run cannot move on
its own. Those need supplier media (see docs/supplier-media-request.md).

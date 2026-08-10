# Catalog image coverage

Regenerate with `node tools/coverage/report.mjs`.

Cards are counted the way the site counts them: one card per wine — producer
and cuvée, with vintages folded in — and the card's picture is the one the grid
shows, from the newest vintage's best-enriched row.

| Metric | Value |
|---|---|
| Wines | 2637 |
| Wines with a photograph | 1439 (54.6%) |
| Portfolio cards | 1894 |
| Cards with a photograph | 967 (51.1%) |
| Cards on the neutral placeholder | 927 |

## Why the rest are missing

Counted per wine, not per card, because the search runs per wine.

| Ledger outcome | Wines |
|---|---|
| searched, nothing usable found | 1002 |
| verified but never evaluated | 5 |
| imported then withdrawn on audit | 145 |
| not yet searched | 46 |
| unrecognised ledger outcome | 0 |
| **total without a photograph** | **1198** |

"Searched, nothing usable found" is the ceiling the nightly run cannot move on
its own: the public web has already been asked and had nothing usable to give.
Moving it means asking the producers and importers we buy from for their own
bottle photography.

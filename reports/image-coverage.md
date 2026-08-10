# Catalog image coverage

Regenerate with `node tools/coverage/report.mjs`.

Cards are counted the way the site counts them: one card per wine — producer
and cuvée, with vintages folded in — and the card's picture is the one the grid
shows, from the newest vintage's best-enriched row.

| Metric | Value |
|---|---|
| Wines | 2637 |
| Wines with a photograph | 1395 (52.9%) |
| Portfolio cards | 1894 |
| Cards with a photograph | 923 (48.7%) |
| Cards on the neutral placeholder | 971 |

## Why the rest are missing

Counted per wine, not per card, because the search runs per wine.

| Ledger outcome | Wines |
|---|---|
| searched, nothing usable found | 1045 |
| verified but never evaluated | 5 |
| imported then withdrawn on audit | 146 |
| not yet searched | 46 |
| unrecognised ledger outcome | 0 |
| **total without a photograph** | **1242** |

"Searched, nothing usable found" is the ceiling the nightly run cannot move on
its own: the public web has already been asked and had nothing usable to give.
Moving it means asking the producers and importers we buy from for their own
bottle photography.

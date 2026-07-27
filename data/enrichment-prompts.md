# FineVines — Wine Enrichment (ChatGPT batch)

## Instructions — read once, apply to EVERY wine below

You are enriching a wine catalog for FineVines, a licensed Illinois wholesale
wine & spirits distributor. Voice: elegant, editorial, old-world wine trade —
never corporate-tech.

For EACH wine in the list:
1. Search the web for the EXACT wine — match producer, wine name, AND vintage
   (watch for red/white or bottle-size variants of the same name). Prefer the
   producer/importer site and reputable references.
2. Write ORIGINAL trade tasting copy. NEVER copy tasting notes, reviews, or any
   other text verbatim. NEVER state critic scores, prices, or awards. If unsure
   of a fact, mark it "derived" or "missing" and keep the copy general.
3. Produce a JSON object with EXACTLY these keys:
   - "description":    2–3 original sentences of trade tasting copy
   - "sommelierNotes": 1–2 sentences of service/pairing guidance
   - "aroma","palate","finish": a short original phrase each ("" if unknown)
   - "foodPairings":   array of 2–5 short strings ([] if unknown)
   - "appellation","country","color","abv","bottleSize","drinkWindow":
                       factual strings, e.g. abv "13.5%", bottleSize "750ml"
                       ("" if unknown)
   - "sources":        object mapping EACH of the 12 fields above
                       (description, sommelierNotes, aroma, palate, finish,
                       foodPairings, appellation, country, color, abv,
                       bottleSize, drinkWindow) to one of:
                         "found"   — established from a real search result
                         "derived" — inferred from grape/region/style only
                         "missing" — could not determine
   - "matchConfidence": integer 0–100 (confidence it's THIS exact wine+vintage)
   - "imageUrl":       URL of a real bottle/label image you found, else ""
   - "imagePrompt":    a prompt for a photorealistic studio bottle photo
                       (region/style-appropriate bottle & label, neutral
                       warm-grey backdrop, soft light; no people/scenery/logos)

## Output format — IMPORTANT

Return ONE JSON object mapping each wine's SKU to its enrichment object, and
NOTHING else (no commentary):

    {
      "<SKU>": { ...enrichment object... },
      "<SKU>": { ...enrichment object... }
    }

If the list is long, you may split the output across multiple JSON objects of
the same shape — each keyed by SKU — and we will merge them.

## Wines
1. **SKU CD3310** — Domaine Charles Lachaux · Bourgogne Rouge (2020) · Pinot Noir · Burgundy · Bourgogne · Red · Still
2. **SKU EF4420** — The Eyrie Vineyards · Pinot Noir Estate (2019) · Pinot Noir · Oregon · Dundee Hills · Red · Still
3. **SKU GH5501** — Arnaud Lambert · Saumur Blanc « Clos David » (2021) · Chenin Blanc · Loire · Saumur · White · Still
4. **SKU JK6612** — Altocedro · Año Cero Malbec (2022) · Malbec · Mendoza · La Consulta · Red · Still
5. **SKU LM7723** — JL Chave Sélection · Côtes-du-Rhône « Mon Cœur » (2021) · Grenache Blend · Rhône · Côtes-du-Rhône · Red · Still
6. **SKU NP8834** — Benjamin Leroux · Auxey-Duresses Blanc (2020) · Chardonnay · Burgundy · Auxey-Duresses · White · Still
7. **SKU QR9945** — Domaine Bruno Clair · Marsannay Rosé (2022) · Pinot Noir · Burgundy · Marsannay · Rosé · Still
8. **SKU BX1010** — Château Sociando-Mallet · Haut-Médoc (2016) · Cabernet Blend · Bordeaux · Haut-Médoc · Red · Still
9. **SKU BX2015** — Château Doisy-Daëne · Barsac (2015) · Sémillon Blend · Bordeaux · Barsac · White · Sweet
10. **SKU CH3020** — Pierre Péters · Cuvée de Réserve Blanc de Blancs Brut (NV) · Chardonnay · Champagne · Champagne Grand Cru · Sparkling
11. **SKU AL4025** — Domaine Weinbach · Riesling « Cuvée Théo » (2021) · Riesling · Alsace · Alsace · White · Still
12. **SKU PM5031** — Produttori del Barbaresco · Barbaresco (2020) · Nebbiolo · Piedmont · Barbaresco · Red · Still
13. **SKU TU6040** — Isole e Olena · Chianti Classico (2021) · Sangiovese · Tuscany · Chianti Classico · Red · Still
14. **SKU TU6041** — Il Poggione · Brunello di Montalcino (2018) · Sangiovese · Tuscany · Brunello di Montalcino · Red · Still
15. **SKU VN7050** — Allegrini · Amarone della Valpolicella Classico (2018) · Corvina Blend · Veneto · Amarone della Valpolicella · Red · Still
16. **SKU VN7051** — Nino Franco · Rustico Prosecco Superiore (NV) · Glera · Veneto · Valdobbiadene Prosecco Superiore · Sparkling
17. **SKU RJ8060** — La Rioja Alta · Viña Ardanza Reserva (2016) · Tempranillo Blend · Rioja · Rioja · Red · Still
18. **SKU RD8065** — Dominio de Pingus · PSI (2021) · Tempranillo · Ribera del Duero · Ribera del Duero · Red · Still
19. **SKU RB9070** — Pazo Señorans · Albariño (2022) · Albariño · Rías Baixas · Rías Baixas · White · Still
20. **SKU MZ1080** — Weingut Joh. Jos. Prüm · Wehlener Sonnenuhr Riesling Kabinett (2021) · Riesling · Mosel · Mosel · White · Off-Dry
21. **SKU NP2090** — Ridge Vineyards · Estate Cabernet Sauvignon (2019) · Cabernet Sauvignon · Napa Valley · Santa Cruz Mountains · Red · Still
22. **SKU SO3095** — Littorai · Les Larmes Pinot Noir (2021) · Pinot Noir · Sonoma · Anderson Valley · Red · Still
23. **SKU SO3096** — Kistler · Les Noisetiers Chardonnay (2021) · Chardonnay · Sonoma · Sonoma Coast · White · Still
24. **SKU WM4100** — Cristom Vineyards · Mt. Jefferson Cuvée Pinot Noir (2021) · Pinot Noir · Oregon · Willamette Valley · Red · Still
25. **SKU BR6120** — Torbreck · The Steading Grenache Shiraz Mataro (2020) · Grenache Blend · Barossa Valley · Barossa Valley · Red · Still
26. **SKU CO7130** — Felton Road · Bannockburn Pinot Noir (2021) · Pinot Noir · Central Otago · Central Otago · Red · Still
27. **SKU PR8140** — Domaine Tempier · Bandol Rosé (2022) · Mourvèdre Blend · Provence · Bandol · Rosé · Still
28. **SKU LO9150** — François Cotat · Sancerre « La Grande Côte » (2021) · Sauvignon Blanc · Loire · Sancerre · White · Still
29. **SKU CB1160** — Domaine William Fèvre · Chablis 1er Cru « Montmains » (2021) · Chardonnay · Burgundy · Chablis 1er Cru · White · Still
30. **SKU PT2170** — Álvaro Palacios · Camins del Priorat (2021) · Garnacha Blend · Priorat · Priorat · Red · Still

# Salesforce catalog corrections — for the FineVines team

*Prepared 2026-08-05. Everything below was found automatically while building
the website's catalog pipeline; each item links to why it matters on the site.
These are fixes to make in Salesforce (Product2 records) so they hold at the
source — the website inherits them on the next sync, and page renames are
redirected automatically, so nothing breaks by fixing them.*

## 1. The one structural fix: the producer field

**~930 products have no value in the producer field** (`FV_Brand__c` mapping —
open item #2 from the build spec). The producer is typed into the product
*name* instead ("DOM BERNARD MOREAU POMMARD…"). Everything downstream —
grouping vintages of one wine, matching bottle photos, writing tasting copy —
has to guess where the producer ends and the wine begins, and every error
class below got harder to catch because of it.

**Ask:** populate the producer field (or map `FV_Brand__c`) going forward, and
backfill when convenient. Even partial coverage helps immediately.

## 2. Name spellings that split one wine into two catalog entries

The website groups vintages of a wine by its name. A one-letter difference
between the 2021 row and the 2022 row makes them two different wines on the
portfolio page. Recommended canonical spelling in **bold**; the rows to edit
are the vintages shown.

| Product rows (vintages) | Fix to |
|---|---|
| Altocedro Malbec Gran Reserv**e** (2021) | **Gran Reserva** |
| Benjamin Leroux Meursault 1er Cru L**e** Genevrières (2020) | **Les Genevrières** |
| Bourgogne Passetoutgrain / Passetoutgrains (Castagnier 2019/2020; Groffier 2020/2022/2023) | **Passetoutgrains** (one spelling everywhere) |
| Charles Lachaux Cote**s** de Nuits-Villages (2021) | **Côte de Nuits-Villages** (the appellation is singular) |
| Charlopin Marsannay Mon**chenevoy** (2012) / Montche**v**evoy (2015) | **Montchenevoy** |
| Chauvenet-**Shopin** (2012) | **Chauvenet-Chopin** |
| Domaine Collo**9**tte (2019) | **Collotte** |
| Confuron-Gindre E**xh**ezeaux Grand Cru (2020) | **Échezeaux** |
| Arnaud Lambert Saum**uir** Blanc (2021); St-Cyr / Saint-C**ry**-en-Bourg variants | **Saumur**, **Saint-Cyr-en-Bourg** |
| B&T Glantenay Volnay 1er Clos **de** Chênes (2022) | **Clos des Chênes** |
| Domaine Benoit Cha**va**llier (2023) | **Chevallier** |
| Berthaut-Gerbet Bourgogne Haute**(s)** Côtes de Nuits (2018–2023 mixed) | **Hautes-Côtes de Nuits** |
| Bruno Clavelier Nuit**(s)**-Saint-Georges (2018) | **Nuits-Saint-Georges** |
| Bruno Colin Chassagne 1er **Les** Maltroie (2024) | **La Maltroie** |
| Bruno Colin **Puilgny**-Montrachet (2023) | **Puligny-Montrachet** |
| Daniel Bouland Morgon Corcel**l**ette (2021) | **Corcelette** |
| Daniel Bouland Morgon **Delays** VV (2023) / **Delys** VV (2018) | **Delys** *(please confirm — this is the cuvée on the label)* |
| Denis **B Achelet** (2018) | **Bachelet** |
| Georges Noëllat Meursault 1er **Aux** Cras (2016, 2018) | **Les Cras** *(confirm against the label)* |
| Georges Noëllat NSG 1er **Les** Boudots (2018–2023) / Aux Boudots (2017) | **Aux Boudots** (the climat's name) |
| Humbert Frères Charm**s**-Chambertin (2022) | **Charmes-Chambertin** |
| Humbert Frères Gevrey-Cham**er**tin 1er Petite Chapelle (2023) | **Gevrey-Chambertin** |
| J-N Gagnard Bourgogne **Hauters** Côtes de Beaune (2022) | **Hautes** |
| J-N Gagnard **Chassange-Montrachhet** Rouge l'Estimée (2021) | **Chassagne-Montrachet** |
| J-N Gagnard **Crement** de Bourgogne (2016) | **Crémant** |
| La Bérangeraie Cahors Cuvée **Mauarin** (2023) | **Maurin** |
| Lafarge-Vial Fleurie Clos **Volnay** (2023) | **Clos Vernay** (the Fleurie lieu-dit) |
| Lebreuil Savigny 1er Aux Peuillet**(s)** (2019/2022) | **Aux Peuillets** |
| Lignier-Michelot Morey 1er **Cheneverey / Lis Chenevery / Chenevery** (2017–2023); **Facconnières** (2017) | **Les Chenevery**, **Les Faconnières** |
| Michel **Nielloin** Chevalier-Montrachet (2022); **Chasssagne** (2022); Champs Gain**s** (2021) | **Niellon**, **Chassagne**, **Les Champs Gain** |
| Nicolas Millet Sancerre **Chêne Marchand** / **Le Chêne Marchand** (2020/2022) | **Le Chêne Marchand** |
| Philippe Bouzereau **Merusault** 1er Poruzots (2023) | **Meursault** |
| Saint-Damien Gigondas **Vieiles** Vignes (2020) | **Vieilles** |
| Servin Chablis Grand Cru Les Preuse**(s)** (2023) | **Les Preuses** |
| Sylvain Cathiard Les Dames **Hugettes** (2022) | **Huguettes** |
| Felton Road Cornish Point **Centra l** Otago (2020) | **Central Otago** |
| Robert Groffier Chambolle 1er Les Senti**ères** (2023) | **Les Sentiers** |
| Anne **Patent** Pommard 1er Les Épenots (2018) | **Anne Parent** |
| Domaine **Benard** Moreau Pommard Fremiers (2020) | **Bernard Moreau** |
| Bevan Cellars Tin Box **Nape** Valley (2024) | **Napa Valley** |
| Atomique 3 Chardonnay le **Sedimanetaire** (2021/2022) | **le Sédimentaire** |
| Yannick Amirault **Bourgeuil** (2017) | **Bourgueil** |
| Château de Beauregard Pouilly-Fuissé Grand **Beaurgard** (2014) | **Beauregard** |

**Deliberately NOT merged** — these look like typos but are genuinely
different wines; please leave them distinct:

- Benjamin Leroux Meursault 1er **Genevrières Dessous** (2018) vs
  **Genevrières Dessus** (2022) — two different climats.
- La Bastide Blanche Bandol **Rosé** vs **Rouge** — different wines.
- Kracher Trockenbeerenauslese **No. 2** vs **No. 6** — numbered bottlings.
  (The row suffixed "**ZDS**" (2021) looks like stray data — please check.)

## 3. Region field misspellings

The region field (`FV_Region__c`) carries a few typos that reached the public
site: **Burgudy**, **Burgandy** → Burgundy; **Mendoze** → Mendoza. The site
copies are already corrected; fixing the org stops them coming back.

## 4. Rows that are not products

Two bookkeeping rows published as wine pages before rules caught them:
"REMIT TO" (remittance address) and "FREE GOODS PROVIDED IN LIEU OF PRICE
REDUCTION". Both are now blocked site-side by pattern. If more memo-style rows
are added to the ledger, prefixing their SKU with "9" keeps them off the site
by the original rule.

---
*Site-side handling: every rename above flows through the catalog's redirect
lifecycle automatically (old page URLs 301 to the new ones), so these edits
can be made at any pace without breaking links.*

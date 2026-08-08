# Fine Vines wine-catalog imagery — briefing for ChatGPT

Paste everything below into ChatGPT. It is self-contained: it assumes no access
to the repository, the site, or any prior conversation.

---

I'm rebuilding the website for Fine Vines, a licensed wholesale wine and
spirits distributor in Illinois. It's a static site generated from their
Salesforce catalog: about 2,640 product rows, which collapse to roughly 1,900
distinct wines once vintages of the same wine are grouped into one listing.
Staging is at finevines.biz; the old site is still live at finevines.com.

I need your help thinking about **what picture to show for each wine**, and
whether the approach I've landed on is sound. Please push back rather than
agree — I've been over-confident on this and want the errors found.

## Where the images come from

Every wine gets one image, from one of five sources:

| Source | Count | What it is |
|---|---|---|
| Scraped web photos | 1,059 | Bottle photos found via web search on retailer/importer sites |
| AI-generated photos | 874 | Photorealistic bottles invented by an image model (gpt-image-1) |
| Label scans | 189 | Flat scans of the paper label, no bottle |
| Old-site photos | 48 | Recovered from the client's own previous website |
| SVG placeholder | 472 | A generated vector label — obviously a placeholder, not a photo |

The client explicitly accepted the copyright risk of sourcing real bottle
images by web search, after it was flagged twice. That decision is theirs and
is not up for re-litigation. Watermark removal was refused and remains refused.

## The problem I hit

The pipeline verifies a candidate image by reading its label with OCR and
checking the text names the wine. That check had a specific hole: it required
the **producer** to appear on the label but not the **cuvée**. So with the
estate confirmed, any bottle from that estate satisfied any of its wines.

A full-resolution audit of every published image found **551 wrong bottles
live on the site**. Real examples:

- François Mikulski's plain Meursault shown as his Meursault *Limozin* and again as his *Tillets*
- Maison Ambroise's *Échezeaux* shown as their *Clos Vougeot*
- Anne Parent's Pommard *La Croix Blanche* shown as her Pommard 1er Cru *Croix Noires*
- Altocedro *Reserva* shown as *Gran Reserva*
- A Kerr Cellars Sonoma Pinot Noir shown as their Napa Cabernet

Error rates by source, measured: 22% of scraped photos, 47% of label scans,
39% of old-site images. All 551 have been pulled and replaced with placeholders.

## What I changed

1. **The verifier now also requires the cuvée.** For each *other* wine the same
   producer makes, the label must carry something that tells this wine apart
   from that one. Checked per sibling, not pooled — "grand cru" distinguishes
   Ambroise's Clos Vougeot from their Nuits-Saint-Georges, and pooling let that
   stand as proof against their Échezeaux, which it isn't. A producer with only
   one wine in the book has nothing to be confused with, so nothing extra is
   demanded and short labels still pass.

2. **A second, independent check before anything publishes.** A vision model
   reads the full-resolution image and answers whether the label names this
   exact wine. It is conservative: only a well-formed "no" pulls an image; a
   malformed reply or a network error is "no opinion". So it can remove a photo
   but never promote one.

Measured against that second check as ground truth, the fixed verifier catches
70% of bad images by itself while keeping 92% of the good ones.

## The question I actually need help with

**About 874 wines — nearly half the catalog — currently show an AI-generated
bottle that does not exist.** The label text is correct (we supply it), but the
bottle shape, label design, colours and typography are all invented.

Of those, roughly 254 are worse: the generator couldn't render a legible label,
so it produced a photorealistic bottle with a **completely blank label**. Some
of these sit on serious wines — a David Duband Clos Vougeot Grand Cru, for
instance, shown as a generic red bottle with an empty cream label.

There's a related wrinkle: because we print the catalog's own spelling onto the
generated label, a typo in Salesforce becomes a *misspelling rendered onto a
convincing fake label*. We have a real one live: Domaine Rapet's Corton-
Charlemagne is spelled "Coton Charlemagne" in the catalog, and the generated
bottle now carries that misspelling in elegant type.

**What I want from you:**

1. For a licensed wholesale distributor showing real producers' wines to trade
   buyers, where is the line between an acceptable stand-in and a
   misrepresentation? Does a correct-label generated bottle cross it? Does a
   blank-label one?
2. Is an obvious placeholder (a flat vector label that nobody would mistake for
   a photograph) actually *better* than a photorealistic invented bottle, even
   though it looks less finished?
3. Does the answer change by wine — generic bottles acceptable for a $12
   Prosecco but not for a grand cru?
4. Is there a disclosure approach that makes generated imagery legitimate, and
   would it be credible to a buyer?
5. What am I not asking that I should be?

Assume the alternative to a generated bottle is the SVG placeholder, and that
the remaining 472 placeholders can be filled by generation at roughly $0.44
each. Real photography for these specific wines is not available — search has
been exhausted at roughly a 29% success rate, and the failures are largely
obscure Burgundian growers with little web presence.

---

## Appendix: things I got wrong, in case they matter to your reasoning

- I assumed thumbnail-based "no match" verdicts from an AI review pass were
  mostly false alarms. They weren't — about 80% were correct.
- I shipped the cuvée fix and reported it as working. It was inert in
  production for a day: callers pass a producer-led name while catalog rows
  store the name alone, so the *estate's own name* looked like the
  distinguishing word and satisfied the check every time.
- I concluded the search *sources* were the weak link based on results produced
  while that filter wasn't running.
- I estimated a re-run at 18 hours; measured, it's about 42 seconds per wine.
- I said a re-run would cost nothing in API spend. It makes a vision call per
  candidate image — roughly 8,100 calls on the last run — because I passed a
  flag that exists as a workaround for Linux CI onto a Windows machine where
  the local OCR is free and about as accurate.

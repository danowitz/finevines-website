---
name: finevines-news
description: Use when posting a tasting, new arrival, or event to the FineVines website — interviews for the details, writes the post in the FineVines voice, and offers to publish.
---

# FineVines News & Events

This skill turns a short conversation with Barbara (or whoever on staff is posting) into a finished
`data/news/<slug>.json` file, and optionally publishes it to finevines.com. Barbara isn't a developer — no jargon,
no talk of JSON, slugs, git, or "the build." To her this is just "post the update about the tasting."

## Step 1 — Interview, one question at a time

Ask conversationally, in plain language, one question per turn — don't front-load a form. Gather:

1. **What's this about?** — get the gist first; it tells you the category:
   - `Events` — a tasting, dinner, trade show, in-store pour, etc.
   - `New Arrivals` — a new wine or producer joining the portfolio.
   - `News` — anything else (an award, a press mention, a staff note).
2. **Title** — a short headline for the post. Suggest one from what they've told you if they're not sure.
3. **Date** — defaults to today if they don't give one. Always store as `YYYY-MM-DD`.
4. **Location** — only ask if it's an `Events` post ("Where's it happening?"). Skip this question entirely for
   `New Arrivals` or `News`.
5. **The substance** — what actually happened or is being announced. Ask follow-up questions until you have enough
   for 2–5 short paragraphs: who/what/when/where, and anything that makes it worth reading (why this wine, why this
   producer, what makes the event worth attending). Don't pad with questions once you have enough — three good
   paragraphs beats five thin ones.
6. **Image** (optional) — only ask if it seems natural ("Do you have a photo you want linked to this?"). If they
   don't have one or don't know, skip it — `image` is optional and most posts won't have one.

Never invent facts. If a date, price, wine name, producer, or person's name wasn't given to you, ask for it — don't
guess or fill it in from general wine knowledge.

## Step 2 — Write the body in the FineVines voice

FineVines is an old-world wine trade voice: elegant, editorial, unhurried. Never corporate-tech phrasing, never
marketing hype, never exclamation points doing the work that a well-chosen verb should do. Write the way a
knowledgeable friend in the trade would tell you about a wine or an evening — warm, specific, a little formal, never
salesy. You don't need to repeat the tagline ("Pouring elegance with a sommelier's touch") — just let that
sensibility come through in the word choices.

**Before (corporate-tech, wrong):**
> Exciting news! FineVines is thrilled to announce our newest addition to the portfolio! This amazing Barolo is a
> must-try for wine lovers everywhere. Don't miss out — stop by today!!

**After (FineVines voice, right):**
> FineVines welcomes a new Barolo to the portfolio this month: the 2019 vintage from a family estate in the
> Langhe hills, farmed in the traditional way for three generations. It's a wine that rewards patience — firm
> tannins now, but the makings of real elegance a few years out. We think it belongs on any list built for the
> long haul.

**Before (thin, generic event copy):**
> Join us for a tasting event on Friday. Great wines, great people. See you there!

**After:**
> On Friday evening, FineVines opens its tasting room for an evening built around the wines of Piedmont — six
> pours, guided by our sales team, with the kind of unhurried conversation that a good bottle deserves. Doors open
> at six.

Rules while writing:
- 2–5 short paragraphs, separated by a **blank line** between each (this matters — see Step 3).
- Plain prose only. No markdown (no bullet points, bold, headers, or links) — the site renders body text as-is.
- Use only the facts Barbara gave you in the interview. If something is missing or unclear, go back and ask rather
  than smoothing it over with a vague generality.

## Step 3 — Compute the slug and write the file

1. **Slug**: lowercase the title, strip punctuation and accents, replace spaces/remaining separators with single
   hyphens, and trim leading/trailing hyphens. E.g. "A Toast to Piedmont: Spring Tasting!" → `a-toast-to-piedmont-spring-tasting`.
2. **Write `data/news/<slug>.json`** with exactly these keys — no more, no fewer (this must match `model.NewsPost`
   in the Go build tool exactly, or the site build will silently drop fields):

```json
{
  "title": "A Toast to Piedmont",
  "date": "2026-07-24",
  "category": "Events",
  "body": "First paragraph of prose.\n\nSecond paragraph of prose, separated by a blank line.",
  "slug": "a-toast-to-piedmont",
  "image": "assets/news/a-toast-to-piedmont.jpg"
}
```

- `title`, `date`, `category`, `body`, `slug` are always present.
- `image` is included **only** if the user gave you an image path — omit the key entirely otherwise (don't write
  `"image": ""`).
- `category` must be exactly one of `Events`, `New Arrivals`, `News` (matching case).
- `body` paragraphs are separated by a literal blank line (`\n\n`) — the site build splits on that to render each
  paragraph as its own `<p>`.
- If `data/news/<slug>.json` already exists, confirm with the user before overwriting it.

## Step 4 — Show the draft, get approval, offer to publish

Show the user the drafted JSON (or, if they'd rather not look at JSON, just read the title, date, category, and
body back to them in plain language) and ask if it looks right. Make any edits they ask for.

Once approved, ask: **"Publish now? I'll run the site build and deploy."**

- **If yes**: from the repo root, run `./finevines.exe build` then `./finevines.exe deploy`, and report back the
  summary lines each command prints (don't paste the full raw output — just the outcome: pages built, anything
  deployed, any errors).
- **If no**: tell them the file is saved and ready — it'll go live the next time someone runs a build and deploy.

## Boundaries

This skill only ever writes to `data/news/<slug>.json`. Never touch `data/wines.json`, never touch anything related
to Salesforce or the `enrich` pipeline, and never edit any other file in the repo. If the user asks for something
outside posting news or events (adding a wine, editing team bios, changing site design), tell them that's outside
what this skill does.

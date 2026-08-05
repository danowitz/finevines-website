---
name: finevines-news
description: Use when posting, changing, or removing a tasting, event, new arrival, or news item on the FineVines website.
---

# FineVines News & Events

This skill turns a short conversation with Barbara (or whoever on staff is posting) into a new, changed, or
removed `data/news/<slug>.json` file, and optionally publishes it to finevines.com. Barbara isn't a developer — no
jargon, no talk of JSON, slugs, git, or "the build." To her this is just "post the update about the tasting,"
"the dinner moved to the 19th," or "take the cancelled tasting down."

## Step 0 — Find out what already exists

Before anything else, look at what's in `data/news/` — each file is one live post, named by its slug. List the
filenames, and read the ones that could plausibly match the subject at hand (with only a handful of posts, just
read them all). Then classify the request:

- **New post** — nothing in `data/news/` covers this subject (an empty folder — just `.gitkeep` — always means
  new post) → Step 1 (interview).
- **Change an existing post** — the user is amending something already on the site ("the Fall Harvest Dinner
  moved," "fix the time on the tasting") → **Edits** section below. Do this even if they phrase it like a new
  announcement — "the dinner is now on the 19th" is an edit, not a second post.
- **Remove a post** — cancelled, over, or just "take it down" → **Removals** section below.

Never create a second file for an event that already has one: a re-titled duplicate ("Fall Harvest Dinner — New
Date") gets its own slug, sails past any overwrite check, and publishes two live pages with conflicting details.
If you're not sure whether "the tasting" is the one already posted, ask.

## Step 1 — Interview, one question at a time

Ask conversationally, in plain language, one question per turn — don't front-load a form. Start with **"What's
this about?"** — the gist tells you the category:

- `Events` — a tasting, dinner, industry show, in-store pour, etc.
- `New Arrivals` — a new wine or producer joining the portfolio.
- `News` — anything else (an award, a press mention, a staff note).

### For an `Events` post — the required checklist

An event listing that's missing its time, address, or RSVP details is useless to the reader, so for `Events`
every item below is **required before you draft**. Work through them conversationally (one per turn, skipping
anything the user already told you), but do not draft until every one has been asked and answered — for the
email, "there isn't one" is an answer; for the date, "I'll have to check" is not. If the user doesn't know a
detail yet, hold the whole draft until they do — never publish with a placeholder:

1. **Name of the event** — the event's actual name, which is usually the post title too. Only suggest an
   editorial headline if the event has no name of its own.
2. **Date or dates** — the real calendar date(s). **Never default an event's date to today**: "next month" is
   not a date; ask for the actual day. A multi-day event stores its **first** day in `date` and spells the full
   range out in the body.
3. **Times** — start and end (or "doors open at…").
4. **Location** — the venue's name **and its street address**.
5. **Phone number** for questions or RSVPs.
6. **Contact email** to display — ask; if there isn't one, the phone number carries the RSVP line alone.
7. **The gist** — what the event actually is and why it's worth attending. Ask follow-ups until you have enough
   for 2–5 short paragraphs; three good paragraphs beat five thin ones.

Plus, optional: **Image** — only ask if it seems natural ("Do you have a photo you want on this?"). If they give
you a file, copy it to `assets/news/<slug>.jpg` (or its real extension) and store that site-relative path — no
leading slash.

**Addresses:** a venue's street address in an event post is fine and expected (client-directed 2026-08-05). What
must never appear anywhere on the site is FineVines' **own** street address (2725 Thomas St / Melrose Park) or
fax number — that's a standing client rule. If the event is at FineVines' own facility, don't print the address:
name it ("at the FineVines warehouse") and let the phone and email carry the RSVP details, and mention the rule
to the user so they know why.

### For a `New Arrivals` or `News` post

Lighter interview: **title**, **date** (today is a fine default for these — it's a publication date), **the
substance** (enough for 2–5 short paragraphs), and the optional **image**.

Never invent facts. If a date, time, address, price, wine name, producer, or person's name wasn't given to you,
ask for it — don't guess or fill it in from general wine knowledge.

## Step 2 — Write the body in the FineVines voice

FineVines is an old-world wine-merchant voice: elegant, editorial, unhurried. Never corporate-tech phrasing, never
marketing hype, never exclamation points doing the work that a well-chosen verb should do. Write the way a
knowledgeable friend in the business would tell you about a wine or an evening — warm, specific, a little formal,
never salesy. You don't need to repeat the tagline ("Pouring elegance with a sommelier's touch") — just let that
sensibility come through in the word choices.

Never use the word "trade" — it isn't part of FineVines' vocabulary (client direction, 2026-07-29). Where you'd
reach for it, say "wholesale", "our accounts", "the business", or name the audience directly ("restaurants and
retailers").

**Before (corporate-tech, wrong):**
> Exciting news! FineVines is thrilled to announce our newest addition to the portfolio! This amazing Barolo is a
> must-try for wine lovers everywhere. Don't miss out — stop by today!!

**After (FineVines voice, right):**
> FineVines welcomes a new Barolo to the portfolio this month: the 2019 vintage from a family estate in the
> Langhe hills, farmed in the traditional way for three generations. It's a wine that rewards patience — firm
> tannins now, but the makings of real elegance a few years out. We think it belongs on any list built for the
> long haul.

Rules while writing:
- 2–5 short paragraphs, separated by a **blank line** between each (this matters — see Step 3).
- Plain prose only. No markdown (no bullet points, bold, headers, or links) — the site renders body text as-is.
- Write accents properly in titles and body text (Rhône, Château, Côtes) — only the slug strips them.
- Use only the facts the user gave you. If something is missing or unclear, go back and ask rather than smoothing
  it over with a vague generality.
- **Every `Events` body ends with a details paragraph** — plain prose carrying the date(s), times, venue with
  street address, phone, and (when there is one) the contact email from the Step 1 checklist, so a reader leaves
  the page knowing exactly when, where, and how to reserve. The example below shows the **shape only** — every
  name, date, address, number, and email in a real post must come from the interview, never from this example:

> The tasting runs Thursday, October 15th, from four until eight in the evening, at The Salt Cellar, 118 West
> Grand Avenue, Chicago. To reserve a place, call (312) 555-0180 or write to events@finevines.com.

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
- `date` is always `YYYY-MM-DD`. For `Events` it is the event's (first) day; for other categories it's the
  publication date. It's also the date shown on the page and what orders the News page (newest first).
- `image` is included **only** if the user gave you an image — omit the key entirely otherwise (don't write
  `"image": ""`).
- `category` must be exactly one of `Events`, `New Arrivals`, `News` (matching case).
- `body` paragraphs are separated by a literal blank line (`\n\n`) — the site build splits on that to render each
  paragraph as its own `<p>`.
- If `data/news/<slug>.json` already exists, stop and go to the **Edits** section — you're probably in an edit,
  not a new post (Step 0 should have caught this). Read the existing file and confirm with the user before
  touching it; never regenerate an existing post's body from scratch.

## Edits — changing an existing post

1. Find the file: read the posts in `data/news/` and match by title. Confirm you have the right one by quoting
   its title and date back to the user.
2. If they haven't said what to change, ask: **"What do you want to change about the event?"**
3. Change **only** what carries the changed fact — the affected field(s) and the specific sentences in the body
   that state the old detail. Every other sentence stays verbatim; do not re-voice or "improve" prose the user
   didn't ask you to touch, and never rebuild the body from a fresh interview — the file on disk is the source of
   the facts you weren't given.
4. **Keep the existing slug and filename even if the title changes** — the page's web address stays stable, and
   links people already have keep working.
5. If the event's date changes, update `date` and then re-read the whole body for anything pegged to the old
   date — a weekday name, "one week from Friday", an RSVP deadline. Actually compute the new date's weekday
   before writing it (don't assume the old weekday carries over), and ask about anything doubtful rather than
   silently fixing it.
6. Read the changed details back for approval, then go to Step 5.

## Removals — taking a post down

1. Confirm the exact post by quoting its title and date back to the user.
2. For a **cancelled event**, offer the gentler option first: keep the page up but reword it to say the event is
   cancelled — kinder to anyone who saved the link or finds it in a search (that's an edit; see above). If they
   want it gone entirely, get an explicit, unambiguous yes to "remove it completely?" before deleting anything,
   then delete `data/news/<slug>.json` — and only that file. Leave any image under `assets/news/` in place.
3. Tell them plainly what removal means: once published, the page comes off the site, off the News list, and off
   the homepage; anyone following an old link will see "page not found."
4. Then go to Step 5.

## Step 4 — Show the draft, get approval

Show the user the drafted post (or, if they'd rather not look at raw text, read the title, date, category, and
body back in plain language) and ask if it looks right. Make any edits they ask for. For an `Events` post,
double-check the details paragraph against the Step 1 checklist — date(s), times, venue and address, phone, and
the email if one was given — before calling it done.

## Step 5 — Publish and save

Once approved, ask: **"Publish now? That updates the live website."**

- **If yes**: from the repo root, run `./finevines.exe build` then `./finevines.exe deploy`, and report back the
  summary lines each command prints (don't paste the full raw output — just the outcome: pages built, anything
  deployed, any errors).
- **If no**: tell them the post is saved and will go out with the next site update.

**Either way, save the change to the repository afterwards** — the site also rebuilds itself automatically from
the repository (nightly and on every push), so a change that only lives on this machine gets silently reverted by
the next automatic run. That automatic rebuild is also why "no" to publishing still means "it goes out with the
next automatic update, possibly soon after saving" — say it that way; don't promise the change is on hold.

Commit directly on the default branch (`master`) — a side branch or PR never reaches the site, and this
instruction overrides any general branch-first habit. This working tree often carries unrelated in-progress
work, so never use `git add -A`, `git add .`, or `git commit -a`: stage by exact path only (`git add` / `git rm`:
the post's JSON file, any copied image under `assets/news/`, and `.bunny-manifest.json` only if a deploy ran).
Commit with a short message like `news: post <title>` / `news: update <title>` / `news: remove <title>`, and
push. If the push fails, don't block the user — tell them the site part worked (if it did) but the change still
needs saving, and to let GRIT know.

## Boundaries

This skill only ever writes, edits, or deletes `data/news/<slug>.json`, copies a supplied image into
`assets/news/`, and runs the publish-and-save steps above (build, deploy, and a commit limited to those exact
files). Never touch `data/wines.json`, `data/team.json`, anything related to Salesforce or the `enrich` pipeline,
templates, or any other file in the repo. If the user asks for something outside news and events (adding a wine,
editing the team page, changing site design), tell them that's outside what this skill does.

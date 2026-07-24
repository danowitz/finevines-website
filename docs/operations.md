# Running the Fine Vines website — a guide for the office

This is the day-to-day guide for keeping finevines.com up to date. It's written for whoever at Fine Vines is
running the machine (Barbara, or anyone covering for her) — no programming knowledge required. If you're a
developer looking for the technical README, see [`../README.md`](../README.md) instead.

---

## What this tool does

`finevines.exe` is one small program that does four jobs. You'll mostly never run these one at a time — the
`deploy.bat` file (see below) runs the first three together in the right order.

| Command | Plain-language description |
|---|---|
| `enrich` | Pulls the current wine list from Salesforce, writes AI-generated tasting notes and a bottle photo for anything new or changed, and drops any wine that's out of stock or not meant for the web. Saves everything to `data\wines.json`. This is the only step that talks to Salesforce. |
| `build` | Turns the wine list, the news posts, and the team roster into the actual website pages (HTML files) in a folder called `dist`. This step never goes out to the internet — it just reads the JSON files and writes pages. |
| `deploy` | Uploads the freshly built pages to Fine Vines' hosting account (Bunny.net) and tells the CDN to clear its cache so visitors see the new version right away. Only files that actually changed get re-uploaded, so this is fast on a normal day. |
| `redirects` | A separate, occasional command (not part of the nightly run) that maps every old finevines.com web address to its new location, so old links and Google search results keep working after the rebuild. This is mainly a one-time launch-day tool — GRIT will run this as part of go-live, not something you need to run regularly. |

---

## One-time setup: the `.env` file

Before anything can run, a file named `.env` needs to sit in the **same folder as `finevines.exe`** (the repo
root — see "Where things live" below). This file holds every password/API key the tool needs. It is a plain
text file — GRIT can help you create or edit it, but **never email it, upload it anywhere, or check it into
GitHub.** It's already set up so Git will refuse to track it, but don't rely on that — treat it like a
password vault.

A template with all the blank fields lives at `.env.example` in the repo — copy it to `.env` and fill in the
values below.

### What goes in `.env`

**Salesforce** — needed for `enrich` only. Comes from Fine Vines' Salesforce administrator setting up a
"Connected App" in Salesforce Setup (this is a one-time IT step, not something you do daily):
- `FINEVINES_SF_BASE_URL` — the org's My Domain URL (looks like `https://finevines.my.salesforce.com`).
- `FINEVINES_SF_CLIENT_ID` — the Connected App's Consumer Key.
- `FINEVINES_SF_CLIENT_SECRET` — the Connected App's Consumer Secret.
- `FINEVINES_SF_API_VERSION` — optional; leave blank and the tool picks a sensible default.

**Anthropic (Claude)** — needed for `enrich` (writes tasting notes) and for both Claude skills below (writing
news posts and updating the team page):
- `ANTHROPIC_API_KEY` — an API key from Anthropic's console. GRIT can help set up the account.

**Image generation (Gemini)** — needed for `enrich`'s bottle photos:
- `FINEVINES_GEMINI_API_KEY` — an API key from Google's Gemini/AI Studio console.
- `FINEVINES_IMAGE_MODEL` — optional; leave blank and the tool picks a sensible default.

**Bunny.net (hosting)** — needed for `deploy`, and for the "publish now" option in the two Claude skills. All
of these come from the Bunny.net account dashboard once Fine Vines has a Bunny.net account set up:
- `FINEVINES_BUNNY_STORAGE_ZONE` — the name of the storage zone the site's files live in.
- `FINEVINES_BUNNY_STORAGE_KEY` — that storage zone's password (its "FTP & API Access" key).
- `FINEVINES_BUNNY_STORAGE_ENDPOINT` — optional; leave blank and the tool picks a sensible default.
- `FINEVINES_BUNNY_API_KEY` — the account-level API key (found under Account Settings, not the storage zone
  settings) — used both to clear the CDN cache after every deploy and to publish redirects.
- `FINEVINES_BUNNY_PULL_ZONE_ID` — the ID of the Pull Zone (CDN) in front of the storage zone.
- `FINEVINES_BUNNY_SCRIPT_ID` — only needed if/when GRIT publishes the old-URL redirect map via
  `redirects --publish`; this identifies the Bunny Edge Script that serves the redirects. Not needed for the
  nightly `enrich`/`build`/`deploy` cycle.

**Site**
- `FINEVINES_SITE_BASE_URL` — optional; the site's public URL (`https://finevines.com`). Leave blank and the
  tool defaults to that address.

If any required value for a given command is missing, that command stops immediately and prints exactly which
one is missing — it won't run half-configured.

---

## Where things live

Everything lives together in one folder — call it the "repo root." That folder should contain, at minimum:
`finevines.exe`, `.env`, `deploy.bat`, a `data` folder, and (after the first build) a `dist` folder. Always run
`deploy.bat` from this folder.

---

## Running it by hand

Double-click `deploy.bat`, or open a Command Prompt window in the repo-root folder and type:

```
deploy.bat
```

It runs `enrich`, then `build`, then `deploy`, in that order, and stops immediately if any step fails — so a
half-finished run never goes live. A normal run prints progress as it goes, ending with either:

- `Done.` — everything succeeded and the live site now reflects the latest data.
- `FAILED - see output above. The site was NOT updated.` — something went wrong; the previous, still-working
  version of the site is untouched. See "If something fails," below.

---

## Running it automatically every night (Windows Task Scheduler)

GRIT will typically set this up during launch, but here's the click path if it ever needs to be recreated on a
new machine:

1. Open the Start menu, type **Task Scheduler**, and open it.
2. In the right-hand panel, click **Create Basic Task...**
3. Name it something like `Fine Vines Nightly Site Update`, click **Next**.
4. Under **Trigger**, choose **Daily**, click **Next**, set the start time to **2:00 AM**, click **Next**.
5. Under **Action**, choose **Start a program**, click **Next**.
6. In **Program/script**, click **Browse...** and select `deploy.bat` inside the repo-root folder.
7. In **Start in (optional)**, type (or paste) the full path to the repo-root folder itself — for example
   `C:\FineVines\finevines-website`. This step matters: without it, the task won't be able to find `.env` or
   `finevines.exe`.
8. Click **Next**, then **Finish**.
9. Find the new task in the Task Scheduler Library list, right-click it, choose **Properties**.
10. On the **General** tab, select **Run whether user is logged on or not**, so it still runs overnight even if
    nobody's signed in on the machine. You'll be prompted for that Windows user's password — enter it and click
    **OK**.
11. Optional but recommended: on the **Settings** tab, check "Run task as soon as possible after a scheduled
    start is missed," in case the machine is off or asleep at 2 AM.

To test it without waiting for 2 AM: right-click the task in the list and choose **Run**.

---

## Reading the output

### `enrich` summary

At the end of an `enrich` run you'll see a line like:

```
enrich: complete — enriched 42, kept 5113, dropped 3, label-fallbacks 1
```

- **enriched** — wines that were new or had changed, and got fresh AI-written tasting notes and (if needed) a
  new bottle image.
- **kept** — wines that hadn't changed since the last run, so nothing was re-done (this keeps runs fast and
  cheap after the first one).
- **dropped** — wines that this run tried to write fresh tasting notes/photos for, but couldn't. This number
  does **not** include wines that simply went out of stock or were removed from Salesforce — those come off the
  live site automatically and quietly, without being counted here at all. "Dropped" only ever means one of two
  things, and they're not equally serious:
  - Most of the time, it's a wine whose AI tasting-note text failed to generate this run (e.g. a hiccup talking
    to the AI service). This is safe: that one wine is simply skipped and tried again automatically on the next
    run, and every other wine still gets published normally.
  - Rarely, it's a wine whose bottle-image step hit a file-saving problem. This is serious: it stops the entire
    `enrich` run in its tracks right then, and none of that run's changes are published — this is what shows up
    as `deploy.bat`'s `FAILED` message. If you see a `dropped` count together with a failed run, this is
    almost certainly why — see "If something fails," below.
- **label-fallbacks** — wines where the AI photo step didn't succeed, so a generated illustrated wine label was
  used instead of a photorealistic bottle image. This is a normal, on-brand fallback, not an error — nothing to
  act on.

### `deploy` summary

```
deploy: uploaded 42, deleted 3, purged
```

- **uploaded** — how many files were new or changed and sent to Bunny.net.
- **deleted** — how many files were removed (e.g. a wine page for a wine that's no longer sold).
- **purged** — confirms the Bunny.net CDN cache was cleared, so visitors immediately see the new version
  instead of a stale cached copy.

---

## If something fails

`deploy.bat` is written so that a failure at any step stops the whole run — nothing partial ever goes live.
If you see `FAILED - see output above. The site was NOT updated.`:

1. Scroll up in the window to see the actual error message printed above that line — often it's something
   simple like a missing or wrong `.env` value.
2. It's safe to just run `deploy.bat` again — every step here is designed to be safely re-run (an interrupted
   `enrich` picks up where it left off; `deploy` only re-uploads what's actually different).
3. If it fails again, or the error doesn't make sense, contact GRIT with the exact text of the error message.

The previous, working version of the site stays live throughout — a failed run never takes finevines.com down
or publishes anything half-finished.

---

## Who owns which files

- **`data\news\` and `data\team.json`** — these are Barbara's (or whoever's) to manage, and normally you'll
  never open them directly — you'll use the two Claude skills described below, which edit them for you through
  a conversation.
- **`data\wines.json`** — this file is entirely machine-owned by `enrich`. Never hand-edit it — any manual
  change will simply be overwritten (or fought with) on the next `enrich` run, since it works by comparing
  what's in Salesforce to what's already in this file.

---

## The two Claude skills

Two Claude Code skills let office staff update news/events and the team roster through a conversation, without
touching any files directly.

### One-time install

In Claude Code, run:

```
/plugin marketplace add <path to this repo>
```

(GRIT will give you the exact path or URL to use the first time this is set up.) Then install the two plugins
from that marketplace: `finevines-news` and `finevines-team`.

### Posting news, arrivals, or events

Just start a conversation and describe what you want to post — e.g. "I want to post about Friday's tasting
event." Claude will ask a few plain-language questions (what it's about, a title, the date, and so on — no
mention of files or code), write it up in the Fine Vines voice, show you the draft for approval, and then ask
whether to publish it right away. If you say yes, it runs `build` and `deploy` itself and reports back what
happened.

### Updating the team page

Same idea — say something like "Add Jane to the About page" or "Take George's old photo down," and Claude will
walk you through it, then offer to publish the change the same way.

If you say "not now" to publishing in either skill, the change is saved and will simply go live the next time
`deploy.bat` runs (e.g. the next 2 AM cycle).

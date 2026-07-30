# Running the FineVines website — a guide for the office

This is the day-to-day guide for keeping finevines.com up to date. It's written for whoever at FineVines is
running the machine (Barbara, or anyone covering for her) — no programming knowledge required. If you're a
developer looking for the technical README, see [`../README.md`](../README.md) instead.

---

## What this tool does

`finevines.exe` is one small program that does four jobs. **Normally you run none of them**: the site updates
itself every night in the cloud (see "The nightly run" below). This table is here so the output makes sense when
you read it, and for the rare occasion GRIT asks you to run something by hand.

| Command | Plain-language description |
|---|---|
| `enrich` | Pulls the current wine list from Salesforce, writes AI-generated tasting notes and a bottle photo for anything new or changed, and drops any wine that's out of stock or not meant for the web. Saves everything to `data\wines.json`. This is the only step that talks to Salesforce. |
| `build` | Turns the wine list, the news posts, and the team roster into the actual website pages (HTML files) in a folder called `dist`. This step never goes out to the internet — it just reads the JSON files and writes pages. |
| `deploy` | Uploads the freshly built pages to FineVines' hosting account (Bunny.net) and tells the CDN to clear its cache so visitors see the new version right away. Only files that actually changed get re-uploaded, so this is fast on a normal day. |
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

**Salesforce** — needed for `enrich` only. Comes from FineVines' Salesforce administrator setting up a
"Connected App" in Salesforce Setup (this is a one-time IT step, not something you do daily):
- `FINEVINES_SF_BASE_URL` — the org's My Domain URL (looks like `https://finevines.my.salesforce.com`).
- `FINEVINES_SF_CLIENT_ID` — the Connected App's Consumer Key.
- `FINEVINES_SF_CLIENT_SECRET` — the Connected App's Consumer Secret.
- `FINEVINES_SF_API_VERSION` — optional; leave blank and the tool picks a sensible default.

**OpenAI** — needed for `enrich` (researches each wine and writes its tasting notes), for `applyqueue` (rewrites
a wine's notes when a reviewer sends a correction), and for the image stage (reads bottle labels and sweeps for
watermarks). One key covers all three:
- `OPENAI_API_KEY` — an API key from OpenAI's platform console. GRIT can help set up the account.
- `FINEVINES_OPENAI_MODEL` — optional; leave blank and the tool picks a sensible default.

**Postmark** — needed only for `notify`, the nightly digest email. Not used by anything you run by hand:
- `POSTMARK_TOKEN` — the Postmark **server** token.
- `FINEVINES_NOTIFY_FROM` — the confirmed Postmark sender signature the digest is sent from. This has to be a
  mailbox someone reads: the digest invites a reply when a bottle photo looks wrong.
- `FINEVINES_NOTIFY_TO` — who gets the digest, comma-separated.

**Bunny.net (hosting)** — needed for `deploy`, and for the "publish now" option in the two Claude skills. All
of these come from the Bunny.net account dashboard once FineVines has a Bunny.net account set up:
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
  tool defaults to that address. Set this explicitly to the staging URL for a staging deployment.

Before the first production deploy, George must confirm the public contact details and all team email addresses.
After that approval, set `contactConfirmed` and `teamEmailsConfirmed` to `true` in `data\site.json`. Until both
flags are true, `finevines deploy` refuses to publish to `finevines.com`; staging deploys remain available.

If any required value for a given command is missing, that command stops immediately and prints exactly which
one is missing — it won't run half-configured.

---

## Where things live

Everything lives together in one folder — call it the "repo root." That folder should contain, at minimum:
`finevines.exe`, `.env`, `deploy.bat`, a `data` folder, and (after the first build) a `dist` folder. Always run
`deploy.bat` from this folder.

---

## The nightly run

The site updates itself. Every night at **2:15am Central** a GitHub Actions workflow runs the whole cycle in the
cloud — reviewer corrections, Salesforce refresh, bottle photographs, build, upload, and a digest email
summarising what changed. Nothing on the office machine has to be switched on, and there is nothing to schedule.
The full detail is under "Runbook: the GitHub Actions pipeline" further down.

**There is exactly one nightly publisher, and it is the pipeline.** Do not schedule `deploy.bat` (or anything
else) to run on a timer. Two publishers would fight: each keeps its own record of what is already uploaded, and a
workstation run from a stale copy of the repo can re-upload the whole site, or put yesterday's wine list back
over today's.

## Running `deploy.bat` by hand (the manual fallback)

`deploy.bat` exists for one situation: GitHub Actions is unavailable and something needs to go live now. Ask GRIT
first if you have the option. Double-click it, or open a Command Prompt window in the repo-root folder and type:

```
deploy.bat
```

It runs `enrich`, then `build`, then `deploy`, in that order, and stops immediately if any step fails — so a
half-finished run never goes live. A normal run prints progress as it goes, ending with either:

- `Done.` — everything succeeded and the live site now reflects the latest data.
- `FAILED - see output above. The site was NOT updated.` — something went wrong; the previous, still-working
  version of the site is untouched. See "If something fails," below.

Two things it does **not** do. It skips the pipeline-only steps — it does not apply reviewer corrections, source
bottle photographs, or send the digest email. And it does not save its own results anywhere but this machine:
whatever it changed has to be committed back to the repository, or the next nightly run will compare against
stale records and re-upload the entire site. GRIT does that part — tell them you ran it.

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

## If a manual `deploy.bat` run fails

(For a failed *nightly* run, see "Runbook: the GitHub Actions pipeline → When a step fails" below — the nightly
run emails GRIT automatically, so this section is only for something you started yourself.)

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
- **`data\site.json`** — GRIT owns the public contact details, client-confirmation flags, and curated homepage
  wine list. Change the confirmation flags only after explicit client approval.
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
mention of files or code), write it up in the FineVines voice, show you the draft for approval, and then ask
whether to publish it right away. If you say yes, it runs `build` and `deploy` itself and reports back what
happened.

### Updating the team page

Same idea — say something like "Add Jane to the About page" or "Take George's old photo down," and Claude will
walk you through it, then offer to publish the change the same way.

If you say "not now" to publishing in either skill, the change is saved and will simply go live on the next
nightly run.

---

## Wine lifecycle: out of stock vs delisted

- **Out of stock** (stock hits 0, everything else fine): the wine's page
  stays published so its search ranking survives, marked "currently
  unavailable", with OutOfStock structured data. It disappears from the
  portfolio, filters, search, and the sitemap. The moment stock returns,
  the next `enrich` reactivates it everywhere automatically.
- **Withheld** (ready-to-sell unchecked in Salesforce) and non-wine rows:
  removed entirely, page 301s to /portfolio/. Unchanged from before.
- **Gone for good**: after 180 days continuously unavailable, the page is
  dropped and 301s to /portfolio/.
- **Renamed wines** (Salesforce name/producer edits that change the URL):
  the old URL 301s to the new one automatically.

The 301 map accumulates in `data/lifecycle-redirects.json` (committed with
the catalog) and ships inside `dist/redirects.json`, which the Bunny Edge
middleware serves. No operator action is ever required.

---

## Runbook: the GitHub Actions pipeline

### Where to look
- **Actions tab → `pipeline`** for runs. `gh run list --workflow=pipeline.yml`
  from a terminal; `gh run view <id> --log` for the full log.
- A failed run emails the repo owner automatically (GitHub's own notification).
  The digest email is for content changes, not CI health — the two are separate
  on purpose.

### Triggering a run by hand
```
gh workflow run pipeline.yml
gh run watch
```

### When a step fails
The site is never left half-published, and the repo never records work that did
not happen. One thing is NOT true, and it matters: a reviewer's correction can be
applied to the catalog in step 1 and then lost, because the catalog and the
ledger only reach the repo at the bot commit in step 6. If enrich, the image
stage, build or deploy fails in between, the run dies with those changes in a
discarded workspace. That is why every batch is archived before it is applied —
see "Recovering a lost review batch" below.

Step by step:
- **applyqueue failed** — the queue is not cleared and nothing was committed. The
  next run re-reads the same actions; `data/queue-ledger.json` stops anything
  that did apply from applying twice. Safe to just re-run.
- **applyqueue succeeded but a LATER step failed** — the queue was cleared, and
  the corrections it applied were never committed. They are not lost: the batch
  was archived first. Re-run the pipeline and, if the reviewer's fix is still
  missing from the site afterwards, restore it from the archive (below).
- **enrich failed** — `data/wines.json` holds whatever the last checkpoint saved
  (every 50 wines). Wines that succeeded now hash-match and are skipped on the
  retry, so nothing is re-billed.
- **image stage failed** — no image reached `assets/img/wines/` unless it passed
  both gates. `data/image-attempts.json` was written per wine, so a retry does
  not re-search what was already tried.

  Note what is NOT a failure: the stage does at most 150 wines and 120 minutes a
  night and then stops, exit 0, having logged `stopped after N min: the
  120-minute budget is spent`. Wines it did not reach stay due for tomorrow. It
  will take a couple of weeks of nightly runs to work through the wines that have
  never been searched, and the coverage figure in the digest should climb a
  little each night — that is the stage working, not stalling.
- **deploy failed** — `.bunny-manifest.json` was NOT saved and the CDN was NOT
  purged. The next run re-diffs against the old manifest and retries exactly the
  files that never uploaded.
- **commit-back was rejected twice** — a human pushed mid-run. The deploy already
  happened; the site is live and correct, but the repo has not caught up. Re-run
  the pipeline: it re-diffs and commits.
- **notify failed** — everything shipped; only the email did not. The most likely
  cause is `FINEVINES_NOTIFY_FROM` not being a confirmed Postmark sender
  signature (Postmark returns HTTP 200 with a non-zero `ErrorCode` for that).

### Recovering a lost review batch
Before `applyqueue` applies anything, it copies the whole batch to the Bunny
storage zone as `_review/queue-applied-<run id>.json` — the same format as
`_review/queue.json`, so recovery is a copy rather than a repair. The run log
names the file:

```
applyqueue: archived 3 queued action(s) to _review/queue-applied-1234567890.json before applying them (recover a lost batch by copying that file back to _review/queue.json)
```

Find that line with `gh run view <id> --log | grep archived`. To replay the
batch, download the archive from the storage zone (Bunny dashboard → the storage
zone → `_review/`, or the Storage API) and upload it back as
`_review/queue.json`, then trigger a run. Re-applying is safe: the ledger skips
every action that already landed, so only the lost ones are done again.

The archives are never deleted, and `_review/` is not served by the public pull
zone — nothing there is reachable from finevines.com.

### After a bot commit lands, never use "Re-run failed jobs"
`notify` is the last step in the pipeline, so the failure that sends an operator
to the Actions "Re-run failed jobs" button is almost always `notify` itself —
and by then the bot's commit-back has already landed on `master`. A re-run
checks out that same master, so the before/after snapshot it takes captures the
**after** state (the run has nothing left to diff against itself), `notify`
finds no changes, and the job goes green having sent no digest — silently, on
the exact night an email mattered most.

To re-send the digest by hand instead, check out **at the bot commit itself**
(if later commits have landed since, `data/wines.json` at `HEAD` is no longer
that run's after-state, so this only works from the bot commit, not from
whatever is on `master` now):

```
git show <bot-commit>~1:data/wines.json > /tmp/before.json
./finevines notify -before /tmp/before.json
```

Add `-dry` to preview the digest without sending it through Postmark.

### Rotating a secret
`gh secret set <NAME>`, then `gh workflow run pipeline.yml` to confirm. Secrets
are never printed in logs; a step that needs one and does not have it fails with
`set <NAME> in .env (or the environment) before running <subcommand>`.

### Stopping the pipeline
Disable the workflow: `gh workflow disable pipeline.yml`. The nightly schedule
and every trigger stop; `deploy.bat` remains available on the workstation.

### Launch steps still open (repo-admin + live credentials required)
These have not been done yet — they need someone with repository admin rights
and the real production credentials, not just a code change:
1. **Configure the 16 GitHub Actions repository secrets** (Settings → Secrets
   and variables → Actions). See the table in the README's
   [pipeline section](../README.md#6-the-automated-pipeline-github-actions) for
   the exact names and what each one is; verify each against
   `.github/workflows/pipeline.yml`'s `env:` block before setting it — a typo
   here is a silent empty value at 2:15am.
2. **Set Settings → Actions → General → Workflow permissions to Read and
   write**, so the bot commit-back can push to `master`.
3. **Run the first manual `workflow_dispatch`** (`gh workflow run pipeline.yml`)
   as the acceptance run, and read its log end to end (`gh run watch`, then
   `gh run view <id> --log`) before trusting the nightly schedule to run
   unattended.
4. **Point `FINEVINES_NOTIFY_FROM` at a mailbox someone actually reads.** The
   digest tells George that if a photograph shows the wrong bottle he should
   reply and it will be replaced — and a reply goes to this address. Until the
   review console ships, that reply is his only channel for a correction, so an
   unread sender address means corrections are silently discarded. A confirmed
   Postmark sender signature on a monitored mailbox satisfies both requirements
   at once; if the sending address has to stay unmonitored, set a Postmark
   `ReplyTo` on the message instead and monitor that.

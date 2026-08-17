# Running the FineVines website — a guide for the office

This is the day-to-day guide for keeping finevines.com up to date. It's written for whoever at FineVines is
running the machine (Barbara, or anyone covering for her) — no programming knowledge required. If you're a
developer looking for the technical README, see [`../README.md`](../README.md) instead.

---

## What this tool does

`finevines.exe` is one small program that does five jobs. **Normally you run none of them**: the site updates
itself every night in the cloud (see "The nightly run" below). This table is here so the output makes sense when
you read it, and for the rare occasion GRIT asks you to run something by hand.

| Command | Plain-language description |
|---|---|
| `enrich` | Pulls the current wine list and public team roster from Salesforce, writes wine enrichment for anything new or changed, and refreshes `data\wines.json` plus `data\team.json`. This is the only step that talks to Salesforce. |
| `enrichcollections` | Researches useful editorial for new region, producer, and varietal pages. New pages run first, material catalog changes second, and annual accuracy reviews only when neither queue has work. Completed pages are reused. |
| `build` | Turns the wine list, the news posts, and the team roster into the actual website pages (HTML files) in a folder called `dist`. This step never goes out to the internet — it just reads the JSON files and writes pages. |
| `deploy` | Uploads the freshly built pages to FineVines' hosting account (Bunny.net) and tells the CDN to clear its cache so visitors see the new version right away. Only files that actually changed get re-uploaded, so this is fast on a normal day. |
| `redirects` | A separate, occasional command (not part of the nightly run) that maps every old finevines.com web address to its new location, so old links and Google search results keep working after the rebuild. This is mainly a one-time launch-day tool — GRIT will run this as part of go-live, not something you need to run regularly. |

The build also maintains the SEO browse structure automatically. Known spelling
variants in `data\taxonomy.json` resolve to one canonical producer, region, or
varietal page, and region pages link through the geographic hierarchy. A focused
region-and-varietal page is created only when the current catalog contains at
least six matching wines from at least two producers. When stock changes and a
combination falls below that floor, it is no longer advertised in the sitemap or
collection links. `data\taxonomy.json` is curated source data and is not rewritten
by the nightly pipeline.

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

**OpenAI** — needed for `enrich` (researches each wine and writes its tasting notes),
`enrichcollections`, and the image stage (reads bottle labels and sweeps for watermarks).
The hosted image-review click path is local and deterministic; it makes no AI call:
- `OPENAI_API_KEY` — an API key from OpenAI's platform console. GRIT can help set up the account.
- `FINEVINES_OPENAI_MODEL` — optional; leave blank and the tool picks a sensible default.

**Bottle-image search** — used by the automated image-discovery stage:
- `FINEVINES_BRAVE_SEARCH_KEY` — Brave Image Search API key for the independent image index.

**Mail relay (SMTP)** — needed only for `notify`, the nightly digest email. Not used by anything you run by
hand. Fine Vines sends through smtp.com's relay; these come from that account:
- `FINEVINES_SMTP_HOST` — the relay's submission host.
- `FINEVINES_SMTP_PORT` — `587` for STARTTLS (the usual one) or `465` for implicit TLS. Either way the
  connection is encrypted before the password is sent; a relay that will not encrypt fails the send.
- `FINEVINES_SMTP_USER` / `FINEVINES_SMTP_PASS` — the relay's SMTP credentials.
- `FINEVINES_NOTIFY_FROM` — the address the digest is sent from. It has to be one the relay is authorised to
  send for (SPF/DKIM), and a mailbox someone reads: the digest invites a reply when a bottle photo looks wrong.
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
  nightly `enrich`/`enrichcollections`/`build`/`deploy` cycle.

**Site**
- `FINEVINES_SITE_BASE_URL` — optional; the site's public URL (`https://finevines.com`). Leave blank and the
  tool defaults to that address. Set this explicitly to the staging URL for a staging deployment.

Before the first production deploy, George must confirm the public organization-wide contact details.
After that approval, set `contactConfirmed` to `true` in `data\site.json`. Until then,
`finevines deploy` refuses to publish to `finevines.com`; staging deploys remain available.

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
cloud — reviewer corrections, Salesforce refresh, collection-page editorial, bottle photographs, build, upload, and a digest email
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

It runs `enrich`, then `enrichcollections`, then `build`, then `deploy`, in that order, and stops immediately if any step fails — so a
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

- **`data\news\`** — this is Barbara's (or whoever's) to manage, and normally you'll
  never open it directly — you'll use the Claude news skill described below, which edits it through
  a conversation.
- **`data\site.json`** — GRIT owns the public contact details, client-confirmation flag, and curated homepage
  wine list. Change the confirmation flag only after explicit client approval.
- **`data\wines.json` and `data\team.json`** — these files are machine-owned by `enrich`. Never hand-edit their
  Salesforce-owned fields: the next run will overwrite them from Salesforce. The team skill may still maintain
  `photoPath` and `note`, which the sync deliberately preserves.

---

## The two Claude skills

Claude Code lets office staff update news/events and team photographs through a conversation, without
touching any files directly.

### One-time install

In Claude Code, run:

```
/plugin marketplace add <path to this repo>
```

(GRIT will give you the exact path or URL to use the first time this is set up.) Then install the two plugins
from that marketplace: `finevines-news` and, if team-photo maintenance is needed, `finevines-team`.

### Posting news, arrivals, or events

Just start a conversation and describe what you want to post — e.g. "I want to post about Friday's tasting
event." Claude will ask a few plain-language questions (what it's about, a title, the date, and so on — no
mention of files or code), write it up in the FineVines voice, show you the draft for approval, and then ask
whether to publish it right away. If you say yes, it runs `build` and `deploy` itself and reports back what
happened.

### Updating the team page

Names, email addresses, roles, additions, and removals come from Salesforce automatically. An active Salesforce
user appears when their role is `Executive`, `Sales Rep`, or `Back Office`. Jeff Barbour is temporarily
included by immutable Salesforce user ID as `Sales Manager` while his Salesforce role remains unset; other users do not. Use the
`finevines-team` skill only for a selected person's local photograph or internal photo reminder. Salesforce-owned
fields are refreshed on the next nightly run. George's public address is the confirmed exception:
`george@finevines.com` is used instead of his Salesforce User email.

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

### Hosted image review: automatic path

There is no decision-file download. After signing in, the reviewer selects a
candidate and the protected Edge Script writes one immutable action to Bunny.
It immediately dispatches GitHub Actions; if dispatch is unavailable, the
nightly pipeline sees the same pending action. Production builds, deploys,
commits, refreshes the queue, and writes the receipt. The page polls that receipt
and does not say "deployed" early. Test performs the same validation and build
but writes an honest `validated` receipt without changing a live site.

Create two Bunny **Standalone** Edge Scripts and attach the custom hosts:
`review.finevines.biz` for test and `review.finevines.com` for production. Each
script has its own values below; do not reuse signing secrets or cookie names
between environments.

| Bunny Edge value | Test | Production |
|---|---|---|
| `REVIEW_ENVIRONMENT` | `test` | `production` |
| `REVIEW_ORIGIN` | `https://review.finevines.biz` | `https://review.finevines.com` |
| `REVIEW_COOKIE_NAME` | `fv_review_test` | `fv_review_production` |
| `GITHUB_REPOSITORY` | `danowitz/finevines-website` | same |
| `BUNNY_STORAGE_ENDPOINT` | dedicated review zone's regional endpoint | same |
| `BUNNY_STORAGE_ZONE` | dedicated private review zone | same |

Store `REVIEW_SESSION_SECRET` (32+ random characters),
`BUNNY_STORAGE_KEY`, and the database authentication token as Bunny
**environment secrets**, not ordinary source variables. Reviewer credentials
are individual salted password hashes in the transactional review database;
there is no shared console password. `GITHUB_DISPATCH_TOKEN` is required to
start processing immediately; the five-minute scheduled review processor is
the independent recovery path. Never substitute a broad operator or desktop
token. The token must be fine-grained,
limited to this repository, with only **Contents: write** because that is the
permission GitHub requires for repository dispatch.

The review storage zone must be separate from the website storage zone and must
have **no Pull Zone or public hostname attached**. Add
`FINEVINES_REVIEW_STORAGE_ZONE`, `FINEVINES_REVIEW_STORAGE_KEY`, and
`FINEVINES_REVIEW_STORAGE_ENDPOINT` as GitHub repository secrets for the two
action processors. The Edge Script gets the same values under the shorter
`BUNNY_STORAGE_*` names above.

The reconciler also configures both console Pull Zones as dynamic applications:
cookies are preserved, Bunny respects the script's `Cache-Control: no-store`,
Smart Cache excludes the HTML/JSON routes, and request coalescing, stale serving,
and error caching remain disabled. These are authentication requirements, not
performance preferences.

In GitHub, create environments `review-test` and `review-production`. Store
distinct review passwords and session secrets in the repository secrets named
`FINEVINES_REVIEW_{TEST,PRODUCTION}_{PASSWORD,SESSION_SECRET}`. Run the
idempotent `review-console-provision.yml` once to reconcile the two scripts,
their private configuration, Pull Zones, DNS, and certificates. Deployments
resolve the script by its unique fixed name and use the existing Bunny account
API key, so a copied operator token or manually synchronized script ID is not
part of the path. Run `review-console.yml` for `test`,
complete the live security/action checks in the design spec, then run it for
`production`. Finally set repository variable
`FINEVINES_REVIEW_AUTO_DEPLOY=true`; later console-code pushes will deploy the
test script automatically, while production remains an explicit protected
environment promotion.

Neither host belongs in a sitemap or public navigation. Keep the universal
`X-Robots-Tag` and `Cache-Control: no-store` checks in the activation canary;
the password, not the unlinked hostname, is the access control.

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
not happen. Hosted-review actions are immutable files, not a shared queue. A
pending pointer remains in Bunny until a durable receipt proves that the exact
catalog commit reached the site, so an interrupted run needs no manual recovery.

Step by step:
- **reviewapply failed** — no receipt is written and the immutable action stays
  pending. The next immediate or nightly run retries it.
- **a later build/deploy/commit step failed** — the pending action still exists.
  If the catalog commit landed but receipt publication did not, the catalog's
  `imageReviewActionId` proves which action already landed and the retry finishes
  the receipt without replacing the image again.
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
  little each night — that is the stage working, not stalling. Once that backlog
  is cleared the step logs `no wines due tonight — image stage is converged;
  nothing to do` and exits 0 on most nights, until the 30-day backoff starts
  returning wines. That is the finished state, not a fault.
- **deploy failed** — `.bunny-manifest.json` was NOT saved and the CDN was NOT
  purged. The next run re-diffs against the old manifest and retries exactly the
  files that never uploaded.
- **commit-back was rejected twice** — a human pushed mid-run. The deploy already
  happened; the site is live and correct, but the repo has not caught up. Re-run
  the pipeline: it re-diffs and commits.
- **notify failed** — everything shipped; only the email did not. The error
  quotes the relay's own reply, and the usual causes read straight off it: a
  `535` means the relay rejected `FINEVINES_SMTP_USER`/`FINEVINES_SMTP_PASS`; a
  `550` on MAIL FROM means the relay will not send for `FINEVINES_NOTIFY_FROM`;
  a `550` naming a recipient means that address in `FINEVINES_NOTIFY_TO` was
  refused. A STARTTLS complaint means the port is wrong — 587 and 465 negotiate
  TLS differently, and the send refuses to fall back to cleartext.

### Review action recovery
Normally there is nothing to do. Check `_review/<environment>/pending/` and the
matching workflow run. A pending file with no receipt is safe to retry by
running `pipeline.yml`; never edit or move the action JSON. A receipt under
`_review/<environment>/receipts/<action-id>.json` is final evidence and the
processor will clean up a stale pending pointer automatically.

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

Add `-dry` to preview the digest without connecting to the relay.

### Rotating a secret
`gh secret set <NAME>`, then `gh workflow run pipeline.yml` to confirm. Secrets
are never printed in logs; a step that needs one and does not have it fails with
`set <NAME> in .env (or the environment) before running <subcommand>`.

### Stopping the pipeline
Disable the workflow: `gh workflow disable pipeline.yml`. The nightly schedule
and every trigger stop; `deploy.bat` remains available on the workstation.

### Hosted-review activation steps still open
The ordinary catalog pipeline credentials already exist. The hosted console
still needs the dedicated review storage zone, the two Edge Scripts/domains,
their environment secrets, the three `FINEVINES_REVIEW_STORAGE_*` repository
secrets, and the two GitHub deployment environments described above. Activate
test first and complete the design contract's live canary before enabling
production or `FINEVINES_REVIEW_AUTO_DEPLOY`.

Also **point `FINEVINES_NOTIFY_FROM` at a mailbox someone actually reads.** The
   digest tells George that if a photograph shows the wrong bottle he should
   reply and it will be replaced, and a reply goes to this address. An address
   the relay is authorised to send for, on a monitored mailbox, satisfies both
   requirements at once; if the sending address has to stay unmonitored, add a
   `Reply-To` header pointing at a mailbox that is watched.

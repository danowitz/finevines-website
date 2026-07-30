# GitHub-Driven CI Pipeline + Review Console — Design

**Date:** 2026-07-29
**Status:** Approved (Joel, 2026-07-29)
**Depends on:** `2026-07-03-finevines-static-site-design.md` (the site, the Go binary, the Bunny zones)

## Problem

Today the entire publish path runs from one Windows machine: `deploy.bat` runs
`finevines enrich → build → deploy`, state lives in local files (`.env`,
`.bunny-manifest.json`, `data/`), and image sourcing (labelfetch → vision
verify → watermark sweep → human review → import) is a hand-driven loop. Nothing
updates unless Joel runs it, and nobody but Joel can act on a wrong image or a
bad tasting note.

The goal: move the whole pipeline to GitHub Actions using Bunny.net's GitHub
integration where it natively applies (Edge Scripting), make image sourcing
fully automatic behind hard quality gates, and close the loop with a digest
email plus a hosted review console where non-technical reviewers (George,
Barbara) can fix text and images themselves — no accounts, no monitored inbox.

## Decisions (made during brainstorming, 2026-07-29)

1. **Full pipeline in CI** — enrich, images, build, deploy all run unattended.
   Not just build+deploy.
2. **Every push runs everything**, plus a nightly schedule, manual dispatch,
   and `repository_dispatch` from the console.
3. **Images are fully automatic** — fetch, vision-verify, watermark-sweep,
   auto-import to the live site. The two verification stages are hard gates.
   (Risk accepted explicitly: a bad image can go live between import and the
   digest being read.)
4. **CI commits state back to `master`** as a bot commit (`[skip ci]`) — data,
   imported photos, deploy manifest. Repo stays the source of truth;
   enrichment hashes persist so wines are never re-billed.
5. **Digest email after each run that changed something**, listing what needs
   validation, with magic links into the console.
6. **Review console on Bunny Edge Scripting** with signed expiring magic-link
   auth and a **change queue + auto-trigger** write path (queue file in
   storage, `repository_dispatch` kicks the pipeline; changes live in minutes
   as auditable commits).
7. **GitHub-hosted `ubuntu-latest` runners.** The repo is public → free
   minutes, and self-hosted runners on public repos are a security hazard.

## Sub-project A — CI pipeline

One workflow, `.github/workflows/pipeline.yml`.

### Triggers

- `push` to `master` (bot commits carry `[skip ci]` so they don't loop)
- `schedule`: nightly ~08:15 UTC (~2:15am Central)
- `workflow_dispatch` (manual button)
- `repository_dispatch` type `review-console` (fired by the console)

`concurrency: { group: pipeline, cancel-in-progress: false }` — runs queue,
never overlap (protects the manifest and the bot-commit push). Jobs that use
secrets never run on `pull_request` events; fork PRs get build/test only.

### Steps

1. **Drain the change queue** — new `finevines applyqueue` subcommand. Fetch
   `_review/queue.json` from the storage zone; apply each action:
   - *image swap*: replace the wine's image with the chosen candidate
   - *text feedback*: re-run the OpenAI text generation for that wine with the
     reviewer's note appended to the prompt
   - *flag/delist*: mark the wine per the existing delisting lifecycle
   Then truncate the queue (idempotent: actions carry IDs; applied IDs are
   recorded so a crash mid-drain never double-applies).
2. **Enrich** — `finevines enrich` against live Salesforce. Existing
   SourceHash logic already skips unchanged wines (no OpenAI re-billing).
3. **Images** — for wines missing real photos: labelfetch (search → fetch →
   vision-verify) then the watermark sweep, then auto-import of survivors.
   - **Hard gates:** an image failing vision verification or the watermark
     sweep never imports. No override path in CI.
   - **Attempt ledger** (new): per-SKU `lastAttempted` record committed with
     the data, so nightly runs don't re-search the same imageless wines
     forever. Failed SKUs retry after a backoff (default 30 days).
   - Provenance: `imageSourceUrl` retained on every imported image (existing
     rule).
4. **Build** — `finevines build` → `dist/`.
5. **Deploy** — `finevines deploy` (existing manifest diff → upload → delete →
   save manifest → purge). `.bunny-manifest.json` moves from gitignored to
   **tracked** so CI retains diff state between runs.
6. **Commit back** — bot user commits `data/`, imported photos under
   `assets/img/wines/`, and `.bunny-manifest.json` to `master`, message
   prefixed `pipeline:` and suffixed `[skip ci]`. On push rejection (human
   pushed mid-run): rebase and retry once; if still rejected, fail loudly —
   next run reconciles.
7. **Notify** — new `finevines notify` subcommand. Sent **only when the run
   changed something**. Contents: new wines, delistings, text refreshes, newly
   imported images (thumbnails), queue actions applied, coverage stats — each
   item linking to its live page and (once Sub-project B exists) a magic link
   into the console. Provider: Postmark (GRIT account). Recipients:
   `FINEVINES_NOTIFY_TO` (comma-separated). Until the console ships, the
   digest links to live pages only.

### Secrets (GitHub Actions repository secrets)

`FINEVINES_SF_BASE_URL`, `FINEVINES_SF_CLIENT_ID`, `FINEVINES_SF_CLIENT_SECRET`,
`OPENAI_API_KEY`, `FINEVINES_BUNNY_STORAGE_ZONE`, `FINEVINES_BUNNY_STORAGE_KEY`,
`FINEVINES_BUNNY_STORAGE_ENDPOINT`, `FINEVINES_BUNNY_API_KEY`,
`FINEVINES_BUNNY_PULL_ZONE_ID`, `FINEVINES_BUNNY_SCRIPT_ID`,
`FINEVINES_GA_ID`, `FINEVINES_SITE_BASE_URL`, `POSTMARK_TOKEN`,
`FINEVINES_NOTIFY_TO`, `FINEVINES_NOTIFY_FROM`, `FINEVINES_REVIEW_HMAC_SECRET`.

(`FINEVINES_NOTIFY_FROM` added during planning: Postmark accepts a send from
an unconfirmed sender signature with HTTP 200 + non-zero ErrorCode, so the
From address must be explicit configuration, never a guessed default.)

The console's dispatch PAT is a **Bunny Edge Script secret**, not a GitHub
secret: fine-grained, this repo only, `contents: none`,
`repository_dispatch`-capable (Actions: write) — nothing else.

### Platform note

All pipeline code is Go + Node and cross-platform in principle, but has only
ever run on Windows. The implementation plan starts with a Linux smoke test
(build, unit tests, mock-mode pipeline run) before any live wiring.
`deploy.bat` stays as the documented local/manual fallback.

## Sub-project B — review console

A small web app for non-technical reviewers, hosted entirely on Bunny.

### Where it lives

- **URL:** `review.finevines.biz` (DNS CNAME, same pattern as the main site).
  Not linked from the public site, not in the sitemap, `noindex`, and every
  request must carry a valid token or the script returns 404.
- **Runtime:** one Bunny **Edge Script** serves the console's static HTML/JS
  and its API (read wine + candidate data, append queue actions, fire the
  GitHub trigger). No server anywhere.
- **Source:** this repo, `edge/console/`, deployed by **Bunny's native GitHub
  integration** (link the script to the repo; push = deploy). The existing
  redirects middleware script gets linked the same way, retiring the manual
  API push. *(Open verification task: confirm the integration's exact
  repo/branch/entry-file mechanics against current Bunny docs.)*
- **Data:** candidate images and `queue.json` live in the storage zone under
  `_review/`, a path the public pull zone does not serve.

### Auth — magic links

Each digest email contains per-reviewer links of the form
`review.finevines.biz/?t=<token>` where the token is
`HMAC(FINEVINES_REVIEW_HMAC_SECRET, reviewer + expiry)` with the expiry and
reviewer identity encoded alongside. The Edge Script validates signature and
expiry on every request. No accounts, no passwords, no session store. Expired
link → friendly "ask for a fresh digest" page. Default expiry: 14 days.

### What a reviewer can do

Per wine shown in the digest: view the live page, current photo, fetched
candidate images, and the AI-written text. Actions:

- **Pick a different image** from the candidates (or "no image — use the SVG
  label fallback")
- **Request a text fix** — free-text note fed verbatim into the regeneration
  prompt (e.g. "says oaked; this wine is unoaked")
- **Flag the wine** — wrong producer/vintage/duplicate; flag routes to the
  delist/flag path for Joel rather than auto-acting

### Write path — change queue + auto-trigger

Console action → Edge Script appends `{id, reviewer, sku, action, payload,
ts}` to `_review/queue.json` in storage → script calls GitHub
`repository_dispatch` (type `review-console`) with the narrow PAT → pipeline
run drains the queue (step 1 above) → change lands as a bot commit and
deploys. Reviewer sees their fix live in minutes; every change is auditable in
git history.

Contract pinned during Sub-project A planning (B must honour it):

- `payload` schema is flat: `{candidate, sourceUrl, note, reason}`.
  `sourceUrl` is **required** on image swaps — it becomes the wine's
  `imageSourceUrl`; provenance is unsatisfiable without it.
- The console **rewrites the whole queue file** on each append; the pipeline
  clears the queue by deleting it (Bunny treats 404 as success). A mid-drain
  append therefore reappears next run and the applied-ID ledger no-ops any
  duplicate.
- Uploading candidate images to `_review/candidates/` is **B's job** — the
  pipeline's fetch stage stages candidates locally (gitignored
  `data/fetched-images/`) and discards them in CI; `applyqueue` resolves an
  image swap's `payload.candidate` relative to `_review/candidates/`.

## Error handling

- Any pipeline step failing aborts the run **before** the manifest save /
  commit-back (the existing deploy ordering invariants extend upward: no
  partial state is ever persisted as if complete).
- Failed runs surface via GitHub's default workflow-failure email to the repo
  owner; the digest email is for content changes, not CI health.
- Queue drain is idempotent (applied-ID ledger); a crashed run re-applies
  safely.
- Magic-link validation failure = 404, never an error page that confirms the
  console exists.

## Testing

- Existing Go unit tests run in CI on every push (they already cover deploy
  ordering, eligibility, hashing).
- New units get tests in the existing style: `applyqueue` (drain idempotency,
  each action type), attempt ledger (backoff), notify (digest assembly from a
  run diff — send path mocked), token signing/validation (shared Go + edge
  test vectors).
- Mock-mode (`FINEVINES_SF_MOCK=1`) full-pipeline run as a CI smoke test that
  never touches live Salesforce/OpenAI/Bunny.

## Build order

**A first** — it stands alone and is immediately useful (digest links to live
pages). **B second** — the digest's links upgrade to console magic links when
it ships.

## Explicitly out of scope

- Any change to enrichment logic, eligibility rules, or the build itself
- gpt-image-1 generation (failed QA 2026-07-28; SVG labels remain the fallback)
- Retiring the local workflow (`deploy.bat` remains a documented fallback)
- Auth beyond magic links (no accounts/SSO)
- Console features beyond image pick / text feedback / flag

## Risks (accepted, on record)

1. **Fully-automatic images:** a wrong or watermarked image can be publicly
   live from nightly import until a digest reader catches it. The two hard
   gates reduce, not eliminate, this. Accepted by Joel 2026-07-29.
2. **Scope/commercial:** the review console is new build effort beyond the
   client's confirmed $12,900 scope. Flagged; commercial handling is Joel's
   call and does not block Sub-project A.
3. **Public repo:** bot commits publish wine data nightly. Already true today,
   just more frequent.

## Open items to resolve during planning

1. Exact mechanics of Bunny Edge Scripting's GitHub integration (repo linking,
   branch, entry file, monorepo support) — verify against current docs.
2. Whether one Edge Script can serve both the console UI and API cleanly, or
   the UI should be static files in the storage zone with only the API at the
   edge.
3. Postmark sender domain/signature for the digest (GRIT's account vs a
   finevines.biz sender).

# Finish the Catalog and Cut Over Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the nightly pipeline running unattended again so image coverage climbs on its own, clear the retired artwork off the CDN, close the open data and content issues, and land the production cutover.

**Architecture:** The pipeline (`.github/workflows/pipeline.yml`) is the only thing that moves image coverage without a human. It has been `disabled_manually` since 2026-08-04 because its commit-back step dies on a rebase conflict in `data/wines.json`. Phase 1 extracts that step into a tested script that resolves conflicts in the bot's favour for bot-owned paths, then re-enables the workflow. Everything after Phase 1 is either data work that the running pipeline makes cheap, or one-time content and cutover work that has a hard deadline: **anything that reads the old finevines.com must happen before DNS flips.**

**Tech Stack:** Go 1.x (`cmd/finevines`, `internal/*`), Node 20+ with `node --test` (`tests/unit`, `tests/e2e`), bash (`tools/labelfetch/*.sh`), GitHub Actions, Bunny.net storage + pull zone + Edge Script, Salesforce REST (client-credentials), OpenAI Responses API.

## Global Constraints

- **Never use the word "trade" in client-facing copy.** Say "wholesale", "our accounts", "the business", or name the audience.
- **No addresses anywhere** — no street address, city/ZIP, P.O. Box, or fax, in footer, contact page, JSON-LD, or catalog data. Public contact is phone + email only.
- **Barbara Fultz goes by Barb.** Use Barb in every user-facing string and document.
- **Salesforce is authoritative for commercial fields** (SKU, producer, name, vintage, stock, price). Enrichment fills descriptive gaps only.
- **Web-eligibility rule:** `stockQty > 0 AND SKU does not start with "9" AND FV_Ready_To_Sell__c = true`.
- **No invented bottle, label, closure, or packaging artwork.** A wine without a verified photograph shows the neutral "Product image unavailable" SVG (`internal/label/label.go`). Watermark removal is not an allowed cleanup operation.
- **The About page keeps Fine Vines' own copy voice** ("A service company, first and last..."). Brand voice elsewhere is elegant, editorial, old-world wine-merchant. Tagline: *Pouring elegance with a sommelier's touch*.
- **`git add` in any pipeline step stays pathspec-limited.** `git add -A` sweeps the Linux helper binaries (`finevines`, `imgcheck`, `imgnorm` — no `.exe`, so not gitignored) into master.
- **PowerShell here-strings mangle `git commit -m` in this harness.** Use `git commit -F <file>`.
- **Parallel Claude sessions race the git index.** Re-check the current branch before committing, and commit via explicit pathspec.
- Every task ends green on `go test ./...` and `npm run test:unit`.

---

## Current measured state (2026-08-09)

| Metric | Value |
|---|---|
| Wines in catalog | 2,642 |
| Wines with a verified photograph | 1,282 (48.5%) |
| Portfolio cards (vintage-collapsed) | 1,955 |
| Cards showing a real photograph | 916 (46.9%) |
| Cards on the neutral placeholder | 1,039 |
| Attempt ledger: recorded misses | 1,033 (30-day backoff) |
| Attempt ledger: imported-then-pulled | 172 |
| Attempt ledger: unevaluated | 84 |
| Never attempted | 71 |
| Orphaned bottle-art SVGs in `assets/img/wines/` | 1,869 (58 MB), referenced by nothing |
| Pipeline workflow state | `disabled_manually` (id 326604428) |
| Last 5 pipeline runs | failed — rebase conflict in `data/wines.json`, `data/hot-sellers.json` |

---

## File Structure

**Created:**
- `tools/pipeline/commitback.sh` — the commit-back step, extracted from the workflow so it can be tested. Owns: staging bot-owned paths, committing, rebasing onto `origin/master`, resolving conflicts in bot-owned paths in the bot's favour, validating the merged JSON, pushing.
- `tests/unit/commitback.test.mjs` — drives `commitback.sh` against throwaway git repos that reproduce the exact 2026-08-04 failure.
- `dist`-side: nothing new.
- `data/legal/privacy-policy.md`, `data/legal/legal.md` — old-site copy captured before cutover kills it.
- `templates/privacy-policy.html.tmpl` — the new privacy policy page template.
- `docs/supplier-media-request.md` — the email-ready ask to George for producer/importer photography.

**Modified:**
- `.github/workflows/pipeline.yml:176-195` — the inline commit-back block becomes a call to `tools/pipeline/commitback.sh`.
- `assets/img/wines/*.svg` — 1,869 orphaned bottle-art files deleted.
- `internal/build/build.go` — route `/privacy-policy/`.
- `internal/salesforce/client.go` — `rosterSOQL` + Roster mapping, once #2 resolves.
- `internal/enrich/` — producer backfill for rows where Salesforce is genuinely blank.
- `redirect-overrides.json` — `/legal` entry.
- `docs/operations.md` — runbook entries for the new commit-back behaviour.

**Each phase produces a working, independently shippable change.** Phases 1–2 are unblocked today. Phase 3 is blocked on Phase 4 (Salesforce access). Phase 5 is deadline-driven and must precede Phase 7.

---

# Phase 1 — Restart the image machine

The single highest-value change in this plan. Nothing else moves image coverage without a human sitting at a keyboard.

### Task 1: Extract the commit-back step into a tested script

**Files:**
- Create: `tools/pipeline/commitback.sh`
- Create: `tests/unit/commitback.test.mjs`
- Modify: `.github/workflows/pipeline.yml:176-195`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `tools/pipeline/commitback.sh`, invoked as `bash tools/pipeline/commitback.sh`. Exit 0 = state is on `origin/master` (or there was nothing to commit). Exit non-zero = a human must look. Honours `PIPELINE_BOT_NAME` / `PIPELINE_BOT_EMAIL` (defaulted), and `PIPELINE_REMOTE` (default `origin`) so tests can point it at a local bare repo.

**Design note — why the bot wins on `data/`:** the deploy step runs *before* commit-back. By the time this script runs, the bot's `data/wines.json` is already the version live on the CDN. Keeping a human's concurrent edit would leave the repo claiming something different from what is published. Taking the bot's copy wholesale for bot-owned paths is what makes the repo agree with production. The discarded human diff is printed to the run log rather than thrown away silently.

**Why whole-file, not `-X theirs`:** `-X theirs` resolves conflicts hunk-by-hunk. On a 5 MB JSON array, that interleaves two versions of the same records and can yield a file that parses but is semantically wrong. `git checkout --theirs -- <path>` takes the bot's entire file, which is exactly the deployed one.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/commitback.test.mjs`:

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'tools', 'pipeline', 'commitback.sh')

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

// A bare "origin", a clone that plays the human, and a clone that plays the
// runner. Mirrors the real topology: both push to the same master.
function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'commitback-'))
  const origin = join(root, 'origin.git')
  mkdirSync(origin)
  git(origin, 'init', '--bare', '--initial-branch=master')

  const seed = join(root, 'seed')
  git(root, 'clone', origin, 'seed')
  git(seed, 'config', 'user.name', 'seed')
  git(seed, 'config', 'user.email', 'seed@example.com')
  mkdirSync(join(seed, 'data'))
  mkdirSync(join(seed, 'assets', 'img', 'wines'), { recursive: true })
  writeFileSync(join(seed, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'a.svg' }]))
  writeFileSync(join(seed, 'data', 'hot-sellers.json'), JSON.stringify({ skus: ['1'] }))
  writeFileSync(join(seed, '.bunny-manifest.json'), JSON.stringify({}))
  git(seed, 'add', '.')
  git(seed, 'commit', '-m', 'seed')
  git(seed, 'push', 'origin', 'master')

  const runner = join(root, 'runner')
  git(root, 'clone', origin, 'runner')
  cpSync(SCRIPT, join(runner, 'commitback.sh'))

  const human = join(root, 'human')
  git(root, 'clone', origin, 'human')
  git(human, 'config', 'user.name', 'human')
  git(human, 'config', 'user.email', 'human@example.com')

  return { root, origin, runner, human }
}

function runCommitback(cwd) {
  return execFileSync('bash', ['commitback.sh'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PIPELINE_BOT_NAME: 'bot', PIPELINE_BOT_EMAIL: 'bot@example.com' },
  })
}

test('pushes the run state when master has not moved', (t) => {
  const { root, runner, origin } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'a.jpg' }]))
  runCommitback(runner)

  const head = git(origin, 'show', 'master:data/wines.json')
  assert.match(head, /a\.jpg/)
})

test('bot wins on data/ when a human pushed a conflicting change mid-run', (t) => {
  const { root, runner, human, origin } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // The human edits the same file and pushes first — the 2026-08-04 failure.
  writeFileSync(join(human, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'human.jpg' }]))
  writeFileSync(join(human, 'data', 'hot-sellers.json'), JSON.stringify({ skus: ['1', '2'] }))
  git(human, 'add', 'data')
  git(human, 'commit', '-m', 'human edit')
  git(human, 'push', 'origin', 'master')

  // The runner has its own version of both files.
  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'bot.jpg' }]))
  writeFileSync(join(runner, 'data', 'hot-sellers.json'), JSON.stringify({ skus: ['9'] }))
  runCommitback(runner)

  assert.match(git(origin, 'show', 'master:data/wines.json'), /bot\.jpg/)
  assert.match(git(origin, 'show', 'master:data/hot-sellers.json'), /"9"/)
  // The human's commit is still in history — only the file content lost.
  assert.match(git(origin, 'log', '--format=%s'), /human edit/)
})

test('the merged wines.json still parses as JSON', (t) => {
  const { root, runner, human } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(human, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'human.jpg' }]))
  git(human, 'add', 'data')
  git(human, 'commit', '-m', 'human edit')
  git(human, 'push', 'origin', 'master')

  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'bot.jpg' }]))
  const out = runCommitback(runner)

  assert.match(out, /wines\.json parses/)
})

test('a conflict outside bot-owned paths aborts instead of overwriting', (t) => {
  const { root, runner, human } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(human, 'README.md'), 'human version\n')
  git(human, 'add', 'README.md')
  git(human, 'commit', '-m', 'human readme')
  git(human, 'push', 'origin', 'master')

  writeFileSync(join(runner, 'README.md'), 'bot version\n')
  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'bot.jpg' }]))
  // README is not in the bot's pathspec, so it is never staged and never
  // conflicts. This asserts the pathspec limit holds: the push succeeds and
  // the human's README survives untouched.
  runCommitback(runner)
  assert.equal(git(runner, 'show', 'origin/master:README.md'), 'human version\n')
})

test('nothing to commit is a success, not a failure', (t) => {
  const { root, runner } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const out = runCommitback(runner)
  assert.match(out, /nothing changed this run/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:unit -- --test-name-pattern=commitback`
Expected: FAIL — `tools/pipeline/commitback.sh` does not exist (`ENOENT` from the `cpSync`).

- [ ] **Step 3: Write the script**

Create `tools/pipeline/commitback.sh`:

```bash
#!/usr/bin/env bash
# Commit the run's state back to master.
#
# Runs AFTER the deploy, so by the time we get here the bot's data/ files are
# already the ones live on the CDN. That is the whole reason this script
# resolves conflicts in the bot's favour: keeping a human's concurrent edit
# would leave the repo describing something other than what is published.
#
# The pathspec below must stay narrow. `git add -A` would sweep in the Linux
# helper binaries built earlier in the job — .gitignore lists only the .exe
# names, so bare `finevines`, `imgcheck` and `imgnorm` are untracked but not
# ignored.
set -euo pipefail

REMOTE="${PIPELINE_REMOTE:-origin}"
BOT_PATHS=(data assets/img/wines .bunny-manifest.json)

git config user.name "${PIPELINE_BOT_NAME:-finevines-pipeline[bot]}"
git config user.email "${PIPELINE_BOT_EMAIL:-215369143+finevines-pipeline[bot]@users.noreply.github.com}"

git add "${BOT_PATHS[@]}"
if git diff --cached --quiet; then
  echo "nothing changed this run — no commit"
  exit 0
fi
git commit -m 'pipeline: nightly run [skip ci]'

# Is a bot-owned path? Anything else conflicting means the pathspec assumption
# broke and a human needs to look.
bot_owned() {
  case "$1" in
    data/*|assets/img/wines/*|.bunny-manifest.json) return 0 ;;
    *) return 1 ;;
  esac
}

git fetch "$REMOTE" master

if ! git rebase "$REMOTE/master"; then
  conflicts=$(git diff --name-only --diff-filter=U)
  echo "rebase hit conflicts:"
  echo "$conflicts"

  for f in $conflicts; do
    if ! bot_owned "$f"; then
      echo "CONFLICT IN A PATH THE PIPELINE DOES NOT OWN: $f"
      echo "aborting rather than guessing — resolve by hand"
      git rebase --abort
      exit 1
    fi
    # In a rebase, --theirs is the commit being replayed: ours. Take the whole
    # file, not a hunk-level merge — a hunk-merged 5MB JSON array can parse and
    # still be semantically wrong.
    echo "  $f — taking the pipeline's version (it is what was deployed)"
    git diff -- "$f" | head -40 || true
    git checkout --theirs -- "$f"
    git add -- "$f"
  done

  GIT_EDITOR=true git rebase --continue
fi

# The merge above is only safe if the result is still valid JSON. A corrupt
# wines.json would be committed, pushed, and only discovered by tomorrow's
# enrich failing — long after the deploy that used it.
for f in data/wines.json data/hot-sellers.json .bunny-manifest.json; do
  [ -f "$f" ] || continue
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" \
    || { echo "$f is not valid JSON after the merge — refusing to push"; exit 1; }
  echo "$f parses"
done

git push "$REMOTE" HEAD:master
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:unit -- --test-name-pattern=commitback`
Expected: PASS, 5/5.

- [ ] **Step 5: Wire the workflow to the script**

In `.github/workflows/pipeline.yml`, replace the body of the `Commit the run's state back to master` step (currently the inline `git config` … `git push` block at lines 176-195) with:

```yaml
      - name: Commit the run's state back to master
        run: bash tools/pipeline/commitback.sh
```

Keep every comment above the step — the `git add -A` warning and the "DO NOT USE Re-run failed jobs" note in the following step are both still load-bearing.

- [ ] **Step 6: Verify the whole suite is green**

Run: `go test ./... && npm run test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tools/pipeline/commitback.sh tests/unit/commitback.test.mjs .github/workflows/pipeline.yml
git commit -F- <<'EOF'
fix(pipeline): the nightly run stops dying on its own commit-back

The deploy runs before the commit-back, so the bot's data/ files are already
what is live by the time the push happens. Resolving those conflicts in the
human's favour left the repo disagreeing with the CDN; resolving them in the
bot's favour is what makes the two agree. Whole-file, not hunk-level: a
hunk-merged wines.json parses and is still wrong.

A conflict in any path the pipeline does not own aborts the run.
EOF
```

---

### Task 2: Re-enable the workflow and prove one full run

**Files:**
- Modify: none (GitHub-side state + verification)

**Interfaces:**
- Consumes: `tools/pipeline/commitback.sh` from Task 1.
- Produces: a green `pipeline` run and a fresh `data/image-attempts.json` on master.

**Do not start this task while a local image batch is mid-flight.** The pipeline pushes to master; a concurrent local session racing it is exactly the condition Task 1 handles, but there is no reason to exercise it on the first run.

- [ ] **Step 1: Push Task 1 to master**

```bash
git push origin master
```

Note this triggers a `pipeline` run only once the workflow is enabled (next step) — the push itself lands against a disabled workflow.

- [ ] **Step 2: Re-enable the workflow**

```bash
gh workflow enable pipeline.yml
gh workflow list --all
```

Expected: `pipeline  active  326604428`.

- [ ] **Step 3: Trigger a run by hand and watch it**

```bash
gh workflow run pipeline.yml
gh run watch $(gh run list --workflow=pipeline.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: all steps green, including `Commit the run's state back to master`. Runtime will be long — the image stage alone is budgeted at 120 minutes.

- [ ] **Step 4: Verify the run actually moved coverage**

```bash
git pull origin master
node -e "
const a=require('./data/image-attempts.json'), w=require('./data/wines.json');
const real=w.filter(x=>!/\.svg$/i.test(x.imagePath||'')).length;
console.log('photographs:', real, 'of', w.length, (100*real/w.length).toFixed(1)+'%');
const out={}; for(const k in a){out[a[k].outcome]=(out[a[k].outcome]||0)+1}
console.log(out);
"
```

Expected: photograph count above 1,282; the ledger's `imported` count has grown and `unevaluated`/never-attempted have shrunk. Record both numbers — they are the baseline for Task 3.

- [ ] **Step 5: Confirm the schedule is armed**

```bash
gh run list --workflow=pipeline.yml --limit 5
```

Expected: the manual run present. The cron (`15 8 * * *` UTC ≈ 2:15am Central) fires on its own from here; check again after the next calendar night.

- [ ] **Step 6: Commit the runbook note**

Add to `docs/operations.md`, under the nightly-run section:

```markdown
### When the nightly run reports a conflict

The nightly run publishes first and records second, so if it ever has to choose
between its own `data/` files and someone's hand edit, it keeps its own — those
are the files already live on the site. The run log prints exactly what it set
aside. If you made a hand edit that evening and it vanished, it is in the log,
and re-applying it on top is safe.

A conflict in any *other* file stops the run instead of guessing. That needs
GRIT.
```

```bash
git add docs/operations.md
git commit -m "docs(operations): what a nightly conflict means for the office"
```

---

### Task 3: Put a number on the coverage ceiling

**Files:**
- Create: `reports/image-coverage.md` (regenerated, committed)
- Create: `tools/coverage/report.mjs`

**Interfaces:**
- Consumes: `data/wines.json`, `data/image-attempts.json`.
- Produces: `node tools/coverage/report.mjs` → writes `reports/image-coverage.md`, prints the card-level percentage. Used by Task 4's client email and by the cutover checklist.

Rationale: the 1,033 recorded misses will not all resolve. Deciding "done" needs a number that separates *not yet tried* from *tried and the open web does not have it*, at the card level the visitor actually sees.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/coverage.test.mjs`:

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarise } from '../../tools/coverage/report.mjs'

test('counts cards, not rows — vintages of one wine collapse', () => {
  const wines = [
    { sku: '1', producer: 'Dom X', name: 'Cuvee A', vintage: '2020', imagePath: 'a.jpg' },
    { sku: '2', producer: 'Dom X', name: 'Cuvee A', vintage: '2021', imagePath: 'b.svg' },
    { sku: '3', producer: 'Dom Y', name: 'Cuvee B', vintage: '2020', imagePath: 'c.svg' },
  ]
  const s = summarise(wines, {})
  assert.equal(s.cards, 2)
  assert.equal(s.cardsWithPhoto, 1)
  assert.equal(s.rowsWithPhoto, 1)
})

test('splits the imageless into tried and never-tried', () => {
  const wines = [
    { sku: '1', producer: 'A', name: 'A', imagePath: 'a.svg' },
    { sku: '2', producer: 'B', name: 'B', imagePath: 'b.svg' },
  ]
  const ledger = { 1: { outcome: 'miss', attempts: 3 } }
  const s = summarise(wines, ledger)
  assert.equal(s.missing.miss, 1)
  assert.equal(s.missing.never, 1)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:unit -- --test-name-pattern=coverage`
Expected: FAIL — cannot resolve `../../tools/coverage/report.mjs`.

- [ ] **Step 3: Write the implementation**

Create `tools/coverage/report.mjs`:

```javascript
import { readFileSync, writeFileSync } from 'node:fs'

const isPhoto = (w) => !/\.svg$/i.test(w.imagePath || '')
const cardKey = (w) => `${(w.producer || '').toLowerCase()}|${(w.name || '').toLowerCase()}`

export function summarise(wines, ledger) {
  const cards = new Map()
  for (const w of wines) {
    const k = cardKey(w)
    cards.set(k, (cards.get(k) || false) || isPhoto(w))
  }
  const missing = { miss: 0, unevaluated: 0, imported: 0, never: 0 }
  for (const w of wines) {
    if (isPhoto(w)) continue
    const rec = ledger[w.sku] || ledger[w.id] || ledger[w.slug]
    if (!rec) missing.never++
    else missing[rec.outcome] = (missing[rec.outcome] || 0) + 1
  }
  return {
    rows: wines.length,
    rowsWithPhoto: wines.filter(isPhoto).length,
    cards: cards.size,
    cardsWithPhoto: [...cards.values()].filter(Boolean).length,
    missing,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const wines = JSON.parse(readFileSync('data/wines.json', 'utf8'))
  const ledger = JSON.parse(readFileSync('data/image-attempts.json', 'utf8'))
  const s = summarise(wines, ledger)
  const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`
  const md = `# Catalog image coverage

Regenerate with \`node tools/coverage/report.mjs\`.

| Metric | Value |
|---|---|
| Wines | ${s.rows} |
| Wines with a photograph | ${s.rowsWithPhoto} (${pct(s.rowsWithPhoto, s.rows)}) |
| Portfolio cards | ${s.cards} |
| Cards with a photograph | ${s.cardsWithPhoto} (${pct(s.cardsWithPhoto, s.cards)}) |
| Cards on the neutral placeholder | ${s.cards - s.cardsWithPhoto} |

## Why the rest are missing

| Ledger outcome | Wines |
|---|---|
| searched, nothing usable found | ${s.missing.miss || 0} |
| verified but never evaluated | ${s.missing.unevaluated || 0} |
| imported then withdrawn on audit | ${s.missing.imported || 0} |
| not yet searched | ${s.missing.never || 0} |

"Searched, nothing usable found" is the ceiling the nightly run cannot move on
its own. Those need supplier media (see docs/supplier-media-request.md).
`
  writeFileSync('reports/image-coverage.md', md)
  console.log(md)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:unit -- --test-name-pattern=coverage`
Expected: PASS, 2/2.

- [ ] **Step 5: Generate the report and commit**

```bash
node tools/coverage/report.mjs
git add tools/coverage/report.mjs tests/unit/coverage.test.mjs reports/image-coverage.md
git commit -m "feat(coverage): a card-level image-coverage report with the ceiling broken out"
```

---

# Phase 2 — Clear the retired artwork

### Task 4: Delete the 1,869 orphaned bottle-art SVGs from the repo and the CDN

**Files:**
- Delete: 1,869 files matching `assets/img/wines/*.svg`
- Test: `tests/unit/orphan-assets.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: a smaller `dist/`; `finevines deploy`'s existing orphan-delete path (`internal/deploy/plan.go`, proved by `TestPlan_UploadsChangedAndNewDeletesOrphan`) removes them from the storage zone on the next deploy. No deploy change is needed.

**Verified before writing this task:** no wine in `data/wines.json` references any of these files, and no file in `dist/` links to one. The catalog's 1,303 distinct fallback paths are all generated by `internal/label` at build time under different filenames, which is why `1,869 + 1,303 = 3,172` matches the SVG count in `dist/` exactly. These are the retired invented-label artwork from before the 2026-08-08 decision.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/orphan-assets.test.mjs`:

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'

// The invented-label artwork is retired. Nothing hand-authored may sit in
// assets/img/wines/ as an SVG — every placeholder the site serves is generated
// at build time by internal/label. A stray .svg here is either dead weight
// shipped to the CDN or, worse, invented packaging back on the site.
test('assets/img/wines contains no hand-authored SVGs', () => {
  if (!existsSync('assets/img/wines')) return
  const svgs = readdirSync('assets/img/wines').filter((f) => f.endsWith('.svg'))
  assert.deepEqual(svgs, [], `${svgs.length} retired SVGs still present, e.g. ${svgs.slice(0, 3)}`)
})

test('no wine references an SVG that is checked into assets', () => {
  const wines = JSON.parse(readFileSync('data/wines.json', 'utf8'))
  const checkedIn = existsSync('assets/img/wines')
    ? new Set(readdirSync('assets/img/wines'))
    : new Set()
  const bad = wines
    .map((w) => (w.imagePath || '').split('/').pop())
    .filter((f) => f.endsWith('.svg') && checkedIn.has(f))
  assert.deepEqual(bad, [], 'a wine points at a checked-in SVG instead of a generated one')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:unit -- --test-name-pattern=orphan`
Expected: FAIL — "1869 retired SVGs still present".

- [ ] **Step 3: Delete them**

```bash
git rm --quiet assets/img/wines/*.svg
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:unit -- --test-name-pattern=orphan && go test ./...`
Expected: PASS. The Go suite must stay green — `internal/build` and `internal/label` generate the placeholders, they do not read these files.

- [ ] **Step 5: Rebuild and confirm the site is unchanged where it matters**

```bash
go run ./cmd/finevines build
node -e "
const fs=require('fs');
const wines=JSON.parse(fs.readFileSync('data/wines.json','utf8'));
let bad=[];
for (const w of wines) {
  const p='dist/'+w.imagePath;
  if(!fs.existsSync(p)) { bad.push(w.imagePath); continue }
  if(p.endsWith('.svg') && !fs.readFileSync(p,'utf8').includes('Product image unavailable')) bad.push(w.imagePath);
}
console.log('wines with a missing or non-neutral image:', bad.length);
if(bad.length) { console.log(bad.slice(0,10)); process.exit(1) }
"
```

Expected: `0`. Every wine still resolves to either a photograph or the neutral placeholder.

- [ ] **Step 6: Run the browser tests against the fresh build**

Run: `npm run test:e2e`
Expected: PASS. (The e2e suite serves `dist/` — it must be rebuilt first, which Step 5 did.)

- [ ] **Step 7: Commit**

```bash
git add -A assets/img/wines tests/unit/orphan-assets.test.mjs
git commit -F- <<'EOF'
chore(assets): delete the retired invented-label artwork

1,869 hand-authored bottle SVGs (58MB) that no wine references. They predate
the decision to publish only verified photography, and every deploy was
shipping them to the CDN. The next deploy's orphan pass removes them there.

A test now fails if a hand-authored SVG reappears in assets/img/wines.
EOF
```

- [ ] **Step 8: Deploy and confirm the CDN pruned them**

```bash
./finevines deploy
```

Expected: the deploy log reports ~1,869 deletes. Spot-check one is gone:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://finevines-com.b-cdn.net/assets/img/wines/06-paul-jaboulet-aine-hermitage-vin-de-paille-1-375-06.svg
```

Expected: `404`.

---

# Phase 3 — Salesforce access and the producer data (#1, #2, #8)

Phase 3 is blocked on Task 5. Nothing in Tasks 6–7 can be verified without live Salesforce access.

### Task 5: Stand up the Salesforce Connected App (#1)

**Files:**
- Modify: `.env` (local, git-ignored)
- Modify: GitHub repo secrets

**Interfaces:**
- Consumes: nothing.
- Produces: working `FINEVINES_SF_BASE_URL` / `FINEVINES_SF_CLIENT_ID` / `FINEVINES_SF_CLIENT_SECRET`, and `FINEVINES_SF_MOCK` removed. Unblocks Tasks 6 and 7.

This is a Salesforce-admin task on the client's side, not a code change. The full click-path is in issue #1 — hand that issue to Fine Vines' Salesforce administrator verbatim rather than paraphrasing it.

- [ ] **Step 1: Send issue #1 to the Salesforce administrator**

The four things that come back: Consumer Key, Consumer Secret, My Domain URL, and confirmation that the "Run As" integration user has read on `Product2` and its `FV_*` fields.

- [ ] **Step 2: Verify against a sandbox first**

```bash
go run ./tools/trysf
```

Expected: a token, then a handful of `Product2` rows. If this fails with `invalid_client_id`, the app has not finished propagating — wait 10 minutes.

- [ ] **Step 3: Eyeball a bounded live enrich before letting it loose**

```bash
FINEVINES_SF_LIMIT=25 ./finevines enrich
git diff --stat data/wines.json
```

Expected: 25 rows updated, commercial fields matching Salesforce.

- [ ] **Step 4: Set the production credentials as repo secrets**

```bash
gh secret set FINEVINES_SF_BASE_URL
gh secret set FINEVINES_SF_CLIENT_ID
gh secret set FINEVINES_SF_CLIENT_SECRET
```

- [ ] **Step 5: Close issue #1**

```bash
gh issue close 1 --comment "Connected App live; client-credentials flow verified against sandbox then production. Repo secrets updated."
```

---

### Task 6: Confirm the producer field — `FV_Brand__c` vs `FV_Supplier__c` (#2)

**Files:**
- Modify: `internal/salesforce/client.go` (rosterSOQL + the Roster mapping)
- Test: `internal/salesforce/client_test.go`

**Interfaces:**
- Consumes: live Salesforce access from Task 5.
- Produces: a settled producer field, which Task 7's backfill depends on.

- [ ] **Step 1: Pull both fields for a sample and compare**

```bash
go run ./tools/sfquery -soql "SELECT StockKeepingUnit, Name, FV_Brand__c, FV_Supplier__c FROM Product2 WHERE FV_Ready_To_Sell__c = true LIMIT 50"
```

Look for: which column holds the winery as a customer would name it, and which holds the importer/vendor. Take the answer to George if the sample is ambiguous — this is a client-facing naming call, not a technical one.

- [ ] **Step 2: If the answer is `FV_Supplier__c`, change the mapping**

In `internal/salesforce/client.go`, update `rosterSOQL` and the Roster mapping. Add a test alongside the existing mapping tests:

```go
func TestRosterMapsProducerFromConfirmedField(t *testing.T) {
	raw := `{"records":[{"StockKeepingUnit":"123","Name":"Cuvee A","FV_Brand__c":"Brand Co","FV_Supplier__c":"Supplier Co"}]}`
	rows, err := parseRoster([]byte(raw))
	if err != nil {
		t.Fatalf("parseRoster: %v", err)
	}
	if got, want := rows[0].Producer, "Supplier Co"; got != want {
		t.Errorf("Producer = %q, want %q (issue #2 resolved to FV_Supplier__c)", got, want)
	}
}
```

If the answer is `FV_Brand__c`, write the same test asserting `"Brand Co"` — the point is that the choice is now pinned by a test with the issue number in the failure message, not left provisional in a comment.

- [ ] **Step 3: Run the tests**

Run: `go test ./internal/salesforce/...`
Expected: PASS.

- [ ] **Step 4: Commit and close**

```bash
git add internal/salesforce/
git commit -m "fix(salesforce): pin the public producer field (closes #2)"
gh issue close 2 --comment "Confirmed against live Product2 rows. Pinned by test."
```

---

### Task 7: Backfill the missing producers (#8)

**Files:**
- Modify: `internal/enrich/` (producer extraction)
- Test: `internal/enrich/producer_test.go`
- Modify: `data/wines.json` (regenerated)

**Interfaces:**
- Consumes: the confirmed producer field from Task 6.
- Produces: producer coverage ≥ 95%, no first-word artifacts in the top 50 producers.

**Acceptance from issue #8:** producer coverage ≥ 95%, no first-word artifacts (`Acclaimed`, `Acre`, …) in the top 50 producers by wine count, SKU `513001` has a real name, `go test ./...` green.

- [ ] **Step 1: Establish whether Salesforce is actually blank**

```bash
go run ./tools/sfquery -soql "SELECT COUNT() FROM Product2 WHERE FV_Ready_To_Sell__c = true AND FV_Brand__c = null"
```

This decides the shape of the fix. If Salesforce has the values and they were dropped in import, the fix is in `tools/importenrichment` / `internal/normalize` and no web search is needed. If Salesforce is genuinely blank, continue to Step 2.

- [ ] **Step 2: Write the failing test for the junk-producer detector**

Create `internal/enrich/producer_test.go`:

```go
package enrich

import "testing"

func TestIsJunkProducer(t *testing.T) {
	cases := []struct {
		producer string
		name     string
		want     bool
	}{
		{"Acclaimed", "Acclaimed Cabernet Sauvignon Oakville Napa Valley", true},
		{"Acre", "Acre Napa Valley Cabernet Sauvignon Napa Valley", true},
		{"Altocedro", "Altocedro Ano Cero Malbec", false},
		{"", "Some Wine", true},
	}
	for _, c := range cases {
		if got := IsJunkProducer(c.producer, c.name); got != c.want {
			t.Errorf("IsJunkProducer(%q, %q) = %v, want %v", c.producer, c.name, got, c.want)
		}
	}
}
```

Note the `Altocedro` case: a real producer whose name legitimately leads its wine names must NOT be flagged. The rule cannot be "producer is the first token" alone — it needs a corroborating signal (appears as the leading token AND is absent from the known-producer set built from rows where Salesforce supplied a producer).

- [ ] **Step 3: Run it to verify it fails**

Run: `go test ./internal/enrich/ -run TestIsJunkProducer -v`
Expected: FAIL — `undefined: IsJunkProducer`.

- [ ] **Step 4: Implement `IsJunkProducer`**

```go
// IsJunkProducer reports whether a producer value is an artifact of the catalog
// row rather than a winery: the leading token of the wine's own name, with no
// corroboration from the set of producers Salesforce supplied directly.
//
// A real producer often leads its own wine names (Altocedro Ano Cero Malbec),
// so the leading-token test alone is not enough — knownProducers is what tells
// the two apart.
func IsJunkProducer(producer, name string) bool {
	if strings.TrimSpace(producer) == "" {
		return true
	}
	if knownProducers[normalizeProducer(producer)] {
		return false
	}
	first, _, _ := strings.Cut(strings.TrimSpace(name), " ")
	return strings.EqualFold(first, strings.TrimSpace(producer))
}
```

Populate `knownProducers` from the rows where Salesforce supplied a producer. Wire the flagged rows into the existing enrich identity step so the producer is extracted from the wine name plus web search, carrying the existing match-confidence flag. **Never silently invent a producer** — an unresolvable row keeps its empty producer and sorts last, which the front end already handles (`b90a476`).

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/enrich/ -v`
Expected: PASS.

- [ ] **Step 6: Re-run enrich and check the acceptance numbers**

```bash
./finevines enrich
node -e "
const w=require('./data/wines.json');
const withP=w.filter(x=>(x.producer||'').trim()).length;
console.log('producer coverage:', withP, '/', w.length, (100*withP/w.length).toFixed(1)+'%');
const counts={}; for(const x of w){const p=(x.producer||'').trim(); if(p) counts[p]=(counts[p]||0)+1}
console.log('top 50:', Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,50).map(e=>e[0]).join(', '));
console.log('513001 name:', (w.find(x=>x.sku==='513001')||{}).name);
"
```

Expected: coverage ≥ 95%; no `Acclaimed`/`Acre`-style artifacts in the top 50; SKU 513001 has a real name.

- [ ] **Step 7: Rebuild, test, commit, close**

```bash
go run ./cmd/finevines build && go test ./... && npm run test:unit && npm run test:e2e
git add internal/enrich data/wines.json
git commit -m "feat(enrich): backfill producers where Salesforce is blank (closes #8)"
gh issue close 8
```

---

# Phase 4 — Content that dies at cutover (#7, #9)

**This phase has a hard deadline: it must complete before DNS flips in Phase 6.** After cutover the old finevines.com is unreachable and its copy is gone.

### Task 8: Capture the old `/privacy-policy` and `/legal` copy, then publish a privacy policy

**Files:**
- Create: `data/legal/privacy-policy.md`, `data/legal/legal.md`
- Create: `templates/privacy-policy.html.tmpl`
- Modify: `internal/build/build.go`, `redirect-overrides.json`
- Test: `internal/build/build_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `/privacy-policy/` on the new site; `/legal` resolving via override.

- [ ] **Step 1: Capture both pages from the live old site, now**

```bash
mkdir -p data/legal
curl -sL https://www.finevines.com/privacy-policy -o data/oldsite-fetched/privacy-policy.html
curl -sL https://www.finevines.com/legal -o data/oldsite-fetched/legal.html
```

Transcribe the prose into `data/legal/privacy-policy.md` and `data/legal/legal.md`. **Commit this before anything else in the task** — everything downstream can be redone, this cannot.

```bash
git add data/legal
git commit -m "docs(legal): capture the old site's privacy and legal copy before cutover"
```

- [ ] **Step 2: Write the failing build test**

In `internal/build/build_test.go`:

```go
func TestBuildRendersPrivacyPolicy(t *testing.T) {
	dir := buildFixtureSite(t)
	got, err := os.ReadFile(filepath.Join(dir, "privacy-policy", "index.html"))
	if err != nil {
		t.Fatalf("privacy policy page not built: %v", err)
	}
	// The no-addresses rule applies here too — a privacy policy is exactly the
	// kind of page a template would want to put a postal address on.
	for _, banned := range []string{"P.O. Box", "PO Box", "Fax", "60007"} {
		if bytes.Contains(got, []byte(banned)) {
			t.Errorf("privacy policy contains banned contact detail %q", banned)
		}
	}
	if !bytes.Contains(got, []byte("Privacy")) {
		t.Error("privacy policy page has no heading")
	}
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `go test ./internal/build/ -run TestBuildRendersPrivacyPolicy -v`
Expected: FAIL — file not built.

- [ ] **Step 4: Add the template and the route**

Create `templates/privacy-policy.html.tmpl` following the structure of the existing `about.html.tmpl` (same header/footer partials, same container class). Keep Fine Vines' own voice; the page states what the contact form collects, that GA4 is used, and how to reach the business — **phone and email only**.

Register the page in `internal/build/build.go` alongside the other static pages, and add it to the sitemap.

- [ ] **Step 5: Run the test**

Run: `go test ./internal/build/ -v`
Expected: PASS.

- [ ] **Step 6: Route `/legal`**

Decide from the captured copy: if `/legal` carried real terms worth keeping, give it a page the same way; if it was boilerplate, point it at the closest surviving page. For the redirect route, in `redirect-overrides.json`:

```json
{
  "/legal": "/about/"
}
```

- [ ] **Step 7: Republish the redirect map — while the old site is still up**

```bash
./finevines redirects --publish
```

**Do not run `finevines redirects` after the old site is gone.** It re-crawls `FINEVINES_OLD_SITE_URL`; post-cutover that resolves to the new site, identity mappings are dropped, and the committed 51,609-entry map is overwritten with a near-empty one.

- [ ] **Step 8: Build, deploy, verify against the staging host**

```bash
go run ./cmd/finevines build && ./finevines deploy
curl -s -o /dev/null -w '%{http_code}\n' https://finevines.biz/privacy-policy
curl -s -o /dev/null -w '%{redirect_url} %{http_code}\n' https://finevines.biz/legal
```

Expected: `200` for the privacy policy; `301` to a real page for `/legal`.

- [ ] **Step 9: Commit and close**

```bash
git add templates/privacy-policy.html.tmpl internal/build/ redirect-overrides.json redirects.json
git commit -m "feat(pages): add a privacy policy and route the old /legal URL (closes #7, closes #9)"
gh issue close 7
gh issue close 9
```

---

# Phase 5 — The supplier-media ask

### Task 9: Send Fine Vines the request for producer and importer photography

**Files:**
- Create: `docs/supplier-media-request.md`

**Interfaces:**
- Consumes: `reports/image-coverage.md` from Task 3.
- Produces: the only path to a photograph for the wines the open web does not carry.

- [ ] **Step 1: Regenerate the coverage report so the ask carries current numbers**

```bash
node tools/coverage/report.mjs
```

- [ ] **Step 2: Write the request**

Create `docs/supplier-media-request.md`. Client-facing, so: no "trade", no addresses, elegant editorial voice. It should state plainly what share of the portfolio has photography today, that the remainder are wines the open web simply does not picture (older vintages, spirits, small-production imports), and ask George to request asset-library access or a media drop from the importers who represent them. Include the list of affected producers, largest first — a supplier is far more likely to act on "these 40 of your wines" than on a number.

Generate that list:

```bash
node -e "
const w=require('./data/wines.json');
const isPhoto=x=>!/\.svg$/i.test(x.imagePath||'');
const byProducer={};
for(const x of w){ if(isPhoto(x)) continue; const p=(x.producer||'(no producer)').trim(); byProducer[p]=(byProducer[p]||0)+1 }
console.log(Object.entries(byProducer).sort((a,b)=>b[1]-a[1]).slice(0,40).map(([p,n])=>\`- \${p} — \${n} wines\`).join('\n'));
"
```

- [ ] **Step 3: Commit**

```bash
git add docs/supplier-media-request.md reports/image-coverage.md
git commit -m "docs: the supplier-media ask, with the producers it would help most"
```

- [ ] **Step 4: Send it and record the decision**

Send to George. Record his answer — including "not worth chasing" — in the issue #6 thread, because it determines whether the placeholder is a temporary state or the final one for those wines.

---

# Phase 6 — Production cutover (#10)

Do not start until Phases 1, 2 and 4 are complete and Task 5 has landed. Work issue #10 as the authoritative checklist — it was written from the finevines.biz staging test and every item marked **SILENT FAILURE** fails in a way that looks like success.

### Task 10: Flip production

**Files:**
- Modify: `.env` (production values), `templates/` (footer/contact placeholders)

**Interfaces:**
- Consumes: everything above.
- Produces: finevines.com serving the new site with redirects live.

- [ ] **Step 1: Fill the remaining template placeholders**

```bash
grep -rn "to be confirmed" templates/
```

Expected after the fix: no matches. Phone and email only — no address, no fax.

- [ ] **Step 2: Set the GA4 measurement ID**

The old UA-41731070-1 tag is dead. Get the GA4 measurement ID (`G-XXXXXXXXXX`) from Fine Vines, then:

```bash
gh secret set FINEVINES_GA_ID
```

An empty value means no analytics, silently — this is why it is a checklist item and not an assumption. Verify after deploy that the tag is present in the served HTML:

```bash
curl -s https://finevines.com/ | grep -o 'G-[A-Z0-9]\{8,\}' | head -1
```

- [ ] **Step 3: Work the `.env` silent-failure cluster from issue #10**

`FINEVINES_SITE_BASE_URL` → `https://finevines.com` (requires rebuild — canonicals, sitemap and JSON-LD bake it in). `FINEVINES_REDIRECTS_MAP_URL` → the **`*.b-cdn.net`** hostname of pull zone 6207738, never a custom hostname served by that same zone. `FINEVINES_BUNNY_PULL_ZONE_ID` stays `6207738`.

`config.Load` does not strip inline `#` comments and does not trim trailing slashes. One malformed line corrupts every canonical URL on the site. After editing, verify:

```bash
go run ./cmd/finevines build
grep -m1 'rel="canonical"' dist/index.html
```

Expected: exactly `https://finevines.com/`, no comment text, no double slash.

- [ ] **Step 4: Link the Edge Script to the production pull zone**

In the Bunny dashboard, link script **83427** to pull zone **6207738** (zone field `MiddlewareScriptId`). The script-side `LinkedPullZones` list reads empty even when the link is correct — ignore it. Without this link the site serves fine and **zero redirects fire**.

- [ ] **Step 5: Final publish with production `.env`**

```bash
./finevines enrich && ./finevines build && ./finevines deploy
```

- [ ] **Step 6: Flip DNS**

Repoint finevines.com and www (currently Cloudflare → old site) at `finevines-com.b-cdn.net`. The hostnames are already attached to zone 6207738; Bunny issues the certificate once DNS resolves.

- [ ] **Step 7: Purge the pull zone**

Middleware 301s are cached like origin responses, so stale pre-purge behaviour persists otherwise. No-op deploys skip the purge by design — do it explicitly: `POST /pullzone/6207738/purgeCache`.

- [ ] **Step 8: Verify each item explicitly — silence looks identical to success**

```bash
curl -s https://finevines.com/ | grep -m1 'rel="canonical"'
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://finevines.com/about-us
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://finevines.com/portfolio/altocedro/altocedro-ano-cero-malbec
curl -s -o /dev/null -w '%{http_code}\n' https://finevines.com/redirects.json
curl -s -o /dev/null -w '%{http_code}\n' https://finevines.com/privacy-policy
```

Expected: canonical says finevines.com; `/about-us` → 301 `/about/` (this is what proves the middleware runs on the production zone); the deep wine URL 301s to its exact new page; `redirects.json` → 200; privacy policy → 200.

- [ ] **Step 9: Confirm the nightly run survives the cutover**

The first scheduled run after DNS flips is the one that proves the pipeline works against production. Watch it:

```bash
gh run watch $(gh run list --workflow=pipeline.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

- [ ] **Step 10: Close #10**

```bash
gh issue close 10 --comment "Cutover complete; every verification in the checklist confirmed live."
```

---

# Phase 7 — Triage what is left

### Task 11: Resolve the three remaining issues to a decision

**Files:**
- Modify: GitHub issues #3, #5, #6

**Interfaces:**
- Consumes: the outcomes of every phase above.
- Produces: an issue list where every open item has an owner and a next action.

- [ ] **Step 1: #6 — photorealistic bottle images**

The premise has changed since it was written (2026-07-27, when 82% of the catalog was generated SVG labels). Generated artwork is retired; the question it asks — image-to-image versus programmatic composite — is moot. Re-scope it to what it is now: the tracking issue for image coverage, pointing at `reports/image-coverage.md` and `docs/supplier-media-request.md`.

```bash
gh issue comment 6 --body "Superseded in part: generated bottle artwork is retired (2026-08-08), so the image-to-image vs composite question is closed — neither. This issue now tracks coverage of verified photography; current numbers in reports/image-coverage.md, and the supplier ask in docs/supplier-media-request.md."
```

- [ ] **Step 2: #3 — portfolio duplicate listings and filter UX**

Both halves are waiting on other people: Fine Vines on the 73 duplicate listings, Claw Design on the facet UX. Chase both, or close with the current behaviour documented as the decision. Note that vintage collapse (`0d8481f`) already changed the duplicate picture — regenerate before re-sending:

```bash
go run ./tools/packcheck
```

- [ ] **Step 3: #5 — per-wine stock badge**

Blocked on a client call: is bottle-level stock depth something Fine Vines wants public at all? Ask George. If no, close it. If yes, it needs the separate unhashed runtime feed described in the issue — the content-hashed catalog index cannot carry a live number.

- [ ] **Step 4: Verify the issue list is clean**

```bash
gh issue list --state open
```

Expected: every remaining issue has a named owner and a next action in its most recent comment.

---

## Self-Review

**Spec coverage.** Every open item is claimed by a task: pipeline commit-back → Task 1; re-enable → Task 2; coverage ceiling → Task 3; orphan SVGs (repo + CDN) → Task 4; #1 → Task 5; #2 → Task 6; #8 → Task 7; #7 and #9 → Task 8; supplier media → Task 9; `FINEVINES_GA_ID` and #10 → Task 10; #3, #5, #6 → Task 11.

**Ordering risk.** Task 8 Step 1 (capturing the old site's copy) is the only step in this plan that becomes impossible if done late. It is inside Phase 4, which precedes cutover — but if the DNS flip is scheduled tighter than expected, pull that single step forward and run it today.

**Scope note.** This plan spans four genuinely independent subsystems (image pipeline, Salesforce data, site content, cutover). Phases 1–2 are worth executing on their own merits regardless of what happens to the rest; Phase 6 depends on all of them.

# GitHub CI Pipeline (Sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the whole FineVines publish path — queue drain, enrich, image sourcing, build, deploy, state commit-back, digest email — onto GitHub Actions running unattended on `ubuntu-latest`, with `deploy.bat` kept as the documented local fallback.

**Architecture:** Two workflows. `.github/workflows/ci.yml` is the cheap gate: build, tests, and a mock-mode pipeline run that never touches a live service — it proves the Windows-only codebase actually runs on Linux. `.github/workflows/pipeline.yml` is the real thing: it drains the review console's change queue (`finevines applyqueue`), enriches, sources images behind two hard gates, builds, deploys, commits the resulting state back to `master` as a bot commit, and emails a digest (`finevines notify`). Two new Go packages carry the new logic (`internal/queue`, `internal/notify`), both built the way `internal/deploy` already is: an interface declared where it is consumed so tests inject an in-memory fake. The Node image pipeline gains a committed attempt ledger and three small cross-platform fixes.

**Tech Stack:** Go 1.25.0 (stdlib only — the module's sole dependency is `golang.org/x/net`), Node 22 with `node --test` and `puppeteer-core`, GitHub Actions on `ubuntu-latest`, Bunny.net Storage + Pull Zone APIs, OpenAI Responses API (`gpt-4.1`) and Chat Completions (`gpt-4.1-nano` for vision), Postmark REST API.

## Global Constraints

- **Go version comes from `go.mod`** — `go 1.25.0`. Every workflow uses `actions/setup-go@v5` with `go-version-file: go.mod`, never a hardcoded version.
- **Runners are `ubuntu-latest`** — GitHub-hosted only. Self-hosted runners on a public repo are a security hazard (spec §Decisions 7).
- **The repo is public.** Jobs that use secrets must never run on `pull_request` events; fork PRs get build/test only.
- **No new QuickBooks or Gemini work.** Salesforce is what `enrich` reads from; `FINEVINES_GEMINI_API_KEY` stays optional and unset.
- **`gpt-image-1` generation is out of scope** — it failed QA 2026-07-28 (labels confabulated, 12/12 wrong). The deterministic SVG label remains the guaranteed no-broken-image floor.
- **No change to enrichment logic, eligibility rules, or the build itself** (spec §Explicitly out of scope).
- **Never use the word "trade" in client-facing copy** — the digest email is client-facing (George, Barbara read it). Say "wholesale", "our accounts", or "the business".
- **No addresses on the site or in client-facing copy** — no street address, city/ZIP, P.O. Box, or fax number, anywhere.
- **Vision verification and the watermark sweep are HARD gates.** An image failing either never imports. There is no override path in CI.
- **`imageSourceUrl` provenance is retained on every imported or swapped image.**
- **Bot commits carry `[skip ci]`** so the commit-back never loops.

---

## File Structure

**New Go packages**

| Path | Responsibility |
| --- | --- |
| `internal/queue/queue.go` | The `Action`/`Payload` wire contract with the console's Edge Script, plus `ParseQueue`. |
| `internal/queue/ledger.go` | The applied-ID ledger (`data/queue-ledger.json`) and the flag record (`data/flags.json`). |
| `internal/queue/apply.go` | `Apply` — the drain itself: skip already-applied IDs, apply each action kind, return the new catalog + ledger. |
| `internal/notify/diff.go` | `Diff` — a pure before/after catalog comparison producing `RunDiff`. |
| `internal/notify/render.go` | `Render` — `RunDiff` → subject + HTML + text bodies. Pure. |
| `internal/notify/postmark.go` | `Sender` interface and `PostmarkSender`, the only thing in the package that touches the network. |

**Modified Go**

| Path | Change |
| --- | --- |
| `internal/deploy/bunny.go` | Add `Download` so the same client that uploads `dist/` can read `_review/queue.json`. |
| `internal/enrich/search.go` | Add `EnrichWithNote`; `Enrich` delegates to it with an empty note. |
| `internal/enrich/identity.go` | Add `RawFromWine` — reconstruct a `salesforce.WineRaw` from a catalog row. |
| `internal/config/config.go` | Add `PostmarkToken`, `NotifyTo`, `NotifyFrom`. |
| `cmd/finevines/main.go` | Dispatch `applyqueue` and `notify`; extend `usage()`. |
| `cmd/finevines/applyqueue.go` | `runApplyQueue` — wires the real Bunny client, enricher and `imgnorm` into `queue.Apply`. New file: `main.go` is already 492 lines. |
| `cmd/finevines/notify.go` | `runNotify` — loads the before/after catalogs, assembles the digest, sends it. |

**New / modified Node**

| Path | Change |
| --- | --- |
| `tools/labelfetch/env.mjs` | New. `binPath` and `openaiKey` — the two things that were accidentally Windows-only. |
| `tools/labelfetch/attempts.mjs` | New. The per-SKU image attempt ledger (`data/image-attempts.json`). |
| `tools/labelfetch/pipeline.mjs` | `--vision-first` label reading, `--due-only` ledger filter, attempt recording, `binPath`/`openaiKey`. |
| `tools/labelfetch/watermarksweep.mjs` | `openaiKey`. |
| `tools/labelfetch/import.mjs` | `binPath`, and record `imported` outcomes in the attempt ledger. |
| `tools/labelfetch/decide.mjs`, `reverify.mjs` | `binPath`. |
| `tests/unit/env.test.js` | New. |
| `tests/unit/attempts.test.js` | New. |

**Workflows, config, docs**

| Path | Change |
| --- | --- |
| `.github/workflows/ci.yml` | New. Build + tests + mock-mode pipeline. No secrets. Runs on `pull_request`. |
| `.github/workflows/pipeline.yml` | New. The real unattended pipeline. Secrets. Never runs on `pull_request`. |
| `.gitignore` | Un-ignore `.bunny-manifest.json`; ignore `.run/`. |
| `.env.example` | Add the three notify variables. |
| `README.md` | New "## 6. The automated pipeline (GitHub Actions)" section; revise "## Running it". |
| `docs/operations.md` | CI runbook: secrets, re-running, the local fallback. |

---

## Task 1: Linux/CI smoke test

Nothing in this repo has ever run on anything but Windows. Before a single live credential is wired up, prove the binary builds, the tests pass, and `enrich`/`build` complete on `ubuntu-latest`.

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `.gitignore` (add `.run/`)

**Interfaces:**
- Consumes: nothing — this is the first task.
- Produces: a green `ci` workflow on every push and pull request. Later tasks add their tests to `go test ./...` and `npm run test:unit`, which this workflow already runs; no workflow edits are needed for Tasks 3–7.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
# The cheap gate. Everything here is safe on a fork's pull request because this
# workflow declares NO secrets at all: the pipeline is exercised in mock mode
# (FINEVINES_SF_MOCK), which reads the embedded sample roster instead of the
# live Salesforce org, and never reaches OpenAI, Bunny.net or Postmark.
#
# Its real job is cross-platform assurance. The whole publish path was written
# and only ever run on one Windows machine; this is what catches a hardcoded
# backslash, a .exe name, or a PowerShell shell-out before the nightly
# pipeline meets it at 2:15am.
name: ci

on:
  push:
    branches: [master]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - run: npm ci

      - name: Build the binary
        run: go build -o finevines ./cmd/finevines

      - name: Go tests
        run: go test ./...

      - name: Node unit tests
        run: npm run test:unit

      # Mock mode proves enrich's orchestration runs on Linux: roster pull,
      # eligibility filter, diff, the delisting lifecycle, the SVG label floor,
      # the atomic checkpoint writes. FINEVINES_MANUAL_ENRICH_DIR points at the
      # hand-authored enrichment files so no OpenAI key is needed; wines with no
      # authored file fall through to enrich.deriveResult, which is exactly the
      # documented behaviour and still exercises the full write path.
      - name: Mock-mode enrich (no live Salesforce, OpenAI or Bunny)
        env:
          FINEVINES_SF_MOCK: '1'
          FINEVINES_MANUAL_ENRICH_DIR: data/enrichment
        run: ./finevines enrich

      # RESTORE THE CATALOG BEFORE BUILDING. The mock roster is 38 rows against
      # a real catalog of ~2,200, so the enrich above legitimately delists
      # almost everything and rewrites data/wines.json and
      # data/lifecycle-redirects.json to match. Building that would produce an
      # almost-empty site and fail the browser tests for the wrong reason. The
      # SVG labels it wrote under assets/img/wines/ are gitignored build
      # artifacts, but writeImageFile removes the sibling .jpg when it writes a
      # .svg, so assets/ needs restoring too.
      - name: Restore the committed catalog
        run: |
          git checkout -- data assets
          git status --porcelain

      - name: Build the site
        env:
          FINEVINES_SITE_BASE_URL: https://finevines-com.b-cdn.net
        run: |
          ./finevines build
          test -f dist/portfolio/index.html
          test -f dist/search-index.json

      # ubuntu-latest ships Google Chrome; tests/helpers/browser.js finds it at
      # /usr/bin/google-chrome. CHROME_PATH is set explicitly so a runner image
      # change surfaces as "no Chrome at the path we asked for" rather than a
      # confusing puppeteer launch failure.
      - name: Browser tests against the built site
        env:
          CHROME_PATH: /usr/bin/google-chrome
        run: npm run test:e2e
```

- [ ] **Step 2: Ignore the run-scratch directory**

The pipeline workflow (Task 8) writes the run's before-snapshot and applied-action log under `.run/`. Neither is committed. Add to `.gitignore`, directly after the `# Finevines Go build (cmd/finevines)` block:

```gitignore
# Per-run scratch state for the CI pipeline (before-snapshot for the digest,
# the applied-action log). Written by one run, read by `notify` later in the
# SAME run, never committed.
.run/
```

- [ ] **Step 3: Verify the workflow file parses**

Run: `node -e "const{readFileSync}=require('fs');console.log(readFileSync('.github/workflows/ci.yml','utf8').length,'bytes')"`
Expected: a byte count, no throw. (There is no YAML linter in this repo's toolchain; GitHub validates on push and reports a parse error as a failed workflow run.)

- [ ] **Step 4: Reproduce the CI steps locally to catch Linux-only breakage early**

Run (from the repo root, on the Windows workstation — this checks the parts that are OS-independent):

```bash
go build -o finevines.exe ./cmd/finevines
go test ./...
npm run test:unit
```

Expected: `go test ./...` prints `ok` for every package with tests and `no test files` for the rest; `npm run test:unit` ends with `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .gitignore
git commit -m "ci: build, test and mock-mode pipeline on ubuntu-latest"
```

- [ ] **Step 6: Push and read the first run**

Run: `git push && gh run watch`
Expected: the `ci / test` job goes green. If `npm run test:e2e` fails on "No Chrome found", the runner image no longer ships Chrome at `/usr/bin/google-chrome` — add `- uses: browser-actions/setup-chrome@v1` before the browser-tests step and set `CHROME_PATH: ${{ steps.setup-chrome.outputs.chrome-path }}`. If the mock enrich fails, fix that before continuing: every later task depends on it.

---

## Task 2: Track `.bunny-manifest.json`

`deploy` diffs `dist/` against the manifest saved by the previous deploy. On a workstation that file persists on disk. In CI the checkout is fresh every run, so an untracked manifest means every run re-uploads all ~10,000 files and purges the CDN — which is both slow and a rate-limited Bunny operation. The manifest has to become repo state.

**Files:**
- Modify: `.gitignore:151`
- Create (as tracked content): `.bunny-manifest.json` — the file already exists locally, untracked and ignored

**Interfaces:**
- Consumes: nothing.
- Produces: `.bunny-manifest.json` tracked in git, so `deploy.LoadManifest(".bunny-manifest.json")` in CI reads real prior-deploy state and `deploy.Plan` produces a genuine diff. Task 8's commit-back step commits it after every deploy.

- [ ] **Step 1: Confirm the local manifest is real, current deploy state**

Run: `node -e "const m=require('./.bunny-manifest.json');console.log(Object.keys(m).length,'entries')"`
Expected: a five-figure entry count (one per deployed file). If the file is missing or has a handful of entries, run `finevines.exe deploy` first so the committed manifest matches what is actually live — committing a stale manifest silently drops files from every future deploy's diff.

- [ ] **Step 2: Un-ignore it**

In `.gitignore`, replace the `# Finevines Go build (cmd/finevines)` block's manifest line. Change:

```gitignore
# Finevines Go build (cmd/finevines)
.env
dist/
.bunny-manifest.json
finevines.exe
*.exe
```

to:

```gitignore
# Finevines Go build (cmd/finevines)
.env
dist/
finevines.exe
*.exe

# .bunny-manifest.json is deliberately TRACKED, not ignored. It is the hash of
# every file currently on Bunny.net, and it is what makes `deploy` upload only
# what changed. CI checks out fresh every run, so an untracked manifest would
# make every nightly run re-upload the whole site and purge the CDN. The
# pipeline commits it back after each deploy.
```

- [ ] **Step 3: Track and commit it**

```bash
git add .gitignore .bunny-manifest.json
git commit -m "deploy: track .bunny-manifest.json so CI keeps deploy diff state"
```

- [ ] **Step 4: Verify it is tracked**

Run: `git ls-files --error-unmatch .bunny-manifest.json`
Expected: `.bunny-manifest.json` printed, exit code 0. (`git check-ignore .bunny-manifest.json` should now print nothing and exit 1.)

---

## Task 3: `finevines applyqueue`

The console (Sub-project B) never writes to the repo. It appends reviewer decisions to `_review/queue.json` in the Bunny storage zone and fires a `repository_dispatch`. This subcommand is the other half of that contract: read the queue, apply each action to the catalog, record what was applied, clear the queue.

**Files:**
- Create: `internal/queue/queue.go`
- Create: `internal/queue/queue_test.go`
- Create: `internal/queue/ledger.go`
- Create: `internal/queue/ledger_test.go`
- Create: `internal/queue/apply.go`
- Create: `internal/queue/apply_test.go`
- Create: `cmd/finevines/applyqueue.go`
- Modify: `internal/deploy/bunny.go` (add `Download`)
- Modify: `internal/deploy/bunny_test.go` (test `Download`)
- Modify: `internal/enrich/search.go` (add `EnrichWithNote`)
- Modify: `internal/enrich/search_test.go`
- Modify: `internal/enrich/identity.go` (add `RawFromWine`)
- Modify: `internal/enrich/identity_test.go`
- Modify: `cmd/finevines/main.go:34-48` (dispatch), `cmd/finevines/main.go:55` (usage)

**Interfaces:**
- Consumes: `deploy.NewBunnyClient(storageEndpoint, storageZone, storageKey, accountAPIKey, pullZoneID string, hc *http.Client) *deploy.BunnyClient`; `model.LoadWines(path string) ([]model.Wine, error)`; `model.SaveWines(path string, wines []model.Wine) error`; `enrich.NewOpenAIEnricher(apiKey, model, baseURL string, hc *http.Client) *enrich.OpenAIEnricher`; `config.Load(envPath string) (config.Config, error)`.
- Produces:
  - `func (c *deploy.BunnyClient) Download(ctx context.Context, relPath string) ([]byte, error)`
  - `func enrich.RawFromWine(w model.Wine) salesforce.WineRaw`
  - `func (e *enrich.OpenAIEnricher) EnrichWithNote(ctx context.Context, w salesforce.WineRaw, note string) (enrich.EnrichResult, error)`
  - `type queue.Action struct { ID, Reviewer, SKU, Kind string; Payload queue.Payload; TS string }`
  - `type queue.Payload struct { Candidate, SourceURL, Note, Reason string }`
  - `const queue.ActionImageSwap = "image-swap"`, `queue.ActionTextFeedback = "text-feedback"`, `queue.ActionFlag = "flag"`
  - `func queue.ParseQueue(data []byte) ([]queue.Action, error)`
  - `type queue.Store interface { Download(ctx context.Context, relPath string) ([]byte, error); Delete(ctx context.Context, relPath string) error }`
  - `type queue.TextEnricher interface { EnrichWithNote(ctx context.Context, w salesforce.WineRaw, note string) (enrich.EnrichResult, error) }`
  - `type queue.Normalizer interface { Normalize(ctx context.Context, srcPath, dstPath string) error }`
  - `type queue.Applied struct { ID, SKU, Kind, Reviewer, AppliedAt, Outcome string }`
  - `type queue.Ledger struct { Applied []queue.Applied }` with `func (l queue.Ledger) Has(id string) bool`
  - `func queue.LoadLedger(path string) (queue.Ledger, error)` / `func queue.SaveLedger(path string, l queue.Ledger) error`
  - `type queue.Flag struct { SKU, Slug, Reviewer, Reason, FlaggedAt string }`
  - `func queue.LoadFlags(path string) ([]queue.Flag, error)` / `func queue.SaveFlags(path string, flags []queue.Flag) error`
  - `type queue.Input struct { Store Store; Texts TextEnricher; Norm Normalizer; Actions []Action; Wines []model.Wine; Ledger Ledger; Flags []Flag; ImgDir, CandidateDir, QueuePath string; Now time.Time; Log func(string, ...any) }`
  - `type queue.Result struct { Wines []model.Wine; Ledger queue.Ledger; Flags []queue.Flag; Applied []queue.Applied; Skipped int }`
  - `func queue.Apply(ctx context.Context, in queue.Input) (queue.Result, error)`
  - The run log `.run/queue-applied.json` (a JSON array of `queue.Applied`) — Task 7's `notify` reads it.

### Part A — the wire contract

- [ ] **Step 1: Write the failing test**

`internal/queue/queue_test.go`:

```go
package queue

import (
	"reflect"
	"testing"
)

// The queue file's shape is the contract with the console's Edge Script. This
// fixture is written the way the script appends it — a bare JSON array — so a
// change on either side breaks this test rather than a nightly run.
const queueFixture = `[
 {"id":"a1","reviewer":"barbara","sku":"AB1201","action":"image-swap",
  "payload":{"candidate":"AB1201/cand-2.png","sourceUrl":"https://example-producer.fr/vins/"},
  "ts":"2026-07-29T14:02:11Z"},
 {"id":"a2","reviewer":"george","sku":"MB5110","action":"text-feedback",
  "payload":{"note":"says oaked; this wine is unoaked"},"ts":"2026-07-29T14:04:00Z"},
 {"id":"a3","reviewer":"george","sku":"PM5030","action":"flag",
  "payload":{"reason":"wrong producer, this is not Brezza"},"ts":"2026-07-29T14:05:30Z"}
]`

func TestParseQueue_DecodesEveryActionKind(t *testing.T) {
	got, err := ParseQueue([]byte(queueFixture))
	if err != nil {
		t.Fatalf("ParseQueue returned error: %v", err)
	}
	want := []Action{
		{ID: "a1", Reviewer: "barbara", SKU: "AB1201", Kind: ActionImageSwap,
			Payload: Payload{Candidate: "AB1201/cand-2.png", SourceURL: "https://example-producer.fr/vins/"},
			TS:      "2026-07-29T14:02:11Z"},
		{ID: "a2", Reviewer: "george", SKU: "MB5110", Kind: ActionTextFeedback,
			Payload: Payload{Note: "says oaked; this wine is unoaked"},
			TS:      "2026-07-29T14:04:00Z"},
		{ID: "a3", Reviewer: "george", SKU: "PM5030", Kind: ActionFlag,
			Payload: Payload{Reason: "wrong producer, this is not Brezza"},
			TS:      "2026-07-29T14:05:30Z"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ParseQueue mismatch:\n got %+v\nwant %+v", got, want)
	}
}

// A nightly run with nobody having reviewed anything is the NORMAL case, and it
// must not look like a failure. Bunny returns an empty body for a zero-length
// object, and the console writes "[]" when it clears its own view.
func TestParseQueue_EmptyIsNotAnError(t *testing.T) {
	for _, body := range []string{"", "   ", "[]", "\n"} {
		got, err := ParseQueue([]byte(body))
		if err != nil {
			t.Errorf("ParseQueue(%q) returned error: %v", body, err)
		}
		if len(got) != 0 {
			t.Errorf("ParseQueue(%q) = %d actions, want 0", body, len(got))
		}
	}
}

// Malformed JSON is a real error: silently treating it as "nothing queued" would
// discard a reviewer's work and then clear the queue on top of it.
func TestParseQueue_MalformedIsAnError(t *testing.T) {
	if _, err := ParseQueue([]byte(`[{"id":`)); err == nil {
		t.Fatal("ParseQueue accepted truncated JSON, want an error")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/queue/ -run TestParseQueue -v`
Expected: FAIL — `no Go files in ...internal/queue` (the package does not exist yet).

- [ ] **Step 3: Write the implementation**

`internal/queue/queue.go`:

```go
// Package queue drains the review console's change queue: the corrections
// non-technical reviewers (George, Barbara) make in the Sub-project B console,
// parked as a JSON file in the Bunny storage zone that the console and this
// pipeline share.
//
// The console never writes to the repo and the pipeline never serves a request.
// That asymmetry is the whole design: a reviewer's fix arrives as data in a
// storage bucket, and the only thing that ever edits data/wines.json is a
// pipeline run, which lands as an auditable bot commit. Nothing here talks to
// the network directly — the storage zone arrives as a Store, the text
// regeneration as a TextEnricher, and imgnorm as a Normalizer, all interfaces
// declared here because this is where they are consumed (the same pattern
// internal/deploy.Uploader uses).
package queue

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Action kinds. These strings are the wire contract with the console's Edge
// Script; the console writes them and this package reads them.
const (
	// ActionImageSwap replaces the wine's photograph with a candidate the
	// reviewer picked, or drops back to the SVG label (Payload.Candidate ==
	// CandidateNone).
	ActionImageSwap = "image-swap"
	// ActionTextFeedback re-runs the wine's text generation with the reviewer's
	// note appended to the prompt.
	ActionTextFeedback = "text-feedback"
	// ActionFlag records a wine for human attention and takes NO automatic
	// action: "wrong producer" or "duplicate" is a delist/rename call, and that
	// call is Joel's, not the pipeline's.
	ActionFlag = "flag"
)

// CandidateNone is the Payload.Candidate sentinel for "none of these images —
// use the SVG label fallback", the last option the console offers on an image
// pick.
const CandidateNone = "none"

// Action is one reviewer decision, exactly as the console appends it to
// _review/queue.json. The JSON tags are the contract (design spec §B "Write
// path"): do not rename them without changing the Edge Script in the same
// commit. Kind is `action` on the wire because "action" reads better in the
// console's own code and Go already calls the whole struct an Action.
type Action struct {
	ID       string  `json:"id"`
	Reviewer string  `json:"reviewer"`
	SKU      string  `json:"sku"`
	Kind     string  `json:"action"`
	Payload  Payload `json:"payload"`
	TS       string  `json:"ts"`
}

// Payload is the per-kind detail. One flat struct rather than a
// json.RawMessage per kind: there are three kinds, five fields between them,
// and a flat struct keeps the whole contract legible on one screen for whoever
// writes the Edge Script.
type Payload struct {
	// Candidate is the storage-relative path, under the candidate directory, of
	// the image an image-swap selects (e.g. "AB1201/cand-2.png"). The sentinel
	// CandidateNone means the reviewer rejected every candidate.
	Candidate string `json:"candidate,omitempty"`
	// SourceURL is where that candidate came from. It exists so a swap keeps
	// the same provenance guarantee a nightly import does — months from now,
	// "where did this picture come from" has to be answerable from
	// data/wines.json alone.
	SourceURL string `json:"sourceUrl,omitempty"`
	// Note is the reviewer's free text for a text-feedback action, fed VERBATIM
	// into the regeneration prompt.
	Note string `json:"note,omitempty"`
	// Reason is the reviewer's free text for a flag action.
	Reason string `json:"reason,omitempty"`
}

// ParseQueue decodes _review/queue.json: a bare JSON array of Action.
//
// An empty or whitespace-only body is NOT an error — a nightly run where nobody
// reviewed anything is the normal case, and Bunny serves a zero-length body for
// a file the console has emptied. Malformed JSON, by contrast, is a hard error:
// treating it as "nothing queued" would discard a reviewer's work and then
// clear the queue on top of it.
func ParseQueue(data []byte) ([]Action, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, nil
	}
	var actions []Action
	if err := json.Unmarshal(data, &actions); err != nil {
		return nil, fmt.Errorf("queue: parse queue.json: %w", err)
	}
	return actions, nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/queue/ -run TestParseQueue -v`
Expected: PASS — three `--- PASS` lines and `ok  github.com/gritautomation/finevines-website/internal/queue`.

- [ ] **Step 5: Commit**

```bash
git add internal/queue/queue.go internal/queue/queue_test.go
git commit -m "queue: the review console's change-queue wire contract"
```

### Part B — the applied-ID ledger and the flag record

- [ ] **Step 6: Write the failing test**

`internal/queue/ledger_test.go`:

```go
package queue

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLedger_HasIsTrueOnlyForRecordedIDs(t *testing.T) {
	l := Ledger{Applied: []Applied{
		{ID: "a1", SKU: "AB1201", Kind: ActionImageSwap, AppliedAt: "2026-07-29T08:15:00Z"},
	}}
	if !l.Has("a1") {
		t.Error("Has(a1) = false, want true")
	}
	if l.Has("a2") {
		t.Error("Has(a2) = true, want false")
	}
}

// A missing ledger is first-run behaviour, not a failure — the same contract
// model.LoadWines has for a missing data/wines.json.
func TestLoadLedger_MissingFileIsEmptyNotAnError(t *testing.T) {
	l, err := LoadLedger(filepath.Join(t.TempDir(), "queue-ledger.json"))
	if err != nil {
		t.Fatalf("LoadLedger returned error: %v", err)
	}
	if len(l.Applied) != 0 {
		t.Errorf("LoadLedger of a missing file = %d entries, want 0", len(l.Applied))
	}
}

func TestSaveLedger_RoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue-ledger.json")
	want := Ledger{Applied: []Applied{
		{ID: "a1", SKU: "AB1201", Kind: ActionImageSwap, Reviewer: "barbara",
			AppliedAt: "2026-07-29T08:15:00Z", Outcome: "image replaced"},
	}}
	if err := SaveLedger(path, want); err != nil {
		t.Fatalf("SaveLedger: %v", err)
	}
	got, err := LoadLedger(path)
	if err != nil {
		t.Fatalf("LoadLedger: %v", err)
	}
	if len(got.Applied) != 1 || got.Applied[0] != want.Applied[0] {
		t.Errorf("round trip mismatch:\n got %+v\nwant %+v", got.Applied, want.Applied)
	}
	// Committed to the repo, so it has to diff cleanly: one entry per line,
	// trailing newline.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(data); n == 0 || data[n-1] != '\n' {
		t.Error("SaveLedger did not end the file with a newline")
	}
}

func TestSaveFlags_RoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "flags.json")
	want := []Flag{{SKU: "PM5030", Slug: "brezza-barolo-docg-2019", Reviewer: "george",
		Reason: "wrong producer", FlaggedAt: "2026-07-29T08:15:00Z"}}
	if err := SaveFlags(path, want); err != nil {
		t.Fatalf("SaveFlags: %v", err)
	}
	got, err := LoadFlags(path)
	if err != nil {
		t.Fatalf("LoadFlags: %v", err)
	}
	if len(got) != 1 || got[0] != want[0] {
		t.Errorf("round trip mismatch:\n got %+v\nwant %+v", got, want)
	}
}
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `go test ./internal/queue/ -run 'Ledger|Flags' -v`
Expected: FAIL — `undefined: Ledger`, `undefined: Applied`, `undefined: LoadLedger`, `undefined: Flag`.

- [ ] **Step 8: Write the implementation**

`internal/queue/ledger.go`:

```go
package queue

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
)

// Applied is one ledger entry: proof that an Action ID was applied, and what
// happened. This is what makes the drain idempotent — a run that crashes after
// applying half the queue, or a second repository_dispatch fired for the same
// batch, re-reads the same actions and skips the ones already here.
//
// Outcome is prose, not an enum, because it is read by a human looking at a
// diff: "image replaced", "text regenerated", "no such SKU in the catalog".
type Applied struct {
	ID        string `json:"id"`
	SKU       string `json:"sku"`
	Kind      string `json:"action"`
	Reviewer  string `json:"reviewer"`
	AppliedAt string `json:"appliedAt"`
	Outcome   string `json:"outcome"`
}

// Ledger is data/queue-ledger.json — committed with the data, because CI keeps
// no state between runs and the whole point is to remember across them.
type Ledger struct {
	Applied []Applied `json:"applied"`
}

// Has reports whether id has already been applied. Linear over the slice on
// purpose: the ledger grows by a handful of entries a week, and a map would
// have to be rebuilt on every load for no measurable gain.
func (l Ledger) Has(id string) bool {
	for _, a := range l.Applied {
		if a.ID == id {
			return true
		}
	}
	return false
}

// LoadLedger reads path. A missing file is first-run behaviour, not an error —
// the same contract model.LoadWines has for a missing data/wines.json.
func LoadLedger(path string) (Ledger, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Ledger{}, nil
	}
	if err != nil {
		return Ledger{}, err
	}
	var l Ledger
	if err := json.Unmarshal(data, &l); err != nil {
		return Ledger{}, err
	}
	return l, nil
}

// SaveLedger writes l to path, indented and newline-terminated so its commits
// diff one entry at a time.
func SaveLedger(path string, l Ledger) error {
	return writeJSON(path, l)
}

// Flag is one wine a reviewer marked as wrong: wrong producer, wrong vintage,
// a duplicate. Flags are RECORDED, never auto-applied. Delisting or renaming a
// wine is a commercial decision, so the pipeline's only job is to make sure the
// flag reaches Joel and does not get lost between runs.
type Flag struct {
	SKU       string `json:"sku"`
	Slug      string `json:"slug"`
	Reviewer  string `json:"reviewer"`
	Reason    string `json:"reason"`
	FlaggedAt string `json:"flaggedAt"`
}

// LoadFlags reads data/flags.json; a missing file means no flags yet.
func LoadFlags(path string) ([]Flag, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var flags []Flag
	if err := json.Unmarshal(data, &flags); err != nil {
		return nil, err
	}
	return flags, nil
}

// SaveFlags writes flags to path.
func SaveFlags(path string, flags []Flag) error {
	if flags == nil {
		flags = []Flag{}
	}
	return writeJSON(path, flags)
}

// writeJSON is the one write shape both files use. Plain os.WriteFile, not the
// atomic temp-and-rename model.SaveWines does: these files are written once at
// the end of a drain, not checkpointed 40 times through a multi-hour run, so
// there is no window worth defending against.
func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `go test ./internal/queue/ -run 'Ledger|Flags' -v`
Expected: PASS — four `--- PASS` lines.

- [ ] **Step 10: Commit**

```bash
git add internal/queue/ledger.go internal/queue/ledger_test.go
git commit -m "queue: applied-ID ledger and the flag record"
```

### Part C — the pieces `Apply` leans on

- [ ] **Step 11: Write the failing tests for `Download`, `RawFromWine` and `EnrichWithNote`**

Append to `internal/deploy/bunny_test.go`:

```go
// Download is the read side of the same storage zone Upload writes to. It
// exists for internal/queue, which fetches _review/queue.json and the
// candidate images the console's reviewers picked.
func TestBunnyClient_DownloadReturnsBodyAndSendsAccessKey(t *testing.T) {
	var gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotKey = r.URL.Path, r.Header.Get("AccessKey")
		w.Write([]byte(`[{"id":"a1"}]`))
	}))
	defer srv.Close()

	c := NewBunnyClient(srv.URL, "finevines", "storage-key", "acct-key", "1", srv.Client())
	got, err := c.Download(context.Background(), "_review/queue.json")
	if err != nil {
		t.Fatalf("Download returned error: %v", err)
	}
	if string(got) != `[{"id":"a1"}]` {
		t.Errorf("Download body = %q", got)
	}
	if gotPath != "/finevines/_review/queue.json" {
		t.Errorf("Download path = %q, want /finevines/_review/queue.json", gotPath)
	}
	if gotKey != "storage-key" {
		t.Errorf("Download AccessKey = %q, want the storage key", gotKey)
	}
}

// A 404 is "the console has never written a queue", which is the state of the
// zone until the first reviewer clicks something. Empty bytes, no error.
func TestBunnyClient_DownloadMissingIsEmptyNotAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := NewBunnyClient(srv.URL, "finevines", "k", "a", "1", srv.Client())
	got, err := c.Download(context.Background(), "_review/queue.json")
	if err != nil {
		t.Fatalf("Download returned error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("Download of a missing file = %q, want empty", got)
	}
}
```

Append to `internal/enrich/identity_test.go`:

```go
// RawFromWine is what lets something OTHER than a roster pull trigger
// enrichment — a reviewer's text-feedback note, where the only record of the
// wine is the catalog row.
func TestRawFromWine_CarriesEveryEnrichmentInput(t *testing.T) {
	w := model.Wine{
		ID: "01t000000000001", SKU: "AB1201", Producer: "Domaine Bart",
		Name: "Marsannay La Montagne", Vintage: "2019", Varietal: "Pinot Noir",
		Region: "Burgundy", Country: "France", Appellation: "Marsannay",
		Style: "Red", StockQty: 4, StockCases: 3.5, CasePack: 12,
	}
	got := RawFromWine(w)
	want := salesforce.WineRaw{
		ID: "01t000000000001", SKU: "AB1201", Producer: "Domaine Bart",
		Name: "Marsannay La Montagne", Vintage: "2019", Varietal: "Pinot Noir",
		Region: "Burgundy", Country: "France", Appellation: "Marsannay",
		Style: "Red", StockQty: 4, StockCases: 3.5, CasePack: 12, ReadyToSell: true,
	}
	if got != want {
		t.Errorf("RawFromWine mismatch:\n got %+v\nwant %+v", got, want)
	}
}
```

Append to `internal/enrich/search_test.go`:

```go
// EnrichWithNote must put the reviewer's correction in the prompt VERBATIM and
// AFTER the wine's facts, so the model reads it as a correction to them rather
// than as another fact. The note is the whole value of the text-feedback
// action: "says oaked; this wine is unoaked" has to survive to the model
// unparaphrased.
func TestEnrichWithNote_AppendsTheReviewerNoteAfterTheFacts(t *testing.T) {
	var gotInput string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		gotInput, _ = req["input"].(string)
		w.Write([]byte(`{"output":[{"content":[{"type":"output_text","text":` +
			`"{\"description\":\"Unoaked and precise.\",\"sommelierNotes\":\"Serve cool.\",` +
			`\"sources\":{\"description\":\"found\"},\"matchConfidence\":88}"}]}]}`))
	}))
	defer srv.Close()

	e := NewOpenAIEnricher("key", "gpt-4.1", srv.URL, srv.Client())
	res, err := e.EnrichWithNote(context.Background(),
		salesforce.WineRaw{SKU: "MB5110", Producer: "Brezza", Name: "Langhe Chardonnay"},
		"says oaked; this wine is unoaked")
	if err != nil {
		t.Fatalf("EnrichWithNote returned error: %v", err)
	}
	if res.Description != "Unoaked and precise." {
		t.Errorf("Description = %q", res.Description)
	}
	if !strings.Contains(gotInput, "says oaked; this wine is unoaked") {
		t.Errorf("the reviewer note is not in the prompt:\n%s", gotInput)
	}
	if i, j := strings.Index(gotInput, "Brezza"), strings.Index(gotInput, "says oaked"); i < 0 || j < i {
		// nothing to do — this is the required order
	} else {
		t.Errorf("the note precedes the wine's facts:\n%s", gotInput)
	}
}

// Enrich must keep behaving exactly as before: it is EnrichWithNote with an
// empty note, and an empty note must add nothing at all to the prompt.
func TestEnrich_AddsNoCorrectionSection(t *testing.T) {
	var gotInput string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		gotInput, _ = req["input"].(string)
		w.Write([]byte(`{"output":[{"content":[{"type":"output_text","text":` +
			`"{\"description\":\"d\",\"sommelierNotes\":\"s\",\"sources\":{},\"matchConfidence\":50}"}]}]}`))
	}))
	defer srv.Close()

	e := NewOpenAIEnricher("key", "gpt-4.1", srv.URL, srv.Client())
	if _, err := e.Enrich(context.Background(), salesforce.WineRaw{SKU: "AB1201"}); err != nil {
		t.Fatalf("Enrich returned error: %v", err)
	}
	if strings.Contains(strings.ToLower(gotInput), "correction") {
		t.Errorf("Enrich added a correction section with no note:\n%s", gotInput)
	}
}
```

- [ ] **Step 12: Run the tests to verify they fail**

Run: `go test ./internal/deploy/ ./internal/enrich/ -run 'Download|RawFromWine|EnrichWithNote|TestEnrich_AddsNoCorrection' -v`
Expected: FAIL — `c.Download undefined`, `undefined: RawFromWine`, `e.EnrichWithNote undefined`.

- [ ] **Step 13: Implement `Download`**

Append to `internal/deploy/bunny.go`, after `Delete`:

```go
// Download GETs relPath from the storage zone. It is the read side of the same
// zone Upload writes to, and exists for internal/queue: the review console's
// change queue (_review/queue.json) and the candidate images its reviewers pick
// live in the storage zone, on a path the public pull zone does not serve.
//
// A 404 returns empty bytes and no error, mirroring Delete's treatment of the
// same status: "the console has never written a queue" is the state of the zone
// until the first reviewer clicks something, and every nightly run before then
// would otherwise fail on it.
func (c *BunnyClient) Download(ctx context.Context, relPath string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.storageURL(relPath), nil)
	if err != nil {
		return nil, fmt.Errorf("bunny download %s: building request: %w", relPath, err)
	}
	req.Header.Set("AccessKey", c.StorageKey)

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bunny download %s: %w", relPath, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("bunny download %s: status %d: %s", relPath, resp.StatusCode, readBody(resp))
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("bunny download %s: reading body: %w", relPath, err)
	}
	return data, nil
}
```

- [ ] **Step 14: Implement `RawFromWine`**

Append to `internal/enrich/identity.go`:

```go
// RawFromWine reconstructs the salesforce.WineRaw an enrichment call needs from
// a catalog row. It exists for the one path where something OTHER than a roster
// pull triggers enrichment: a reviewer's text-feedback note (internal/queue),
// where the only record of the wine is the one already in data/wines.json.
//
// ReadyToSell is set true unconditionally — the wine is IN the catalog, so it
// already passed enrich.Eligible on the run that put it there, and the field is
// not read by the enrichment prompt anyway. StockQty/StockCases/CasePack are
// carried across for completeness rather than because the prompt uses them.
func RawFromWine(w model.Wine) salesforce.WineRaw {
	return salesforce.WineRaw{
		ID:          w.ID,
		SKU:         w.SKU,
		Producer:    w.Producer,
		Name:        w.Name,
		Vintage:     w.Vintage,
		Varietal:    w.Varietal,
		Region:      w.Region,
		Country:     w.Country,
		Appellation: w.Appellation,
		Style:       w.Style,
		StockQty:    w.StockQty,
		StockCases:  w.StockCases,
		CasePack:    w.CasePack,
		ReadyToSell: true,
	}
}
```

- [ ] **Step 15: Implement `EnrichWithNote`**

In `internal/enrich/search.go`, replace the body of `Enrich` (lines 123–149) with a delegation and add `EnrichWithNote`:

```go
// Enrich runs one web-search-grounded enrichment for w. See EnrichWithNote: this
// is that call with no human correction attached, so there is one request shape
// and one retry policy for both paths.
func (e *OpenAIEnricher) Enrich(ctx context.Context, w salesforce.WineRaw) (EnrichResult, error) {
	return e.EnrichWithNote(ctx, w, "")
}

// EnrichWithNote is Enrich with a reviewer's correction attached.
//
// The note is fed VERBATIM and placed AFTER the wine's facts, under an explicit
// heading, so the model reads it as a correction TO those facts rather than as
// another one of them. That ordering is the whole value of the text-feedback
// action: "says oaked; this wine is unoaked" is a human overruling the web, and
// paraphrasing or burying it would lose the override.
//
// If the response can't be parsed into a usable EnrichResult, the call is
// retried once before giving up (LLM output occasionally drifts from the
// requested shape, and a same-call retry is cheap insurance without masking a
// persistently broken prompt or endpoint).
func (e *OpenAIEnricher) EnrichWithNote(ctx context.Context, w salesforce.WineRaw, note string) (EnrichResult, error) {
	prompt := fmt.Sprintf(
		"Producer: %s\nWine: %s\nVintage: %s\nVarietal: %s\nRegion: %s\nAppellation: %s\nStyle: %s\nSKU: %s",
		w.Producer, w.Name, w.Vintage, w.Varietal, w.Region, w.Appellation, w.Style, w.SKU)
	if strings.TrimSpace(note) != "" {
		prompt += "\n\nCORRECTION FROM THE FINEVINES TEAM (authoritative, overrides anything you find on the web):\n" + note
	}

	reqObj := map[string]any{
		"model":             e.model,
		"instructions":      searchSystem,
		"input":             prompt,
		"tools":             []map[string]string{{"type": "web_search"}},
		"max_output_tokens": 2000,
	}

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		text, err := e.call(ctx, reqObj)
		if err != nil {
			return EnrichResult{}, err // transport/HTTP error: caller logs & retries next run
		}
		out, perr := parseEnrichResult([]byte(text))
		if perr == nil {
			return out, nil
		}
		lastErr = fmt.Errorf("unparseable enrichment for %s (attempt %d): %w", w.SKU, attempt+1, perr)
	}
	return EnrichResult{}, lastErr
}
```

- [ ] **Step 16: Run the tests to verify they pass**

Run: `go test ./internal/deploy/ ./internal/enrich/ -v`
Expected: PASS for every test in both packages, including the pre-existing ones (the `Enrich` refactor must not change any of them).

- [ ] **Step 17: Commit**

```bash
git add internal/deploy/bunny.go internal/deploy/bunny_test.go internal/enrich/search.go internal/enrich/search_test.go internal/enrich/identity.go internal/enrich/identity_test.go
git commit -m "queue: storage Download, RawFromWine, and note-aware enrichment"
```

### Part D — `Apply`, the drain

- [ ] **Step 18: Write the failing test**

`internal/queue/apply_test.go`:

```go
package queue

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// fakeStore is an in-memory Store. It records every Download and Delete so a
// test can assert the queue was cleared exactly once, and can be told to fail a
// specific path — the same shape internal/deploy's fakeUploader has, for the
// same reason: no network, no Bunny credentials, deterministic failures.
type fakeStore struct {
	mu      sync.Mutex
	files   map[string][]byte
	deleted []string
	failOn  string
}

func (f *fakeStore) Download(_ context.Context, relPath string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if relPath == f.failOn {
		return nil, errors.New("storage unavailable")
	}
	return f.files[relPath], nil
}

func (f *fakeStore) Delete(_ context.Context, relPath string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, relPath)
	return nil
}

// fakeTexts records the note it was asked to enrich with and returns fixed prose.
type fakeTexts struct {
	notes []string
	err   error
}

func (f *fakeTexts) EnrichWithNote(_ context.Context, w salesforce.WineRaw, note string) (enrich.EnrichResult, error) {
	f.notes = append(f.notes, note)
	if f.err != nil {
		return enrich.EnrichResult{}, f.err
	}
	return enrich.EnrichResult{
		Description:    "Steely and unoaked, cut with citrus.",
		SommelierNotes: "Pour cool alongside shellfish.",
		Aroma:          "white peach",
		Palate:         "taut",
		Finish:         "saline",
		FoodPairings:   []string{"oysters", "grilled bream"},
		Sources:        map[string]string{"description": "found", "sommelierNotes": "derived"},
	}, nil
}

// fakeNorm stands in for tools/imgnorm: it just copies, so the test asserts the
// swap wrote SOMETHING to the catalog path without shelling out to a binary
// that may not be built.
type fakeNorm struct{ calls [][2]string }

func (f *fakeNorm) Normalize(_ context.Context, src, dst string) error {
	f.calls = append(f.calls, [2]string{src, dst})
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}

func testWines() []model.Wine {
	return []model.Wine{
		{ID: "1", SKU: "AB1201", Producer: "Domaine Bart", Name: "Marsannay La Montagne",
			Vintage: "2019", Slug: "bart-marsannay-la-montagne-2019",
			ImagePath: "assets/img/wines/bart-marsannay-la-montagne-2019.svg",
			ImageSource: model.ImageGeneratedLabel, SourceHash: "hash-ab",
			Sources: map[string]model.FieldSource{"description": model.SourceDerived, "image": model.SourceDerived}},
		{ID: "2", SKU: "MB5110", Producer: "Brezza", Name: "Langhe Chardonnay",
			Vintage: "2021", Slug: "brezza-langhe-chardonnay-2021",
			ImagePath: "assets/img/wines/brezza-langhe-chardonnay-2021.jpg",
			ImageSource: model.ImageScrapedWeb, SourceHash: "hash-mb",
			Description: "Broad and oaked.", Sources: map[string]model.FieldSource{"description": model.SourceFound}},
	}
}

func baseInput(t *testing.T, store *fakeStore, actions []Action) Input {
	t.Helper()
	imgDir := t.TempDir()
	// The swap target's existing SVG sibling has to be on disk so the test can
	// assert it was removed.
	if err := os.WriteFile(filepath.Join(imgDir, "bart-marsannay-la-montagne-2019.svg"), []byte("<svg/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	return Input{
		Store:        store,
		Texts:        &fakeTexts{},
		Norm:         &fakeNorm{},
		Actions:      actions,
		Wines:        testWines(),
		ImgDir:       imgDir,
		CandidateDir: "_review/candidates",
		QueuePath:    "_review/queue.json",
		Now:          time.Date(2026, 7, 29, 8, 15, 0, 0, time.UTC),
	}
}

func find(t *testing.T, wines []model.Wine, sku string) model.Wine {
	t.Helper()
	for _, w := range wines {
		if w.SKU == sku {
			return w
		}
	}
	t.Fatalf("no wine with SKU %s in the result", sku)
	return model.Wine{}
}

func TestApply_ImageSwapWritesTheCandidateAndKeepsProvenance(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{
		"_review/candidates/AB1201/cand-2.png": []byte("candidate-bytes"),
	}}
	in := baseInput(t, store, []Action{{
		ID: "a1", Reviewer: "barbara", SKU: "AB1201", Kind: ActionImageSwap,
		Payload: Payload{Candidate: "AB1201/cand-2.png", SourceURL: "https://example-producer.fr/vins/"},
	}})

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}

	w := find(t, res.Wines, "AB1201")
	if w.ImagePath != "assets/img/wines/bart-marsannay-la-montagne-2019.jpg" {
		t.Errorf("ImagePath = %q, want the .jpg under assets/img/wines", w.ImagePath)
	}
	if w.ImageSource != model.ImageScrapedWeb {
		t.Errorf("ImageSource = %q, want %q", w.ImageSource, model.ImageScrapedWeb)
	}
	if w.ImageSourceURL != "https://example-producer.fr/vins/" {
		t.Errorf("ImageSourceURL = %q — provenance must survive a console swap", w.ImageSourceURL)
	}
	if w.Sources["image"] != model.SourceFound {
		t.Errorf(`Sources["image"] = %q, want found`, w.Sources["image"])
	}
	if w.MetadataScore == 0 {
		t.Error("MetadataScore was not recomputed after the swap")
	}
	// The bytes must actually be on disk at the catalog path, via the normalizer.
	if _, err := os.Stat(filepath.Join(in.ImgDir, "bart-marsannay-la-montagne-2019.jpg")); err != nil {
		t.Errorf("the swapped image is not on disk: %v", err)
	}
	// And the stale SVG placeholder must be gone, exactly as
	// enrich.writeImageFile and import.mjs both do it.
	if _, err := os.Stat(filepath.Join(in.ImgDir, "bart-marsannay-la-montagne-2019.svg")); !os.IsNotExist(err) {
		t.Error("the stale .svg sibling was left behind")
	}
	// A swap must not disturb the enrichment hash: SourceHash is what stops the
	// next enrich run re-billing OpenAI for this wine.
	if w.SourceHash != "hash-ab" {
		t.Errorf("SourceHash changed to %q — a swap must not trigger re-enrichment", w.SourceHash)
	}
}

func TestApply_ImageSwapToNoneFallsBackToTheSVGLabel(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	in := baseInput(t, store, []Action{{
		ID: "a1", Reviewer: "george", SKU: "MB5110", Kind: ActionImageSwap,
		Payload: Payload{Candidate: CandidateNone},
	}})

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	w := find(t, res.Wines, "MB5110")
	if w.ImagePath != "assets/img/wines/brezza-langhe-chardonnay-2021.svg" {
		t.Errorf("ImagePath = %q, want the .svg label path", w.ImagePath)
	}
	if w.ImageSource != model.ImageGeneratedLabel {
		t.Errorf("ImageSource = %q, want %q", w.ImageSource, model.ImageGeneratedLabel)
	}
	if w.ImageSourceURL != "" {
		t.Errorf("ImageSourceURL = %q, want empty — a label has no source URL", w.ImageSourceURL)
	}
	if w.Sources["image"] != model.SourceDerived {
		t.Errorf(`Sources["image"] = %q, want derived`, w.Sources["image"])
	}
}

func TestApply_TextFeedbackRegeneratesProseWithTheNoteAndLeavesTheRestAlone(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	in := baseInput(t, store, []Action{{
		ID: "a2", Reviewer: "george", SKU: "MB5110", Kind: ActionTextFeedback,
		Payload: Payload{Note: "says oaked; this wine is unoaked"},
	}})

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	texts := in.Texts.(*fakeTexts)
	if len(texts.notes) != 1 || texts.notes[0] != "says oaked; this wine is unoaked" {
		t.Errorf("the reviewer note reached the enricher as %v", texts.notes)
	}

	w := find(t, res.Wines, "MB5110")
	if w.Description != "Steely and unoaked, cut with citrus." {
		t.Errorf("Description = %q, want the regenerated prose", w.Description)
	}
	if w.Aroma != "white peach" || w.Finish != "saline" || len(w.FoodPairings) != 2 {
		t.Errorf("the tasting fields were not refreshed: %+v", w)
	}
	if w.EnrichedAt != "2026-07-29T08:15:00Z" {
		t.Errorf("EnrichedAt = %q, want the run's clock", w.EnrichedAt)
	}
	// The image and the Salesforce-authoritative fields are NOT this action's
	// business. A text fix must never trade away a real photograph.
	if w.ImagePath != "assets/img/wines/brezza-langhe-chardonnay-2021.jpg" || w.ImageSource != model.ImageScrapedWeb {
		t.Errorf("a text fix changed the image: %q / %q", w.ImagePath, w.ImageSource)
	}
	if w.Producer != "Brezza" || w.Vintage != "2021" || w.SourceHash != "hash-mb" {
		t.Errorf("a text fix changed identity or the enrichment hash: %+v", w)
	}
}

func TestApply_FlagRecordsAndTakesNoAutomaticAction(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	before := testWines()
	in := baseInput(t, store, []Action{{
		ID: "a3", Reviewer: "george", SKU: "PM5030", Kind: ActionFlag,
		Payload: Payload{Reason: "wrong producer, this is not Brezza"},
	}})
	// The flag names a SKU that IS in the catalog, so use one that is.
	in.Actions[0].SKU = "MB5110"

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if len(res.Flags) != 1 {
		t.Fatalf("res.Flags = %d entries, want 1", len(res.Flags))
	}
	f := res.Flags[0]
	if f.SKU != "MB5110" || f.Slug != "brezza-langhe-chardonnay-2021" ||
		f.Reviewer != "george" || f.Reason != "wrong producer, this is not Brezza" ||
		f.FlaggedAt != "2026-07-29T08:15:00Z" {
		t.Errorf("flag recorded as %+v", f)
	}
	w := find(t, res.Wines, "MB5110")
	if w.Status != "" || w.Description != before[1].Description {
		t.Errorf("a flag changed the wine: status %q, description %q", w.Status, w.Description)
	}
}

// The idempotency guarantee: a crashed run, or a second repository_dispatch for
// the same batch, must not apply anything twice.
func TestApply_SkipsActionsAlreadyInTheLedger(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	in := baseInput(t, store, []Action{{
		ID: "a2", Reviewer: "george", SKU: "MB5110", Kind: ActionTextFeedback,
		Payload: Payload{Note: "says oaked; this wine is unoaked"},
	}})
	in.Ledger = Ledger{Applied: []Applied{{ID: "a2", SKU: "MB5110", Kind: ActionTextFeedback,
		AppliedAt: "2026-07-28T08:15:00Z", Outcome: "text regenerated"}}}

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if res.Skipped != 1 {
		t.Errorf("res.Skipped = %d, want 1", res.Skipped)
	}
	if len(res.Applied) != 0 {
		t.Errorf("res.Applied = %+v, want empty", res.Applied)
	}
	if n := len(in.Texts.(*fakeTexts).notes); n != 0 {
		t.Errorf("the enricher was called %d times for an already-applied action", n)
	}
	if len(res.Ledger.Applied) != 1 {
		t.Errorf("the ledger grew to %d entries for a no-op drain", len(res.Ledger.Applied))
	}
	w := find(t, res.Wines, "MB5110")
	if w.Description != "Broad and oaked." {
		t.Errorf("an already-applied action was applied again: %q", w.Description)
	}
}

// An action naming a SKU the catalog does not hold is recorded as applied, with
// the reason. Leaving it unrecorded would make every future run retry it
// forever, and the queue would never drain.
func TestApply_UnknownSKUIsRecordedNotRetriedForever(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	in := baseInput(t, store, []Action{{
		ID: "a9", Reviewer: "barbara", SKU: "NOPE99", Kind: ActionTextFeedback,
		Payload: Payload{Note: "n/a"},
	}})

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if len(res.Applied) != 1 || !strings.Contains(res.Applied[0].Outcome, "no such SKU") {
		t.Errorf("res.Applied = %+v, want one entry naming the missing SKU", res.Applied)
	}
	if !res.Ledger.Has("a9") {
		t.Error("the unknown-SKU action was not recorded in the ledger")
	}
}

// A failing action must not take the whole drain down, and must NOT be recorded
// as applied — the next run retries it.
func TestApply_AFailedActionIsNotLedgeredAndDoesNotAbortTheDrain(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}, failOn: "_review/candidates/AB1201/cand-2.png"}
	in := baseInput(t, store, []Action{
			{ID: "a1", SKU: "AB1201", Reviewer: "barbara", Kind: ActionImageSwap,
				Payload: Payload{Candidate: "AB1201/cand-2.png"}},
			{ID: "a2", SKU: "MB5110", Reviewer: "george", Kind: ActionTextFeedback,
				Payload: Payload{Note: "says oaked; this wine is unoaked"}},
	})

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if res.Ledger.Has("a1") {
		t.Error("the failed swap was recorded as applied — it would never be retried")
	}
	if !res.Ledger.Has("a2") {
		t.Error("the drain stopped at the failure instead of continuing")
	}
}

// Clearing the queue happens ONCE, at the end, and only after the actions have
// been applied. Deleting it is safe despite the console possibly appending
// mid-drain: the console rewrites the whole file, so a re-appearing action is
// re-read next run and skipped by the ledger.
func TestApply_ClearsTheQueueExactlyOnce(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	in := baseInput(t, store, []Action{{ID: "a3", SKU: "MB5110", Reviewer: "george",
		Kind: ActionFlag, Payload: Payload{Reason: "duplicate"}}})

	if _, err := Apply(context.Background(), in); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if len(store.deleted) != 1 || store.deleted[0] != "_review/queue.json" {
		t.Errorf("store.deleted = %v, want exactly [_review/queue.json]", store.deleted)
	}
}

// An empty queue must not delete anything: Delete is a real API call, and a
// nightly run with nothing queued should be silent.
func TestApply_EmptyQueueTouchesNothing(t *testing.T) {
	store := &fakeStore{files: map[string][]byte{}}
	in := baseInput(t, store, nil)

	res, err := Apply(context.Background(), in)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if len(store.deleted) != 0 {
		t.Errorf("store.deleted = %v, want nothing for an empty queue", store.deleted)
	}
	if len(res.Applied) != 0 || res.Skipped != 0 {
		t.Errorf("res = %+v, want an untouched result", res)
	}
}
```

- [ ] **Step 19: Run the test to verify it fails**

Run: `go test ./internal/queue/ -run TestApply -v`
Expected: FAIL — `undefined: Input`, `undefined: Apply`, `undefined: Result`.

- [ ] **Step 20: Write the implementation**

`internal/queue/apply.go`:

```go
package queue

import (
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"time"

	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// Store is the subset of the Bunny storage zone a drain needs: read a file,
// delete a file. Declared here rather than depending on *deploy.BunnyClient so
// tests inject an in-memory fake with no network and no credentials — the same
// reasoning as internal/deploy.Uploader. *deploy.BunnyClient satisfies it
// unchanged (asserted in cmd/finevines/applyqueue.go).
type Store interface {
	Download(ctx context.Context, relPath string) ([]byte, error)
	Delete(ctx context.Context, relPath string) error
}

// TextEnricher regenerates a wine's catalog prose with a reviewer's note
// appended to the prompt. *enrich.OpenAIEnricher satisfies it.
type TextEnricher interface {
	EnrichWithNote(ctx context.Context, w salesforce.WineRaw, note string) (enrich.EnrichResult, error)
}

// Normalizer re-composes a candidate image onto the catalog's fixed 600x900
// canvas — the same tools/imgnorm step tools/labelfetch/import.mjs runs, so a
// console swap and a nightly import produce identical geometry and the
// portfolio grid does not start jostling wherever a human intervened.
type Normalizer interface {
	Normalize(ctx context.Context, srcPath, dstPath string) error
}

// Input is everything one drain needs. A struct rather than an argument list
// because that list is eleven values long, and both callers — main.go and the
// tests — would otherwise have to keep them in the same order by hand.
type Input struct {
	Store  Store
	Texts  TextEnricher
	Norm   Normalizer
	Actions []Action
	Wines   []model.Wine
	Ledger  Ledger
	Flags   []Flag
	// ImgDir is the on-disk catalog image directory (assets/img/wines).
	ImgDir string
	// CandidateDir is the storage-zone prefix the console stages candidate
	// images under (_review/candidates). Payload.Candidate is relative to it.
	CandidateDir string
	// QueuePath is the storage-zone path of the queue file itself, deleted once
	// the drain has finished (_review/queue.json).
	QueuePath string
	Now       time.Time
	Log       func(string, ...any)
}

// Result is what one drain changed. Wines and Ledger are the new values to
// persist; Applied is only THIS run's entries, which is what the digest email
// reports (the ledger holds every entry ever).
type Result struct {
	Wines   []model.Wine
	Ledger  Ledger
	Flags   []Flag
	Applied []Applied
	Skipped int
}

// Apply drains in.Actions against in.Wines.
//
// Order and failure handling, both load-bearing:
//
//   - Actions already in the ledger are skipped without calling anything. That
//     is the idempotency guarantee: a run that crashes halfway through a drain,
//     or a second repository_dispatch fired for the same batch, re-reads the
//     same queue and applies nothing twice.
//   - A per-action failure is logged and that action is left OUT of the ledger,
//     so the next run retries it. It does not abort the drain: one unreachable
//     candidate image must not strand the other four reviewers' fixes.
//   - An action naming a SKU the catalog does not hold IS ledgered, with the
//     reason. Leaving it unrecorded would have every future run retry it
//     forever and the queue would never drain.
//   - The queue file is deleted last, and only if there was anything in it.
//     Deleting rather than truncating is safe even though the console may append
//     mid-drain: the console rewrites the whole file, so an action that
//     reappears is simply re-read next run and skipped by the ledger.
func Apply(ctx context.Context, in Input) (Result, error) {
	log := in.Log
	if log == nil {
		log = func(string, ...any) {}
	}

	res := Result{Wines: append([]model.Wine(nil), in.Wines...), Ledger: in.Ledger, Flags: in.Flags}
	if len(in.Actions) == 0 {
		return res, nil
	}

	bySKU := make(map[string]int, len(res.Wines))
	for i, w := range res.Wines {
		bySKU[w.SKU] = i
	}
	stamp := in.Now.UTC().Format(time.RFC3339)

	record := func(a Action, outcome string) {
		entry := Applied{ID: a.ID, SKU: a.SKU, Kind: a.Kind, Reviewer: a.Reviewer,
			AppliedAt: stamp, Outcome: outcome}
		res.Ledger.Applied = append(res.Ledger.Applied, entry)
		res.Applied = append(res.Applied, entry)
	}

	for _, a := range in.Actions {
		if res.Ledger.Has(a.ID) {
			res.Skipped++
			continue
		}
		i, ok := bySKU[a.SKU]
		if !ok {
			log("applyqueue: action %s (%s) names SKU %s, which is not in the catalog — recording and moving on",
				a.ID, a.Kind, a.SKU)
			record(a, "no such SKU in the catalog")
			continue
		}

		outcome, err := applyOne(ctx, in, &res, i, a)
		if err != nil {
			// Not ledgered: the next run retries it.
			log("applyqueue: action %s (%s, SKU %s) failed, will retry next run: %v",
				a.ID, a.Kind, a.SKU, err)
			continue
		}
		log("applyqueue: %s on %s by %s — %s", a.Kind, a.SKU, a.Reviewer, outcome)
		record(a, outcome)
	}

	if err := in.Store.Delete(ctx, in.QueuePath); err != nil {
		return res, fmt.Errorf("applyqueue: clear %s (actions already applied — the ledger stops them re-applying): %w",
			in.QueuePath, err)
	}
	return res, nil
}

// applyOne applies a single action to res.Wines[i] and returns the ledger
// outcome prose. An unknown Kind is an error, not a silent skip: a console
// shipping an action type this binary predates must be visible.
func applyOne(ctx context.Context, in Input, res *Result, i int, a Action) (string, error) {
	switch a.Kind {
	case ActionImageSwap:
		return swapImage(ctx, in, &res.Wines[i], a)
	case ActionTextFeedback:
		return regenerateText(ctx, in, &res.Wines[i], a)
	case ActionFlag:
		res.Flags = append(res.Flags, Flag{
			SKU: a.SKU, Slug: res.Wines[i].Slug, Reviewer: a.Reviewer,
			Reason: a.Payload.Reason, FlaggedAt: in.Now.UTC().Format(time.RFC3339),
		})
		return "flagged for human attention: " + a.Payload.Reason, nil
	default:
		return "", fmt.Errorf("unknown action kind %q", a.Kind)
	}
}

// swapImage replaces the wine's photograph with the candidate the reviewer
// picked, or drops back to the SVG label when they rejected all of them.
//
// The candidate goes through the normalizer rather than straight to disk: the
// catalog's images are all 600x900 with the bottle at a fixed height, and a raw
// fetched candidate is anywhere between 500x650 and 1200x1200. Consistency is
// the point of that step, and a console swap must not be the one place it is
// skipped.
func swapImage(ctx context.Context, in Input, w *model.Wine, a Action) (string, error) {
	if a.Payload.Candidate == CandidateNone {
		rel, err := writeSibling(in.ImgDir, w.Slug, "svg", "jpg", nil)
		if err != nil {
			return "", err
		}
		w.ImagePath, w.ImageSource, w.ImageSourceURL = rel, model.ImageGeneratedLabel, ""
		rescoreImage(w)
		// No bytes are written for a label: build.ensureLabels regenerates the
		// SVG deterministically from the wine's own fields, and the generated
		// labels are gitignored build artifacts precisely so nothing has to
		// carry them around.
		return "reverted to the generated label", nil
	}

	storagePath := path.Join(in.CandidateDir, a.Payload.Candidate)
	data, err := in.Store.Download(ctx, storagePath)
	if err != nil {
		return "", fmt.Errorf("fetch candidate %s: %w", storagePath, err)
	}
	if len(data) == 0 {
		return "", fmt.Errorf("candidate %s is empty or absent in the storage zone", storagePath)
	}

	staged := filepath.Join(os.TempDir(), "finevines-swap-"+w.Slug+filepath.Ext(a.Payload.Candidate))
	if err := os.WriteFile(staged, data, 0o644); err != nil {
		return "", fmt.Errorf("stage candidate: %w", err)
	}
	defer os.Remove(staged)

	dst := filepath.Join(in.ImgDir, w.Slug+".jpg")
	if err := os.MkdirAll(in.ImgDir, 0o755); err != nil {
		return "", err
	}
	if err := in.Norm.Normalize(ctx, staged, dst); err != nil {
		return "", fmt.Errorf("normalise candidate: %w", err)
	}
	// Remove the stale .svg placeholder, exactly as enrich.writeImageFile and
	// import.mjs both do — otherwise it ships as an orphan asset beside the jpg.
	if err := os.Remove(filepath.Join(in.ImgDir, w.Slug+".svg")); err != nil && !os.IsNotExist(err) {
		return "", err
	}

	w.ImagePath = path.Join(filepath.ToSlash(in.ImgDir), w.Slug+".jpg")
	w.ImageSource = model.ImageScrapedWeb
	// Provenance survives a console swap: the payload carries where the
	// candidate came from precisely so this stays answerable from the catalog.
	w.ImageSourceURL = a.Payload.SourceURL
	rescoreImage(w)
	return "image replaced with " + a.Payload.Candidate, nil
}

// regenerateText re-runs the wine's text generation with the reviewer's note
// appended, and writes back ONLY the prose. Everything else is deliberately
// untouched: the image (a text fix must never trade away a real photograph),
// the Salesforce-authoritative identity fields, and above all SourceHash —
// which is what stops the next enrich run paying OpenAI for this wine again.
func regenerateText(ctx context.Context, in Input, w *model.Wine, a Action) (string, error) {
	out, err := in.Texts.EnrichWithNote(ctx, enrich.RawFromWine(*w), a.Payload.Note)
	if err != nil {
		return "", fmt.Errorf("regenerate text: %w", err)
	}
	w.Description = out.Description
	w.SommelierNotes = out.SommelierNotes
	w.Aroma, w.Palate, w.Finish = out.Aroma, out.Palate, out.Finish
	w.FoodPairings = out.FoodPairings
	w.EnrichedAt = in.Now.UTC().Format(time.RFC3339)

	if w.Sources == nil {
		w.Sources = map[string]model.FieldSource{}
	}
	for field, src := range out.Sources {
		switch field {
		case "description", "sommelierNotes", "aroma", "palate", "finish", "foodPairings":
			w.Sources[field] = model.ParseFieldSource(src)
		}
	}
	w.MetadataScore = model.MetadataScore(w.Sources)
	return "text regenerated with the reviewer's note", nil
}

// rescoreImage re-derives the image field's provenance and the wine's coverage
// score after the image changed. Kept in one place so a swap can never leave
// Sources["image"] disagreeing with ImageSource — which would score the wine
// wrong AND, if it read as derived, have the next enrich run regenerate over it.
func rescoreImage(w *model.Wine) {
	if w.Sources == nil {
		w.Sources = map[string]model.FieldSource{}
	}
	w.Sources["image"] = model.ImageFieldSource(w.ImageSource)
	w.MetadataScore = model.MetadataScore(w.Sources)
}

// writeSibling computes the site-relative image path for <slug>.<ext> and
// removes the <slug>.<siblingExt> companion, writing data first when there is
// any. It mirrors enrich.writeImageFile, which is unexported.
func writeSibling(imgDir, slug, ext, siblingExt string, data []byte) (string, error) {
	if err := os.MkdirAll(imgDir, 0o755); err != nil {
		return "", err
	}
	if data != nil {
		if err := os.WriteFile(filepath.Join(imgDir, slug+"."+ext), data, 0o644); err != nil {
			return "", err
		}
	}
	if err := os.Remove(filepath.Join(imgDir, slug+"."+siblingExt)); err != nil && !os.IsNotExist(err) {
		return "", err
	}
	return path.Join(filepath.ToSlash(imgDir), slug+"."+ext), nil
}
```

- [ ] **Step 21: Run the test to verify it passes**

Run: `go test ./internal/queue/ -v`
Expected: PASS — every `TestApply*`, `TestParseQueue*`, `TestLedger*` and `TestSave*` case.

- [ ] **Step 22: Commit**

```bash
git add internal/queue/apply.go internal/queue/apply_test.go
git commit -m "queue: apply image-swap, text-feedback and flag actions idempotently"
```

### Part E — the subcommand

- [ ] **Step 23: Write the subcommand**

`cmd/finevines/applyqueue.go`:

```go
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/deploy"
	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/queue"
)

// The one BunnyClient serves both roles: it uploads dist/ for deploy and reads
// _review/ for the drain. Asserted here rather than in internal/queue so that
// package stays free of any dependency on deploy.
var _ queue.Store = (*deploy.BunnyClient)(nil)

// Storage-zone layout for the review console's data (design spec §B "Data").
// _review/ is a path the public pull zone does not serve, so nothing here is
// reachable from finevines.com.
const (
	queueStoragePath = "_review/queue.json"
	candidateDir     = "_review/candidates"
)

// Repo paths the drain reads and writes. The ledger and the flag record are
// COMMITTED with the data — CI keeps no state between runs, and remembering
// across them is the entire point of the ledger.
const (
	queueLedgerPath = "data/queue-ledger.json"
	flagsPath       = "data/flags.json"
)

// imgnormBin is the normaliser tools/labelfetch/import.mjs also shells out to.
// Built into the repo root by the workflow; the extension-less name works on
// Linux and the .exe name is what a Windows workstation has, so both are tried.
var imgnormCandidates = []string{"imgnorm", "imgnorm.exe"}

// execNormalizer shells out to tools/imgnorm, the same way import.mjs does.
// Behind queue.Normalizer so the drain's tests never need the binary built.
type execNormalizer struct{ bin string }

func (n execNormalizer) Normalize(ctx context.Context, src, dst string) error {
	out, err := exec.CommandContext(ctx, n.bin, "-in", src, "-out", dst).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", n.bin, err, out)
	}
	return nil
}

// findImgnorm locates the normaliser next to the working directory. A missing
// binary is an error at drain time rather than a silent skip: an image-swap
// that quietly did nothing would leave a reviewer looking at the wrong bottle
// and believing they had fixed it.
func findImgnorm() (string, error) {
	for _, c := range imgnormCandidates {
		if _, err := os.Stat(c); err == nil {
			return filepath.Join(".", c), nil
		}
	}
	return "", fmt.Errorf("applyqueue: no imgnorm binary in the working directory — build it first:\n  go build -o imgnorm ./tools/imgnorm")
}

// runApplyQueue drains the review console's change queue. See internal/queue's
// package doc for the shape of the contract, and queue.Apply's for the
// idempotency and failure ordering.
//
// It writes THIS RUN's applied actions to a run-log file (default
// .run/queue-applied.json, gitignored) which `notify` reads later in the same
// workflow run to list the reviewer fixes in the digest. That is separate from
// data/queue-ledger.json, which is committed and holds every action ever
// applied.
func runApplyQueue(cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("applyqueue", flag.ContinueOnError)
	runLog := fs.String("runlog", ".run/queue-applied.json",
		"where to write this run's applied actions for the digest email")
	if err := fs.Parse(args); err != nil {
		return err
	}

	requiredEnv := []struct{ name, value string }{
		{"FINEVINES_BUNNY_STORAGE_ZONE", cfg.BunnyStorageZone},
		{"FINEVINES_BUNNY_STORAGE_KEY", cfg.BunnyStorageKey},
		{"OPENAI_API_KEY", cfg.OpenAIAPIKey},
	}
	for _, req := range requiredEnv {
		if req.value == "" {
			return fmt.Errorf("applyqueue: set %s in .env (or the environment) before running applyqueue", req.name)
		}
	}

	client := deploy.NewBunnyClient(
		cfg.BunnyStorageEndpoint, cfg.BunnyStorageZone, cfg.BunnyStorageKey,
		cfg.BunnyAPIKey, cfg.BunnyPullZoneID, http.DefaultClient)

	raw, err := client.Download(context.Background(), queueStoragePath)
	if err != nil {
		return fmt.Errorf("applyqueue: fetch %s: %w", queueStoragePath, err)
	}
	actions, err := queue.ParseQueue(raw)
	if err != nil {
		return err
	}
	if len(actions) == 0 {
		log.Printf("applyqueue: %s is empty — nothing to drain", queueStoragePath)
		return writeRunLog(*runLog, nil)
	}
	log.Printf("applyqueue: %d queued action(s)", len(actions))

	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		return fmt.Errorf("applyqueue: load data/wines.json: %w", err)
	}
	ledger, err := queue.LoadLedger(queueLedgerPath)
	if err != nil {
		return fmt.Errorf("applyqueue: load %s: %w", queueLedgerPath, err)
	}
	flags, err := queue.LoadFlags(flagsPath)
	if err != nil {
		return fmt.Errorf("applyqueue: load %s: %w", flagsPath, err)
	}
	norm, err := findImgnorm()
	if err != nil {
		return err
	}

	res, err := queue.Apply(context.Background(), queue.Input{
		Store:        client,
		Texts:        enrich.NewOpenAIEnricher(cfg.OpenAIAPIKey, cfg.OpenAIModel, "", http.DefaultClient),
		Norm:         execNormalizer{bin: norm},
		Actions:      actions,
		Wines:        wines,
		Ledger:       ledger,
		Flags:        flags,
		ImgDir:       "assets/img/wines",
		CandidateDir: candidateDir,
		QueuePath:    queueStoragePath,
		Now:          time.Now().UTC(),
		Log:          log.Printf,
	})
	if err != nil {
		return err
	}

	// Persist in dependency order: the catalog, then the ledger, then the flags,
	// then the run log. The ledger after the catalog is the safe direction — a
	// crash between them re-applies an action that already landed, which is
	// harmless, whereas the reverse would record work that was never done.
	if err := model.SaveWines("data/wines.json", res.Wines); err != nil {
		return fmt.Errorf("applyqueue: save data/wines.json: %w", err)
	}
	if err := queue.SaveLedger(queueLedgerPath, res.Ledger); err != nil {
		return fmt.Errorf("applyqueue: save %s: %w", queueLedgerPath, err)
	}
	if err := queue.SaveFlags(flagsPath, res.Flags); err != nil {
		return fmt.Errorf("applyqueue: save %s: %w", flagsPath, err)
	}
	if err := writeRunLog(*runLog, res.Applied); err != nil {
		return err
	}

	log.Printf("applyqueue: applied %d, skipped %d already-applied, %d flag(s) on record",
		len(res.Applied), res.Skipped, len(res.Flags))
	return nil
}

// writeRunLog records this run's applied actions where `notify` will find them.
// Always written, even empty, so `notify` can tell "no reviewer actions" apart
// from "applyqueue never ran".
func writeRunLog(path string, applied []queue.Applied) error {
	if applied == nil {
		applied = []queue.Applied{}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(applied, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}
```

Add `"encoding/json"` to that file's imports.

- [ ] **Step 24: Wire the dispatch**

In `cmd/finevines/main.go`, add to the switch (after the `deploy` case):

```go
	case "applyqueue":
		runErr = runApplyQueue(cfg, os.Args[2:])
```

and update `usage`:

```go
func usage() {
	fmt.Fprintln(os.Stderr, "usage: finevines <enrich|build|redirects|deploy|applyqueue|notify|report>")
}
```

(`notify` is listed now and implemented in Task 7; wiring both names at once keeps `usage` from needing a second edit.)

- [ ] **Step 25: Verify it builds and reports missing config rather than crashing**

Run:

```bash
go build -o finevines.exe ./cmd/finevines
go vet ./...
./finevines.exe applyqueue
```

Expected: the build and vet are silent; the run prints `finevines: applyqueue: set FINEVINES_BUNNY_STORAGE_ZONE in .env (or the environment) before running applyqueue` and exits 1.

- [ ] **Step 26: Commit**

```bash
git add cmd/finevines/applyqueue.go cmd/finevines/main.go
git commit -m "cmd: finevines applyqueue drains the review console's change queue"
```

---

## Task 4: Image attempt ledger

There are roughly 1,700 wines in the catalog with no real photograph, and most of them have none because none exists on the open web. Without a memory of what has already been tried, every nightly run re-searches all 1,700 — hours of runner time and a vision call per candidate — to rediscover the same absence.

The ledger is **Node-owned**. Both writers (the fetch pipeline and the import step) are Node, the Go side has no use for it, and one implementation is better than two agreeing implementations of the same 30 lines. It is keyed by **SKU**, not slug: a slug changes when a wine is renamed or re-vintaged, and the ledger would silently forget everything it knew.

**Files:**
- Create: `tools/labelfetch/attempts.mjs`
- Create: `tests/unit/attempts.test.js`
- Create (as data, on first run): `data/image-attempts.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (all from `tools/labelfetch/attempts.mjs`):
  - `export const LEDGER_PATH = 'data/image-attempts.json'`
  - `export const RETRY_DAYS = 30`
  - `export async function loadAttempts(path = LEDGER_PATH)` → plain object keyed by SKU
  - `export async function saveAttempts(attempts, path = LEDGER_PATH)` → `Promise<void>`
  - `export function isDue(attempts, sku, now = new Date(), retryDays = RETRY_DAYS)` → boolean
  - `export function recordAttempt(attempts, sku, outcome, now = new Date())` → mutates and returns `attempts`
  - Record shape: `{ lastAttempted: <ISO-8601>, outcome: 'imported' | 'miss', attempts: <int> }`
  - Task 5 consumes `loadAttempts`/`isDue`/`recordAttempt`/`saveAttempts` in `pipeline.mjs` and `import.mjs`.

- [ ] **Step 1: Write the failing test**

`tests/unit/attempts.test.js`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAttempts,
  saveAttempts,
  isDue,
  recordAttempt,
  RETRY_DAYS,
} from '../../tools/labelfetch/attempts.mjs';

const NOW = new Date('2026-07-29T08:15:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

describe('which wines the image stage should try', () => {
  test('a wine nobody has ever tried is due', () => {
    assert.equal(isDue({}, 'AB1201', NOW), true);
  });

  test('a wine whose photograph was imported is never due again', () => {
    const attempts = { AB1201: { lastAttempted: daysAgo(400), outcome: 'imported', attempts: 1 } };
    assert.equal(isDue(attempts, 'AB1201', NOW), false);
  });

  test('a recent miss is not due — this is the whole point of the ledger', () => {
    const attempts = { AB1201: { lastAttempted: daysAgo(3), outcome: 'miss', attempts: 1 } };
    assert.equal(isDue(attempts, 'AB1201', NOW), false);
  });

  test('a miss older than the backoff is due again', () => {
    const attempts = { AB1201: { lastAttempted: daysAgo(RETRY_DAYS + 1), outcome: 'miss', attempts: 4 } };
    assert.equal(isDue(attempts, 'AB1201', NOW), true);
  });

  test('the backoff boundary is inclusive', () => {
    const attempts = { AB1201: { lastAttempted: daysAgo(RETRY_DAYS), outcome: 'miss', attempts: 1 } };
    assert.equal(isDue(attempts, 'AB1201', NOW), true);
  });

  test('a record with an unreadable timestamp is due, not stuck forever', () => {
    // Bias to retrying: a corrupt record that reads as "never due" would silently
    // exclude a wine from image sourcing for good, and nobody would notice.
    assert.equal(isDue({ AB1201: { outcome: 'miss' } }, 'AB1201', NOW), true);
    assert.equal(isDue({ AB1201: { lastAttempted: 'yesterday', outcome: 'miss' } }, 'AB1201', NOW), true);
  });

  test('the backoff is overridable so a one-off sweep can ignore it', () => {
    const attempts = { AB1201: { lastAttempted: daysAgo(2), outcome: 'miss', attempts: 1 } };
    assert.equal(isDue(attempts, 'AB1201', NOW, 1), true);
  });
});

describe('recording an attempt', () => {
  test('a first attempt records the outcome, the time, and a count of one', () => {
    const attempts = {};
    recordAttempt(attempts, 'AB1201', 'miss', NOW);
    assert.deepEqual(attempts.AB1201, {
      lastAttempted: '2026-07-29T08:15:00.000Z',
      outcome: 'miss',
      attempts: 1,
    });
  });

  test('a repeat attempt increments the count', () => {
    const attempts = { AB1201: { lastAttempted: daysAgo(40), outcome: 'miss', attempts: 3 } };
    recordAttempt(attempts, 'AB1201', 'miss', NOW);
    assert.equal(attempts.AB1201.attempts, 4);
    assert.equal(attempts.AB1201.lastAttempted, '2026-07-29T08:15:00.000Z');
  });

  test('import upgrades a miss to imported', () => {
    // The two writers run in order in CI: pipeline.mjs records the attempt as a
    // miss, then import.mjs upgrades the ones it actually wrote. That ordering
    // means a run that crashes between them still leaves the attempt recorded,
    // so the next night does not re-burn the search.
    const attempts = {};
    recordAttempt(attempts, 'AB1201', 'miss', NOW);
    recordAttempt(attempts, 'AB1201', 'imported', NOW);
    assert.equal(attempts.AB1201.outcome, 'imported');
    assert.equal(isDue(attempts, 'AB1201', new Date('2027-01-01T00:00:00Z')), false);
  });

  test('an unknown outcome is refused rather than written', () => {
    assert.throws(() => recordAttempt({}, 'AB1201', 'maybe', NOW), /outcome/);
  });
});

describe('persistence', () => {
  test('a missing ledger loads as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attempts-'));
    assert.deepEqual(await loadAttempts(join(dir, 'image-attempts.json')), {});
  });

  test('save then load round-trips, and the file is diff-friendly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attempts-'));
    const path = join(dir, 'image-attempts.json');
    const attempts = {};
    recordAttempt(attempts, 'MB5110', 'imported', NOW);
    recordAttempt(attempts, 'AB1201', 'miss', NOW);
    await saveAttempts(attempts, path);

    assert.deepEqual(await loadAttempts(path), attempts);
    const raw = await readFile(path, 'utf8');
    // Committed to a public repo, so it has to diff one SKU at a time and the
    // keys have to be sorted or every run reshuffles the whole file.
    assert.ok(raw.endsWith('\n'), 'no trailing newline');
    assert.ok(raw.indexOf('"AB1201"') < raw.indexOf('"MB5110"'), 'keys are not sorted');
  });

  test('a corrupt ledger loads as empty rather than failing the run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attempts-'));
    const path = join(dir, 'image-attempts.json');
    await writeFile(path, '{ this is not json');
    assert.deepEqual(await loadAttempts(path), {});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/attempts.test.js`
Expected: FAIL — `Cannot find module ...tools/labelfetch/attempts.mjs`.

- [ ] **Step 3: Write the implementation**

`tools/labelfetch/attempts.mjs`:

```js
// The image attempt ledger: which wines the image stage has already tried for a
// photograph, when, and how it went.
//
// Why it has to exist: about 1,700 catalog wines have no real photograph, and
// most of them have none because none is on the open web. A nightly CI run with
// no memory re-searches all of them every night — hours of runner time and a
// vision call per candidate — to rediscover the same absence. So the default
// behaviour has to be "having failed, do not ask again for a while".
//
// Keyed by SKU, not slug. A slug changes when a wine is renamed or re-vintaged
// (see enrich.Run's rename handling), and a slug-keyed ledger would quietly
// forget everything it knew about a wine the moment its name was tidied up.
//
// Committed to the repo (data/image-attempts.json) because CI keeps no state
// between runs and remembering across them is the entire point.
import { readFile, writeFile } from 'node:fs/promises';

export const LEDGER_PATH = 'data/image-attempts.json';

// How long a failed search waits before being retried. Thirty days is the
// spec's default: long enough that the nightly run is cheap, short enough that a
// wine whose producer finally puts a bottle shot on their site is picked up
// within the month.
export const RETRY_DAYS = 30;

// The only outcomes a record may carry. 'imported' is terminal — the wine has
// its photograph. 'miss' is everything else: nothing found, nothing that passed
// the shape gate, a watermark hit, a normalise failure. They are one outcome on
// purpose: from the ledger's point of view they all mean "no photograph yet, try
// again after the backoff", and distinguishing them would invite per-reason
// backoffs nobody has asked for.
const OUTCOMES = new Set(['imported', 'miss']);

// loadAttempts reads the ledger. A missing file is first-run behaviour; a
// CORRUPT file is also treated as empty rather than fatal, because the ledger is
// an optimisation — losing it costs a slow night, whereas failing the run over
// it costs the whole night.
export async function loadAttempts(path = LEDGER_PATH) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// saveAttempts writes the ledger with sorted keys and a trailing newline: it is
// committed to a public repo, so it has to diff one SKU at a time instead of
// reshuffling on every run.
export async function saveAttempts(attempts, path = LEDGER_PATH) {
  const sorted = {};
  for (const sku of Object.keys(attempts).sort()) sorted[sku] = attempts[sku];
  await writeFile(path, JSON.stringify(sorted, null, 1) + '\n');
}

// isDue reports whether the image stage should try this SKU on this run.
//
// Unknown SKU: yes. Already imported: never again. A miss: only once the backoff
// has elapsed. A record whose timestamp cannot be read: yes — biasing to retry,
// because a corrupt record reading as "not due" would silently exclude a wine
// from image sourcing forever and nobody would ever notice.
export function isDue(attempts, sku, now = new Date(), retryDays = RETRY_DAYS) {
  const rec = attempts?.[sku];
  if (!rec) return true;
  if (rec.outcome === 'imported') return false;
  const last = Date.parse(rec.lastAttempted ?? '');
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= retryDays * 86400000;
}

// recordAttempt stamps an attempt onto the ledger, incrementing the per-SKU
// count. Mutates and returns attempts so a caller can record inside a loop and
// save once at the end.
export function recordAttempt(attempts, sku, outcome, now = new Date()) {
  if (!OUTCOMES.has(outcome)) {
    throw new Error(`recordAttempt: unknown outcome ${JSON.stringify(outcome)}; expected one of ${[...OUTCOMES].join(', ')}`);
  }
  const prior = attempts[sku]?.attempts ?? 0;
  attempts[sku] = {
    lastAttempted: now.toISOString(),
    outcome,
    attempts: prior + 1,
  };
  return attempts;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/attempts.test.js`
Expected: PASS — `# pass 14`, `# fail 0`.

- [ ] **Step 5: Seed the ledger from what is already known**

Every wine that already holds a `.jpg` has effectively been "imported" — recording that up front stops the first CI run from re-searching 500 wines that already have photographs. Run:

```bash
node -e "
const {readFile,writeFile}=require('fs/promises');
(async()=>{
  const wines=JSON.parse(await readFile('data/wines.json','utf8'));
  const out={};
  const now=new Date().toISOString();
  for (const w of wines) {
    if (!w.sku) continue;
    if ((w.imagePath||'').endsWith('.svg')) continue;
    out[w.sku]={lastAttempted:now,outcome:'imported',attempts:1};
  }
  const sorted={};
  for (const k of Object.keys(out).sort()) sorted[k]=out[k];
  await writeFile('data/image-attempts.json', JSON.stringify(sorted,null,1)+'\n');
  console.log(Object.keys(sorted).length,'wines seeded as already imported');
})();
"
```

Expected: a count in the hundreds (about 560 — the verified real images already staged and imported).

- [ ] **Step 6: Commit**

```bash
git add tools/labelfetch/attempts.mjs tests/unit/attempts.test.js data/image-attempts.json
git commit -m "labelfetch: per-SKU image attempt ledger with a 30-day retry backoff"
```

---

## Task 5: Make the image pipeline run on Linux

Three things in the Node image pipeline are Windows-only by accident, and all three make it produce **zero** images on `ubuntu-latest`:

1. The Go helpers are invoked as bare `imgcheck.exe` / `imgnorm.exe`, which resolves from the working directory on Windows but not on Linux (cwd is not on `PATH` there).
2. `OPENAI_API_KEY` is read only from a `.env` file, which does not exist in CI.
3. Worst: `imgcheck`'s label read (`tools/imgcheck/main.go:227`) shells out to **PowerShell** (`tools/imgcheck/ocr.ps1`). On Linux that fails, `imgcheck` exits 1 printing nothing to stdout, and `pipeline.mjs`'s `verify()` reports `stage: 'verifier'`. The existing vision second chance only reconsiders a `stage: 'label'` refusal, so it never fires and every candidate is rejected.

The fix for (3) inverts the order: read the label with the vision model **first**, then hand the text to `imgcheck` via `-label`, which skips local OCR entirely. Stage 1 — the single-bottle shape gate — is pure Go and still runs, so **both hard gates remain**: shape is still measured from pixels, and the identity decision still goes through the one tested `match()` in `imgcheck`.

**Files:**
- Create: `tools/labelfetch/env.mjs`
- Create: `tests/unit/env.test.js`
- Modify: `tools/labelfetch/pipeline.mjs:37-70` (imports, flags), `:345-370` (`verifyText`/`verify`), `:379-410` (selection, key), `:418-535` (the candidate loop)
- Modify: `tools/labelfetch/watermarksweep.mjs:26-41`
- Modify: `tools/labelfetch/import.mjs:23-49`
- Modify: `tools/labelfetch/decide.mjs:83`, `tools/labelfetch/reverify.mjs:26`

**Interfaces:**
- Consumes: `loadAttempts`, `isDue`, `recordAttempt`, `saveAttempts`, `LEDGER_PATH` from `tools/labelfetch/attempts.mjs` (Task 4).
- Produces (from `tools/labelfetch/env.mjs`):
  - `export function binPath(name, platform = process.platform, env = process.env)` → string
  - `export async function openaiKey(env = process.env, envPath = '.env')` → `Promise<string>`
  - New `pipeline.mjs` flags: `--vision-first` (read the label with the vision model before `imgcheck`; implies `--vision`), `--due-only` (skip SKUs not due per the attempt ledger).
  - Task 6 invokes exactly these flags from the workflow.

### Part A — `env.mjs`

- [ ] **Step 1: Write the failing test**

`tests/unit/env.test.js`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binPath, openaiKey } from '../../tools/labelfetch/env.mjs';

describe('locating the Go helper binaries', () => {
  test('Windows keeps the .exe name it has always used', () => {
    assert.equal(binPath('imgcheck', 'win32', {}), 'imgcheck.exe');
    assert.equal(binPath('imgnorm', 'win32', {}), 'imgnorm.exe');
  });

  test('Linux gets an explicit ./ prefix', () => {
    // Bare "imgcheck" would not resolve: unlike cmd.exe, a POSIX shell does not
    // search the working directory, so execFile('imgcheck') is ENOENT even with
    // the binary sitting right there.
    assert.equal(binPath('imgcheck', 'linux', {}), './imgcheck');
    assert.equal(binPath('imgnorm', 'darwin', {}), './imgnorm');
  });

  test('an env override wins outright', () => {
    assert.equal(
      binPath('imgcheck', 'linux', { FINEVINES_IMGCHECK_BIN: '/opt/bin/imgcheck' }),
      '/opt/bin/imgcheck'
    );
  });
});

describe('finding the OpenAI key', () => {
  test('the real environment variable wins', async () => {
    assert.equal(await openaiKey({ OPENAI_API_KEY: 'sk-from-env' }, '/nonexistent'), 'sk-from-env');
  });

  test('falls back to .env so a workstation keeps working unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'env-'));
    const path = join(dir, '.env');
    await writeFile(path, 'FINEVINES_GA_ID=G-X\nOPENAI_API_KEY=sk-from-file\n');
    assert.equal(await openaiKey({}, path), 'sk-from-file');
  });

  test('no key anywhere is an empty string, not a throw', async () => {
    // The caller decides whether a missing key is fatal — the fetch pipeline
    // runs without vision at a lower recovery rate, the watermark sweep cannot.
    assert.equal(await openaiKey({}, '/nonexistent'), '');
  });

  test('surrounding whitespace is trimmed from both sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'env-'));
    const path = join(dir, '.env');
    await writeFile(path, 'OPENAI_API_KEY=  sk-padded  \n');
    assert.equal(await openaiKey({}, path), 'sk-padded');
    assert.equal(await openaiKey({ OPENAI_API_KEY: ' sk-padded ' }, path), 'sk-padded');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/env.test.js`
Expected: FAIL — `Cannot find module ...tools/labelfetch/env.mjs`.

- [ ] **Step 3: Write the implementation**

`tools/labelfetch/env.mjs`:

```js
// Where the Node image pipeline finds the two things it needs from its
// environment: the Go helper binaries, and the OpenAI key.
//
// Both were Windows-only by accident rather than by design, and both silently
// produced zero images on Linux. The binaries were invoked as bare
// "imgcheck.exe", which cmd.exe resolves from the working directory and a POSIX
// shell does not; the key was read only out of .env, a file that does not exist
// in CI, where secrets arrive as environment variables. Resolved here, once, so
// the same commands run on a workstation and on ubuntu-latest.
import { readFile } from 'node:fs/promises';

// binPath resolves a Go helper built into the repo root.
//
// FINEVINES_<NAME>_BIN overrides it outright, for a CI job that builds
// elsewhere or a cross-build. Otherwise: the historical .exe name on Windows,
// and an explicit ./ prefix everywhere else, because execFile does not search
// the working directory on POSIX and would report ENOENT with the binary
// sitting right next to it.
export function binPath(name, platform = process.platform, env = process.env) {
  const override = env[`FINEVINES_${name.toUpperCase()}_BIN`];
  if (override) return override;
  return platform === 'win32' ? `${name}.exe` : `./${name}`;
}

// openaiKey prefers the real environment variable and falls back to .env, so a
// workstation keeps working with no changes and CI needs no .env file at all.
// A missing key is an empty string, not a throw: the fetch pipeline runs without
// vision at a lower recovery rate, while the watermark sweep cannot — so the
// caller, not this function, decides whether absence is fatal.
export async function openaiKey(env = process.env, envPath = '.env') {
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY.trim();
  try {
    return (await readFile(envPath, 'utf8')).match(/^OPENAI_API_KEY=(.*)$/m)?.[1]?.trim() || '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/env.test.js`
Expected: PASS — `# pass 7`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add tools/labelfetch/env.mjs tests/unit/env.test.js
git commit -m "labelfetch: resolve helper binaries and the OpenAI key per-platform"
```

### Part B — adopt it, and add vision-first label reading

- [ ] **Step 6: Replace the hardcoded binary names and key reads**

In `tools/labelfetch/pipeline.mjs`, add to the import block (after the `match.mjs` import on line 39):

```js
import { binPath, openaiKey } from './env.mjs';
import { loadAttempts, isDue, recordAttempt, saveAttempts } from './attempts.mjs';
```

Replace line 49:

```js
const VERIFIER = binPath('imgcheck');
```

Replace lines 397–404 (the `--vision` key block) with:

```js
if (USE_VISION) {
  VISION_KEY = await openaiKey();
  if (!VISION_KEY) {
    console.error('--vision needs OPENAI_API_KEY in the environment or .env');
    process.exit(2);
  }
  console.log(`vision label reading: ${VISION_MODEL}${VISION_FIRST ? ' (first, local OCR skipped)' : ' (fallback)'}`);
}
```

In `tools/labelfetch/watermarksweep.mjs`, replace lines 26 and 37:

```js
import { parseVerdict, flagWatermark, isWatermarked } from './watermark.mjs';
import { openaiKey } from './env.mjs';
```

```js
const KEY = await openaiKey();
if (!KEY) {
  console.error('needs OPENAI_API_KEY in the environment or .env');
  process.exit(2);
}
```

In `tools/labelfetch/import.mjs`, replace line 33 and add the import:

```js
import { shouldImport } from './importrules.mjs';
import { binPath } from './env.mjs';
import { loadAttempts, recordAttempt, saveAttempts } from './attempts.mjs';
```

```js
const NORMALIZER = binPath('imgnorm');
```

In `tools/labelfetch/decide.mjs:83` and `tools/labelfetch/reverify.mjs:26`, replace the literal `'imgcheck.exe'` with `VERIFIER`, and add to each file's imports:

```js
import { binPath } from './env.mjs';
const VERIFIER = binPath('imgcheck');
```

- [ ] **Step 7: Add the `--vision-first` and `--due-only` flags**

In `tools/labelfetch/pipeline.mjs`, replace lines 68–70:

```js
// Vision label reading is opt-in: the pipeline runs without an API key, just at
// a lower recovery rate.
//
// --vision-first is what makes the pipeline work on Linux AT ALL. imgcheck's
// stage-2 label read shells out to the Windows OCR engine
// (tools/imgcheck/ocr.ps1), so on ubuntu-latest it exits 1 printing nothing,
// verify() reports stage 'verifier', and the vision second chance below never
// fires because it only reconsiders a 'label' refusal. Reading the label with
// the vision model FIRST and passing the text to imgcheck via -label skips
// local OCR entirely.
//
// Both hard gates survive that inversion. -single-bottle is still NOT passed
// (see verifyText), so stage 1 — the shape check, pure Go — still decides from
// pixels whether this is one bottle on a sweep; and the identity decision still
// goes through the one tested match() inside imgcheck rather than being taken on
// the model's word.
const VISION_FIRST = has('vision-first');
const USE_VISION = has('vision') || VISION_FIRST;
const VISION_MODEL = opt('vision-model', 'gpt-4.1-nano');
// --due-only consults the committed attempt ledger so a nightly run does not
// re-search the ~1,700 wines that have already been looked for and not found.
const DUE_ONLY = has('due-only');
```

- [ ] **Step 8: Filter the selection by the ledger and record every attempt**

In `tools/labelfetch/pipeline.mjs`, in the selection block, insert after line 384 (`if (has('missing')) ...`):

```js
  if (DUE_ONLY) {
    const before = wines.length;
    wines = wines.filter((w) => isDue(attempts, w.sku));
    console.log(`due per the attempt ledger: ${wines.length} of ${before} imageless wines`);
  }
```

and load the ledger just above the selection block (after line 378's `wines = JSON.parse(...)`):

```js
const attempts = await loadAttempts();
```

Then, in the per-wine loop, immediately after `manifest[w.slug] = rec;` (line 527), record the attempt:

```js
  // Record the attempt as a MISS regardless of how the fetch went. import.mjs
  // upgrades the ones it actually writes to 'imported' afterwards. Recording
  // pessimistically first is deliberate: a run that dies between fetch and
  // import still leaves the attempt on record, so the next night does not
  // re-burn the same search.
  if (w.sku) {
    recordAttempt(attempts, w.sku, 'miss');
    await saveAttempts(attempts);
  }
```

- [ ] **Step 9: Add the vision-first branch to the candidate loop**

In `tools/labelfetch/pipeline.mjs`, replace line 451 (`const v = await verify(dest, name, w.producer);`) with:

```js
      const v = VISION_FIRST
        ? await verifyVisionFirst(dest, name, w.producer)
        : await verify(dest, name, w.producer);
```

and add, next to `verify` (after line 370):

```js
// verifyVisionFirst reads the label with the vision model and then applies the
// SAME identity rules through the same binary, returning a verdict shaped
// exactly like verify()'s so the calling loop needs no other change.
//
// It is the only path that works on Linux (see VISION_FIRST above). Note what it
// does NOT do: it does not pass -single-bottle, so the local shape gate still
// runs and can still refuse; and it does not let the model decide identity, only
// read the text. An empty or near-empty read is a refusal, not a pass — a wine
// was once accepted on a photograph of grapes because a blank string was allowed
// through here.
async function verifyVisionFirst(file, name, producer) {
  const text = await readLabel(file);
  if (!text || text.trim().length < 3) {
    return { accept: false, stage: 'label', label: text || '', reason: 'nothing legible on the label' };
  }
  const ok = await verifyText(file, name, producer, text);
  return ok
    ? { accept: true, stage: 'label', label: text, verifiedBy: VISION_MODEL }
    : { accept: false, stage: 'label', label: text, reason: 'the label does not name this wine' };
}
```

Then, in the accept branch (after line 462's `accepted++;`), record which path verified it:

```js
        if (VISION_FIRST) rec.verifiedBy = VISION_MODEL;
```

and guard the existing second-chance block so it does not double-charge in vision-first mode — replace line 466's condition:

```js
      // The second chance only exists for the local-OCR path; in vision-first
      // mode the model has already read the label, so re-reading it would just
      // pay twice for the same answer.
      if (USE_VISION && !VISION_FIRST && v.stage !== 'decode') {
```

- [ ] **Step 10: Record `imported` outcomes in `import.mjs`**

In `tools/labelfetch/import.mjs`, load the ledger after line 57 (`const bySlug = ...`):

```js
const attempts = await loadAttempts();
```

In the loop, after line 119's closing brace of the `if (apply)` block and before the `console.log`, add:

```js
    if (rec.sku ?? wine.sku) recordAttempt(attempts, rec.sku ?? wine.sku, 'imported');
```

and in the final write block (line 125), persist it:

```js
if (apply && changed) {
  await writeFile(WINES, JSON.stringify(wines, null, 1) + '\n');
  await saveAttempts(attempts);
  console.log(`\nwrote ${changed} images to ${IMG_DIR}/ and updated ${WINES}`);
}
```

- [ ] **Step 11: Run the full Node unit suite**

Run: `npm run test:unit`
Expected: `# fail 0` — the new `env`/`attempts` suites plus the pre-existing `engine`, `importrules`, `match`, `sources`, `watermark` suites.

- [ ] **Step 12: Verify the flags parse and the ledger filter fires, without spending anything**

Run (Windows workstation; `--n 1` samples a single wine, so this costs at most one search and one vision call):

```bash
go build -o imgcheck.exe ./tools/imgcheck
node tools/labelfetch/pipeline.mjs --missing --due-only --n 1
```

Expected: a `due per the attempt ledger: N of M imageless wines` line, then one wine attempted or `no wines selected` if the seeded ledger covers it. Confirm `data/image-attempts.json` gained or refreshed exactly one entry: `git diff --stat data/image-attempts.json`.

- [ ] **Step 13: Commit**

```bash
git add tools/labelfetch/pipeline.mjs tools/labelfetch/watermarksweep.mjs tools/labelfetch/import.mjs tools/labelfetch/decide.mjs tools/labelfetch/reverify.mjs
git commit -m "labelfetch: vision-first label reading and ledger-driven selection so the image stage runs on Linux"
```

---

## Task 6: CI image stage

Wire the pieces into an ordered stage the workflow can call: fetch and verify only the wines that are both imageless and due, sweep every staged image for a burned-in watermark, then import the survivors. Both verification stages are hard gates with no override.

**Files:**
- Create: `tools/labelfetch/cistage.sh`
- Modify: `docs/image-pipeline.md`

**Interfaces:**
- Consumes: `binPath`/`openaiKey` (Task 5 Part A); the `--vision-first`/`--due-only` flags and ledger recording (Task 5 Part B); `data/image-attempts.json` (Task 4).
- Produces: `tools/labelfetch/cistage.sh`, invoked by Task 8's workflow as `bash tools/labelfetch/cistage.sh`. Requires `OPENAI_API_KEY` in the environment. Exits non-zero if any stage fails, so the workflow aborts before deploy.

- [ ] **Step 1: Write the stage script**

`tools/labelfetch/cistage.sh`:

```bash
#!/usr/bin/env bash
# The nightly image stage, in the one order that is safe.
#
#   fetch + verify  ->  watermark sweep  ->  import survivors
#
# Both verification stages are HARD GATES with no override path (design spec §A
# step 3). An image that fails the shape check or whose label does not name the
# wine never reaches the manifest as ok; an image carrying a Vivino or stock
# watermark is flagged on the manifest and importrules.mjs refuses it
# unconditionally, even if every other signal is clean.
#
# The sweep MUST run between fetch and import, not after it. The host gate
# cannot catch a re-hosted copy — clean retailer hosts have served images with
# Vivino's mark burned into the pixels — so the sweep is the only thing standing
# between a watermarked file and the public site, and once import has written it
# to assets/img/wines/ the horse has left.
set -euo pipefail

# Fail loudly rather than silently sourcing no images: every stage here needs the
# vision model, and a missing key would otherwise look like "no images found".
: "${OPENAI_API_KEY:?the image stage needs OPENAI_API_KEY}"

echo "::group::Build the image helpers"
go build -o imgcheck ./tools/imgcheck
go build -o imgnorm ./tools/imgnorm
echo "::endgroup::"

echo "::group::Fetch and verify (imageless + due only)"
# --missing     : only wines still on the SVG label fallback
# --due-only    : and only those the attempt ledger says are due (30-day backoff)
# --all         : no sampling — the whole due set
# --vision-first: read the label with the vision model, then apply imgcheck's
#                 identity rules to that text. Required on Linux: imgcheck's
#                 local OCR is a PowerShell shell-out (tools/imgcheck/ocr.ps1).
node tools/labelfetch/pipeline.mjs --all --missing --due-only --vision-first
echo "::endgroup::"

echo "::group::Watermark sweep (hard gate)"
# --apply records each verdict on the manifest record: a hit becomes a watermark
# flag import refuses, a clean becomes watermarkSwept so a re-run does not pay
# for it twice.
node tools/labelfetch/watermarksweep.mjs --apply
echo "::endgroup::"

echo "::group::Import survivors"
# NOT --clean-only. Review flags ("low resolution", "vintage on label is 2019")
# are informational, not gates, and in CI there is no human to clear them — so
# holding flagged-but-verified images back would mean they never publish at all.
# The digest email lists every newly imported image with its flags so a reader
# can catch a bad one, and the console can swap it. This is the risk Joel
# accepted on 2026-07-29 (spec §Risks 1), recorded here so it is not re-decided
# by accident.
node tools/labelfetch/import.mjs --apply
echo "::endgroup::"

echo "image stage complete"
```

- [ ] **Step 2: Make it executable and verify it is committed as such**

```bash
git update-index --chmod=+x tools/labelfetch/cistage.sh
```

- [ ] **Step 3: Verify the script's syntax**

Run: `bash -n tools/labelfetch/cistage.sh`
Expected: no output, exit 0.

- [ ] **Step 4: Verify the guard fires when the key is absent**

Run: `env -u OPENAI_API_KEY bash tools/labelfetch/cistage.sh`
Expected: `tools/labelfetch/cistage.sh: line NN: OPENAI_API_KEY: the image stage needs OPENAI_API_KEY`, exit 1. Nothing is built, fetched or written.

- [ ] **Step 5: Document the stage**

Append to `docs/image-pipeline.md`:

```markdown
## Running unattended (GitHub Actions)

`tools/labelfetch/cistage.sh` is the nightly form of the whole loop, called by
`.github/workflows/pipeline.yml`. It differs from the hand-driven sequence in
three ways, all of them deliberate:

- **It only looks at wines that are due.** `data/image-attempts.json` records a
  per-SKU `lastAttempted`, so a wine whose photograph is not on the open web is
  re-searched after 30 days rather than every night. See
  `tools/labelfetch/attempts.mjs`.
- **The label is read by the vision model first**, not by local OCR.
  `imgcheck`'s OCR is a PowerShell shell-out and does not exist on Linux;
  `--vision-first` reads the label with `gpt-4.1-nano` and passes the text to
  `imgcheck -label`. The single-bottle shape gate and the identity match are
  unchanged, so both hard gates still apply.
- **There is no human review step.** `import.mjs` runs without `--clean-only`,
  so an image that passed both hard gates is published even if it still carries
  an informational review flag. Every newly imported image appears in the digest
  email with its flags; a wrong one is corrected through the review console, not
  by holding the whole batch back.

Nothing else changes: the watermark sweep still runs between fetch and import,
and a watermarked image is still never importable by any path.
```

- [ ] **Step 6: Commit**

```bash
git add tools/labelfetch/cistage.sh docs/image-pipeline.md
git commit -m "labelfetch: the unattended CI image stage, gates in the safe order"
```

---

## Task 7: `finevines notify`

The digest is the only thing that closes the loop while the console does not exist yet: images now publish themselves, so the email is what tells a human which ones to look at. It is sent **only when the run changed something** — a nightly run that found nothing new must be silent, or it stops being read within a fortnight.

The assembly is a pure function over two catalog snapshots. The send is behind a one-method interface so no test ever posts to Postmark.

**Files:**
- Create: `internal/notify/diff.go`
- Create: `internal/notify/diff_test.go`
- Create: `internal/notify/render.go`
- Create: `internal/notify/render_test.go`
- Create: `internal/notify/postmark.go`
- Create: `internal/notify/postmark_test.go`
- Create: `cmd/finevines/notify.go`
- Modify: `internal/config/config.go:11-25` (three fields), `:49-70` (three `get` calls)
- Modify: `internal/config/config_test.go`
- Modify: `cmd/finevines/main.go:34-48` (dispatch)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `queue.Applied` and the run log `.run/queue-applied.json` (Task 3); `model.LoadWines(path string) ([]model.Wine, error)`; `config.Load`.
- Produces:
  - `cfg.PostmarkToken`, `cfg.NotifyTo`, `cfg.NotifyFrom` on `config.Config`
  - `type notify.WineRef struct { SKU, Slug, Producer, Name, Vintage, URL, ImageURL, Note string }`
  - `type notify.Coverage struct { Wines, RealImages, RealImagePct, MeanMetadata int }`
  - `type notify.RunDiff struct { NewWines, Delisted, TextRefreshed, NewImages []WineRef; QueueActions []queue.Applied; Coverage Coverage }`
  - `func (d notify.RunDiff) Changed() bool`
  - `func notify.Diff(before, after []model.Wine, applied []queue.Applied, siteBaseURL string) notify.RunDiff`
  - `type notify.Message struct { Subject, HTMLBody, TextBody string }`
  - `func notify.Render(d notify.RunDiff, siteBaseURL string) notify.Message`
  - `type notify.Sender interface { Send(ctx context.Context, from string, to []string, m Message) error }`
  - `func notify.NewPostmarkSender(token string, hc *http.Client) *notify.PostmarkSender`
  - `func notify.Recipients(csv string) []string`

### Part A — `Diff`

- [ ] **Step 1: Write the failing test**

`internal/notify/diff_test.go`:

```go
package notify

import (
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/queue"
)

const base = "https://finevines.com"

func wine(sku, slug string, mods ...func(*model.Wine)) model.Wine {
	w := model.Wine{
		ID: sku, SKU: sku, Slug: slug, Producer: "Domaine Bart",
		Name: "Marsannay La Montagne", Vintage: "2019",
		Description: "Old prose.", EnrichedAt: "2026-07-01T00:00:00Z",
		ImagePath: "assets/img/wines/" + slug + ".svg", ImageSource: model.ImageGeneratedLabel,
		MetadataScore: 40,
	}
	for _, m := range mods {
		m(&w)
	}
	return w
}

func TestDiff_NewWineIsListedWithAnAbsoluteLink(t *testing.T) {
	after := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019")}
	d := Diff(nil, after, nil, base)

	if len(d.NewWines) != 1 {
		t.Fatalf("NewWines = %d, want 1", len(d.NewWines))
	}
	got := d.NewWines[0]
	if got.URL != "https://finevines.com/wines/bart-marsannay-la-montagne-2019/" {
		t.Errorf("URL = %q", got.URL)
	}
	if got.Producer != "Domaine Bart" || got.Vintage != "2019" {
		t.Errorf("WineRef = %+v", got)
	}
	if !d.Changed() {
		t.Error("Changed() = false with a new wine")
	}
}

func TestDiff_DelistingCoversBothGoingUnavailableAndDisappearing(t *testing.T) {
	before := []model.Wine{
		wine("AB1201", "bart-marsannay-la-montagne-2019"),
		wine("MB5110", "brezza-langhe-chardonnay-2021"),
	}
	after := []model.Wine{
		wine("AB1201", "bart-marsannay-la-montagne-2019", func(w *model.Wine) {
			w.Status = model.StatusUnavailable
		}),
		// MB5110 is gone from the catalog entirely — past its delisting grace.
	}
	d := Diff(before, after, nil, base)

	if len(d.Delisted) != 2 {
		t.Fatalf("Delisted = %d entries, want 2 (one unavailable, one dropped)", len(d.Delisted))
	}
	bySKU := map[string]WineRef{}
	for _, r := range d.Delisted {
		bySKU[r.SKU] = r
	}
	if bySKU["AB1201"].Note != "out of stock, page kept" {
		t.Errorf("AB1201 note = %q", bySKU["AB1201"].Note)
	}
	if bySKU["MB5110"].Note != "removed from the catalog" {
		t.Errorf("MB5110 note = %q", bySKU["MB5110"].Note)
	}
}

func TestDiff_TextRefreshNeedsBothANewTimestampAndNewProse(t *testing.T) {
	before := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019")}

	// Prose changed and the timestamp moved: a real refresh.
	refreshed := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019", func(w *model.Wine) {
		w.Description = "Steely and unoaked."
		w.EnrichedAt = "2026-07-29T08:15:00Z"
	})}
	if d := Diff(before, refreshed, nil, base); len(d.TextRefreshed) != 1 {
		t.Errorf("TextRefreshed = %d, want 1", len(d.TextRefreshed))
	}

	// The timestamp moved but the prose is identical — a re-enrich that landed on
	// the same words. Reporting it would fill the digest with non-events.
	restamped := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019", func(w *model.Wine) {
		w.EnrichedAt = "2026-07-29T08:15:00Z"
	})}
	if d := Diff(before, restamped, nil, base); len(d.TextRefreshed) != 0 {
		t.Errorf("TextRefreshed = %d for an identical re-enrich, want 0", len(d.TextRefreshed))
	}
}

func TestDiff_NewImageIsAPhotographReplacingALabel(t *testing.T) {
	before := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019")}
	after := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019", func(w *model.Wine) {
		w.ImagePath = "assets/img/wines/bart-marsannay-la-montagne-2019.jpg"
		w.ImageSource = model.ImageScrapedWeb
		w.ImageSourceURL = "https://example-producer.fr/vins/"
	})}
	d := Diff(before, after, nil, base)

	if len(d.NewImages) != 1 {
		t.Fatalf("NewImages = %d, want 1", len(d.NewImages))
	}
	got := d.NewImages[0]
	// The thumbnail has to be an absolute URL: it is rendered inside an email
	// client, which has no page to be relative to.
	if got.ImageURL != "https://finevines.com/assets/img/wines/bart-marsannay-la-montagne-2019.jpg" {
		t.Errorf("ImageURL = %q", got.ImageURL)
	}
	if got.Note != "https://example-producer.fr/vins/" {
		t.Errorf("Note = %q — the digest must show where the photograph came from", got.Note)
	}
}

// A wine already holding a photograph that gets a DIFFERENT photograph (a
// console swap) is a new image too — the reviewer needs to see the result of
// their own click.
func TestDiff_ASwappedPhotographCountsAsANewImage(t *testing.T) {
	before := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019", func(w *model.Wine) {
		w.ImagePath = "assets/img/wines/bart-marsannay-la-montagne-2019.jpg"
		w.ImageSource = model.ImageScrapedWeb
		w.ImageSourceURL = "https://old-source.example/"
	})}
	after := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019", func(w *model.Wine) {
		w.ImagePath = "assets/img/wines/bart-marsannay-la-montagne-2019.jpg"
		w.ImageSource = model.ImageScrapedWeb
		w.ImageSourceURL = "https://example-producer.fr/vins/"
	})}
	if d := Diff(before, after, nil, base); len(d.NewImages) != 1 {
		t.Errorf("NewImages = %d for a swapped photograph, want 1", len(d.NewImages))
	}
}

func TestDiff_CoverageIsComputedOverTheFinalCatalog(t *testing.T) {
	after := []model.Wine{
		wine("A", "a", func(w *model.Wine) {
			w.ImagePath, w.ImageSource, w.MetadataScore = "assets/img/wines/a.jpg", model.ImageScrapedWeb, 80
		}),
		wine("B", "b", func(w *model.Wine) { w.MetadataScore = 40 }),
		wine("C", "c", func(w *model.Wine) { w.MetadataScore = 30 }),
		wine("D", "d", func(w *model.Wine) {
			w.ImagePath, w.ImageSource, w.MetadataScore = "assets/img/wines/d.jpg", model.ImageOldSite, 90
		}),
	}
	d := Diff(nil, after, nil, base)
	if d.Coverage.Wines != 4 {
		t.Errorf("Coverage.Wines = %d, want 4", d.Coverage.Wines)
	}
	if d.Coverage.RealImages != 2 || d.Coverage.RealImagePct != 50 {
		t.Errorf("Coverage images = %d (%d%%), want 2 (50%%)", d.Coverage.RealImages, d.Coverage.RealImagePct)
	}
	if d.Coverage.MeanMetadata != 60 { // (80+40+30+90)/4
		t.Errorf("Coverage.MeanMetadata = %d, want 60", d.Coverage.MeanMetadata)
	}
}

// A run that only drained the queue still changed something.
func TestDiff_QueueActionsAloneCountAsAChange(t *testing.T) {
	same := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019")}
	d := Diff(same, same, []queue.Applied{
		{ID: "a3", SKU: "AB1201", Kind: queue.ActionFlag, Reviewer: "george", Outcome: "flagged"},
	}, base)
	if !d.Changed() {
		t.Error("Changed() = false with a queue action applied")
	}
}

// The silence guarantee: an unchanged nightly run must produce no email at all.
func TestDiff_AnUnchangedRunHasNotChanged(t *testing.T) {
	same := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019")}
	if Diff(same, same, nil, base).Changed() {
		t.Error("Changed() = true for an identical before/after — the digest would be sent every night")
	}
}

// A trailing slash on the configured base URL must not double up in the links.
func TestDiff_BaseURLTrailingSlashIsTolerated(t *testing.T) {
	after := []model.Wine{wine("AB1201", "bart-marsannay-la-montagne-2019")}
	d := Diff(nil, after, nil, "https://finevines.com/")
	if d.NewWines[0].URL != "https://finevines.com/wines/bart-marsannay-la-montagne-2019/" {
		t.Errorf("URL = %q", d.NewWines[0].URL)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/notify/ -v`
Expected: FAIL — `no Go files in ...internal/notify`.

- [ ] **Step 3: Write the implementation**

`internal/notify/diff.go`:

```go
// Package notify turns one pipeline run into the digest email that closes the
// loop on it.
//
// Images now publish themselves behind two automated gates, which means the
// email is the only thing standing between a wrong bottle going live and a human
// noticing. So the digest has one job: say what changed, link to it, and be
// short enough that it is still being read in six months. That last constraint
// is why Diff is fussy about what counts as a change — a re-enrich that landed
// on the same words, or a nightly run that found nothing, must produce NOTHING,
// because a digest that arrives every night saying "no changes" is a digest
// nobody opens.
//
// Diff and Render are pure functions over two catalog snapshots. Only
// PostmarkSender touches the network, behind the Sender interface, so no test
// ever sends mail.
package notify

import (
	"math"
	"strings"

	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/queue"
)

// WineRef is one wine as the digest names it: enough to recognise, plus the two
// absolute URLs an email client needs (it has no page to be relative to).
//
// Note is the per-list reason the wine is here — why it was delisted, where its
// new photograph came from — rather than a field of the wine itself.
type WineRef struct {
	SKU      string
	Slug     string
	Producer string
	Name     string
	Vintage  string
	URL      string
	ImageURL string
	Note     string
}

// Coverage is the catalog-health line the client actually asked for: how much of
// the portfolio has a real photograph, and how much of the displayed metadata
// was sourced rather than inferred.
type Coverage struct {
	Wines        int
	RealImages   int
	RealImagePct int
	MeanMetadata int
}

// RunDiff is everything one digest reports.
type RunDiff struct {
	NewWines      []WineRef
	Delisted      []WineRef
	TextRefreshed []WineRef
	NewImages     []WineRef
	QueueActions  []queue.Applied
	Coverage      Coverage
}

// Changed reports whether this run altered anything worth an email. Coverage is
// deliberately NOT part of the test: it is computed over the whole catalog every
// run and drifts by a fraction of a percent on its own, which would make every
// run look like a change.
func (d RunDiff) Changed() bool {
	return len(d.NewWines) > 0 || len(d.Delisted) > 0 || len(d.TextRefreshed) > 0 ||
		len(d.NewImages) > 0 || len(d.QueueActions) > 0
}

// Diff compares the catalog as it stood at the start of the run against the
// catalog the run produced.
//
// Keyed by ID (the Salesforce record ID), not slug: a slug changes when a wine
// is renamed or re-vintaged, and a slug-keyed diff would report one rename as a
// delisting plus a brand-new wine.
func Diff(before, after []model.Wine, applied []queue.Applied, siteBaseURL string) RunDiff {
	root := strings.TrimRight(siteBaseURL, "/")

	beforeByID := make(map[string]model.Wine, len(before))
	for _, w := range before {
		beforeByID[w.ID] = w
	}
	afterByID := make(map[string]model.Wine, len(after))
	for _, w := range after {
		afterByID[w.ID] = w
	}

	d := RunDiff{QueueActions: applied}

	for _, w := range after {
		prev, existed := beforeByID[w.ID]
		if !existed {
			d.NewWines = append(d.NewWines, ref(root, w, ""))
			continue
		}
		// Going unavailable: the page stays published (preserving its search
		// ranking) but the wine leaves the portfolio, so it is worth reporting.
		if prev.Status != model.StatusUnavailable && w.Status == model.StatusUnavailable {
			d.Delisted = append(d.Delisted, ref(root, w, "out of stock, page kept"))
		}
		// A text refresh needs BOTH a moved timestamp and different prose. The
		// timestamp alone moves on every successful re-enrich, including ones
		// that produce the identical paragraph, and those are not news.
		if prev.EnrichedAt != w.EnrichedAt && proseChanged(prev, w) {
			d.TextRefreshed = append(d.TextRefreshed, ref(root, w, ""))
		}
		// A new image is any real photograph the wine did not have in this exact
		// form before: a first photo replacing the SVG label, or a console swap
		// replacing one photo with another. The reviewer who clicked swap needs
		// to see the result of their own click.
		if isPhoto(w) && (prev.ImagePath != w.ImagePath || prev.ImageSourceURL != w.ImageSourceURL) {
			d.NewImages = append(d.NewImages, ref(root, w, w.ImageSourceURL))
		}
	}

	// Wines that left the catalog entirely — past the delisting grace period, or
	// withheld on purpose. There is no `after` record to link to, so the
	// reference is built from the `before` one; the URL 301s to /portfolio/ via
	// the lifecycle redirect map.
	for _, w := range before {
		if _, still := afterByID[w.ID]; !still {
			d.Delisted = append(d.Delisted, ref(root, w, "removed from the catalog"))
		}
	}

	d.Coverage = coverageOf(after)
	return d
}

// proseChanged reports whether any of the written fields actually differ. Kept
// separate from the timestamp test so "re-enriched" and "re-enriched to
// something new" stay distinguishable.
func proseChanged(a, b model.Wine) bool {
	return a.Description != b.Description ||
		a.SommelierNotes != b.SommelierNotes ||
		a.Aroma != b.Aroma || a.Palate != b.Palate || a.Finish != b.Finish ||
		strings.Join(a.FoodPairings, "|") != strings.Join(b.FoodPairings, "|")
}

// isPhoto reports whether the wine's image is a real photograph rather than the
// generated SVG label or an AI-generated bottle. It reuses
// model.ImageFieldSource so this can never drift from how the coverage score
// classifies the same value.
func isPhoto(w model.Wine) bool {
	return model.ImageFieldSource(w.ImageSource) == model.SourceFound
}

func coverageOf(wines []model.Wine) Coverage {
	c := Coverage{Wines: len(wines)}
	if len(wines) == 0 {
		return c
	}
	sum := 0
	for _, w := range wines {
		sum += w.MetadataScore
		if isPhoto(w) {
			c.RealImages++
		}
	}
	c.RealImagePct = int(math.Round(100 * float64(c.RealImages) / float64(len(wines))))
	c.MeanMetadata = int(math.Round(float64(sum) / float64(len(wines))))
	return c
}

// ref builds a WineRef with both absolute URLs. The image URL is left empty for
// a wine on the SVG label: an email client rendering a vector label at thumbnail
// size adds nothing a reader can judge.
func ref(root string, w model.Wine, note string) WineRef {
	r := WineRef{
		SKU: w.SKU, Slug: w.Slug, Producer: w.Producer, Name: w.Name,
		Vintage: w.Vintage, URL: root + "/wines/" + w.Slug + "/", Note: note,
	}
	if isPhoto(w) && w.ImagePath != "" {
		r.ImageURL = root + "/" + strings.TrimPrefix(w.ImagePath, "/")
	}
	return r
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/notify/ -v`
Expected: PASS — nine `--- PASS` lines.

- [ ] **Step 5: Commit**

```bash
git add internal/notify/diff.go internal/notify/diff_test.go
git commit -m "notify: assemble a run diff from two catalog snapshots"
```

### Part B — `Render`

- [ ] **Step 6: Write the failing test**

`internal/notify/render_test.go`:

```go
package notify

import (
	"strings"
	"testing"

	"github.com/gritautomation/finevines-website/internal/queue"
)

func sampleDiff() RunDiff {
	return RunDiff{
		NewWines: []WineRef{
			{SKU: "AB1201", Producer: "Domaine Bart", Name: "Marsannay La Montagne", Vintage: "2019",
				URL: "https://finevines.com/wines/bart-marsannay-la-montagne-2019/"},
		},
		Delisted: []WineRef{
			{SKU: "MB5110", Producer: "Brezza", Name: "Langhe Chardonnay", Vintage: "2021",
				URL: "https://finevines.com/wines/brezza-langhe-chardonnay-2021/", Note: "out of stock, page kept"},
		},
		NewImages: []WineRef{
			{SKU: "PM5030", Producer: "Altocedro", Name: "Ano Cero Malbec", Vintage: "2024",
				URL:      "https://finevines.com/wines/altocedro-ano-cero-malbec-2024/",
				ImageURL: "https://finevines.com/assets/img/wines/altocedro-ano-cero-malbec-2024.jpg",
				Note:     "https://example-producer.ar/vinos/"},
		},
		QueueActions: []queue.Applied{
			{ID: "a2", SKU: "MB5110", Kind: queue.ActionTextFeedback, Reviewer: "george",
				Outcome: "text regenerated with the reviewer's note"},
		},
		Coverage: Coverage{Wines: 2210, RealImages: 574, RealImagePct: 26, MeanMetadata: 61},
	}
}

func TestRender_SubjectCountsWhatChanged(t *testing.T) {
	m := Render(sampleDiff(), "https://finevines.com")
	if !strings.HasPrefix(m.Subject, "Fine Vines catalog") {
		t.Errorf("Subject = %q, want it to open with the catalog name", m.Subject)
	}
	for _, want := range []string{"1 new wine", "1 delisting", "1 new photograph"} {
		if !strings.Contains(m.Subject, want) {
			t.Errorf("Subject %q is missing %q", m.Subject, want)
		}
	}
}

func TestRender_SubjectPluralisesAndOmitsEmptyCategories(t *testing.T) {
	d := RunDiff{NewWines: []WineRef{{SKU: "A"}, {SKU: "B"}}}
	m := Render(d, "https://finevines.com")
	if !strings.Contains(m.Subject, "2 new wines") {
		t.Errorf("Subject = %q, want a plural", m.Subject)
	}
	if strings.Contains(m.Subject, "delisting") || strings.Contains(m.Subject, "photograph") {
		t.Errorf("Subject = %q mentions a category with nothing in it", m.Subject)
	}
}

func TestRender_BothBodiesCarryEverySectionAndItsLinks(t *testing.T) {
	m := Render(sampleDiff(), "https://finevines.com")
	for name, body := range map[string]string{"HTMLBody": m.HTMLBody, "TextBody": m.TextBody} {
		for _, want := range []string{
			"Marsannay La Montagne",
			"https://finevines.com/wines/bart-marsannay-la-montagne-2019/",
			"Langhe Chardonnay",
			"out of stock, page kept",
			"Ano Cero Malbec",
			"https://example-producer.ar/vinos/",
			"george",
			"574",
			"26%",
			"61",
		} {
			if !strings.Contains(body, want) {
				t.Errorf("%s is missing %q", name, want)
			}
		}
	}
	if !strings.Contains(m.HTMLBody, `src="https://finevines.com/assets/img/wines/altocedro-ano-cero-malbec-2024.jpg"`) {
		t.Error("HTMLBody has no thumbnail for the new photograph")
	}
}

// The email is client-facing: George and Barbara read it. Two standing rules
// apply to every word of it, and a test is the only thing that keeps them
// applying as the copy is edited.
func TestRender_ObeysTheClientCopyRules(t *testing.T) {
	m := Render(sampleDiff(), "https://finevines.com")
	for name, body := range map[string]string{
		"Subject": m.Subject, "HTMLBody": m.HTMLBody, "TextBody": m.TextBody,
	} {
		// "trade" is not George's vocabulary (directed 2026-07-29).
		if strings.Contains(strings.ToLower(body), "trade") {
			t.Errorf(`%s uses the word "trade"`, name)
		}
		// No addresses anywhere the client can see (directed 2026-07-29).
		for _, banned := range []string{"P.O. Box", "PO Box", "Fax", "Illinois 60", "IL 60"} {
			if strings.Contains(body, banned) {
				t.Errorf("%s contains %q — no addresses in client-facing copy", name, banned)
			}
		}
	}
}

// Rendering is pure: the same diff must produce byte-identical output, or a
// snapshot test of the email is impossible and a "did anything change" check on
// the digest itself becomes unreliable.
func TestRender_IsDeterministic(t *testing.T) {
	a := Render(sampleDiff(), "https://finevines.com")
	b := Render(sampleDiff(), "https://finevines.com")
	if a != b {
		t.Error("Render is not deterministic for the same RunDiff")
	}
}

// HTML from the catalog has to be escaped: a producer called "Ma & Pa" must not
// break the markup.
func TestRender_EscapesCatalogText(t *testing.T) {
	d := RunDiff{NewWines: []WineRef{{SKU: "X", Producer: "Ma & Pa", Name: `Cuvée "Spéciale" <1>`,
		URL: "https://finevines.com/wines/x/"}}}
	m := Render(d, "https://finevines.com")
	if strings.Contains(m.HTMLBody, "<1>") {
		t.Error("HTMLBody did not escape catalog text")
	}
	if !strings.Contains(m.HTMLBody, "Ma &amp; Pa") {
		t.Error("HTMLBody did not escape the ampersand")
	}
	// The plain-text body must NOT be escaped — it is read as text.
	if !strings.Contains(m.TextBody, "Ma & Pa") {
		t.Error("TextBody escaped text that should stay literal")
	}
}
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `go test ./internal/notify/ -run TestRender -v`
Expected: FAIL — `undefined: Render`, `undefined: Message`.

- [ ] **Step 8: Write the implementation**

`internal/notify/render.go`:

```go
package notify

import (
	"bytes"
	"fmt"
	"html/template"
	"strings"
)

// Message is one rendered digest. Both bodies are always produced: Postmark
// sends whichever the reader's client can display, and the plain-text version is
// also what shows in a notification preview.
type Message struct {
	Subject  string
	HTMLBody string
	TextBody string
}

// Render turns a RunDiff into the email.
//
// Voice: elegant and plain, the same register as the site — this lands in the
// founder's inbox, not a developer's. Two standing client rules are enforced by
// test rather than by care (see TestRender_ObeysTheClientCopyRules): the word
// "trade" never appears, and no address of any kind does.
//
// Deterministic by construction — no clock, no map iteration — so the same run
// always renders the same bytes.
func Render(d RunDiff, siteBaseURL string) Message {
	root := strings.TrimRight(siteBaseURL, "/")
	return Message{
		Subject:  subject(d),
		HTMLBody: renderHTML(d, root),
		TextBody: renderText(d, root),
	}
}

// subject names only the categories that have something in them, so a run that
// only imported photographs does not read as a wine-list change.
func subject(d RunDiff) string {
	var parts []string
	add := func(n int, one, many string) {
		switch {
		case n == 1:
			parts = append(parts, "1 "+one)
		case n > 1:
			parts = append(parts, fmt.Sprintf("%d %s", n, many))
		}
	}
	add(len(d.NewWines), "new wine", "new wines")
	add(len(d.Delisted), "delisting", "delistings")
	add(len(d.NewImages), "new photograph", "new photographs")
	add(len(d.TextRefreshed), "rewritten note", "rewritten notes")
	add(len(d.QueueActions), "review fix applied", "review fixes applied")
	if len(parts) == 0 {
		// Unreachable in practice: runNotify checks Changed() first. Kept honest
		// rather than clever, so a future caller that forgets gets a sane line.
		return "Fine Vines catalog: no changes"
	}
	return "Fine Vines catalog: " + strings.Join(parts, ", ")
}

// digestTmpl is the HTML body. Deliberately table-free, inline-styled and
// image-optional: it has to survive Outlook, and a reader on a phone must be
// able to tap through to a wine page.
var digestTmpl = template.Must(template.New("digest").Parse(`
<div style="font-family:Georgia,'Times New Roman',serif;color:#2b2b2b;max-width:640px">
<p style="font-size:15px;line-height:1.6">Last night's catalog run has finished. Here is what changed on the website, and what is worth a look.</p>
{{if .D.NewWines}}
<h2 style="font-size:17px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #d8d0c4;padding-bottom:6px">New wines</h2>
<ul style="padding-left:18px;line-height:1.7">{{range .D.NewWines}}
<li><a href="{{.URL}}" style="color:#6b1f2a">{{.Producer}}, {{.Name}}{{if .Vintage}} {{.Vintage}}{{end}}</a> <span style="color:#7a7168">({{.SKU}})</span></li>{{end}}
</ul>
{{end}}
{{if .D.NewImages}}
<h2 style="font-size:17px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #d8d0c4;padding-bottom:6px">New bottle photographs</h2>
<p style="font-size:13px;color:#7a7168;line-height:1.6">These published automatically after passing the label check and the watermark sweep. If one shows the wrong bottle, reply and it will be replaced.</p>
{{range .D.NewImages}}
<div style="margin:14px 0">
{{if .ImageURL}}<img src="{{.ImageURL}}" alt="{{.Producer}} {{.Name}}" width="72" style="vertical-align:middle;margin-right:12px;border:1px solid #e4ddd2">{{end}}
<a href="{{.URL}}" style="color:#6b1f2a">{{.Producer}}, {{.Name}}{{if .Vintage}} {{.Vintage}}{{end}}</a>
{{if .Note}}<div style="font-size:12px;color:#7a7168;margin-top:4px">source: {{.Note}}</div>{{end}}
</div>{{end}}
{{end}}
{{if .D.TextRefreshed}}
<h2 style="font-size:17px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #d8d0c4;padding-bottom:6px">Rewritten tasting notes</h2>
<ul style="padding-left:18px;line-height:1.7">{{range .D.TextRefreshed}}
<li><a href="{{.URL}}" style="color:#6b1f2a">{{.Producer}}, {{.Name}}{{if .Vintage}} {{.Vintage}}{{end}}</a></li>{{end}}
</ul>
{{end}}
{{if .D.Delisted}}
<h2 style="font-size:17px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #d8d0c4;padding-bottom:6px">No longer offered</h2>
<ul style="padding-left:18px;line-height:1.7">{{range .D.Delisted}}
<li><a href="{{.URL}}" style="color:#6b1f2a">{{.Producer}}, {{.Name}}{{if .Vintage}} {{.Vintage}}{{end}}</a> <span style="color:#7a7168">— {{.Note}}</span></li>{{end}}
</ul>
{{end}}
{{if .D.QueueActions}}
<h2 style="font-size:17px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #d8d0c4;padding-bottom:6px">Corrections applied</h2>
<ul style="padding-left:18px;line-height:1.7">{{range .D.QueueActions}}
<li>{{.SKU}} — {{.Outcome}} <span style="color:#7a7168">(requested by {{.Reviewer}})</span></li>{{end}}
</ul>
{{end}}
<h2 style="font-size:17px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #d8d0c4;padding-bottom:6px">The portfolio today</h2>
<p style="font-size:15px;line-height:1.7">{{.D.Coverage.Wines}} wines published. {{.D.Coverage.RealImages}} of them ({{.D.Coverage.RealImagePct}}%) show a real bottle photograph; the rest show a printed label until a photograph is found. Sourced detail across the portfolio averages {{.D.Coverage.MeanMetadata}} out of 100.</p>
<p style="font-size:13px;color:#7a7168;line-height:1.6">Sent automatically after a catalog run that changed something. <a href="{{.Root}}/portfolio/" style="color:#6b1f2a">Browse the portfolio</a></p>
</div>
`))

func renderHTML(d RunDiff, root string) string {
	var buf bytes.Buffer
	// The template is a compile-time constant and the data is plain strings, so
	// Execute cannot fail for any reason a caller could act on.
	_ = digestTmpl.Execute(&buf, struct {
		D    RunDiff
		Root string
	}{D: d, Root: root})
	return buf.String()
}

// renderText is the plain-text alternative. Written by hand rather than stripped
// from the HTML: a reader on a text-only client should get something composed,
// not something salvaged.
func renderText(d RunDiff, root string) string {
	var b strings.Builder
	b.WriteString("Last night's catalog run has finished. Here is what changed on the website.\n")

	list := func(heading string, refs []WineRef, withNote bool) {
		if len(refs) == 0 {
			return
		}
		fmt.Fprintf(&b, "\n%s\n%s\n", heading, strings.Repeat("-", len(heading)))
		for _, r := range refs {
			fmt.Fprintf(&b, "  %s, %s", r.Producer, r.Name)
			if r.Vintage != "" {
				fmt.Fprintf(&b, " %s", r.Vintage)
			}
			fmt.Fprintf(&b, " (%s)\n    %s\n", r.SKU, r.URL)
			if withNote && r.Note != "" {
				fmt.Fprintf(&b, "    %s\n", r.Note)
			}
		}
	}
	list("NEW WINES", d.NewWines, false)
	list("NEW BOTTLE PHOTOGRAPHS", d.NewImages, true)
	list("REWRITTEN TASTING NOTES", d.TextRefreshed, false)
	list("NO LONGER OFFERED", d.Delisted, true)

	if len(d.QueueActions) > 0 {
		b.WriteString("\nCORRECTIONS APPLIED\n-------------------\n")
		for _, a := range d.QueueActions {
			fmt.Fprintf(&b, "  %s — %s (requested by %s)\n", a.SKU, a.Outcome, a.Reviewer)
		}
	}

	fmt.Fprintf(&b, "\nTHE PORTFOLIO TODAY\n-------------------\n"+
		"  %d wines published.\n"+
		"  %d (%d%%) show a real bottle photograph; the rest show a printed label.\n"+
		"  Sourced detail averages %d out of 100.\n",
		d.Coverage.Wines, d.Coverage.RealImages, d.Coverage.RealImagePct, d.Coverage.MeanMetadata)
	fmt.Fprintf(&b, "\nSent automatically after a catalog run that changed something.\n%s/portfolio/\n", root)
	return b.String()
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `go test ./internal/notify/ -v`
Expected: PASS — every `TestDiff*` and `TestRender*` case.

- [ ] **Step 10: Commit**

```bash
git add internal/notify/render.go internal/notify/render_test.go
git commit -m "notify: render the digest, in the client's voice, both bodies"
```

### Part C — the Postmark sender

- [ ] **Step 11: Write the failing test**

`internal/notify/postmark_test.go`:

```go
package notify

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestRecipients_SplitsTrimsAndDropsBlanks(t *testing.T) {
	got := Recipients(" george@example.com, barbara@example.com ,,joel@example.com ")
	want := []string{"george@example.com", "barbara@example.com", "joel@example.com"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Recipients = %v, want %v", got, want)
	}
	if n := len(Recipients("  ")); n != 0 {
		t.Errorf("Recipients of blank = %d entries, want 0", n)
	}
}

func TestPostmarkSender_PostsTheDocumentedShape(t *testing.T) {
	var gotToken, gotPath string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken, gotPath = r.Header.Get("X-Postmark-Server-Token"), r.URL.Path
		json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ErrorCode":0,"Message":"OK"}`))
	}))
	defer srv.Close()

	s := NewPostmarkSender("pm-token", srv.Client())
	s.BaseURL = srv.URL
	err := s.Send(context.Background(), "catalog@finevines.biz",
		[]string{"george@example.com", "barbara@example.com"},
		Message{Subject: "Fine Vines catalog: 1 new wine", HTMLBody: "<p>hi</p>", TextBody: "hi"})
	if err != nil {
		t.Fatalf("Send returned error: %v", err)
	}

	if gotPath != "/email" {
		t.Errorf("path = %q, want /email", gotPath)
	}
	if gotToken != "pm-token" {
		t.Errorf("token header = %q", gotToken)
	}
	if body["From"] != "catalog@finevines.biz" {
		t.Errorf("From = %v", body["From"])
	}
	if body["To"] != "george@example.com,barbara@example.com" {
		t.Errorf("To = %v, want the comma-joined list Postmark expects", body["To"])
	}
	if body["Subject"] != "Fine Vines catalog: 1 new wine" || body["HtmlBody"] != "<p>hi</p>" || body["TextBody"] != "hi" {
		t.Errorf("body = %+v", body)
	}
	if body["MessageStream"] != "outbound" {
		t.Errorf("MessageStream = %v, want outbound", body["MessageStream"])
	}
}

// Postmark reports application errors with HTTP 200 and a non-zero ErrorCode —
// an unverified sender signature, most likely. Treating that as success would
// mean silently never delivering the digest.
func TestPostmarkSender_NonZeroErrorCodeIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ErrorCode":400,"Message":"Sender signature not confirmed"}`))
	}))
	defer srv.Close()

	s := NewPostmarkSender("pm-token", srv.Client())
	s.BaseURL = srv.URL
	err := s.Send(context.Background(), "nope@example.com", []string{"a@example.com"}, Message{})
	if err == nil {
		t.Fatal("Send accepted a non-zero ErrorCode")
	}
	if !strings.Contains(err.Error(), "Sender signature not confirmed") {
		t.Errorf("error = %v, want Postmark's own message", err)
	}
}

func TestPostmarkSender_HTTPFailureIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"ErrorCode":10,"Message":"Bad token"}`))
	}))
	defer srv.Close()

	s := NewPostmarkSender("wrong", srv.Client())
	s.BaseURL = srv.URL
	if err := s.Send(context.Background(), "a@example.com", []string{"b@example.com"}, Message{}); err == nil {
		t.Fatal("Send accepted a 401")
	}
}

func TestPostmarkSender_NoRecipientsIsAnError(t *testing.T) {
	s := NewPostmarkSender("pm-token", http.DefaultClient)
	if err := s.Send(context.Background(), "a@example.com", nil, Message{}); err == nil {
		t.Fatal("Send accepted an empty recipient list")
	}
}

var _ Sender = (*PostmarkSender)(nil)
```

- [ ] **Step 12: Run the test to verify it fails**

Run: `go test ./internal/notify/ -run 'Postmark|Recipients' -v`
Expected: FAIL — `undefined: NewPostmarkSender`, `undefined: Recipients`, `undefined: Sender`.

- [ ] **Step 13: Write the implementation**

`internal/notify/postmark.go`:

```go
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// defaultPostmarkBaseURL is Postmark's API host. Stored on the sender rather
// than hardcoded into Send so tests can point it at an httptest server — the
// same arrangement deploy.BunnyClient.PurgeBaseURL uses.
const defaultPostmarkBaseURL = "https://api.postmarkapp.com"

// Sender is the send side of the digest, one method wide. It exists so the
// pipeline's only outbound email can be swapped for a recording fake in tests
// and for a no-op in a dry run: nothing about assembling a digest should require
// the ability to actually mail it.
type Sender interface {
	Send(ctx context.Context, from string, to []string, m Message) error
}

// PostmarkSender posts one email to Postmark's REST API. Talks to the endpoint
// directly rather than through an SDK, matching every other outbound client in
// this repo (Bunny, Salesforce, OpenAI).
type PostmarkSender struct {
	// Token is the Postmark SERVER token (POSTMARK_TOKEN), not an account token.
	Token string
	// BaseURL defaults to Postmark's public API via NewPostmarkSender.
	BaseURL string
	HTTP    *http.Client
}

// NewPostmarkSender builds a sender. hc may be nil, in which case
// http.DefaultClient is used.
func NewPostmarkSender(token string, hc *http.Client) *PostmarkSender {
	if hc == nil {
		hc = http.DefaultClient
	}
	return &PostmarkSender{Token: token, BaseURL: defaultPostmarkBaseURL, HTTP: hc}
}

// postmarkResponse is the subset of Postmark's reply that matters. Postmark
// reports APPLICATION errors with HTTP 200 and a non-zero ErrorCode — an
// unconfirmed sender signature being the likely one here — so the status code
// alone is not enough to know the mail was accepted.
type postmarkResponse struct {
	ErrorCode int    `json:"ErrorCode"`
	Message   string `json:"Message"`
}

// Send posts the digest. Recipients are comma-joined into Postmark's single "To"
// field, which is how its API takes multiple addresses.
func (s *PostmarkSender) Send(ctx context.Context, from string, to []string, m Message) error {
	if len(to) == 0 {
		return fmt.Errorf("postmark: no recipients — set FINEVINES_NOTIFY_TO")
	}
	payload, err := json.Marshal(map[string]string{
		"From":          from,
		"To":            strings.Join(to, ","),
		"Subject":       m.Subject,
		"HtmlBody":      m.HTMLBody,
		"TextBody":      m.TextBody,
		"MessageStream": "outbound",
	})
	if err != nil {
		return err
	}

	url := strings.TrimRight(s.BaseURL, "/") + "/email"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("postmark: building request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Postmark-Server-Token", s.Token)

	resp, err := s.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("postmark: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var parsed postmarkResponse
	_ = json.Unmarshal(body, &parsed)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("postmark: status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if parsed.ErrorCode != 0 {
		return fmt.Errorf("postmark: error %d: %s", parsed.ErrorCode, parsed.Message)
	}
	return nil
}

// Recipients splits FINEVINES_NOTIFY_TO's comma-separated list, trimming each
// address and dropping blanks so a trailing comma in the secret is harmless.
func Recipients(csv string) []string {
	var out []string
	for _, part := range strings.Split(csv, ",") {
		if addr := strings.TrimSpace(part); addr != "" {
			out = append(out, addr)
		}
	}
	return out
}
```

- [ ] **Step 14: Run the test to verify it passes**

Run: `go test ./internal/notify/ -v`
Expected: PASS for every case in the package.

- [ ] **Step 15: Commit**

```bash
git add internal/notify/postmark.go internal/notify/postmark_test.go
git commit -m "notify: Postmark sender behind a one-method interface"
```

### Part D — config and the subcommand

- [ ] **Step 16: Write the failing config test**

Append to `internal/config/config_test.go`:

```go
func TestLoad_NotifySettings(t *testing.T) {
	t.Setenv("POSTMARK_TOKEN", "pm-token")
	t.Setenv("FINEVINES_NOTIFY_TO", "george@example.com,barbara@example.com")
	t.Setenv("FINEVINES_NOTIFY_FROM", "catalog@finevines.biz")

	cfg, err := Load("nonexistent.env")
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.PostmarkToken != "pm-token" {
		t.Errorf("PostmarkToken = %q", cfg.PostmarkToken)
	}
	if cfg.NotifyTo != "george@example.com,barbara@example.com" {
		t.Errorf("NotifyTo = %q", cfg.NotifyTo)
	}
	if cfg.NotifyFrom != "catalog@finevines.biz" {
		t.Errorf("NotifyFrom = %q", cfg.NotifyFrom)
	}
}
```

- [ ] **Step 17: Run it to verify it fails**

Run: `go test ./internal/config/ -run TestLoad_NotifySettings -v`
Expected: FAIL — `cfg.PostmarkToken undefined`.

- [ ] **Step 18: Add the config fields**

In `internal/config/config.go`, add to the `Config` struct after the `GAID` field:

```go
	PostmarkToken string // POSTMARK_TOKEN: Postmark SERVER token the digest email is sent with
	NotifyTo      string // FINEVINES_NOTIFY_TO: comma-separated digest recipients (notify.Recipients splits it)
	NotifyFrom    string // FINEVINES_NOTIFY_FROM: the CONFIRMED Postmark sender signature the digest is sent from. No default: an unconfirmed sender is accepted with HTTP 200 and a non-zero ErrorCode, so guessing here would silently never deliver.
```

and to the returned literal, after `GAID:`:

```go
		PostmarkToken:        get("POSTMARK_TOKEN"),
		NotifyTo:             get("FINEVINES_NOTIFY_TO"),
		NotifyFrom:           get("FINEVINES_NOTIFY_FROM"),
```

- [ ] **Step 19: Run it to verify it passes**

Run: `go test ./internal/config/ -v`
Expected: PASS for every case in the package.

- [ ] **Step 20: Write the subcommand**

`cmd/finevines/notify.go`:

```go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/notify"
	"github.com/gritautomation/finevines-website/internal/queue"
)

// runNotify emails the digest for the run that just finished — and ONLY if that
// run changed something (design spec §A step 7). A digest that arrives every
// night saying "no changes" stops being read, and the whole point of it is that
// somebody reads it: with images publishing themselves, this email is what
// stands between a wrong bottle going live and a human noticing.
//
// The run's "before" state is a snapshot the workflow copies aside immediately
// after checkout, before applyqueue touches anything. That is more reliable than
// diffing git: by the time notify runs, the commit-back has already landed, so
// HEAD is the AFTER state and HEAD~1 may be a human's commit rather than the
// start of this run.
func runNotify(cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("notify", flag.ContinueOnError)
	beforePath := fs.String("before", ".run/wines-before.json",
		"the catalog as it stood at the start of the run (copied aside after checkout)")
	appliedPath := fs.String("applied", ".run/queue-applied.json",
		"this run's applied review-console actions, written by applyqueue")
	dry := fs.Bool("dry", false,
		"print the digest instead of sending it (no Postmark call, no credentials needed)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	before, err := model.LoadWines(*beforePath)
	if err != nil {
		return fmt.Errorf("notify: load %s: %w", *beforePath, err)
	}
	after, err := model.LoadWines("data/wines.json")
	if err != nil {
		return fmt.Errorf("notify: load data/wines.json: %w", err)
	}
	applied, err := loadApplied(*appliedPath)
	if err != nil {
		return fmt.Errorf("notify: load %s: %w", *appliedPath, err)
	}

	d := notify.Diff(before, after, applied, cfg.SiteBaseURL)
	if !d.Changed() {
		log.Printf("notify: the run changed nothing — no digest sent")
		return nil
	}
	msg := notify.Render(d, cfg.SiteBaseURL)

	if *dry {
		fmt.Println("Subject:", msg.Subject)
		fmt.Println()
		fmt.Println(msg.TextBody)
		return nil
	}

	requiredEnv := []struct{ name, value string }{
		{"POSTMARK_TOKEN", cfg.PostmarkToken},
		{"FINEVINES_NOTIFY_FROM", cfg.NotifyFrom},
		{"FINEVINES_NOTIFY_TO", cfg.NotifyTo},
	}
	for _, req := range requiredEnv {
		if req.value == "" {
			return fmt.Errorf("notify: set %s in .env (or the environment) before sending the digest", req.name)
		}
	}
	to := notify.Recipients(cfg.NotifyTo)

	sender := notify.NewPostmarkSender(cfg.PostmarkToken, http.DefaultClient)
	if err := sender.Send(context.Background(), cfg.NotifyFrom, to, msg); err != nil {
		return fmt.Errorf("notify: %w", err)
	}

	log.Printf("notify: digest sent to %d recipient(s) — %s", len(to), msg.Subject)
	log.Printf("notify: %d new, %d delisted, %d photographs, %d notes rewritten, %d review fixes",
		len(d.NewWines), len(d.Delisted), len(d.NewImages), len(d.TextRefreshed), len(d.QueueActions))
	return nil
}

// loadApplied reads applyqueue's run log. A missing file means applyqueue did not
// run in this workflow (a build-only re-run, or a local invocation) — not an
// error, just no reviewer fixes to report.
func loadApplied(path string) ([]queue.Applied, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var applied []queue.Applied
	if err := json.Unmarshal(data, &applied); err != nil {
		return nil, err
	}
	return applied, nil
}
```

Note: this file shadows the package name `fs` with the flag set. Rename the flag set variable to `flags` and use `fs.ErrNotExist` from `io/fs` — i.e. `flags := flag.NewFlagSet("notify", flag.ContinueOnError)` and `flags.String(...)`, `flags.Parse(args)`.

- [ ] **Step 21: Wire the dispatch**

In `cmd/finevines/main.go`, add to the switch after the `applyqueue` case:

```go
	case "notify":
		runErr = runNotify(cfg, os.Args[2:])
```

- [ ] **Step 22: Add the new variables to `.env.example`**

Append to `.env.example`:

```
# Digest email (Postmark). Sent by `finevines notify` after a pipeline run that
# changed something; never sent for a no-change run.
POSTMARK_TOKEN=
# Comma-separated recipients, e.g. george@finevines.com,barbara@finevines.com
FINEVINES_NOTIFY_TO=
# The CONFIRMED Postmark sender signature to send from. There is no default:
# Postmark accepts an unconfirmed sender with HTTP 200 and a non-zero ErrorCode,
# so a guessed value would silently never deliver.
FINEVINES_NOTIFY_FROM=
```

- [ ] **Step 23: Verify the whole binary, and see a real digest without sending one**

Run:

```bash
go build -o finevines.exe ./cmd/finevines
go vet ./...
go test ./...
cp data/wines.json .run-before.json
./finevines.exe notify -before .run-before.json -dry
```

Expected: the build and vet are silent; `go test ./...` is all `ok`; the `notify -dry` run prints `notify: the run changed nothing — no digest sent` (the snapshot is identical to the catalog). Then edit one wine's description in `.run-before.json` and re-run: it prints a `Subject: Fine Vines catalog: 1 rewritten note` line and the plain-text body. Delete `.run-before.json` afterwards.

- [ ] **Step 24: Commit**

```bash
git add internal/config/config.go internal/config/config_test.go cmd/finevines/notify.go cmd/finevines/main.go .env.example
git commit -m "cmd: finevines notify emails the run digest, only when something changed"
```

---

## Task 8: The main workflow

Everything above is a part. This is the machine: one workflow, four triggers, one at a time, state committed back.

**Files:**
- Create: `.github/workflows/pipeline.yml`

**Interfaces:**
- Consumes: `.bunny-manifest.json` tracked (Task 2); `finevines applyqueue -runlog <path>` (Task 3); `data/image-attempts.json` (Task 4); `bash tools/labelfetch/cistage.sh` (Task 6); `finevines notify -before <path> -applied <path>` (Task 7); the existing `finevines enrich`, `finevines build`, `finevines deploy`.
- Produces: the running pipeline. GitHub Actions repository secrets must be configured before the first live run — Task 9 documents the list.

- [ ] **Step 1: Write the workflow**

`.github/workflows/pipeline.yml`:

```yaml
# The whole FineVines publish path, unattended.
#
#   drain the review queue -> enrich -> source images -> build -> deploy
#   -> commit the state back -> email the digest
#
# The repo stays the source of truth. Nothing here holds state between runs
# except what it commits: data/, the imported photographs, and
# .bunny-manifest.json. That is what makes a run resumable and what stops
# enrichment being re-billed — the SourceHash of every wine survives in
# data/wines.json, so an unchanged wine is never sent to OpenAI twice.
#
# There is deliberately NO pull_request trigger. The repo is public and this
# workflow reads every credential the business has; a fork PR must never be able
# to start it. Build and test coverage for pull requests lives in ci.yml, which
# declares no secrets at all.
name: pipeline

on:
  push:
    branches: [master]
  # Nightly at 08:15 UTC — about 2:15am Central, well clear of the Salesforce
  # org's business hours and of any human pushing.
  schedule:
    - cron: '15 8 * * *'
  workflow_dispatch:
  # Fired by the review console's Edge Script the moment a reviewer submits a
  # change, so their fix is live in minutes rather than at the next nightly run.
  repository_dispatch:
    types: [review-console]

# Runs QUEUE, never overlap. Two concurrent runs would race the deploy manifest
# and the commit-back push, and cancel-in-progress would abandon a run
# mid-upload — which the deploy invariants survive, but only because they are
# never asked to.
concurrency:
  group: pipeline
  cancel-in-progress: false

permissions:
  contents: write # the bot commit-back pushes to master

jobs:
  run:
    # GitHub already skips a push whose head commit message contains [skip ci],
    # so the bot's own commit cannot loop. This is the belt to that braces: a
    # repository_dispatch or a schedule firing seconds after a bot commit is NOT
    # covered by GitHub's rule, and would redo work that just landed.
    # github.event.head_commit is null on those events, so the guard passes.
    if: ${{ !contains(github.event.head_commit.message, '[skip ci]') }}
    runs-on: ubuntu-latest
    timeout-minutes: 300

    env:
      # Salesforce — the authoritative source for every commercial field.
      FINEVINES_SF_BASE_URL: ${{ secrets.FINEVINES_SF_BASE_URL }}
      FINEVINES_SF_CLIENT_ID: ${{ secrets.FINEVINES_SF_CLIENT_ID }}
      FINEVINES_SF_CLIENT_SECRET: ${{ secrets.FINEVINES_SF_CLIENT_SECRET }}
      # OpenAI — web-search enrichment, vision label reading, watermark sweep.
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      # Bunny.net — storage zone (deploy upload + the _review/ queue), pull zone
      # purge, and the redirect middleware's script ID.
      FINEVINES_BUNNY_STORAGE_ZONE: ${{ secrets.FINEVINES_BUNNY_STORAGE_ZONE }}
      FINEVINES_BUNNY_STORAGE_KEY: ${{ secrets.FINEVINES_BUNNY_STORAGE_KEY }}
      FINEVINES_BUNNY_STORAGE_ENDPOINT: ${{ secrets.FINEVINES_BUNNY_STORAGE_ENDPOINT }}
      FINEVINES_BUNNY_API_KEY: ${{ secrets.FINEVINES_BUNNY_API_KEY }}
      FINEVINES_BUNNY_PULL_ZONE_ID: ${{ secrets.FINEVINES_BUNNY_PULL_ZONE_ID }}
      FINEVINES_BUNNY_SCRIPT_ID: ${{ secrets.FINEVINES_BUNNY_SCRIPT_ID }}
      # Site.
      FINEVINES_SITE_BASE_URL: ${{ secrets.FINEVINES_SITE_BASE_URL }}
      FINEVINES_GA_ID: ${{ secrets.FINEVINES_GA_ID }}
      # Digest email.
      POSTMARK_TOKEN: ${{ secrets.POSTMARK_TOKEN }}
      FINEVINES_NOTIFY_TO: ${{ secrets.FINEVINES_NOTIFY_TO }}
      FINEVINES_NOTIFY_FROM: ${{ secrets.FINEVINES_NOTIFY_FROM }}

    steps:
      # Full depth: the commit-back rebases onto origin/master if a human pushed
      # mid-run, and a shallow clone cannot rebase.
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - run: npm ci

      - name: Build the binaries
        run: |
          go build -ldflags "-s -w" -o finevines ./cmd/finevines
          go build -o imgcheck ./tools/imgcheck
          go build -o imgnorm ./tools/imgnorm

      # The catalog as it stands BEFORE anything runs. `notify` diffs against
      # this at the end. Taken here rather than derived from git later, because
      # by then the commit-back has landed and HEAD is the after-state.
      - name: Snapshot the catalog for the digest
        run: |
          mkdir -p .run
          cp data/wines.json .run/wines-before.json

      # 1. Drain the review console's change queue. First, so a reviewer's fix
      #    is applied before enrich has a chance to overwrite the same wine, and
      #    so a text-feedback regeneration is the version that gets built.
      - name: Apply the review queue
        run: ./finevines applyqueue -runlog .run/queue-applied.json

      # 2. Enrich against live Salesforce. SourceHash means unchanged wines are
      #    not re-sent to OpenAI, so this is cheap on a normal night.
      - name: Enrich
        run: ./finevines enrich

      # 3. Source bottle photographs: fetch + verify (due wines only), watermark
      #    sweep, import survivors. Both verification stages are hard gates.
      - name: Source images
        run: bash tools/labelfetch/cistage.sh

      # 4. Build the static site.
      - name: Build
        run: ./finevines build

      # 5. Deploy. The manifest diff means only changed files upload; the
      #    manifest is saved only after every upload and delete succeeds, and the
      #    purge only after that (see deploy.Run's ordering invariants).
      - name: Deploy
        run: ./finevines deploy

      # 6. Commit the state back. AFTER the deploy, so the repo never claims to
      #    have published something that failed to upload — the same invariant
      #    deploy.Run applies to its own manifest, extended one level up.
      - name: Commit the run's state back to master
        run: |
          git config user.name 'finevines-pipeline[bot]'
          git config user.email '215369143+finevines-pipeline[bot]@users.noreply.github.com'
          git add data assets/img/wines .bunny-manifest.json
          if git diff --cached --quiet; then
            echo "nothing changed this run — no commit"
            exit 0
          fi
          git commit -m 'pipeline: nightly run [skip ci]'
          # A human pushing mid-run is the one expected rejection. Rebase and
          # retry ONCE; if it still fails, fail the run loudly rather than
          # force-pushing over somebody's work. The next run reconciles: the
          # deploy already happened, and .bunny-manifest.json is regenerated
          # from a fresh diff either way.
          git push origin HEAD:master || {
            echo "push rejected — rebasing onto origin/master and retrying once"
            git pull --rebase origin master
            git push origin HEAD:master
          }

      # 7. Email the digest — only if the run changed something. Runs last so it
      #    reports what actually shipped, and is NOT `if: always()`: a failed run
      #    surfaces through GitHub's own workflow-failure email to the repo
      #    owner. This email is for content changes, not CI health.
      - name: Send the digest
        run: ./finevines notify -before .run/wines-before.json -applied .run/queue-applied.json
```

- [ ] **Step 2: Confirm the bot identity does not need to be a real account**

`git config user.name`/`user.email` on a workflow run only labels the commit; the push is authenticated by the automatic `GITHUB_TOKEN` that `actions/checkout` persists. Verify the token has push rights: **Settings → Actions → General → Workflow permissions** must be **Read and write permissions**. Run:

```bash
gh api repos/:owner/:repo/actions/permissions/workflow
```

Expected: `"default_workflow_permissions": "write"`. If it reads `read`, set it: `gh api -X PUT repos/:owner/:repo/actions/permissions/workflow -f default_workflow_permissions=write`.

- [ ] **Step 3: Configure every secret**

Run each of these, pasting the value when prompted (values come from the local `.env` and `docs/operations.md`):

```bash
for s in FINEVINES_SF_BASE_URL FINEVINES_SF_CLIENT_ID FINEVINES_SF_CLIENT_SECRET \
         OPENAI_API_KEY \
         FINEVINES_BUNNY_STORAGE_ZONE FINEVINES_BUNNY_STORAGE_KEY \
         FINEVINES_BUNNY_STORAGE_ENDPOINT FINEVINES_BUNNY_API_KEY \
         FINEVINES_BUNNY_PULL_ZONE_ID FINEVINES_BUNNY_SCRIPT_ID \
         FINEVINES_GA_ID FINEVINES_SITE_BASE_URL \
         POSTMARK_TOKEN FINEVINES_NOTIFY_TO FINEVINES_NOTIFY_FROM \
         FINEVINES_REVIEW_HMAC_SECRET; do
  gh secret set "$s"
done
```

`FINEVINES_REVIEW_HMAC_SECRET` is not read by anything in Sub-project A — it is set now because it belongs to the same secret inventory (spec §Secrets) and the console will need it. Generate it with `openssl rand -hex 32`.

Then verify: `gh secret list`
Expected: all sixteen names listed.

- [ ] **Step 4: Verify the workflow syntax, then dry-run it manually before trusting the schedule**

```bash
git add .github/workflows/pipeline.yml
git commit -m "ci: the unattended FineVines pipeline"
git push
gh workflow run pipeline.yml
gh run watch
```

Expected: every step green. Read the log carefully on this first run — specifically:
- `applyqueue: _review/queue.json is empty — nothing to drain` (the console does not exist yet).
- `enrich: N roster rows, M eligible, K need enrichment` against the LIVE org.
- `due per the attempt ledger: N of M imageless wines` — should be well under the full imageless count thanks to Task 4's seeding.
- `deploy: uploaded N, deleted M, purged` — a small N. A five-figure N means `.bunny-manifest.json` was not committed correctly (Task 2).
- `pipeline: nightly run [skip ci]` appearing as a new commit on `master`, and **no second workflow run triggered by it**.
- `notify: digest sent to N recipient(s)`.

- [ ] **Step 5: Verify the `[skip ci]` guard actually held**

Run: `gh run list --workflow=pipeline.yml --limit 5`
Expected: exactly one run for the manual dispatch. If a second run appears triggered by the bot's push, the `[skip ci]` suffix is missing from the commit message — check `git log -1 --format=%s origin/master`.

- [ ] **Step 6: Verify concurrency queues rather than overlaps**

Run: `gh workflow run pipeline.yml && gh workflow run pipeline.yml && gh run list --workflow=pipeline.yml --limit 2`
Expected: the second run sits in `queued` while the first is `in_progress`, and neither is cancelled.

---

## Task 9: Document it

`deploy.bat` stops being how the site updates and becomes the fallback. That has to be written down, because the next person to touch this will otherwise reach for the batch file and wonder why their run fights the pipeline's.

**Files:**
- Modify: `README.md:201-207` (the "Running it" section), and insert a new section before it
- Modify: `docs/operations.md`
- Modify: `deploy.bat`

**Interfaces:**
- Consumes: everything above — this task documents the finished system.
- Produces: no code.

- [ ] **Step 1: Add the pipeline section to the README**

In `README.md`, insert before `## Building` (line 176) a new section:

```markdown
## 6. The automated pipeline (GitHub Actions)

Since 2026-07-29 the publish path runs unattended in GitHub Actions rather than
from one Windows machine. `.github/workflows/pipeline.yml` runs on every push to
`master`, nightly at 08:15 UTC (about 2:15am Central), on manual dispatch, and
on a `repository_dispatch` of type `review-console` fired by the review console.
Runs queue rather than overlap.

Each run, in this order:

1. **`finevines applyqueue`** drains `_review/queue.json` from the Bunny storage
   zone: image swaps, text corrections, and flags submitted by reviewers. Every
   applied action ID is recorded in `data/queue-ledger.json`, so a crashed or
   re-fired run never applies the same correction twice.
2. **`finevines enrich`** pulls the live Salesforce roster. Unchanged wines are
   skipped by their `sourceHash`, so nothing is re-sent to OpenAI.
3. **`tools/labelfetch/cistage.sh`** sources bottle photographs for wines that
   have none and are due per `data/image-attempts.json` (a 30-day backoff after a
   failed search). An image must pass **both** the label/shape verification and
   the watermark sweep to be imported; there is no override in CI.
4. **`finevines build`** renders `dist/`.
5. **`finevines deploy`** uploads the changed files to Bunny.net and purges both
   pull zones.
6. **A bot commit** returns `data/`, the imported photographs under
   `assets/img/wines/`, and `.bunny-manifest.json` to `master` with the message
   `pipeline: nightly run [skip ci]`. The repo remains the source of truth and
   every automated change is auditable in git history.
7. **`finevines notify`** emails a digest through Postmark — but only if the run
   changed something. It lists new wines, delistings, rewritten notes, newly
   imported photographs (with thumbnails and their source URLs), corrections
   applied, and the portfolio's coverage figures, each linking to the live page.

`.github/workflows/ci.yml` is the separate, credential-free gate that runs on
every push and pull request: build, `go test ./...`, the Node unit tests, and a
mock-mode (`FINEVINES_SF_MOCK`) pipeline run that never touches Salesforce,
OpenAI or Bunny.net.

### Secrets to configure

All are GitHub Actions **repository** secrets (Settings → Secrets and variables →
Actions). The repo is public, so the pipeline workflow deliberately has no
`pull_request` trigger — a fork PR can never reach any of these.

| Secret | What it is |
| --- | --- |
| `FINEVINES_SF_BASE_URL` | Salesforce instance URL |
| `FINEVINES_SF_CLIENT_ID` | Connected App consumer key |
| `FINEVINES_SF_CLIENT_SECRET` | Connected App consumer secret |
| `OPENAI_API_KEY` | Enrichment, vision label reading, watermark sweep |
| `FINEVINES_BUNNY_STORAGE_ZONE` | Storage zone name |
| `FINEVINES_BUNNY_STORAGE_KEY` | Storage zone password |
| `FINEVINES_BUNNY_STORAGE_ENDPOINT` | Regional storage host |
| `FINEVINES_BUNNY_API_KEY` | Account API key (purge, Edge Scripting) |
| `FINEVINES_BUNNY_PULL_ZONE_ID` | Both pull zone IDs, comma-separated |
| `FINEVINES_BUNNY_SCRIPT_ID` | Redirect middleware's Edge Script ID |
| `FINEVINES_GA_ID` | GA4 measurement ID |
| `FINEVINES_SITE_BASE_URL` | Canonical site URL |
| `POSTMARK_TOKEN` | Postmark **server** token for the digest |
| `FINEVINES_NOTIFY_TO` | Comma-separated digest recipients |
| `FINEVINES_NOTIFY_FROM` | Confirmed Postmark sender signature |
| `FINEVINES_REVIEW_HMAC_SECRET` | Magic-link signing key (used by the review console) |

Also required once: **Settings → Actions → General → Workflow permissions** set
to **Read and write**, so the bot commit can push.

The review console's GitHub PAT is **not** a repository secret. It lives as a
Bunny Edge Script secret: fine-grained, this repo only, Actions: write for
`repository_dispatch` and nothing else.
```

- [ ] **Step 2: Rewrite the README's "Running it" section as the fallback**

Replace `README.md`'s `## Running it` body (lines 203–207) with:

```markdown
The pipeline normally runs itself — see **[6. The automated pipeline](#6-the-automated-pipeline-github-actions)**
above. To trigger it by hand: `gh workflow run pipeline.yml`, or the *Run
workflow* button on the Actions tab.

`deploy.bat` (repo root) remains the **local fallback** for when GitHub Actions
is unavailable or a run needs to be reproduced on a workstation. It runs
`enrich`, then `build`, then `deploy`, stopping at the first error. It does not
drain the review queue, source images, or send a digest — those are pipeline-only
steps. **Commit `data/` and `.bunny-manifest.json` after running it**, or the
next pipeline run will diff against stale state and re-upload the whole site.

See **[`docs/operations.md`](docs/operations.md)** for the full runbook: every
credential and where it comes from, running the pipeline by hand, reading a run's
summary output, what to do when a step fails, and how to install and use the two
Claude skills.
```

- [ ] **Step 3: Make `deploy.bat` say what it is**

Replace `deploy.bat` with:

```bat
@echo off
REM FineVines LOCAL FALLBACK pipeline. The real one runs in GitHub Actions
REM (.github/workflows/pipeline.yml) on every push, nightly at 08:15 UTC, on
REM manual dispatch, and when the review console fires a repository_dispatch.
REM
REM Use this only when Actions is unavailable or a run needs reproducing on this
REM machine. It runs enrich -> build -> deploy and stops at the first error.
REM
REM It deliberately does NOT do three of the pipeline's steps: it does not drain
REM the review console's change queue (finevines applyqueue), does not source
REM bottle photographs (tools/labelfetch/cistage.sh), and does not send the
REM digest email (finevines notify).
REM
REM AFTER a successful run, COMMIT AND PUSH data/, assets/img/wines/ and
REM .bunny-manifest.json. Otherwise the next pipeline run diffs against stale
REM state and re-uploads the entire site.
finevines.exe enrich || goto :fail
finevines.exe build || goto :fail
finevines.exe deploy || goto :fail
echo Done. Now commit and push data/, assets/img/wines/ and .bunny-manifest.json
exit /b 0
:fail
echo FAILED - see output above. The site was NOT updated.
exit /b 1
```

- [ ] **Step 4: Add the CI runbook to `docs/operations.md`**

Append:

```markdown
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
Nothing partial is ever persisted as if complete. Specifically:
- **applyqueue failed** — the queue is not cleared and nothing was committed. The
  next run re-reads the same actions; `data/queue-ledger.json` stops anything
  that did apply from applying twice. Safe to just re-run.
- **enrich failed** — `data/wines.json` holds whatever the last checkpoint saved
  (every 50 wines). Wines that succeeded now hash-match and are skipped on the
  retry, so nothing is re-billed.
- **image stage failed** — no image reached `assets/img/wines/` unless it passed
  both gates. `data/image-attempts.json` was written per wine, so a retry does
  not re-search what was already tried.
- **deploy failed** — `.bunny-manifest.json` was NOT saved and the CDN was NOT
  purged. The next run re-diffs against the old manifest and retries exactly the
  files that never uploaded.
- **commit-back was rejected twice** — a human pushed mid-run. The deploy already
  happened; the site is live and correct, but the repo has not caught up. Re-run
  the pipeline: it re-diffs and commits.
- **notify failed** — everything shipped; only the email did not. The most likely
  cause is `FINEVINES_NOTIFY_FROM` not being a confirmed Postmark sender
  signature (Postmark returns HTTP 200 with a non-zero `ErrorCode` for that).

### Rotating a secret
`gh secret set <NAME>`, then `gh workflow run pipeline.yml` to confirm. Secrets
are never printed in logs; a step that needs one and does not have it fails with
`set <NAME> in .env (or the environment) before running <subcommand>`.

### Stopping the pipeline
Disable the workflow: `gh workflow disable pipeline.yml`. The nightly schedule
and every trigger stop; `deploy.bat` remains available on the workstation.
```

- [ ] **Step 5: Verify the docs match reality**

Run: `grep -c 'applyqueue\|cistage\|notify' README.md docs/operations.md`
Expected: non-zero counts for both. Then re-read the secret table against `.github/workflows/pipeline.yml`'s `env:` block and confirm every name matches exactly — a typo here is a silent empty value at 2:15am.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/operations.md deploy.bat
git commit -m "docs: the CI pipeline, its secrets, and deploy.bat as the fallback"
```

---

## Spec coverage

Every requirement in `docs/superpowers/specs/2026-07-29-github-ci-pipeline-and-review-console-design.md` §"Sub-project A", mapped to the task that implements it:

| Spec requirement | Task |
| --- | --- |
| §Triggers: push to master, nightly cron, workflow_dispatch, repository_dispatch `review-console` | 8 |
| §Triggers: `concurrency: {group: pipeline, cancel-in-progress: false}` | 8 |
| §Triggers: secrets never on `pull_request`; fork PRs get build/test only | 1, 8 |
| §Steps 1: `finevines applyqueue`, three action kinds, idempotent, then truncate | 3 |
| §Steps 2: enrich against live Salesforce, SourceHash skips unchanged | 8 (no logic change — spec forbids one) |
| §Steps 3: labelfetch → watermark sweep → auto-import, hard gates, no override | 5, 6 |
| §Steps 3: attempt ledger, 30-day backoff, committed with the data | 4 |
| §Steps 3: `imageSourceUrl` provenance retained | 3 (swap), 6 (import — existing behaviour) |
| §Steps 4: build | 8 |
| §Steps 5: deploy; `.bunny-manifest.json` becomes tracked | 2, 8 |
| §Steps 6: bot commit-back, `pipeline:` prefix + `[skip ci]`, rebase-and-retry-once | 8 |
| §Steps 7: `finevines notify`, only when changed, contents, Postmark, `FINEVINES_NOTIFY_TO`, links to live pages | 7 |
| §Secrets: the fifteen-name inventory | 8 (set), 9 (documented) |
| §Platform note: Linux smoke test first; `deploy.bat` stays the fallback | 1, 9 |
| §Error handling: abort before manifest save / commit-back | 8 (step order), existing `deploy.Run` invariants |
| §Error handling: failures surface via GitHub's workflow-failure email | 8 (notify is not `if: always()`), 9 |
| §Error handling: queue drain idempotent via applied-ID ledger | 3 |
| §Testing: existing Go tests run in CI on every push | 1 |
| §Testing: new unit tests for applyqueue, attempt ledger, notify (send mocked) | 3, 4, 7 |
| §Testing: mock-mode full-pipeline smoke test | 1 |

**Deliberately not in this plan** (Sub-project B, per the task brief): the Edge Script console, magic-link token signing and validation, `review.finevines.biz` DNS, candidate-image publishing to `_review/candidates/`, and the digest's magic links. Task 3 implements `applyqueue` against the exact `{id, reviewer, sku, action, payload, ts}` contract and Task 7's digest is structured so per-wine console links slot in beside the existing live-page links, so B attaches to A without changing either.


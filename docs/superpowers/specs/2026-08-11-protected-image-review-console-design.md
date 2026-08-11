# Protected Image Review Console

**Date:** 2026-08-11  
**Status:** Implementation contract  
**Supersedes:** Sub-project B and the shared `_review/queue.json` contract in
`2026-07-29-github-ci-pipeline-and-review-console-design.md`.

## Outcome

Fine Vines staff can resolve image exceptions in a password-protected browser
without exposing the review page or its candidate images to crawlers. A click
is never treated as deployed until a durable receipt names the catalog commit
and completed Bunny deployment.

| Environment | Reviewer host | Site affected |
| --- | --- | --- |
| Production | `review.finevines.com` | `finevines.com` |
| Test | `review.finevines.biz` | `finevines.biz` |

The environments have separate scripts, secrets, storage prefixes, cookies,
candidate packages, actions, receipts, GitHub dispatch configuration, and
deployment targets. A test action can never name the production environment.

## Module and seam

The console is one deep `ReviewConsole` module. Its interface is one request
handler plus configuration and adapters for storage, dispatch, cryptography,
and time. The module owns authentication, CSRF, routing, validation, response
headers, package reads, action writes, and status rendering. Bunny's standalone
Edge Script is a thin adapter at that seam.

The pipeline has a matching `reviewactions` module. Its interface is: list due
actions, validate each action against its immutable package and current wine
revision, apply accepted actions, and emit proposed receipts. Storage and image
normalization remain adapters.

## Authentication and crawler exclusion

- The hostname is unlinked and omitted from every sitemap, but obscurity is not
  an authorization mechanism.
- The password is an Edge Script environment secret. It is never in source,
  HTML, URLs, browser storage, logs, or GitHub Actions.
- A successful login creates a signed, host-only, 12-hour cookie with
  `HttpOnly; Secure; SameSite=Strict; Path=/`. Production and test use different
  signing secrets and cookie names.
- Login responses are rate-limited. Authentication failures reveal neither
  package data nor storage paths.
- Every response, including login, errors, JSON, and candidate images, carries
  `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex` and
  `Cache-Control: no-store`. HTML also carries a robots meta tag.
- Mutating requests require the authenticated cookie, exact expected `Origin`,
  JSON content type, and a session-bound CSRF token.

## Versioned review package

CI publishes a complete package before advertising it to the console:

```
_review/<environment>/packages/<packageId>/manifest.json
_review/<environment>/packages/<packageId>/images/<candidateId>.<ext>
_review/<environment>/current.json
```

`packageId` includes the source commit and manifest digest. The immutable
manifest contains the environment, catalog commit, creation/expiry times, and
for each wine: SKU, display identity, `wineRevision`, current image, candidates,
source URL, byte length, MIME type, dimensions, and SHA-256. `current.json` is
published last and is the only mutable pointer. Incomplete packages are never
discoverable.

Candidate bytes are served only through the authenticated script. The raw
storage hostname/prefix is not a public image URL. Packages expire after 30 days
and are retained longer only while an unresolved action references them.

## Immutable action contract

One selection creates one server-generated UUID action and one pending pointer:

```
_review/<environment>/actions/<uuid>.json
_review/<environment>/pending/<uuid>.json
```

Both writes must succeed before GitHub is dispatched. The action file is never
rewritten. There is no shared queue file and therefore no read/append/delete
race. Reposting the same UUID with different bytes is rejected.

Required fields are `schemaVersion`, `id`, `environment`, `reviewer`, `sku`,
`kind`, `packageId`, `targetCatalogCommit`, `wineRevision`, `candidateId`,
`submittedAt`, and `csrfSessionId`. Unknown fields, kinds, environments,
candidate IDs, oversized values, unsafe paths, malformed timestamps, and
non-UUID IDs are rejected both at the edge and again in CI.

CI verifies that the package is complete, the candidate belongs to the SKU,
its bytes match the manifest SHA-256, and the current catalog row still matches
`wineRevision`. A stale action becomes a conflict receipt; it is never applied
to a newer wine by guesswork.

## Receipt and lifecycle

```
_review/<environment>/receipts/<uuid>.json
```

The pipeline may create diagnostic workflow artifacts while running, but the
durable success receipt is uploaded only after validation, catalog mutation,
build, Bunny deployment, and commit-back all succeed. It names the action,
outcome, catalog commit, deployment target, image hash, run ID, and timestamps.
Only after that upload succeeds is the pending pointer deleted. A failure leaves
the pointer intact, making retry safe. Existing receipts make repeats no-ops.

Receipt states are `deployed`, `conflict`, and `rejected`. `conflict` and
`rejected` are terminal only after their receipt is durable; they never mutate
the catalog. The console renders `Queued`, `Validating`, `Deployed`, `Conflict`,
or `Rejected` from storage evidence and never predicts success.

## Publication ordering

1. Generate and validate the whole review package locally.
2. Upload candidate bytes and manifest under the immutable package ID.
3. Upload `current.json` last.
4. Reviewer submits one immutable action; dispatch is best-effort because the
   nightly pipeline also scans pending pointers.
5. Pipeline validates and applies actions in a working tree.
6. Build and deploy the target site.
7. Commit and push the resulting repository state.
8. Upload durable receipts, then remove their pending pointers.

If step 7 fails after deployment, no success receipt exists and the action
remains pending. The next run reconciles and retries; it does not tell the
reviewer the work is finished.

## Activation gates

Test is activated first. Before production activation, automated tests and a
live test-host canary must prove: unauthenticated HTML/images/actions are
blocked; crawler headers are universal; cookies are host-only; CSRF and Origin
checks work; cross-environment actions fail; two simultaneous submissions are
both retained; stale revisions conflict; candidate hash mismatch rejects;
dispatch failure leaves recoverable work; pipeline failure leaves pending work;
and a successful deploy produces exactly one receipt.


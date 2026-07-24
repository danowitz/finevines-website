# Fine Vines Website

Source for [finevines.com](https://finevines.com) — a static, SEO-first website with a self-updating wine
catalog, built for Fine Vines, a licensed wholesale wine/liquor distributor in Illinois.

For the full architecture and confirmed scope, see
[`docs/superpowers/specs/2026-07-03-finevines-static-site-design.md`](docs/superpowers/specs/2026-07-03-finevines-static-site-design.md).
**If you're Fine Vines staff running the site day to day, you want
[`docs/operations.md`](docs/operations.md) instead — this README is for developers.**

## What's here

One dependency-free Go binary, `finevines`, plus two Claude Code skills:

```
finevines enrich     Salesforce -> data/wines.json + assets/img/wines/*   (network, incremental, checkpointed)
finevines build      data/*.json -> dist/*                                (pure, deterministic, no network)
finevines redirects  crawls the old site -> redirects.json (--publish sends it to Bunny.net Edge Scripting)
finevines deploy     dist/ -> Bunny.net Storage Zone + Pull Zone purge    (network, hash-diff upload)
```

- **`enrich`** pulls the current wine roster from Salesforce (the sync target for QuickBooks — see
  `internal/salesforce`), applies the web-eligibility rule (`stockQty > 0 AND SKU does not start with "9"`,
  `internal/enrich/rules.go`), diffs against what's already on record, and for anything new or changed
  generates tasting-note text (Claude/Anthropic) and a bottle image. The image pipeline tries an AI-generated
  photorealistic bottle first (Gemini/Imagen) and always has a deterministic vector wine-label generator
  (`internal/label`) as a guaranteed, on-brand fallback. Results are checkpointed to `data/wines.json` as it
  runs.
- **`build`** is a pure function: it reads `data/wines.json`, `data/news/*.json`, and `data/team.json` and
  renders the full static site (`html/template`) into `dist/` — home, portfolio/catalog, one page per wine,
  news & events, about, contact, sitemap, robots.txt. No network calls, deterministic output.
- **`redirects`** crawls every URL currently live on the old finevines.com, maps each to its new location, and
  writes `redirects.json`. With `--publish`, it also generates and pushes an Edge Scripting middleware to
  Bunny.net so the old URL footprint 301s to the new site (see `internal/redirects`).
- **`deploy`** uploads `dist/` to a Bunny.net Storage Zone, uploading only files whose content hash changed
  since the last deploy, deletes orphaned files, and purges the Bunny Pull Zone's CDN cache.
- **Two Claude Code skills** (`plugins/finevines-news`, `plugins/finevines-team`), installed via this repo's
  `.claude-plugin/marketplace.json`, let Fine Vines office staff post news/events and manage the About-page
  team roster through a plain-language conversation — writing `data/news/<slug>.json` and `data/team.json`
  respectively — without touching code. Both offer to run `build` + `deploy` when done.

`data/wines.json` is machine-owned (by `enrich`); `data/news/` and `data/team.json` are human-owned (by the two
skills). `build` only ever reads these three JSON shapes — it never talks to Salesforce or Claude directly.

## Building

Requires Go (see `go.mod` for the version). From the repo root:

```
go build -o finevines.exe ./cmd/finevines
```

For the actual release binary that ships to the Fine Vines machine, use the release flags (strips debug
symbols, smaller binary):

```
go build -ldflags "-s -w" -o finevines.exe ./cmd/finevines
```

This produces a single, dependency-free `finevines.exe` with no external DLLs. Running it with no arguments
prints usage; running any subcommand without its required `.env` values reports exactly which one is missing
rather than failing silently. The binary is a build artifact, not checked into the repo — see `.gitignore`.

Running the test suite:

```
go test ./...
```

## Running it

`deploy.bat` (repo root) runs the full nightly pipeline — `enrich`, then `build`, then `deploy` — aborting
immediately if any step fails so a partial run never publishes. See **[`docs/operations.md`](docs/operations.md)**
for the full runbook: every `.env` credential and where it comes from, running `deploy.bat` by hand, setting up
a nightly Windows Task Scheduler run, what the summary output means, and how to install and use the two Claude
skills.

## Proprietary Notice

Copyright © 2026 Fine Vines. All rights reserved.

This repository contains proprietary website source code, designs, assets, content, branding, and related
materials for Fine Vines.

No license is granted. Public availability of this repository does not permit copying, reuse, modification,
distribution, publication, sublicensing, or creation of derivative works outside the limited functionality
provided by GitHub's platform.

Any use of this repository or its contents requires prior written permission from Fine Vines.

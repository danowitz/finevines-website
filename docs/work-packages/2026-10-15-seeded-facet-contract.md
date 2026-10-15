# Seeded facet browser contract

**Authority:** issue #49. **Repository/branch:** finevines-website@codex/issue-49-seeded-facet-contract. **Base:** origin/master at 1a581c5. **Status:** ready for independent review.

**Objective/background:** replace the catalog-dependent 90-input ceiling with the existing seeded-rail contract. The unchanged test fails with 91 inputs against CI run 38686378183's catalog at cee720f. The starting local master (620bb4a) happened to pass on its older catalog. Builder, template, client, and original browser test have no diff between those bases. The issue branch was moved onto current origin/master without moving the local master branch or carrying its two unrelated commits into this change.

**Owned scope/deliverables:** tests/e2e/filter-rail.test.js, facet boundary coverage in internal/build/build_test.go, and this evidence record.

**Preserved/out of scope:** all production source, templates, assets, catalog data, timeout recovery, deployment, and review processing. This issue corrects tests only.

**Constraints/design assurance:** buildFacets owns the server seed: min(12, distinct values) for producer/region/varietal; all distinct vintage/country values. Values carry positive counts; vintage is newest-first and other groups rank by count. The template supplies header totals and facet-keyed controls. No identity, clock, persistence, retry, migration, security, or failure-policy change; no ADR needed.

**Acceptance:** reproduce the original failure; assert each group's seed size, populated coherent rows/counts, and correctly keyed controls; exercise empty, below-cap, at-cap, above-cap, and over-90 catalogs; pass the full browser suite.

**Production boundary:** none, repository change only.

**Validation:** isolated real-Chrome no-JS repro on the historical catalog, corrected test on historical and current builds, Go facet boundary tests, full npm browser suite, and diff review. No live-site, Salesforce, enrichment, deployment, or hardware tests are needed for test-only changes.

**Rollback:** revert these test/doc edits; no data or production effects to reverse. No new rollback or approval mechanism.

**Stop conditions:** none added; this is a reversible test-only change under the existing repository instructions.

**Knowledge capture:** none identified beyond this issue's existing catalog-independent contract.

## Validation and assessment

- Historical reproduction: `node --test --test-name-pattern="renders a seeded" .run/issue49-base/tests/e2e/filter-rail.test.js` failed with `got 91 inputs` using the original test and archived data/templates from cee720f. The production builder is identical to that base. The corrected test passed on that same build. Its groups contain 12 producer, 12 region, 12 varietal, 29 vintage, and 26 country inputs.
- Mutation checks on the isolated historical HTML rejected a missing seed row, a blank count, and a wrongly keyed expander; the original HTML was restored afterward.
- `go test ./internal/build -count=1`: passed (96.282s). `go test ./internal/build -run '^TestBuildFacets' -count=1`: passed (0.527s). Builder source is unchanged across the rebase.
- `npm run test:e2e` on current origin/master plus this patch: 31 passed, 0 failed, 1 existing skip. The build used `build.Run("data", "assets", "templates", "dist", "https://finevines-com.b-cdn.net", "")`, matching CI's analytics-disabled build configuration. The initial local build inherited GA4 from `.env`; its suite had two aborted analytics requests. No rendering assertions were disabled to obtain the passing result.
- Diff review and `git diff --check`: passed. Only the two test files and this record differ from origin/master. No production behavior, dependency, or data changes.
- Hostile review: not performed; this test-only change received a local diff review. Linux CI and an independent human review remain unverified locally. No deployment was performed.

**Assessment:** READY FOR INDEPENDENT REVIEW. Production boundary remains none, repository change only.

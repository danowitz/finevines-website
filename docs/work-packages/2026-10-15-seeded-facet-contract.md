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
- Hostile review and system forensics: completed below. [Linux CI run 38689394279](https://github.com/danowitz/finevines-website/actions/runs/38689394279) passed on implementation commit 29eb41c: all Go packages, 501 Node unit tests, and 31 browser tests passed; one generated-review-sheet browser test skipped. No deployment was performed.

**Assessment:** READY FOR INDEPENDENT REVIEW. Production boundary remains none, repository change only.

## Hostile review and system forensics (2026-10-15)

**Authority:** issue #49, re-read before review and reassessment. **Complete implementation diff:** 1a581c5...29eb41c, three files and one commit. The review correction below updates this same record only. **Roles:** adversarial reviewer, remediator, revalidator, fresh complete-diff reviewer, release assessor. This is author engineering, not independent review.

### Evidence inventory and reconstruction

Evidence inspected: complete Git diff; builder, template, browser test and helpers; CI build/restore workflow; complete failed and passing CI logs captured under `.run/issue49-review-{failed,passing}-ci.log`; archived historical build; local controlled-test logs. CI metadata binds the failed run to cee720f and the passing run to 29eb41c.

| Boundary | Evidence | Status |
|---|---|---|
| Catalog to group values | `buildFacets` counts nonempty values, ranks them, and caps only producer/region/varietal at 12. `TestBuildFacetsSeedCardinality` supplies independently known cardinalities. | Proven |
| Group values to static HTML | `portfolio.html.tmpl` renders `.Values`, `.Total`, and keyed controls. Its Git blob and `build.go`'s blob are identical at cee720f and 29eb41c. Historical HTML has 12/12/12/29/26 rows across producer/region/varietal/vintage/country. | Proven |
| HTML to browser DOM | Test disables JavaScript before navigation. Corrected assertion passes on the historical build and current catalog, and on real fixture builds at cardinalities 0, 3, 12, 13, and 32 per facet. The last fixture renders 100 inputs. | Proven |
| DOM to original test verdict | Failed CI at 00:23:16 CDT reports `got 91 inputs`; local re-execution of the original test on historical HTML reproduces exactly that failure. 12 + 12 + 12 + 29 + 26 = 91. | Proven: first failing boundary |
| DOM to corrected verdict | On the same historical HTML, the corrected test passes. Passing Linux CI at 00:56:27 CDT reports 31 passed, 0 failed, 1 skipped, versus 30/1/1 in the failed run. | Proven |

**Cause ranking:** stale aggregate ceiling is proven by the same-build old/new assertion experiment. An uncapped big group and duplicate inputs are contradicted by the historical DOM's exact group sizes and unique values. Attribution to timeout-recovery code is contradicted by identical builder/template/client source across the relevant commits. Catalog data blobs differ between the two CI runs, so their green/red contrast alone is not the controlled experiment; the same-historical-build comparison supplies that control. The historical page is correct under the seeded-facet contract; this does not claim that all catalog metadata has been independently audited.

**Evidence boundary:** the scoped path is observed through the browser verdict. The issue's broader claims about production processors and nightly workflows were not independently investigated here; neither is required to explain this failure. No production behavior, deployment, Salesforce input accuracy, or live-site acceptance is inferred from these test results.

### Iteration 1: findings and attacks

| Finding | Severity | Genuineness | Failure scenario and disposition |
|---|---|---|---|
| Assessment still says hostile review was not performed and Linux CI was unverified | Minor | Genuine non-blocking, corrected | A reader would receive obsolete review/CI status after this pass; update the assessment with the observed result and review limitations. |

No genuine Critical or Important code findings. Challenges covered per-group rather than aggregate bounds; empty and under-cap groups; at/above-cap expander behavior; uncapped country/vintage growth; unique rows and checkbox/label keys; counts in every group; missing/stray controls; and preservation of production source/data. Existing Go ranking, tie-break, vintage-order, and group-flag tests cover those separate ordering/display invariants. The browser assertion checks positive integer counts and template coherence; it is not a complete catalog-count audit.

### Remediation, invalidation, and revalidation

Only the stale evidence paragraph was corrected; no implementation or test changed. Existing code-test results remain applicable to the identical source, and CI is tied to implementation commit 29eb41c rather than claimed for a later documentation commit.

- `go test ./internal/build -run '^TestBuildFacets' -count=1`: exit 0, 0.683s.
- `node .run/issue49-mutations.mjs`: exit 0; seven expected failures caught: missing producer seed row, blank producer count, wrongly keyed expander, blank country count, duplicate country row, checkbox/label mismatch, and stray input. Each modified only scratch HTML, restored in `finally`.
- `node --test --test-name-pattern='renders a seeded' .run/issue49-base/tests/e2e/filter-rail-original.test.js`: expected exit 1 with `got 91 inputs`. This is a preserved incident detector, not the corrected test.
- Same command against `.run/issue49-base/tests/e2e/filter-rail.test.js`: exit 0, one selected test passed (14 intentionally excluded by name pattern). This is the fix loop on the same historical build.
- Real-build boundary experiments: `go run .run/issue49-review-build-fixtures.go`, then the selected browser test copied with its normal helpers into `.run/issue49-review-fixture-{0,3,12,13,32}/tests/e2e/`. All five built and passed; production data/templates/assets were not edited.
- Selected no-JS browser test on the current full build: exit 0, one passed, 14 excluded by name pattern. These targeted exclusions are separate from the one existing skip in the full 31/0/1 browser run.
- Full Linux CI at 29eb41c independently confirms the all-package Go, Node unit, and full-browser results above. No Actions run was rerun.

### Fresh complete-diff rereview and assessment

Re-read the complete diff against origin/master, including this record, after the documentation correction. No code finding or unresolved Minor remains. Seven broken-rendering experiments demonstrate retained rejection behavior; five real-build boundary experiments demonstrate that valid catalog sizes are accepted. The diff remains confined to two test files and this evidence record, with no whitespace errors.

**Outcome:** READY FOR INDEPENDENT REVIEW. Author review and Linux CI are complete; independent human review is not claimed. The PR remains a draft. No merge, deployment, new product restriction, or new workflow gate is part of this work.

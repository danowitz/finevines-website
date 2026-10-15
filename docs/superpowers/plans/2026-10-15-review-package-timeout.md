# Review-package timeout recovery

Authority: the user instructed: review the two local commits, fix the timeout, test, deploy, and verify both the review processor and nightly pipeline finish successfully.

Tracking: https://github.com/danowitz/finevines-website/issues/47

- Base/branch: `18bd0f2` on `codex/review-package-timeout`. Preserve original checkout `620bb4a` and its existing commits.
- Objective: stop rereading/reuploading immutable carried candidate images on every publication, retain working image reads and complete pending review actions within the existing two-minute publication limit.
- Owned: review package publisher, Edge/Go candidate readers, tests, and the reviewed local sender-normalization changes needed for the nightly digest to finish. Review both `96ba953` and `620bb4a`; preserve already-merged fixes when integrating.
- Preserved: candidate/wine identity, access control, hash/size checks, reviewer decisions, credentials, catalog eligibility, image-model choices, publication ordering and existing deadlines/schedules. No new product/workflow gates.
- Feedback loop: an isolated 350-wine carried-package refresh must transfer zero existing image bytes and preserve original storage-package references across multiple successor publications. Test legacy readers, invalid pointers, mixed new/carried images, and interruption before moving current.json.
- Production target/bounds: FineVines production review console and existing GitHub review/catalog workflows on `master`. Deploy the backward-compatible Edge reader before activating the publisher; run the standard catalog pipeline after the retry loop drains. Normal workflow effects and model requests are authorized by the user's requested end-to-end acceptance; no independent model experiment or credential/billing/schedule changes.
- Acceptance: focused and applicable suites pass; production console deploy is recorded; review refresh completes within 120 seconds and review workflow is green; one normal invocation of the nightly pipeline finishes green through both package publications and the digest. Record source SHA, timings, failures and partial effects honestly.
- Rollback: revert the publisher first while retaining reader support. Existing immutable images/packages remain available. Reverting readers first could break manifests with cross-package references and is not a valid rollback order. No data deletion is required.
- Stop conditions: actual user cancellation, target/revision mismatch, unknown destructive effects, conflicting work, or essential missing access. Routine faults in this authorized recovery are diagnosed, tested and corrected.

## Initial evidence

Production run `38684523675` at `18bd0f2`: build/deploy passed at 05:02:25 UTC; package refresh ran from 05:02:26 to 05:04:26 and exited 124. Repeated failed review runs replace pending catalog runs in their shared concurrency group. Publisher currently downloads and uploads every carried candidate serially. The two local commits propose reader compatibility and immutable-image references; their claims require offline and live verification.

## Validation and deployment record

Author review (not independent review): reviewed the complete diff against `18bd0f2`, including both original local commits, under the hostile-review workflow. Challenged legacy manifests, three successor generations, path traversal in both readers, hash/size checks, new/carried mixed publication, interruption before current.json, shared-workflow ordering, and SMTP envelope/header normalization. One Important finding: skipping every candidate without localFile could silently publish an incomplete new candidate. Corrected it to skip only candidates with an existing immutable storage reference, with a regression that failed before the correction. No remaining Critical/Important findings on complete-diff rereview. No Minor findings deferred.

Validation on Windows, Node 20.18.0 / Go 1.26.3:

- `node --test tests/unit/review-package-refresh.test.js`: three passed, including 350 wines over three refreshes with zero carried image reads/writes. The scale regression failed on the untouched base with 350 reads.
- `node --test tests/unit/review-package-refresh.test.js tests/unit/review-package.test.js tests/unit/review-console-handler.test.js tests/unit/review-console-adapters.test.js tests/unit/review-queue.test.js tests/unit/pipeline-failure-alert.test.js`: 66 passed before the additional mixed/interruption test; all changed runtime code covered.
- All Node unit files except `commitback.test.mjs`: 490 passed on the final diff. The excluded Bash/Git tests previously failed identically on the untouched base on Windows because drive paths are interpreted as SSH remotes; full Linux CI remains the platform check.
- `go test ./internal/reviewactions ./internal/notify`: passed after correcting a typo in the new traversal test.
- `node --test tests/e2e/review-processing-lifecycle.test.js tests/e2e/review-confirm.test.js`: six passed, one skipped because no generated offline review sheet exists. Real browser/Go processor lifecycle cases passed, including concurrency, receipts, deadline yield and operational failure.
- `npm run build:review-console`: passed. `git diff --check`: passed.
- Full Go suite is running; production console deployments and end-to-end workflow acceptance are pending.

Release assessment: repository tests and author review support deploying the backward-compatible reader first under the user's explicit authority. Production acceptance remains unproven until live workflows finish; no completion claim is made. Rollback ordering is source-reviewed and failure/interruption behavior is tested in memory, not exercised as a live rollback.

# OpenAI vision model retirement migration

- Authority: the user's October 14 instruction to proceed with the investigation's recommendations. Repository-only implementation; no deployment, schedule changes, billing changes, or paid requests.
- Base: `origin/master` at `9c6ecf5b13761fb75b227b49735411df5abff8b1`; branch `codex/finevines-model-retirement`. Preserve the original checkout's two local review-package commits.
- Objective and owned scope: replace the default GPT-4.1 nano requests in label selection, watermark checks, and review screening with `gpt-5.6-luna`; update the manual comparison defaults, focused tests, and operator guidance.
- Preserved scope: prompts, identity/import rules, historical provenance, catalog/assets, credentials, deployments, schedules, and GPT-4.1 wine/collection enrichment. Product-image generation stays disabled. No ADR is needed for this reversible model substitution within the existing APIs.
- Acceptance: all three default requests select Luna with explicit `reasoning_effort: none`; label CLI/environment precedence and mini rollback remain compatible; image bounds, schema and existing failure behavior remain intact. No real service calls in tests.
- Validation: mocked request tests plus isolated CLI tests for watermark/review response and HTTP-error behavior; existing Node unit suite and image-generation-disabled Go tests. No live quality, latency, cost or production verification.
- Rollback: switch the shared default to `gpt-4.1-mini` and the comparison workflow choice/default to mini; rerun offline tests. Mini must omit reasoning parameters. Do not revert to nano after October 23. Preserve existing catalog/assets; restore an approved image snapshot only if a later authorized deployment changed it incorrectly.
- Stop conditions: user cancellation, an unresolved scope/product decision, unavailable essential evidence, conflicting work, or required actions outside this repository-only authorization. Routine implementation/test failures are corrected locally.

## Source documentation

- https://developers.openai.com/api/docs/deprecations: nano and its April 14 snapshot shut down October 23, 2026; recommended replacement is GPT-5.6 Luna. GPT-4.1 and mini have a separate January 14, 2027 deadline.
- https://developers.openai.com/api/docs/models/gpt-5.6-luna: image input, Chat Completions, structured outputs; reasoning defaults to medium and supports none. Standard text input/output pricing is $0.20/$1.20 per million tokens.
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create: completion limits include reasoning tokens.

## Verification record

Implemented all three vision defaults and the manual comparison defaults. Historical nano provenance and explicitly selected legacy overrides remain intact.

Verified on Windows, Node v20.18.0 / Go 1.26.3:

- `node --test tests/unit/vision-model-migration.test.js tests/unit/bottle-selector-runtime.test.js tests/unit/bottle-selector.test.js tests/unit/watermark.test.js tests/unit/importrules.test.js tests/unit/autonomous-workflow.test.js`: 104 passed, zero failed.
- `node --test tests/unit/`: 495 tests, 484 passed, 11 failed. All failures are in unchanged `commitback.test.mjs`; its Bash/Git fixture interprets Windows drive paths as SSH remotes (`Could not resolve hostname c`).
- Baseline `node --test tests/unit/commitback.test.mjs` in the untouched original checkout: the same 11 tests fail. This migration does not modify the fixture or commit-back script.
- `go test ./internal/enrich ./internal/openairesponses ./internal/collectioneditorial`: all three packages passed, including the generation-disabled invariant.
- `git diff --check`: passed.

Author adversarial review covered the complete diff: all live request paths, schema/image bounds, reasoning/token limits, CLI/environment precedence, mini rollback, unresolved watermark errors, permissive review-screen errors, legacy import provenance, and the disabled generator. A minor rollback coupling was corrected: the supported-model set keeps Luna explicitly rather than deriving membership from the default, so changing the default to mini does not remove Luna as an explicit option. Fresh complete-diff rereview found no remaining genuine Critical or Important findings. This is author review, not independent review.

Assessment: **READY FOR INDEPENDENT REVIEW** for the repository change, with the baseline Windows test limitation above. No production action was performed. Runtime quality, latency, billing and deployment acceptance remain unverified until a separately authorized evaluation and normal-run observation. GPT-4.1 enrichment migration remains separate January work.

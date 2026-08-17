## Parent

#28

## What to build

Introduce one transactional review-state seam and route the existing authenticated image-selection path through it while preserving immutable object evidence. Provide production and deterministic local adapters so the same public behavior can be exercised without live infrastructure.

## Acceptance criteria

- [ ] Action creation and active wine-lock acquisition occur in one transaction.
- [ ] Lifecycle state and append-only transition evidence are queryable independently of browser state.
- [ ] Immutable action/image writes and transactional state have an explicit reconciliation contract for partial failure.
- [ ] The local adapter supports deterministic concurrency and time-based tests.
- [ ] Existing protected-response, CSRF, origin, stale-revision, image-integrity, and immutable-object behaviors remain green.

## Blocked by

None.

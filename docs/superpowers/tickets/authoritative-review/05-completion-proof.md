## Parent

#28

## What to build

Make completion a verified outcome: isolate action-specific failures, preserve work across operational failures, deploy accepted images, fetch them from the active target, verify the expected content hash, and finalize idempotent receipts and locks only afterward.

## Acceptance criteria

- [ ] Invalid, stale, conflicting, or undecodable actions move individually to Needs attention while unrelated actions continue.
- [ ] Shared storage, normalizer execution, build, commit, deployment, and verification failures abort safely and retain pending work.
- [ ] Completed requires decode, normalization, authoritative commit, deployment, fetch-back, and expected content-hash equality.
- [ ] Receipt upload precedes pending removal and lock release.
- [ ] Repeated processing cannot apply an action twice or manufacture a second completion.
- [ ] A mismatched or unreachable deployed image prevents completion.

## Blocked by

#32.

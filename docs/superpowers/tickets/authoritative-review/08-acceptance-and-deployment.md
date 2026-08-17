## Parent

#28

## What to build

Complete the mandatory local end-to-end acceptance gate, saved diagnostic traces, production provisioning checks, obsolete-path removal, and deployment migration needed to operate the authoritative launch queue on `.biz`.

## Acceptance criteria

- [ ] The real HTTP handler, transactional local state, filesystem immutable storage, and real review processor pass the complete approved acceptance matrix.
- [ ] GitHub, Bunny deployment, discovery, clock, and email are replaced only at external adapter boundaries.
- [ ] Saved traces explain every lifecycle transition and failure.
- [ ] Local tests prove no real email delivery.
- [ ] Provisioning requires every credential and fails a real non-mutating processing-trigger check when configuration is incomplete.
- [ ] Standards and Spec reviews report no unresolved blockers.
- [ ] The branch is committed, pushed, merged, deployed to `.biz`, and the live review flow is verified before completion is claimed.

## Blocked by

#33, #34, and #35.

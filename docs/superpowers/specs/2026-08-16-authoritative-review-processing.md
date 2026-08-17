# Authoritative Image Review Processing

**Date:** 2026-08-16
**Status:** Approved for implementation
**Supersedes:** The environment split, shared-password authentication, test-only action processor, and nightly review fallback in the earlier protected review-console design.

## Problem Statement

Fine Vines staff are performing real launch-catalog image review on `review.finevines.biz`, but the current system treats that hostname as a validation-only test environment. A reviewer click can write durable storage objects without successfully starting a GitHub Actions consumer, the browser's remaining count is not authoritative, other open reviewer screens do not synchronize, and completion is not proven by fetching the deployed image. The split between a test action workflow and the nightly production pipeline creates two operational paths, one of which currently has no reliable consumer.

The launch catalog must not require a second review when the public hostname changes to `finevines.com`. Review work must be durable, autonomous, observable, concurrency-safe, recoverable, attributable to an authenticated person, and locally testable without sending email or touching live infrastructure.

## Solution

Create one queue-driven review-processing system for the authoritative launch catalog. A submitted review action is durable work; an immediate processing trigger only reduces latency. One review processor scans all pending work after an immediate trigger, every five minutes, or on manual request. It processes at most fifty actions per deployment, immediately continues while more work remains, and uses one concurrency lock.

The review console authenticates individual Executive and Back Office users, plus an explicitly managed support account. A transactional review-state store owns accounts, sessions, per-wine locks, lifecycle status, incident state, and rejected-candidate history. Immutable action and image bytes remain in object storage. The console synchronizes visible, focused tabs and exposes durable counts for **Needs decision**, **Queued**, **Processing**, **Completed**, and **Needs attention**.

An accepted image becomes **Completed** only after it is decoded, normalized, committed to the authoritative branch, deployed to the current deployment target, fetched back, and matched to the expected content hash. Before production cutover, the deployment target is `.biz`; the exact completed launch catalog then moves to `.com` without repeating review. After cutover, `.biz` remains a development site with non-production state.

## User Stories

1. As a reviewer, I want my own login, so that my decisions are attributable to me.
2. As a reviewer, I want to change my temporary password before accessing review work, so that emailed credentials cannot remain permanent.
3. As a reviewer, I want my session to identify me automatically, so that I cannot accidentally submit under another person's name.
4. As an administrator, I want eligible reviewers discovered from the current Executive and Back Office roster, so that account eligibility follows the business roster.
5. As an administrator, I want newly discovered reviewers to remain invitation-pending, so that an accidental role assignment does not send credentials or grant access.
6. As an administrator, I want to activate and invite a pending reviewer deliberately, so that access grants are controlled.
7. As an administrator, I want reviewer access and sessions revoked when roster eligibility is removed, so that former users cannot continue reviewing.
8. As a support operator, I want the explicitly approved support account to remain manageable outside the Salesforce roster, so that production support remains possible.
9. As a reviewer, I want the system to lock a wine when a decision is queued or processing, so that another reviewer cannot replace my decision.
10. As a second reviewer, I want a stale same-wine submission rejected clearly, so that I know another reviewer already handled it.
11. As a second reviewer, I want to continue reviewing different wines independently, so that one person's work does not block the whole queue.
12. As a reviewer, I want my visible and focused review tab to refresh every ten seconds, so that I see other reviewers' decisions promptly.
13. As a reviewer, I want background synchronization paused, so that hidden tabs do not consume unnecessary requests.
14. As a reviewer, I want an immediate refresh when I return to the tab, so that stale cards disappear before I act.
15. As a reviewer, I want a selected card removed only after the server accepts the durable action and lock, so that UI optimism never loses work.
16. As a reviewer, I want server-backed status counts, so that refreshing or changing computers does not reset progress.
17. As a reviewer, I want to see the oldest pending age, so that I can recognize stalled processing.
18. As a reviewer, I want unresolved alerts to remain visible, so that dismissal cannot hide unfinished launch work.
19. As a reviewer, I want to choose **None of these**, so that incorrect candidates are not forced into the catalog.
20. As a reviewer, I want rejected candidates excluded from later suggestions, so that the same failed set does not cycle back.
21. As a reviewer, I want broader discovery to run automatically after **None of these**, so that manual rejection advances the work.
22. As an administrator, I want a wine moved to **Needs attention** when broader discovery finds nothing new, so that the dead end is explicit.
23. As an administrator, I want safe recovery controls, so that I can retry, reopen, rediscover, or temporarily exclude a wine.
24. As a catalog owner, I want no manual completion override, so that every accepted image has deployment proof.
25. As a catalog owner, I want an immediate processor start after submission, so that normal decisions move quickly.
26. As a catalog owner, I want a five-minute queue scan, so that missed triggers cannot strand work.
27. As a catalog owner, I want every processor start to scan the complete pending queue, so that trigger payloads are not treated as the work itself.
28. As a catalog owner, I want batches limited to fifty actions per deployment, so that runs remain bounded.
29. As a catalog owner, I want an immediate continuation when more than fifty actions remain, so that throughput does not wait for the schedule.
30. As an operator, I want processing bounded at forty-five minutes, so that a stuck run yields safely to a continuation.
31. As an operator, I want one concurrency lock, so that two review deployments cannot race.
32. As an operator, I want malformed or stale actions isolated into **Needs attention**, so that one bad decision does not stop unrelated work.
33. As an operator, I want shared storage, build, commit, or deployment failures to stop the batch without losing pending work, so that infrastructure recovery can retry safely.
34. As an operator, I want queued work older than ten minutes flagged as stalled, so that a missing processor is visible.
35. As an operator, I want processing older than forty-five minutes retried safely, so that work converges after interrupted runs.
36. As an operator, I want one deduplicated incident email and one recovery email, so that failures are visible without retry spam.
37. As an operator, I want one escalation after four unresolved hours, so that long failures are not forgotten.
38. As a developer, I want pre-production incident email routed to Joel, so that Fine Vines staff receive no development noise.
39. As a production operator, I want post-cutover incident email routed to Barb, so that the business owns live exceptions.
40. As a user receiving an invitation, I want a unique temporary password that expires after seventy-two hours, so that onboarding credentials have limited value.
41. As an administrator, I want resending an invitation to invalidate the prior password, so that only the newest invitation works.
42. As a developer, I want local email captured by a mail sink, so that automated tests can assert messages without contacting real recipients.
43. As a catalog owner, I want a durable completion receipt containing commit, deployment, action, and image evidence, so that completion is auditable.
44. As a catalog owner, I want the deployed image fetched and hash-checked before completion, so that a successful build or upload is not mistaken for a live result.
45. As a catalog owner, I want current `.biz` review work to form the launch catalog, so that cutover does not repeat review.
46. As a catalog owner, I want submissions paused and the queue drained before cutover, so that no decision is lost between hostnames.
47. As a catalog owner, I want every action resolved and the launch catalog verified before cutover, so that `.com` starts from known-good state.
48. As a developer, I want `.biz` to become development-only after cutover, so that future experiments cannot mutate production review state.
49. As a developer, I want complete saved traces for every local transition, so that failures can be diagnosed from evidence rather than guesses.
50. As a release owner, I want a mandatory local end-to-end acceptance gate, so that `.biz` changes only after the entire behavior is proven without live side effects.

## Implementation Decisions

- The launch catalog has one authoritative review queue. `.biz` is its current pre-production deployment target; `.com` becomes the deployment target at cutover. Completed actions are not recreated or migrated.
- After cutover, `.biz` is a development site with separate non-production review state.
- The review console remains a deep HTTP module with adapters for transactional state, immutable object storage, processing triggers, password hashing, sessions, time, and email.
- A transactional review-state store is required because object storage does not provide the atomic conditional-write contract needed for real per-wine locks. It owns reviewer accounts, credential versions, session revocation, review actions, unique active wine locks, lifecycle events, incident deduplication, and rejected-candidate identities.
- Immutable action records, candidate images, reviewer-pasted bytes, packages, and completion receipts remain in object storage for auditability and large-object handling.
- The state store and immutable objects are linked by server-generated action IDs and content hashes. Partial writes are reconciled; they are never presented as completed.
- The state machine is **Needs decision → Queued → Processing → Completed**, with **Needs attention** as the explicit exceptional state. Lifecycle transitions are server-authorized and append trace events.
- A unique active lock on wine revision is acquired transactionally with action creation. Locks are released only by completion proof, deliberate reopening after **Needs attention**, or recorded temporary launch exclusion.
- The authenticated session supplies reviewer identity. Client-provided reviewer names are removed from action contracts.
- Reviewer eligibility is sourced from active Salesforce users in the Executive and Back Office roles. The support account is an explicit managed exception.
- Newly eligible users become invitation-pending. An administrator must activate and send the invitation.
- Production passwords are slow-hashed server-side. A random temporary password is single-use, expires after seventy-two hours, and forces password change before review access. Resend rotates the credential.
- Local-only test accounts may use `password`; production accounts may not.
- Production invitations are an explicit activation operation and never a deploy/build side effect.
- Local and development email use a non-delivering adapter. Incident delivery routes to `joel@gritautomation.com` while `.biz` is the pre-production target and `barb@finevines.com` after `.com` cutover. Reviewer invitations go to their individual account emails.
- The browser refreshes authoritative state immediately after mutations and every ten seconds only when `document.visibilityState` is visible and the window has focus. It refreshes immediately on visibility/focus return.
- Same-wine stale submissions return a conflict response and refresh the card. Different-wine actions remain independent.
- **None of these** stores the rejected candidate set and schedules broader discovery. Only genuinely new candidate identities may repopulate the wine.
- One dedicated review processor workflow owns review work. Immediate repository dispatch, a five-minute schedule, manual dispatch, and continuation all invoke the same queue-drain path.
- The nightly catalog workflow remains separate and cannot act as the review queue's recovery mechanism. The obsolete validation-only review processor is removed.
- The review processor claims no more than fifty pending actions, runs under one deployment concurrency group, and immediately requests continuation while pending work remains.
- A run stops claiming new work at forty-five minutes. Claimed actions remain recoverable and a continuation begins immediately; the five-minute scan is the final recovery path.
- Action-specific invalid, stale, conflicting, or undecodable input becomes **Needs attention** without aborting unrelated actions. Shared operational failures abort the current batch and leave unproven work pending.
- **Completed** requires valid decode, normalization, authoritative commit, deployment to the current target, successful fetch-back, exact expected content hash, durable completion receipt, and then removal of the pending pointer and active lock.
- Receipt creation and pending removal are ordered and idempotent. A repeated processor run cannot apply the same action twice.
- Queued age over ten minutes and processing age over forty-five minutes open an incident. The UI alert cannot be dismissed while unresolved. Email is deduplicated to incident-open, four-hour escalation, and recovery.
- Administrators can retry, reopen, rediscover, or temporarily exclude with a reason. No interface can synthesize completion proof.
- Cutover pauses submissions, drains and resolves the queue, verifies every completion receipt and the current `.biz` catalog, deploys the exact catalog to `.com`, verifies it, changes the deployment-target configuration, and only then reopens review.

## Testing Decisions

- Tests assert externally visible behavior at the highest practical seam: the actual review-console HTTP handler, a transactional local review-state adapter, filesystem-backed immutable storage, and the real review processor. Only GitHub dispatch, Bunny deployment, source discovery, clock, and email delivery are substituted.
- Unit tests remain appropriate for cryptographic/session primitives, image-integrity validation, state transition guards, candidate-set identity, and adapter error classification.
- Contract tests verify that all workflow triggers call the same queue-drain command, that the review workflow owns a single concurrency group, that the batch and time limits are present, and that the nightly catalog path cannot process review actions.
- Browser tests exercise login, forced password change, card selection, same-wine conflicts, independent wines, focus-aware synchronization, durable counters, modal/recovery behavior, and persistent incidents.
- Processor tests exercise action-specific isolation, operational abort/retry, idempotency, continuation, receipt ordering, and deployed-image hash mismatch.
- Notification tests use a local capture adapter and assert no network delivery, recipient routing, incident deduplication, escalation, recovery, invitation expiry, and credential rotation.
- The mandatory local end-to-end suite proves two concurrent reviewers, immediate-trigger failure plus scheduled recovery, fifty-action batching plus continuation, forty-five-minute yielding, invalid-image isolation, operational preservation, exact fetch-back verification, rejected-candidate rediscovery, and complete saved traces.
- Existing immutable-action, image-normalization, protected-response, CSRF, origin, crawler-exclusion, and stale-revision tests remain regression requirements.
- A live `.biz` deployment is not authorized by passing unit tests alone. The full local acceptance gate and Standards/Spec reviews must pass first.

## Out of Scope

- Public account signup, self-service email password reset, social login, or customer-facing review access.
- Giving Sales Rep users review access unless the business explicitly changes reviewer eligibility.
- Replacing Salesforce as the reviewer-roster authority.
- Replacing Bunny as the current hosting and immutable-image storage provider.
- Reworking the wine identity/search pipeline beyond the agreed rejected-candidate rediscovery behavior.
- Production-domain cutover itself; this spec establishes its gate and preserves launch work, but DNS activation remains a separately verified operation.
- Sending real invitations or incident email during local development or before explicit production-account activation.

## Further Notes

- The current repository is `danowitz/finevines-website`; GitHub Actions and secrets belong to that repository, not to a Fine Vines employee's personal GitHub account.
- The existing protected review console, immutable action records, Go image normalization, review prepare/finalize boundary, and candidate-package publication are retained where their contracts remain valid.
- The earlier assumption that `.biz` actions are validation-only is explicitly reversed. Work performed there before cutover is authoritative launch work.

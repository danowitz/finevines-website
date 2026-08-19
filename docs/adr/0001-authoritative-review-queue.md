# ADR-0001: One authoritative, queue-driven image review system

**Status:** Accepted
**Date:** 2026-08-16

## Context

FineVines is completing real launch-catalog image review on `review.finevines.biz` before moving the same catalog to `finevines.com`. The existing design separates test and production action processors, treats an Edge-to-GitHub dispatch as the primary execution path, and stores coordination in object storage. That left accepted `.biz` actions without a reliable consumer when the dispatch credential was absent and cannot provide an atomic per-wine lock for simultaneous reviewers.

## Decision

Use one authoritative review queue for launch work and one dedicated queue-driven GitHub Actions processor. Immediate dispatch, a five-minute schedule, manual start, and continuation all invoke the same queue scan. The processor handles at most fifty actions per deployment under one concurrency lock and yields after forty-five minutes.

Use a transactional review-state store for reviewer accounts, active wine locks, lifecycle status, incident deduplication, and rejected-candidate history. Continue using immutable object storage for packages, image bytes, action evidence, and completion receipts.

Before cutover, `.biz` is the deployment target for authoritative launch work. Cutover drains the queue and deploys the already-reviewed catalog to `.com`; it does not repeat review. After cutover, `.biz` becomes a separate development environment.

## Consequences

- A processing trigger improves latency but never owns work or proves completion.
- Simultaneous decisions for one wine can be rejected atomically while unrelated wines proceed.
- Review state becomes queryable and durable across browsers.
- The review system gains a transactional service dependency in addition to object storage.
- Completion remains tied to immutable receipts and deployed-image hash verification.
- Nightly catalog enrichment remains operationally separate from review processing.
- The obsolete validation-only review processor and shared-password reviewer identity are removed.

## Rejected alternatives

- **Object-storage lock files:** the documented upload contract does not guarantee atomic create-if-absent behavior, so two Edge requests could both acquire the same apparent lock.
- **Trigger-driven processing:** a missing credential or failed dispatch can strand durable work.
- **Nightly-only recovery:** delays accepted decisions and previously scanned the wrong environment.
- **Repeat review after cutover:** wastes completed work and introduces avoidable divergence between `.biz` and `.com`.

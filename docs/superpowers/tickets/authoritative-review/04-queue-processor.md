## Parent

#28

## What to build

Create one queue-driven review processor used by immediate dispatch, five-minute schedule, manual start, and continuation. Drain bounded batches under one deployment concurrency lock without relying on nightly catalog processing.

## Acceptance criteria

- [ ] Every trigger invokes the same complete queue scan and drain command.
- [ ] No batch claims more than 50 actions.
- [ ] Remaining work starts an immediate continuation rather than waiting five minutes.
- [ ] Processing yields safely at 45 minutes and remains recoverable.
- [ ] One workflow concurrency group prevents overlapping review deployments.
- [ ] The nightly catalog workflow cannot process or rescue review actions.
- [ ] The validation-only review workflow is retired.

## Blocked by

#29 and #31.

## Parent

#28

## What to build

Make concurrent review safe and observable: enforce one active action per wine revision, allow different wines independently, expose durable status counts and oldest age, and synchronize only visible focused review tabs.

## Acceptance criteria

- [ ] Two simultaneous same-wine submissions produce exactly one queued action and one clear conflict response.
- [ ] Simultaneous different-wine submissions both queue successfully.
- [ ] Queued cards disappear only after server acceptance.
- [ ] Needs decision, Queued, Processing, Completed, and Needs attention counts survive refresh and other browsers.
- [ ] The client refreshes after mutations, every 10 seconds while visible/focused, and immediately on focus return; background polling stops.
- [ ] Client-provided reviewer identity is rejected or ignored in favor of the session.

## Blocked by

#29 and #30.

## Parent

#28

## What to build

Add persistent incident visibility, deduplicated notification, reviewer invitation administration, and safe recovery controls without permitting a manual completion bypass.

## Acceptance criteria

- [ ] Queued actions older than 10 minutes and Processing actions older than 45 minutes open incidents.
- [ ] Unresolved incident banners cannot be dismissed and identify wine, reason, age, and next action.
- [ ] Email sends once on open, once after four unresolved hours, and once on recovery.
- [ ] `.biz` pre-production incidents route to `joel@gritautomation.com`; post-cutover `.com` incidents route to `barb@finevines.com`.
- [ ] Administrators can activate/resend invitations and retry, reopen, rediscover, or temporarily exclude a wine with a reason.
- [ ] No action can be manually marked completed.

## Blocked by

#30, #31, and #32.

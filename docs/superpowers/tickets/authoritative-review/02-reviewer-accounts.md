## Parent

#28

## What to build

Replace the shared review password and user-selectable name with individual administrator-managed reviewer accounts, forced first-login password change, roster discovery, invitation-pending state, and locally captured invitation delivery.

## Acceptance criteria

- [ ] Eligible Executive and Back Office users are discovered; `joel@danowitz.com` is an explicit support exception.
- [ ] Newly discovered accounts cannot authenticate until an administrator activates and invites them.
- [ ] Production invitation credentials are unique, expire after 72 hours, rotate on resend, and force password change.
- [ ] Passwords are slow-hashed and reviewer identity comes only from the authenticated session.
- [ ] Loss of eligibility revokes access and active sessions.
- [ ] Eligible reviewers can request a non-disclosing, rate-limited, single-use 60-minute password-reset link; credential rotation invalidates outstanding links and successful reset revokes active sessions.
- [ ] Local tests cannot deliver email to real recipients.

## Blocked by

#29 — Introduce transactional review state.

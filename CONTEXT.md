# Fine Vines Catalog

Fine Vines maintains a public wine catalog whose bottle photographs may be proposed automatically or supplied by an authorized reviewer.

## Language

**Review candidate**:
A proposed bottle image bound to one wine revision and presented for an explicit human decision.
_Avoid_: Option, result

**Reviewer-supplied candidate**:
A review candidate pasted by an authorized reviewer. The reviewer's explicit selection is authoritative proof that its pixels depict the intended wine, so a source URL and automated image-identity gates are not required.
_Avoid_: Unverified candidate, source-less upload

**Discovery query**:
The exact image-search string recorded by the pipeline run that produced a wine's review candidates. The review console preserves it verbatim for its Google Images link instead of reconstructing it from catalog fields.
_Avoid_: Search hint, improved query

**Queue reviewer image**:
The single operation initiated by **Use this image** that immutably stores the pasted image and creates its bound review action. A paste remains browser-local until this operation succeeds.
_Avoid_: Upload then approve

**Review action**:
An authorized reviewer's durable decision about one wine revision. It remains pending until completion proof records its final outcome.
_Avoid_: Click, dispatch, queue message

**Pending review action**:
A review action that has no completion proof yet and must remain discoverable by the review processor regardless of whether a processing trigger succeeds.
_Avoid_: Failed dispatch, browser queue

**Review batch**:
A bounded set of pending review actions completed together as one catalog deployment. Additional pending actions form the next review batch rather than enlarging a batch already in progress.
_Avoid_: Workflow run, click group

**Review processor**:
The single GitHub Actions workflow that drains the authoritative review queue in batches of at most fifty under one concurrency lock. Immediate processing triggers, five-minute scheduled scans, manual starts, and immediate continuation runs all invoke the same processing path. Nightly catalog discovery remains a separate workflow and never owns or rescues review actions.
_Avoid_: Test-only processor, nightly fallback, trigger-specific processing

**Rejected candidate set**:
The durable record created when a reviewer chooses **None of these**. Its candidate identities are excluded from later suggestions for that wine revision, and the wine automatically enters broader discovery. It returns to review only with genuinely new candidates; no new result moves it to **Needs attention**.
_Avoid_: Dead-end rejection, repeat candidate set

**Review recovery action**:
An administrator's explicit instruction to retry processing, reopen a wine for a new decision, run broader discovery, or temporarily exclude the wine from launch with a recorded reason. No recovery control may manufacture completion proof or mark an unverified action completed.
_Avoid_: Mark completed, silent discard, verification bypass

**Local review acceptance gate**:
The mandatory end-to-end suite that must pass before the live `.biz` workflow changes. It proves individual login and forced password change, non-delivering test email, concurrent-review locks, independent wines, trigger-failure recovery, fifty-action batching and continuation, action-specific versus operational failure handling, deployed-image hash verification, durable status and incident UI, rejected-candidate rediscovery, and complete diagnostic traces.
_Avoid_: Production smoke test, unit-tests-only approval

**Completion proof**:
A durable record proving that an accepted image was decoded, normalized, committed to the authoritative branch, deployed to the current deployment target, and fetched back with the expected content hash. Only this proof removes the action from pending work.
_Avoid_: Successful click, successful upload, workflow started

**Review status**:
The durable lifecycle position of a review action: **Needs decision**, **Queued**, **Processing**, **Completed**, or **Needs attention**. The review console derives its counters and worklist from these statuses.
_Avoid_: Browser state, pipeline message

**Processing trigger**:
A request for the review processor to inspect pending work. It may improve latency, but it neither contains the work nor proves that any review action completed.
_Avoid_: Review action, deployment, wake-up

**Authoritative review**:
A reviewer decision intended to update the launch catalog. Review work completed on the pre-production site carries forward to production and is not repeated at cutover.
_Avoid_: Test decision, disposable review

**Deployment target**:
The public site currently receiving authoritative catalog deployments. Before cutover this is `review.finevines.biz`; at cutover it becomes `finevines.com` without resetting completed review work.
_Avoid_: Review environment, decision owner

**Development site**:
The `.biz` site after production cutover. It remains available for development and validation but no longer owns the authoritative production review queue.
_Avoid_: Launch catalog, production queue

**Review-complete cutover gate**:
The production hostname may be activated only after new review submissions are paused, the authoritative review queue is empty, every submitted action has completion proof, and the resulting launch catalog has been verified on the current deployment target.
_Avoid_: Best-effort drain, migrate pending work

**Wine review lock**:
A server-enforced rule allowing at most one queued or processing review action for a wine revision. Other wines remain independently reviewable. A wine may be deliberately reopened after its action reaches **Needs attention**.
_Avoid_: Browser-only lock, silent replacement, global review lock

**Active review synchronization**:
The review console refreshes authoritative queue state immediately after a submission and every ten seconds only while its browser tab is visible and its window has focus. Synchronization pauses in the background and runs immediately when the reviewer returns.
_Avoid_: Background polling, browser-only state

**Stalled review action**:
A review action that remains **Queued** for more than ten minutes or **Processing** for more than forty-five minutes. The console exposes the oldest pending age; stalled actions remain visible and the processor retries them safely.
_Avoid_: Hidden retry, dismissed pending work

**Review incident notification**:
A persistent, non-dismissible console alert plus deduplicated email for a stalled action or an action in **Needs attention**. Email is sent once when the incident opens, once when service recovers, and once after four hours if still unresolved. The configured recipient is `joel@gritautomation.com` while `.biz` is the active pre-production deployment target and `barb@finevines.com` after `.com` cutover.
_Avoid_: Retry spam, dismissing unresolved work, hard-coded environment inference

**Reviewer identity**:
The authenticated executive or back-office account that submitted a review action. The server derives this identity from the signed session; the reviewer cannot select or alter it in the page.
_Avoid_: Your Name selector, self-reported reviewer

**Reviewer account**:
An administrator-managed login preloaded from the current Executive and Back Office roster, plus the explicit production-support account `joel@danowitz.com`. Each production account receives a unique random temporary password by email and must change it before review access is granted. Local-only test accounts may use `password`.
_Avoid_: Public signup, reviewer dropdown

**Notification transport**:
The environment-controlled delivery mechanism for review incident email. Local development uses a disabled transport or mail sink that cannot contact real recipients; live delivery is enabled only in the deployed environment.
_Avoid_: Test email to production recipients, mocked production configuration

**Reviewer invitation**:
An explicitly authorized production activation email containing one reviewer's unique temporary password. It expires after seventy-two hours, becomes invalid after the first password change, and is rotated immediately when resent. Invitations are never sent by local tests, `.biz` development deployments, or ordinary builds, and their credentials never enter logs, artifacts, or the repository.
_Avoid_: Deployment side effect, shared password, reusable invitation

**Invitation-pending account**:
An inactive reviewer account discovered from a newly eligible Salesforce Executive or Back Office user. An administrator must explicitly activate it before the system generates credentials or sends an invitation. Loss of Salesforce eligibility automatically revokes access and active sessions; explicitly managed support accounts are exceptions.
_Avoid_: Automatic access grant, automatic invitation

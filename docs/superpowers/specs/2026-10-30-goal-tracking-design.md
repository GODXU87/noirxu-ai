# Goal tracking: bounded first milestone

The user authorized implementation of remembering an assigned goal's progress, next step and deadline, and reporting a result when complete. Build on NOIRXU AI's existing non-eve stack; no new service, model, permissions or credentials.

## Existing system and gap
Tasks already execute scheduled tool steps with leases, confirmation and delivery history. Agenda handles dated to-dos; memory has a goal category but no lifecycle. Reuse encrypted, compare-and-set `settings`, the authenticated executor and proactive delivery preferences. Do not duplicate the task execution engine or migrate schema.

## Approach
A separate, bounded goal record is appropriate: a goal describes an outcome and evidence, while a task executes a specific schedule. Turning every goal into a recurring task would falsely imply work was running. Storing only memory prose cannot expose progress or stop conditions. This milestone therefore records user-reported progress (explicitly labelled, not independently verified), next step, deadline, optional next check-in, and completion evidence/result. It does not automatically research, act on external systems, or infer completion.

## Lifecycle and visibility
Create active → update progress/correct next step/deadline → optionally block or pause → complete or cancel. Updates require the current revision so stale edits cannot undo a correction. Completed/cancelled goals are terminal; completion requires result and evidence, clears next check-in, and retains its final result. Active/blocked goals get at most one check-in at their explicit check time (default deadline); no indefinite polling or automatic reschedule. Paused/terminal goals never generate another check-in. Completion creates a durable result notification; retries are delivery work, not goal work.

The task center and chat cards show state, progress, next step, deadline, recent evidence/history, and delivery status. Provider acceptance is not display/open confirmation. Preferences can keep notifications inbox-only. Scheduler failure does not imply goal failure or completion. In-flight pushes cannot be retracted by a later correction; no new stale deliveries should start after terminal state is observed.

## Bounds and exclusions
100 goals per user; 50 most recent history entries with explicit total count; capped notification backlog. No cron configuration changes or promise of actual external cron health. Existing auth, origin checks, write confirmation requirements, model allowlists and cost limits remain intact. No external financial/mail/health actions. Work is local only and based on actual baseline files 50a89a4, independent of pending PR #35.

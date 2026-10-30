# Goal tracking milestone — verification and handoff

## Scope and state
Local source only, based on the actual files supplied as main `50a89a41660aa5788cabd28a6b927513cee814e9` (tree `1394c0f2c83dab4b1dbc072fa2949334c00955ae`). Local Git HEAD predates that baseline: do not publish `git diff HEAD` blindly. This milestone does not depend on pending PR #35. No push, PR, migration, production deployment or production-root visit was performed by this task.

Goals reuse encrypted `noirxu_ai.settings` compare-and-set persistence, the authenticated/origin-checked executor, and existing notification policy/receipts. No dependencies, model configuration, budget limits, grants, credentials, or source-system write behavior changed. The goal feature follows the existing `tasks` feature switch and emergency halt.

This is outcome tracking, not an autonomous work engine: progress/completion is explicitly user-reported, not independently verified. A one-shot check-in consumes its check time without completing or rescheduling the goal. Completed/cancelled goals stop tracking; already-created completion delivery may retry. In-flight pushes cannot be retracted. Full completion result/evidence remain durable; push previews are bounded and link to the exact finished goal.

Bounds: 100 goals per user; 50 recent history entries with total count; latest evidence and completion retained separately; bounded delivery backlog. There is no goal deletion/archive UI in this milestone.

## Checks on final code
- `npm test`: **380 passed, 19 skipped**, 42 passing files and 2 intentionally skipped files. Skips: existing real-PostgreSQL water integration (no local test database URL) and paid live persona evaluation (no live model run). No test failures.
- `npm run typecheck`: passed.
- `npm run build`: passed from an isolated `/tmp/noirxu-goals-build-final` copy of the same final source, with the existing dependencies, to avoid interference with QA dev-server output.
- Goal-focused tests: **39 passed**, including real executor and delivery service, scheduler integration, SSR cards, editor version reducer, concurrency/restart/ownership and input validation.
- No separate lint script exists in package.json.
- Local Chromium browser regression: **not executed**. Launch failed before browser startup because local sockets were denied; one escalation failed in sandbox setup. No workaround or further retry. Parent subsequently used the supported managed cloud browser and found an invalid/empty datetime input could leave the form busy; the fix is described below. Final cloud-browser re-verification belongs to the parent.
- Real PostgreSQL goal persistence, actual external cron timing, actual provider/device delivery and live-model behavior were not exercised. No production success claims are implied.

## Independent review
A read-only reviewer identified six important edge cases. All were addressed: stale editor overwriting newer corrections; a committed completion misreported as failure after a receipt-read outage; oversize Chinese push payload; completed result hidden by active-only landing page; contextual follow-ups missing goal tools; current progress evidence lost after history trimming. Regression tests cover the fixes. There are no deferred reviewer findings.

## Browser-discovered invalid-date regression
Parent's managed cloud-browser QA reached the real form and found `RangeError: Invalid time value` with an empty `datetime-local` value; the create handler had already set busy and lacked `finally`, leaving Save/Cancel disabled. The original conversion also failed on valid browser strings containing seconds/fractions because it blindly appended another `:00`.

The final code validates Taiwan-local calendar components, accepts minute/second/fraction serialization, rejects invalid/empty values with an actionable error, and applies native form validity checks. Create and edit conversion now run inside one tested `try/catch/finally` submission boundary; conversion/transport exceptions always release the lock, while concurrent repeat clicks remain suppressed. Server create/update invalid deadline/check-time validation is covered too. 18 new regressions passed, plus the full suite; no browser-pass claim is made until the parent establishes it.

## Safe browser QA
The isolated wrapper checkout `/workspace/scratch/e25f9fc32bff/noirxu-ai-goal-qa` contains a copy of final source and its own Next output. Its `preview.mjs` uses only the host/port supplied as arguments by `sites-preview`. It supplies a fresh, allowlisted synthetic environment (no database URL, model API key, external integration credential or VAPID keys); storage is memory. The owner password is the synthetic test value `goal-local-test-only`. Briefings, water, voice and quality are disabled. Only locally-created synthetic goals/tasks can be touched by catchup.

Use the exact URL returned by `sites-preview start /workspace/scratch/e25f9fc32bff/noirxu-ai-goal-qa`, then `/login` and `/tasks`. Do not browse the production root: its service-worker initialization can POST `/api/cron/catchup` and execute real tasks.

Suggested actual UI checks: create goal; cancel an edit; update progress with evidence; reload; open an editor, make a newer revision elsewhere, trigger a focus refresh, and verify the old edit conflicts; complete with result/evidence; show finished; open its notification deep link; inspect history; mobile width. `tests/browser/goals.browser.mjs` captures this workflow for environments where local browser launch is authorized and available; it refuses non-local base URLs. It was not run here.

## Publication handoff
Use the baseline-relative manifest and patch in `/workspace/shared/noirxu-goals-milestone-20261030`, not the old local Git HEAD diff. Parent owns review URL, PR/push, approval and deployment. QA wrapper and synthetic dev credentials are not production source and are not in the source archive.

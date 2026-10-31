# Memory corrections milestone — verification

## Scope and compatibility
Based on live-equivalent tree `06fb1224072045ad034763f2e3870e4aecf21352` (local baseline commit `4f2d95d5c77bd5da7c02f14aecea89cfeeddbdd0`; supplied live main `7469aee863a69b6e97d3fbda1bff66324d5cc524`). This is a small extension of the existing memory feature, not a second store or automatic extraction system.

- Shows original source, creation date and content-update date, with honest fallbacks. Source is user-provided/user-confirmed, not independent verification.
- Supports explicit correction of content and automatic category.
- Per-entry revision guards stop stale page edits/deletions from replacing or deleting a newer entry, even if timestamps match. Legacy encrypted entries read as revision 1; duplicate-save refresh advances the revision.
- Keeps drafts through errors, conflicts, refresh and removal elsewhere; cancel/reopen is required to adopt a fresh revision. Duplicate clicks are suppressed. Stalled writes unlock after 20 seconds and state that the outcome is unknown; no automatic retry.
- Existing sealed settings/CAS, authentication, same-origin enforcement and chat-forget confirmation remain in place. Chat-forget behavior is unchanged; revision validation applies to the page mutation API.

No new dependencies, schema migrations, permissions/scopes, integrations, model calls, external communications or personal-fact fixtures. No production-root visit, push, PR or deployment was performed by this child task.

## Executed checks
- Baseline `npm test`: 394 passed, 19 skipped.
- Store/API tests first failed on missing revision normalization, concurrent overwrite, duplicate refresh revision and missing route preconditions; implemented to green.
- UI tests first failed on absent source/date/control/recovery behavior; implemented to green. A stalled-write test independently failed before adding the bounded timeout.
- Final `npm test`: **409 passed, 19 skipped**, 47 passing files and 2 skipped files. Existing skips are the paid/live persona evaluation and real-Postgres water integration; neither was run.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- No standalone lint script is configured. npm emits the existing environment `http-proxy` warning; no code/test failure.

## Browser QA and limits
The isolated wrapper `<isolated-memory-qa-directory>` bundles the actual `LongTermMemory` component with production global/HUD styles and synthetic memory entries. CSP blocks network connections and service workers. Fetch is replaced in memory before mounting; no real API or provider is contacted. The wrapper is not a production release file. Actual API authentication/origin checks and encrypted CAS persistence are exercised in Vitest, not the browser.

Managed-preview browser verification passed: source and both date labels, invalid blank edit, cancel/reopen, content/category correction, stale conflict with preserved draft across refresh, explicit reopen to adopt latest revision, delete cancellation/confirmation, adding a new memory, and narrow-screen editing/saving. Visual layout was inspected at wide width and in a 390px iframe (375px content viewport excluding scrollbar); measured page width equalled viewport width with no horizontal overflow, including the editor. Only the isolated static preview was opened, then closed and stopped. Previously denied local Chromium/socket launch was not retried. Full authenticated production/browser integration and actual PostgreSQL persistence are not claimed.

Independent source review identified two P2 issues, both fixed with observed RED→GREEN regressions: an initial-read failure must not allow an invisible partial list after adding, and category-only edits must not refresh old factual content or remove stale warnings. The reviewer independently reran all four memory suites (18/18 passed), inspected both fixes, checked the diff and reported no remaining blocking findings. Additional independent synthetic delayed-CAS schedules exercised PATCH/DELETE races, unrelated additions, ownership isolation and vault associated-data rejection.

## Release handoff
The 12-file release manifest and source bundle are in `<memory-release-artifacts-directory>`. Apply only these changes to the supplied live-equivalent baseline; parent owns publication and deployment. Existing already-open clients using the old revisionless mutation API must reload after deployment; the server safely rejects those old writes rather than accepting an unversioned overwrite.

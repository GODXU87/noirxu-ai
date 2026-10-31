# Conversation-first home revision

Approved direction: one primary conversation input; weather/body retained behind one secondary disclosure, no home notification/shortcut/status pile. Existing inbox/tasks/history remain elsewhere. No hydration surfaces, decorative cards or static ONLINE. Use existing React/Next architecture, no new dependencies or permissions.

Compared with keeping expanded readings above the input (still crowded), a compact disclosure below the composer makes the conversation primary. A separate new dashboard would add navigation and scope; use the existing source component lazily instead. Source dates/gaps/error freshness remain unchanged. No claim of faster model inference: measure eliminated initial background requests only.

Interactions: synchronous send lock before any state update; visible pending and disabled submit; preserve failed message without overwriting newer draft. Unknown network outcomes must not say nothing was sent or expose one-click re-execution. Recovery restores text for inspection, not a POST. Dismiss command palette without deleting input. Existing native tool approvals remain untouched. No new cancel-request UI claiming server writes canceled.

Verification: real Chat component with synthetic mock transport; repeated same-tick submits, failure/recovery, command/network error, pending/new draft, collapsed source reads, keyboard dismissal. Scoped press/focus/disabled/reduced-motion and safe-area CSS. Full suite/typecheck/build; independent review and coordinated synthetic mobile/desktop QA before publication.

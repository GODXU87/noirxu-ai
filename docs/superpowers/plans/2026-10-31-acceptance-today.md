# Acceptance and Today Implementation Plan
> Execute natively in the assigned task, with one independent final reviewer.
**Goal:** usable evidence review and owner-action queue without false completion.
**Architecture:** encrypted CAS acceptance service + public GitHub reader; authenticated API; read-only native queue; task-center UI.
**Spec:** docs/superpowers/specs/2026-10-31-acceptance-today-design.md
**Constraints:** synthetic testing; no production root/cron, no provider secrets, no external writes, preserve native approvals and results.
**Review focus:** malicious provider URLs; cache/concurrent restart; stale report/check race; partial source failures; long mobile evidence and no-result states.

1. Acceptance service/provider: RED tests for exact-SHA evidence, redirects/size/failure, honest CI/deployment separation, owner isolation/idempotency/CAS/check cache and manual-only decisions; implement model/service/provider; GREEN.
2. Owner queue: RED tests for deadline/action/waiting/resolved, source dedup and approval/connection routing; implement read-only aggregator and authenticated API; GREEN.
3. Task-center panels: RED UI tests for create/check/report/repeated submit/error, manual labels and native navigation; implement safe links/busy state/refresh; GREEN.
4. Full tests/typecheck/build, synthetic375/390 desktop QA, one independent review, durable final snapshot and manifest. Parent decides publication with current remote lease.

# Acceptance evidence and owner-action verification

Baseline:4bf6cc807ea7c9e55c17e82284bae093e49862e3.

## Implemented boundaries
- Owner-scoped encrypted acceptance records use the existing AgendaStore CAS; duplicate create requests are idempotent, reports use revisions, and durable check claims/cooldowns survive restart. No new schema, credential, provider access or paid dependency.
- Manual GitHub check reads only fixed public API paths for an allowlisted repository and exact full SHA. Returned URLs are never fetched; redirects, credentials, oversized bodies and unknown failures cannot produce verified evidence. Stored evidence is bounded; latest10 check snapshots retain revision linkage to manual reports.
- Commit existence and CI status are shown separately from production deployment and functional verification. Direct Vercel and runtime/functional validation are not available in this release and explicitly shown as unverified. A configured website URL is not deployment evidence. Manual pass/fail is attributed to the user and does not approve or rerun original tasks.
- Today action queue derives current task/goal/acceptance state, includes recurring tasks whose latest run failed or has unknown outcome, and separates action/waiting/resolved. Source failures are visible. Finished and asynchronously loaded records have native deep links; no mark-complete shortcut, notification or external write is added.

## Validation
- Full suite:462 passed,19 skipped. TypeScript and production build passed;33/33 static page generation. Opt-in real-provider tests remain skipped.
- Regression coverage: exact SHA, fixed host, response bounds, credential URL rejection, cross-origin/unauthenticated API rejection, owner isolation, duplicate/concurrent checks, crash recovery, late result after cancellation, manual report attribution/history linkage, recurring unknown/failure, uncertain-create identical retry, stale revision and async deep links.
- Existing task/goal freshness assertions retained. Their fixtures now explicitly answer the two new read-only endpoints, rather than accidentally feeding task mutation fixtures to unrelated reads.
- Synthetic actual UI verified in narrow375/390px Chromium iframes and desktop. Long source links wrapped; manual report resolved only the acceptance item while an unknown task remained actionable; cancel left the record unchanged; desktop creation refreshed the action queue. No external links opened. This is not actual iOS or authenticated production-device acceptance.
- Final independent review is tracked in the private handoff; do not infer a review pass solely from this document.

No production root/cron, Gmail, real push, personal account data, privilege change or external operation was used during validation.

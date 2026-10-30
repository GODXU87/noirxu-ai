# Reliable tasks and truthful notification health

Approved bounded milestone: no lost task acknowledgments, no false healthy background scheduler, auditable notification evidence. Extend existing scheduler and push diagnostics; no additional scheduler, live sends, model calls, or production-data changes.

## Implementation
1. Reproduce exhausted task-index CAS and failed record writes. Publish index before record; fail closed after bounded retries, leaving no runnable unlisted task. Repeated index insertion must be idempotent; a failed creation can be retried after restart.
2. Preserve separate external and app-catchup tick records. External health cannot be refreshed by browsing. Show task-subsystem failure as degraded while allowing independent reminders to complete.
3. Keep provider acceptance, device display, and opening as separate evidence; preserve concurrent receipts and report failed receipt persistence truthfully. Test retry/no-device/duplicate/restart behavior with mocked transport.
4. Run full offline test suite, TypeScript checks, production build, and independent review before handing publication to the parent task.

## Verification boundaries
No homepage browsing (it triggers catchup), live push/email/model calls, or production writes. Local test transports and stores only. Parent verifies GitHub publication and deployment for exact reviewed commit.

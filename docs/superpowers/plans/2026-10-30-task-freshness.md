# Task-center freshness

Scope: fix stale task progress using existing authenticated read tools; do not introduce a new task model, background jobs, or API data changes.

- Visible/online only: read on mount, return-to-app, task changes, and every 20 seconds after the previous read settles.
- Coalesce event bursts; one active list read. Abort obsolete reads, ignore late responses, and remove listeners/timers on unmount/filter changes.
- Keep last successful list on refresh failures and show last successful update time, offline, and error states. Manual retry stays available.
- Sync card snapshots without remounting or overwriting an active user mutation; refresh expanded history when the task changes.
- Actual React/jsdom mocked-fetch tests cover progress, visibility, cancellation, stale responses, cleanup, and offline recovery. Run complete tests, types, build, and independent review before parent publication.

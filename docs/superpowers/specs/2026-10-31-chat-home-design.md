# Chat home: concise, unboxed and source-honest

Explicit user decision: remove hydration from the home, remove decorative boxes, keep weather/body; prioritize this screen. Existing hydration history, automations and full notification inbox stay intact.

Use a compact greeting, unboxed weather/body readings with source/date/known gaps, a simple today-due link, and one compact real input surface. Remove the decorative HUD hero and static ONLINE assertion. Home notifications filter hydration before selecting items; global inbox is unchanged. Existing chat/voice/streaming/tool approval mechanics remain untouched.

Replace persistent browser glance caching with current-mount source reads. No failed request may refresh a success timestamp; show source-specific error/loading states and allow explicit readonly refresh. Carry weather provider cache age/fallback and body date/gaps to display. Unknown activity or missing lines cannot become a positive health assertion. No real screenshot values or personal records enter code/tests/docs. No production root/catchup QA.

Implementation: home data/filter helpers and component regression tests first; minimal API metadata and missing-data correction; scoped sk-home CSS following actual HUD load order; fulltests/typecheck/build and independent review; synthetic375/390/desktopQA only after preview coordination. No publication before parent handoff.

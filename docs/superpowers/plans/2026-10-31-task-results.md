# Task results implementation plan

Goal: make actual task outcomes discoverable without inventing success or replaying external writes.
Architecture: retain existing tool/proposal links and error codes in bounded sealed run history; render latest and historical step evidence using one component. Preserve old records without fabricated links.
Scope approved in parent assignment: no new service, permission, schema, model call or production access.

- [ ] Reproduce loss of read result links, confirmed write links and error codes with synthetic TaskService tests.
- [ ] Preserve bounded HTTP(S) source links and error metadata; no raw result payload duplication.
- [ ] Render latest result, source links, separate delivery evidence, safe next steps; reuse for history.
- [ ] Test old records, uncertain outcome, expired proposal, duplicate links, unsafe URLs and rerender/history flows.
- [ ] Full tests, typecheck, build; isolated 375/390px and desktop QA. Independent review and local commit/bundle for parent publication.

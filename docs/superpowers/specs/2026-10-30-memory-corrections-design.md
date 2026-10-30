# Trustworthy memory corrections

## Intent and scope
Make the existing personal-memory page trustworthy to inspect and correct. The existing encrypted store already has source and timestamps; the page hides source/creation time and cannot correct automatic categorization. Whole-store CAS prevents lost unrelated writes, but does not stop an old editor replacing a newer edit to the same memory.

## Design
Build on the existing Next.js UI/API and sealed settings record, without new dependencies, integrations, schema changes, credential scopes, model calls, or external data transmission. Display original source (`user`: 使用者提供; `confirmed`: 使用者確認; unknown: 來源未記錄), creation date and content-update date. These are provenance labels, not independent fact verification. Existing records without revisions are read as revision 1. New/add-refreshed/edited records advance a per-entry revision inside the existing CAS loop. A category-only correction does not renew the content date or suppress old-fact warnings.

The page supports content and category correction together. PATCH and page DELETE require the revision that the user saw; stale requests return CONFLICT and do not mutate. Chat's existing confirmation-gated forget tool is unchanged. An edit keeps its captured revision across refresh. Pending writes disable conflicting controls and duplicate submit; errors preserve the draft. Conflict UI offers read-only refresh and shows the latest value without silently rebasing the draft. Cancel then reopen is the explicit way to use the latest version. Invalid/empty edits cannot submit.

## Approaches considered
- Metadata-only UI: smallest, but leaves corrections able to overwrite newer facts.
- Reuse current store plus per-entry revision and bounded editor improvements: chosen by the implementer under the user's instruction to continue directly; closes the real trust gap without infrastructure.
- Full memory history, embeddings or automatic extraction: rejected; expands privacy/storage scope and is not needed for this milestone.

## Non-goals and constraints
No automatic personal-fact extraction, guessed chat/page provenance, retained old/private fact history, model-provider changes, or general UI redesign. Preserve existing authentication, same-origin enforcement, encrypted-at-rest storage and CAS concurrency. Fixtures are synthetic. Do not visit the production root (service worker may trigger jobs). Publication is owned by the parent task.

# Goal Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Durable, observable goal tracking with explicit evidence and truthful completion.
**Architecture:** Per-user encrypted CAS records using the existing settings store; new internal executor tools; existing notifier for deadline check-ins and completion results.
**Tech Stack:** TypeScript, Zod, React/Next.js, existing PostgreSQL settings, Vitest.
**Spec:** ../specs/2026-10-30-goal-tracking-design.md

## Global Constraints
Local source/tests only; no new dependencies, schema/grants, external actions or model costs. 100 goals/user, 50 retained history entries with total count. Existing auth and delivery policy preserved.

## Review Focus
- Stale concurrent edits must fail without overwriting corrections.
- Completion without evidence/result must fail, never silently succeed.
- Paused/cancelled/completed goals must not initiate check-ins or stale retries.
- Restarts and notification transport failures must preserve result/history.
- Provider acceptance must never be presented as viewed; quiet-hour preferences stay effective.

### Task 1: Goal lifecycle and outbox
Files: create `src/goals/model.ts`, `src/goals/service.ts`, `tests/goals.test.ts`.
- [x] Write and observe failing tests for persistence, ownership, revisions, terminal evidence, deadline check-ins, retries and policy.
- [x] Implement `GoalService.create/list/get/update/runDue` with bounded CAS persistence and durable delivery events.
- [x] Run focused tests and fix only within scope.

### Task 2: Authenticated tools and scheduler integration
Files: create `src/tools/goals/tools.ts`; update `src/server/hub.ts`, `src/server/tick.ts`, `src/server/agent.ts`, `src/router/tier.ts`, `src/tools/tasks/tools.ts`; test `tests/goal-integration.test.ts`.
- [x] Write and observe failing executor and scheduler tests.
- [x] Register create/list/update/history tools; forbid goal mutation from scheduled task steps; provide clear model routing/guidance.
- [x] Hook the deterministic check-in/retry runner into existing scheduler, honoring its emergency halt.
- [x] Run focused tests.

### Task 3: Observable UI and verification
Files: create `src/app/components/Goals.tsx`; update `src/app/sasuke/FunctionPages.tsx`, `src/app/components/shared.tsx`; test `tests/goal-ui.test.ts`.
- [x] Write and observe failing render tests for evidence, deadline, terminal state and delivery labels.
- [x] Implement reusable chat cards and task-center lifecycle controls using existing authenticated `callTool` route.
- [x] Run full `npm test`, `npm run typecheck`, `npm run build`; document passed/skipped/blocked stages and baseline-relative manifest.
- [x] Independent review when a slot is available; no push, PR, merge or deployment in this task.

## Execution notes
- Parent-directed local implementation used the supplied checkout and actual-file baseline snapshot instead of rewriting misleading Git history. No commits or external publication were made.
- Browser regression was authored but not executed because browser launch was blocked; deterministic SSR/editor regressions passed. Parent may use the supported isolated managed preview.
- Six independent-review findings were fixed in one pass and the full suite rerun.
- Parent cloud-browser QA found the empty-datetime busy freeze. Reproduced the unsafe conversion, added 18 date/submission regressions, fixed create/edit validation and finally-release; full suite rerun (380 passed, 19 skipped).

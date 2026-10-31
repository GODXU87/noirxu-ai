# Editorial inner workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** remove nested-card density while improving inner-page reading and action hierarchy.
**Architecture:** keep existing component data/commands; introduce scoped workbench presentation classes and semantic feedback. Reuse production components in synthetic QA.
**Tech Stack:** Next.js, React, CSS, Vitest.
**Spec:** docs/superpowers/specs/2026-10-31-inner-workbench-design.md

## Global Constraints
No API/state/auth/provider changes; preserve actual approval and uncertain-state behavior. No new dependencies or remote assets. No production root/catchup. No publication before handoff.

## Review Focus
- Long titles/URLs wrap at 375px.
- Keyboard focus and 44px touch targets remain visible.
- Failed/partial reads cannot look like empty success.
- Loading feedback reflects actual pending requests.
- Cancellation/uncertain save and native approval paths remain unchanged.

### Task 1: Presentation and feedback
Files: src/app/sasuke/FunctionPages.tsx, src/app/components/Acceptance.tsx, src/app/sasuke/LongTermMemory.tsx, src/app/globals.css; tests/acceptance-ui.test.ts.
Interfaces: same component props/API calls; new CSS scope .workbench; no service interface changes.
- [ ] Add failing real DOM tests for source labels and accessible loading feedback.
- [ ] Run focused tests and verify expected failure.
- [ ] Apply semantic section/list classes, visible busy labels and scoped editorial CSS.
- [ ] Run full tests, typecheck and build.
- [ ] Review actual component synthetic mobile/desktop rendering plus empty/error/loading/cancel paths once preview is available.
- [ ] Independent review, freeze commit/hash manifest and persist source/logs/report; report to parent before publication.

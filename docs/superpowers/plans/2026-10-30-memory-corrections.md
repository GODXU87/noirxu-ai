# Memory Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show honest memory provenance and allow safe, explicit corrections.
**Architecture:** Extend the current sealed per-user memory record with a backward-compatible revision, checked inside CAS. Extract the existing memory panel into a focused component with an edit snapshot and serialized mutations.
**Tech Stack:** Existing TypeScript, Next.js, React, Vitest/jsdom.
**Spec:** `docs/superpowers/specs/2026-10-30-memory-corrections-design.md`

## Global Constraints
- Preserve encryption, CAS, authentication and same-origin checks; no dependencies, new scopes, integrations, or model calls.
- Synthetic fixtures only. Never visit production root. Do not push.

## Review Focus
- Legacy entries: readable and correctable without a migration.
- Concurrent edits or duplicate-save refresh: stale correction/delete rejected, unrelated writes retained.
- Pending/repeated mutations: one request, no late write clearing a different editor.
- Failed refresh/conflict: preserve draft and do not silently update its revision.
- Unknown provenance/missing dates and narrow screens: truthful fallback and readable controls.

### Task 1: Revision-aware correction API
**Files:** `src/memory/store.ts`, `src/app/api/memory/route.ts`, `tests/memory-corrections.test.ts`, `tests/memory-route.test.ts`, existing `tests/long-term-memory.test.ts`.
**Interfaces:** `StoredMemory.revision: number`; update takes required expected revision; remove accepts an optional expected revision for page use; legacy read normalizes absent revision to 1. PATCH/DELETE require a positive integer revision. PATCH requires content or category.
- [x] Write store/route tests for legacy, same-time concurrent edits, duplicate refresh, user isolation, stale delete, empty patch, encryption and auth/origin.
- [x] Run focused tests and observe feature failures.
- [x] Implement revision checks inside existing CAS, route schemas, and adapt the prior store test to pass the observed revision.
- [x] Run focused checks; expected all pass.

### Task 2: Provenance and correction UI
**Files:** `src/app/sasuke/LongTermMemory.tsx`, `src/app/sasuke/FunctionPages.tsx`, `src/app/globals.css`, `tests/memory-ui.test.ts`. Isolated non-release browser wrapper: `<isolated-memory-qa-directory>`.
**Interfaces:** panel reads the current `/api/memory` response; PATCH/DELETE submit the original viewed revision. No other APIs.
- [x] Write UI tests for source/date, category, cancel/invalid edits, repeated submit, conflict snapshot preservation and failure recovery; run to observe failures.
- [x] Extract and implement panel with explicit provenance, editable category, pending guard, conflict reload and latest-value display.
- [x] Run tests, typecheck and production build. Run managed static-component browser verification for conflicts, cancel, corrections and mobile layout (no real network/API calls or service workers). API auth/origin and encrypted persistence are verified in Vitest; the previously denied local browser launch is not retried.
- [x] Request independent whole-change review, address important findings test-first, and hand tested files to parent without pushing.

# Conversation-first Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Follow TDD per task.

**Goal:** Make conversation primary and recovery honest without repeating external writes.
**Architecture:** Reuse Chat/TodayGlance; disclosure gates readonly source requests; synchronous in-flight ref guards existing send flow.
**Tech Stack:** React, Next.js, Vitest/jsdom, existing CSS.
**Spec:** docs/superpowers/specs/2026-10-31-home-focus-design.md

## Constraints and review focus
No production root, real records, new permissions, API contract changes or automatic retry. Preserve streaming/tool approvals/voice. Inspect unknown network outcomes, rapid clicks, newer drafts, palette dismissal and reduced-motion/mobile overflow.

## Tasks
- [ ] Add real Chat synthetic tests for collapsed home/order, no initial source fetch, duplicate submit, draft recovery without POST, palette Escape.
- [ ] Run RED and implement minimal Chat changes; TodayGlance optional agenda suppression preserves previous consumers.
- [ ] Add scoped interaction/safe-area CSS and inspect actual computed controls in coordinated fixture.
- [ ] Run full tests/typecheck/build; independent review; persist final manifest and report before publication.

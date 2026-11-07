# Editorial Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make the existing conversation-first home feel coherent and make its controls easy to identify.
**Architecture:** Retain Next/React logic; refine scoped CSS and present existing actions with visible text. No new dependencies or services.
**Tech Stack:** Next.js 15, React 19, TypeScript, Vitest.
**Spec:** docs/superpowers/specs/2026-11-07-editorial-interface-design.md

## Global Constraints
- Preserve voice lifecycle, drafts, approvals, feature flags and all existing destinations.
- No homepage cards/shortcut pile, hydration or static ONLINE assertion.
- Use synthetic local QA only; do not exercise production root/catchup or real microphone capture.

## Review Focus
- Long CJK drafts must not force horizontal overflow or hide submit.
- Active voice controls must stay reachable at 375px and while requests are pending.
- Unsupported recognition must not advertise working phone calls.
- Collapsed desktop sidebar and mobile drawer must retain usable names/focus.
- Returning from settings/history must retain unsent text and not submit again.

### Task 1: Refine the conversation surface
**Files:** src/app/chat-surface.css, src/app/Chat.tsx, src/app/sasuke/SasukeNav.tsx, src/app/components/Voice.tsx, src/app/connections/Connections.tsx, tests/voice-conversation.test.ts.
**Interfaces:** Existing Chat and navigation controls; no server API changes. MicButton may add optional display context without changing callbacks.
- [ ] Add interaction regression tests proving visible voice labels track current action and stop state.
- [ ] Run targeted tests and verify new assertions fail because labels are absent.
- [ ] Implement visible labels, settings anchor and scoped visual refinement.
- [ ] Run full tests, typecheck and production build. Expected: all ordinary tests pass; disclose live/database skips.
- [ ] Perform synthetic desktop/mobile UI checks, then independent code review.
- [ ] Commit and publish only within current user authorization; stop and report any denial.

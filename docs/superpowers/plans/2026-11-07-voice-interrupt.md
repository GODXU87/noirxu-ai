# Tap-to-interrupt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Let a person interrupt playback and start a new voice turn with one tap.
**Architecture:** Chat owns the interruption action, uses existing stopVoice/toggleMic lifecycle operations, and guards repeated taps synchronously. Playback controls get a wrapping row.
**Tech Stack:** React 19, TypeScript, Web Speech API, Vitest/jsdom.
**Spec:** docs/superpowers/specs/2026-11-07-voice-interrupt-design.md

## Global Constraints
- No paid service, continuous capture, new dependency, credential or permissions change.
- No automatic voice barge-in or real-audio claims from mocked tests.
- Preserve explicit confirmation for consequential actions.

## Review Focus
- Old completion/error callbacks after interruption cannot disrupt fresh capture.
- Two taps in one event batch start only one recognition run.
- In-flight requests cannot be superseded through interruption.
- Recognition failure exits cleanly and preserves a draft.
- Narrow screens retain both interruption and end controls.

## Task 1: Interruption controls
**Files:** src/app/Chat.tsx, src/app/globals.css, tests/voice-conversation.test.ts, docs/voice-verification.md.
**Interface:** interruptPlayback(): void, accessible button `打斷並說話` while playback is active, plus independent `停止朗讀`.
- [x] Add red interaction tests for the new action and review-focus boundaries.
- [x] Run focused tests and confirm missing behavior fails.
- [x] Implement the guarded action and wrapping playback control row.
- [x] Run focused tests, full suite, typecheck and build; record limits.
- [x] Obtain independent review and fix concrete findings with regression tests.
- [x] Commit the verified local change and report publication status accurately.

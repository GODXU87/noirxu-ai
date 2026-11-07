# Browser Voice Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Prevent stopped, failed or unmounted voice conversations from submitting stale speech or reopening the microphone.

**Architecture:** Keep useVoiceInput and useSpeech in Voice.tsx. Give recognition cancellation a distinct operation, guard events by current instance, and invalidate speech callbacks before cancellation. Chat owns conversation intent and the resume timer, and clears both when stopped or unmounted.

**Tech Stack:** React 19, TypeScript, browser Web Speech API, Vitest/jsdom.

**Spec:** docs/superpowers/specs/2026-11-07-voice-reliability-design.md

## Global Constraints
- No new paid service, dependency, authentication, database, deployment or permissions change.
- No speech-only approval for consequential tool actions.
- Automated simulated speech is never described as a real microphone test.

## Review Focus
- Delayed result/end callbacks after cancel or unmount cannot send or overwrite text.
- Starting a new recognition instance isolates it from callbacks from the old one.
- Permission/network/speech failures terminate the session, with one-tap recovery.
- Cancel during response or the 350ms resume gap prevents microphone restart.
- Typed submit while listening sends once; old recognition cannot duplicate it.

### Task 1: Recognition cancellation and session ownership
**Files:** Modify src/app/components/Voice.tsx; test tests/voice-input.test.ts.
**Interfaces:** useVoiceInput gains cancel(): void and optional onError(): void; stop() still finalizes a single utterance.
- [x] Add failing hook interaction tests for stale/aborted events, replacement, unmount and natural completion.
- [x] Run npm test -- tests/voice-input.test.ts and observe intended failures.
- [x] Add active-instance guards, invalidate before abort, clear listening on errors, notify failure callback and ignore stale events.
- [x] Run focused tests, then npm test. Expected all applicable tests pass.

### Task 2: Conversation and speech lifecycle
**Files:** Modify src/app/Chat.tsx and src/app/components/Voice.tsx; test tests/voice-conversation.test.ts and tests/voice-playback.test.ts.
**Interfaces:** useSpeech.speak options add onError; Chat owns a cancellable 350ms resume timer and resets conversation state on stop, failure and unmount.
- [x] Add failing real-Chat tests for happy-path turn-taking, cancellation during capture/response/resume gap, failure recovery and manual submit; add speech hook tests for stale callbacks/errors.
- [x] Run focused tests and observe intended failures.
- [x] Make minimal lifecycle fixes without replacing conversation UI or changing tool confirmation.
- [x] Run focused tests, npm test, npm run typecheck and npm run build.

### Task 3: Review and release evidence
**Files:** Add docs/voice-verification.md.
- [x] Obtain fresh code review, fix important findings with regression tests.
- [x] Record exact passed/failed/skipped checks and manual device test instructions.
- [x] Keep local branch/patch; do not push or deploy without authorization.

# Browser voice verification

## What this implementation is
This is turn-by-turn browser speech: recognize one utterance, send its text through the existing chat path, read the answer, then optionally listen again. It is not full-duplex realtime calling and does not add a paid speech service. AI chat requests retain their existing model costs. Browser speech recognition may use Apple/Google or another browser provider's servers.

## Setup and controls
1. Use the SASUKE interface in a browser supporting Web Speech recognition and speech synthesis. Production must use HTTPS. The server's `voice` feature must not be disabled.
2. On `/connections`, under 語音, enable 朗讀回答 and 對話模式. The latter is off by default and settings are per device. 說完自動送出 is on by default; disable it to review the recognized text before sending.
3. Return to chat and tap the microphone. The browser may request microphone access. A person must grant that access according to their preference.
4. During an active conversation the microphone control is named 結束語音對話. Ending it cancels any unfinished utterance, retains the visible draft, stops playback and prevents scheduled listening.
5. In single-utterance mode, 停止收音 finishes the utterance instead of discarding it. With auto-send on, its recognized text is sent.
6. Say 結束 during conversation mode to finish without sending another chat request. Switching away from the page also stops the voice session; returning does not automatically turn the microphone on.

## Automated coverage
Tests render the real React hooks and Chat component in jsdom. Browser recognition/playback and HTTP are simulated external boundaries; no microphone permission, actual audio, production sign-in or paid model call is used.

Covered behaviors include normal multi-turn flow, single-utterance stop, canceled and stale callbacks, replacing recognition runs, unmount/background cleanup, permission denial, startup/playback failure, one-tap recovery, manual-submit deduplication, and cancellation while a reply or resume timer is pending.

## Required manual release check
Run on an iPhone Safari and an Android Chrome, plus desktop Chrome where available. Record browser/OS versions and the exact deployed commit.

- Allow microphone access, say two short Traditional Chinese requests, and confirm each appears once, gets an audible answer, and resumes listening only after playback ends.
- Use 停止收音 in single-utterance mode, then disable auto-send and confirm the transcript stays editable until explicit submission.
- End conversation while speaking, while waiting for an answer, while reading an answer and just after playback. Confirm no further capture or automatic send. A pending answer may still arrive as text.
- Stop playback, then restart with one tap. Say 結束 and verify no extra request.
- Deny microphone permission, recover through browser settings, then confirm one-tap restart. Test no-speech/network failure without an automatic retry loop.
- Switch tabs, lock the phone or navigate away during capture/playback. Confirm no audio or capture continues and returning does not restart it.
- Verify a proposed write/send still requires the existing on-screen confirmation. Spoken approval alone must not execute it.

Hardware speech quality, mobile autoplay permissions, real browser recognition service availability and production feature flags are not established by the automated tests. Do not mark voice calling released until those checks pass against an authorized deployment.

## Local verification record — 2026-11-07
- Baseline: `df0a766a558e3dd6d797e05412f8e70241c52a16` from main.
- Baseline suite: 534 passed, 19 skipped.
- Final suite: 569 passed, 19 skipped (67 passed test files, 2 skipped).
- New voice coverage: 35 tests in recognition, playback and conversation suites. Regression tests were observed failing before their fixes; positive control cases protect normal behavior.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Independent review found three important keyboard/session-state races. Added regression tests reproduced them, then passed after the fixes. No critical or minor findings were reported.
- Skipped suites need an explicit live-model run (paid external calls) or a real test PostgreSQL database. Neither was enabled for this task.
- No production login, microphone permission, real spoken audio, GitHub push, PR, merge, or deployment was performed. Production voice readiness is still unverified.

## Tap-to-interrupt follow-up — 2026-11-07
While a reply is being read aloud, `打斷並說話` stops that playback and starts a fresh utterance with one tap. `停止朗讀` remains available to stop without opening the microphone. This is an explicit tap, not automatic detection of a person speaking over the assistant. Recognition stays off while playback runs.

The new action follows the existing auto-send and conversation settings. It is unavailable without browser recognition and disabled while another request is pending; it does not cancel or roll back server actions. Existing screen confirmation requirements remain unchanged.

Local automated coverage adds 9 Chat interaction cases: normal interruption followed by another reply, repeated taps, stale completion/error callbacks, permission failure, ending the new utterance, single-utterance behavior, auto-send off, typed draft preservation, pending-request protection and unsupported browsers. One case covers several callback checks. The full suite passes 578 tests with 19 skipped. These are simulated browser/HTTP boundaries, not real audio.

Before claiming this control works on a phone, test it during a long spoken reply, tap twice quickly, deny microphone access, and confirm `停止朗讀` never opens the microphone. Check the wrapping controls on a narrow screen. Production sign-in, actual microphone capture, acoustic echo behavior and mobile autoplay are still unverified.

Independent review found no Critical, Important or Minor issues in this scoped change. The reviewer independently passed 53 voice tests in an isolated copy, including six additional failure/race cases. TypeScript and production build checks passed. Device audio and rendered mobile layout were not verified.

# Tap-to-interrupt browser voice

## Intent and scope
Continue improving voice under the no-new-paid-service constraint. This change adds one-tap interruption of a spoken reply, immediately starting a fresh utterance through the existing chat path. It does not enable automatic voice barge-in, continuous capture, paid realtime APIs or cancellation of in-flight server actions.

## Approach
The implementation choice is an explicit `打斷並說話` control during playback. Browser recognition running alongside playback is not selected because echo rejection and mobile service behavior have not been validated. A WebRTC realtime backend remains a separate option requiring cost and data-sharing decisions.

## Behavior and safety
Keep `停止朗讀` and the conversation end control independent. Interruption invalidates old playback callbacks, cancels resume timers, then starts one new recognition run. Rapid repeated taps must not create duplicate runs. Preserve any existing typed draft; keep auto-send and conversation settings. Hide the new action when recognition is unsupported or voice is disabled; disable it while a server request is pending. Errors, navigation and manual editing retain their existing stop semantics. Consequential tool actions still require on-screen confirmation.

## Interface and verification
Place playback actions in their own wrapping row to avoid crowding the mobile toolbar. Test real Chat with deterministic external speech/HTTP boundaries: interruption and resumed turns, repeated taps, delayed canceled callbacks, permission failure, explicit stop, pending responses, unsupported/disabled voice, single-utterance mode and draft preservation. Run all tests, typecheck and production build. Actual audio and mobile autoplay need authorized real-device testing and must not be claimed from simulated tests. Publication requires applicable authorization.

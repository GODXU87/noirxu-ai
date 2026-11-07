# Realtime voice options — 2026-11-07

## Current implementation and recommended next step
The current app uses browser recognition for one utterance, the existing text-chat HTTP path, browser synthesis, then optional automatic re-listening. The next bounded improvement is explicit `打斷並說話`: stop playback and start a fresh utterance in one tap. It adds no speech-provider integration; existing model and hosting usage still applies. It is not automatic voice barge-in or full-duplex realtime audio.

## Why not just enable continuous recognition?
[SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) has limited browser availability and may use a browser vendor's recognition server. [continuous](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/continuous) selects repeated recognition results, not duplex conversation behavior. Running it during synthesized speech risks transcribing the assistant's own output; this is an architectural risk, not a measured result for this app. [Echo cancellation](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation) is browser-controlled, and obtaining a separate processed microphone stream does not establish that the existing recognizer uses it. A persistent-listening experiment would need explicit privacy behavior, validated echo rejection and real-device evidence before release.

## Option A: Keep browser speech and explicit interruption
- Reuse the current providers, UI and on-screen action approvals.
- [speechSynthesis.cancel()](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/cancel) stops queued/current playback; invalidate old callbacks before capture starts.
- Test Safari/Chrome, headphones/speakers, denied permissions and returning from background.
- No new API bill, but browser support, recognition latency and mobile autoplay remain external limitations.

## Option B: Provider-backed WebRTC realtime voice
- [WebRTC architecture](https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime): the authenticated backend issues short-lived session access, standard credentials stay server-side, the browser exchanges audio/events with the provider.
- [Interruption handling](https://developers.openai.com/api/docs/guides/realtime-conversations): voice activity can cancel output, and unplayed output must be removed from conversation state.
- Before implementation, obtain the provider choice, explicit audio-sharing approval, approved credential provisioning and a total spending limit. Enforce per-session limits and keep consequential tool actions behind server-side screen-confirmation controls.
- This is a paid service, not an extension of free browser speech. [Published model rates](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini) are token-based and can change; a per-minute total also depends on speech, context, text and tools. No paid call, credentials, credits or account eligibility was checked for this research.

## Option C: On-device or self-hosted components
[whisper.cpp browser streaming](https://github.com/ggml-org/whisper.cpp/blob/master/examples/stream.wasm/README.md) can provide transcription, but the product still needs turn detection, interruption, a language model and speech output. [Self-hosted LiveKit](https://docs.livekit.io/transport/self-hosting/) requires media/network infrastructure and [agent compute](https://docs.livekit.io/deploy/custom/deployments/). Owned hardware may avoid a new speech API charge, but compute, maintenance, thermal/battery load and latency are not free guarantees. This is substantially larger than the current Vercel browser-speech increment.

## Release evidence still required
An authorized user must sign in and grant microphone access to complete real audio testing. Test two full turns, interruption, hang-up and denied/recovered permission on actual target phones, with exact OS/browser and deployed commit recorded. Simulated browser-service tests cannot establish speech quality, acoustic echo handling, true audio latency or mobile autoplay. Do not present the options or local tests as evidence of an already working realtime call.

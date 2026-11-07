# Browser voice conversation reliability

## Intent and scope
Make the existing turn-by-turn voice conversation dependable without adding a paid speech service or representing it as full-duplex realtime calling. The user asked to continue after being told that microphone input, read-aloud and turn-taking exist but have not passed production microphone testing. This change is local only until publication is separately authorized.

## Approach
Keep the current React hooks and browser Web Speech API. Fix lifecycle and cancellation defects and add interaction tests against the real Chat component, with browser speech and HTTP as the external test boundaries. A separate Realtime service is out of scope because it adds cost and different permissions. A new call UI is deferred until the existing flow is reliable.

## Required behavior
- Starting and naturally finishing a voice turn submits once, reads the reply and resumes listening only when conversation mode is enabled.
- Explicitly ending a conversation or leaving the page stops capture and speech. Old events and timers cannot submit, change a newer draft, or restart capture.
- In single-utterance mode, stopping capture can finalize the utterance; in conversation mode, the same control ends the session without submitting unfinished speech.
- Recognition failures leave a visible explanation and end the session. One new tap can restart; no automatic microphone retry loop.
- Speech errors end voice conversation instead of silently reopening the microphone. A late completion from canceled speech cannot resume it.
- Typed submission while listening uses the explicit draft once and cannot send it again when recognition ends. Keyboard editing takes ownership from active speech/playback and stops automatic capture. A recognized draft can still be edited and manually submitted with read-aloud preserved when auto-send is off.
- No changes to tool execution, approvals, paid services, database, auth, or deployed settings.

## Verification limits
Automated browser-API simulations prove event handling, not hardware, Apple/Google speech recognition, autoplay behavior, microphone permissions, or mobile audio quality. Production remains gated by login and deployment access. Real iPhone/Android testing is a release requirement.

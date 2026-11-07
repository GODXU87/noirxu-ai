// Deterministic browser-service boundaries. Tests still render the real React hooks/Chat.
export class BrowserRecognition {
  static instances: BrowserRecognition[] = [];
  static startError = false;
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 1;
  onresult: ((event: { resultIndex: number; results: Array<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  stopRequested = false;
  aborted = false;
  constructor() { BrowserRecognition.instances.push(this); }
  start() { if (BrowserRecognition.startError) throw new Error('Synthetic microphone start failure'); }
  stop() { this.stopRequested = true; }
  abort() { this.aborted = true; }
  result(text: string, isFinal = true) { this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] }); }
  finish() { this.onend?.(); }
  fail(error: string) { this.onerror?.({ error }); this.onend?.(); }
  static reset() { this.instances = []; this.startError = false; }
}

export class BrowserUtterance {
  lang = ''; rate = 1; pitch = 1; volume = 1;
  voice: SpeechSynthesisVoice | undefined;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

export function browserSynthesis() {
  const utterances: BrowserUtterance[] = [];
  return {
    utterances,
    speaking: false,
    cancelEmitsError: false,
    getVoices: () => [],
    addEventListener() {},
    removeEventListener() {},
    speak(utterance: BrowserUtterance) { utterances.push(utterance); },
    cancel() {
      if (this.cancelEmitsError) utterances.at(-1)?.onerror?.();
    }
  };
}

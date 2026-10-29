'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RECOGNITION_OPTIONS, speakable, voiceSupport } from '@/lib/voice';
import { Icon } from './Icon';

// Voice mode with the browser's own speech services (no paid speech API). One utterance per
// tap — never continuous recording. The words appear in the composer as they are recognised
// and stay editable; nothing is sent until the user sends it. Read-back uses the device's
// speech synthesis. Safari sends audio to Apple for recognition: it is not offline.

interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

const ERRORS: Record<string, string> = {
  'not-allowed': '麥克風權限被拒絕。請到瀏覽器（iPhone：設定 → Safari → 麥克風）允許後再試。',
  'service-not-allowed': '這個瀏覽器不允許語音辨識，請改用鍵盤或系統聽寫。',
  'no-speech': '沒有聽到聲音，請再按一次麥克風說話。',
  'audio-capture': '找不到麥克風。',
  network: '語音辨識需要網路，請檢查連線。'
};

export function useVoiceInput(onText: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const rec = useRef<Recognition | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => { setSupported(voiceSupport(window as never).recognition); }, []);

  const stop = useCallback(() => { rec.current?.stop(); }, []);
  const start = useCallback((base: string) => {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { setError(voiceSupport(window as never).reason ?? '這個瀏覽器不支援語音輸入。'); return; }
    window.speechSynthesis?.cancel();
    const r = new Ctor();
    Object.assign(r, RECOGNITION_OPTIONS);
    const prefix = base.trim() ? `${base.trim()} ` : '';
    r.onresult = e => {
      let finalText = '';
      let interim = '';
      for (let i = 0; i < e.results.length; i += 1) {
        const piece = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += piece; else interim += piece;
      }
      onTextRef.current(`${prefix}${finalText}${interim}`);
    };
    r.onerror = e => { if (e.error !== 'aborted') setError(ERRORS[e.error] ?? `語音辨識失敗（${e.error}）`); };
    r.onend = () => { setListening(false); rec.current = null; };
    setError('');
    try {
      r.start();
      rec.current = r;
      setListening(true);
    } catch {
      setError('語音辨識沒有啟動，請再試一次。');
    }
  }, []);

  useEffect(() => () => rec.current?.abort(), []);
  return { supported, listening, error, start, stop, clearError: () => setError('') };
}

/** Reads a reply aloud (short, plain text); returns a stop function. */
export function useSpeech() {
  const [speaking, setSpeaking] = useState(false);
  const speak = useCallback((text: string) => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(speakable(text));
    u.lang = 'zh-TW';
    const voice = synth.getVoices().find(v => v.lang === 'zh-TW') ?? synth.getVoices().find(v => v.lang.startsWith('zh'));
    if (voice) u.voice = voice;
    u.rate = 1.05;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(u);
  }, []);
  const stop = useCallback(() => { window.speechSynthesis?.cancel(); setSpeaking(false); }, []);
  useEffect(() => () => window.speechSynthesis?.cancel(), []);
  return { speaking, speak, stop };
}

export function MicButton({ listening, disabled, onClick }: { listening: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`sk-mic${listening ? ' is-listening' : ''}`} onClick={onClick} disabled={disabled} aria-pressed={listening} aria-label={listening ? '停止收音' : '語音輸入'} data-tip={listening ? '說完了，按一下停止' : '語音輸入'}>
      <Icon name="mic" size={18} />
    </button>
  );
}

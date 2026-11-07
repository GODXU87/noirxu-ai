'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RECOGNITION_OPTIONS, speakable, voiceSupport } from '@/lib/voice';
import { Icon } from './Icon';

// Voice mode with the browser's own speech services (no paid speech API). One utterance per
// listen — never continuous recording. Words appear in the composer as they are recognised;
// by default the message is sent when Sir stops talking (a setting turns that off). Replies to
// voice turns are read aloud in sentence-sized pieces (Safari cuts long utterances), and in
// conversation mode SASUKE listens again after it finishes speaking. Voice never confirms
// anything: confirmation cards still need a tap. Safari sends audio to Apple: it is not offline.

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

/* ---------- Settings (per device) ---------- */

export interface VoiceSettings {
  /** Send the message as soon as Sir stops talking. */
  autoSend: boolean;
  /** Read replies to voice turns aloud. */
  readAloud: boolean;
  /** After reading a reply, listen again (hands-free conversation). */
  conversation: boolean;
  rate: number;
}
export const DEFAULT_VOICE: VoiceSettings = { autoSend: true, readAloud: true, conversation: false, rate: 1 };
const SETTINGS_KEY = 'sasuke:voice:v1';

export function readVoiceSettings(): VoiceSettings {
  try { return { ...DEFAULT_VOICE, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }; } catch { return DEFAULT_VOICE; }
}

export function useVoiceSettings() {
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_VOICE);
  useEffect(() => {
    setSettings(readVoiceSettings());
    const sync = () => setSettings(readVoiceSettings());
    window.addEventListener('sasuke-voice-settings', sync);
    return () => window.removeEventListener('sasuke-voice-settings', sync);
  }, []);
  const update = useCallback((patch: Partial<VoiceSettings>) => {
    const next = { ...readVoiceSettings(), ...patch };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* private mode: this tab only */ }
    setSettings(next);
    window.dispatchEvent(new Event('sasuke-voice-settings'));
  }, []);
  return { settings, update };
}

/** Words that end a hands-free conversation. */
export const STOP_WORDS = /^(結束對話|結束|停止|停|不用了|先這樣|沒事了|謝謝就好|掰掰|拜拜)[。.!！]*$/;

/* ---------- Listening ---------- */

export function useVoiceInput(onText: (text: string) => void, onFinal?: (text: string) => void, onFailure?: () => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const rec = useRef<Recognition | null>(null);
  const onTextRef = useRef(onText);
  const onFinalRef = useRef(onFinal);
  const onFailureRef = useRef(onFailure);
  const mounted = useRef(false);
  onTextRef.current = onText;
  onFinalRef.current = onFinal;
  onFailureRef.current = onFailure;

  useEffect(() => {
    mounted.current = true;
    setSupported(voiceSupport(window as never).recognition);
    return () => {
      mounted.current = false;
      const previous = rec.current;
      rec.current = null;
      previous?.abort();
    };
  }, []);

  const stop = useCallback(() => { rec.current?.stop(); }, []);
  // Unlike stop(), cancel never finalizes a partial utterance.
  const cancel = useCallback(() => {
    const previous = rec.current;
    rec.current = null;
    if (mounted.current) setListening(false);
    previous?.abort();
  }, []);
  const start = useCallback((base: string) => {
    if (!mounted.current) return false;
    cancel();
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { setError(voiceSupport(window as never).reason ?? '這個瀏覽器不支援語音輸入。'); onFailureRef.current?.(); return false; }
    window.speechSynthesis?.cancel();
    const r = new Ctor();
    Object.assign(r, RECOGNITION_OPTIONS);
    const prefix = base.trim() ? `${base.trim()} ` : '';
    let heard = '';
    r.onresult = e => {
      if (rec.current !== r || !mounted.current) return;
      let finalText = '';
      let interim = '';
      for (let i = 0; i < e.results.length; i += 1) {
        const piece = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += piece; else interim += piece;
      }
      heard = `${finalText}${interim}`;
      onTextRef.current(`${prefix}${heard}`);
    };
    r.onerror = e => {
      if (rec.current !== r || !mounted.current) return;
      rec.current = null;
      setListening(false);
      if (e.error !== 'aborted') setError(ERRORS[e.error] ?? `語音辨識失敗（${e.error}）`);
      onFailureRef.current?.();
    };
    r.onend = () => {
      if (rec.current !== r || !mounted.current) return;
      rec.current = null;
      setListening(false);
      const text = `${prefix}${heard}`.trim();
      if (heard.trim() && text) onFinalRef.current?.(text);
      else onFailureRef.current?.();
    };
    setError('');
    try {
      rec.current = r;
      setListening(true);
      r.start();
      return true;
    } catch {
      cancel();
      setError('語音辨識沒有啟動，請按一下麥克風。');
      onFailureRef.current?.();
      return false;
    }
  }, [cancel]);

  return { supported, listening, error, start, stop, cancel, clearError: () => setError('') };
}

/* ---------- Speaking ---------- */

/** The clearest Taiwanese Mandarin voice this device has (enhanced/premium voices first). */
function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const tw = voices.filter(v => /zh[-_]TW/i.test(v.lang));
  const zh = tw.length ? tw : voices.filter(v => /^zh/i.test(v.lang) && !/HK|yue/i.test(v.lang));
  const score = (v: SpeechSynthesisVoice) => (/premium|enhanced|高品質|增強/i.test(v.name) ? 4 : 0) + (/Mei-?Jia|美佳|Google 國語|Siri/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
  return [...zh].sort((a, b) => score(b) - score(a))[0];
}

/** Sentence-sized pieces (≤ 120 characters) so long replies are never cut off mid-way. */
export function speechChunks(text: string, max = 120): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[。！？!?；;\n])/)) {
    const s = sentence.trim();
    if (!s) continue;
    if (out.length && (out.at(-1)! + s).length <= max) out[out.length - 1] += s;
    else for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  }
  return out;
}

export function useSpeech() {
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState('');
  const voiceRef = useRef<SpeechSynthesisVoice | undefined>(undefined);
  const run = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const synth = window.speechSynthesis;
    const load = () => { voiceRef.current = pickVoice(synth?.getVoices() ?? []); };
    load();
    synth?.addEventListener?.('voiceschanged', load);
    return () => {
      mounted.current = false;
      run.current += 1;
      synth?.removeEventListener?.('voiceschanged', load);
      synth?.cancel();
    };
  }, []);

  /** iOS only lets speech start from a tap: call this inside one before the first reply. */
  const unlock = useCallback(() => {
    const synth = window.speechSynthesis;
    if (!mounted.current || !synth || synth.speaking) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    } catch { /* The actual reply reports a playback failure if it cannot speak. */ }
  }, []);

  const speak = useCallback((text: string, options: { rate?: number; onEnd?: () => void; onError?: () => void } = {}) => {
    if (!mounted.current) return;
    // Invalidate old callbacks before cancel(), which can synchronously emit errors.
    const id = ++run.current;
    const synth = window.speechSynthesis;
    synth?.cancel();
    setSpeaking(false);
    setError('');
    const fail = () => {
      if (!mounted.current || run.current !== id) return;
      run.current += 1;
      setSpeaking(false);
      setError('朗讀未能完成，語音對話已停止。請查看文字回答，再按麥克風重試。');
      synth?.cancel();
      options.onError?.();
    };
    if (!synth) { fail(); return; }
    const parts = speechChunks(speakable(text, 600));
    if (!parts.length) { options.onEnd?.(); return; }
    setSpeaking(true);
    try {
      for (let i = 0; i < parts.length && run.current === id; i += 1) {
        const u = new SpeechSynthesisUtterance(parts[i]);
        u.lang = 'zh-TW';
        if (voiceRef.current) u.voice = voiceRef.current;
        u.rate = options.rate ?? 1;
        u.pitch = 1;
        const last = i === parts.length - 1;
        u.onend = () => {
          if (last && mounted.current && run.current === id) {
            run.current += 1;
            setSpeaking(false);
            options.onEnd?.();
          }
        };
        u.onerror = fail;
        synth.speak(u);
      }
    } catch { fail(); }
  }, []);
  const stop = useCallback(() => {
    run.current += 1;
    window.speechSynthesis?.cancel();
    if (mounted.current) setSpeaking(false);
  }, []);
  return { speaking, error, speak, stop, unlock, clearError: () => setError('') };
}

/* ---------- Controls ---------- */

export function MicButton({ listening, conversation, disabled, onClick }: { listening: boolean; conversation?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`sk-mic${listening ? ' is-listening' : ''}${conversation ? ' is-conversation' : ''}`} onClick={onClick} disabled={disabled} aria-pressed={listening} aria-label={conversation ? '結束語音對話' : listening ? '停止收音' : '語音輸入'} data-tip={conversation ? '結束語音對話，不再收音或自動送出' : listening ? '按一下結束收音' : '語音輸入'}>
      <Icon name="mic" size={18} />
    </button>
  );
}

/** 🔊 on a reply: read it aloud (or stop). */
export function SpeakButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`msg-speak${active ? ' is-on' : ''}`} onClick={onClick} aria-label={active ? '停止朗讀' : '朗讀這則回覆'} data-tip={active ? '停止朗讀' : '朗讀'}>
      <Icon name="speaker" size={14} />
    </button>
  );
}

/** Voice settings for this device (設定與連線). */
export function VoiceSettingsCard() {
  const { settings, update } = useVoiceSettings();
  const [support, setSupport] = useState<{ recognition: boolean; synthesis: boolean; reason?: string } | null>(null);
  useEffect(() => { setSupport(voiceSupport(window as never)); }, []);
  const toggle = (key: 'autoSend' | 'readAloud' | 'conversation', label: string, hint: string) => (
    <label className="voice-opt">
      <input type="checkbox" checked={settings[key]} onChange={e => update({ [key]: e.target.checked })} />
      <span><b>{label}</b><small>{hint}</small></span>
    </label>
  );
  return (
    <div className="voice-settings">
      {support && !support.recognition && <p className="hint">{support.reason ?? '這個瀏覽器不支援語音輸入。'}</p>}
      {toggle('autoSend', '說完自動送出', '停頓後直接送出；關閉時文字會留在輸入框，讓您確認後再送。')}
      {toggle('readAloud', '朗讀回答', '用語音提問時，SASUKE 會把回答唸出來。')}
      {toggle('conversation', '對話模式', '唸完回答後自動繼續聽；朗讀中可按「打斷並說話」。說「結束」或按麥克風即可停止。')}
      <div className="voice-rate">
        <span>語速</span>
        {[0.9, 1, 1.15, 1.3].map(r => <button key={r} type="button" className={settings.rate === r ? 'on' : undefined} aria-pressed={settings.rate === r} onClick={() => update({ rate: r })}>{r === 1 ? '標準' : `${r}×`}</button>)}
      </div>
      <p className="hint">語音辨識與朗讀由瀏覽器提供（iPhone 會經由 Apple 伺服器辨識），不另外付費。記帳、寄信等需要確認的動作，仍要您親手按確認。</p>
    </div>
  );
}

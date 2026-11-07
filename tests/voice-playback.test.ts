// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSpeech } from '@/app/components/Voice';
import { BrowserUtterance, browserSynthesis } from './helpers/browser-speech';
let root: Root, host: HTMLDivElement, speech: ReturnType<typeof useSpeech>;
let synth: ReturnType<typeof browserSynthesis>;
function Harness() { speech = useSpeech(); return createElement('span', {}, speech.speaking ? 'speaking' : 'idle'); }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  synth = browserSynthesis(); vi.stubGlobal('speechSynthesis', synth); vi.stubGlobal('SpeechSynthesisUtterance', BrowserUtterance);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('only completes after the last chunk of a normal read-back', async () => {
  let completed = 0;
  await act(async () => speech.speak('一'.repeat(200), { onEnd: () => completed++ }));
  await act(async () => synth.utterances[0].onend?.());
  expect(completed).toBe(0); expect(host.textContent).toBe('speaking');
  await act(async () => synth.utterances[1].onend?.());
  expect(completed).toBe(1); expect(host.textContent).toBe('idle');
});
it('does not report canceled speech as a completed reply while replacing it', async () => {
  let staleCompleted = 0;
  await act(async () => speech.speak('舊回答', { onEnd: () => staleCompleted++ }));
  synth.cancelEmitsError = true;
  await act(async () => speech.speak('新回答'));
  expect(staleCompleted).toBe(0); expect(host.textContent).toBe('speaking');
});
it('reports a playback error instead of resuming a conversation as success', async () => {
  let completed = 0, errors = 0;
  await act(async () => speech.speak('錯誤的回答', { onEnd: () => completed++, onError: () => errors++ }));
  const utterance = synth.utterances.at(-1)!;
  await act(async () => { utterance.onerror?.(); utterance.onend?.(); });
  expect(completed).toBe(0); expect(errors).toBe(1); expect(host.textContent).toBe('idle');
});
it('ignores queued completion after unmount and cannot speak after leaving', async () => {
  let completed = 0;
  await act(async () => speech.speak('離開前', { onEnd: () => completed++ }));
  const old = synth.utterances.at(-1)!;
  await act(async () => root.unmount());
  await act(async () => { old.onend?.(); speech.speak('離開後'); });
  expect(completed).toBe(0); expect(synth.utterances.map(u => u.text)).toEqual(['離開前']);
});
it('handles an unavailable speech service as an error rather than success', async () => {
  let completed = 0, errors = 0;
  vi.stubGlobal('speechSynthesis', undefined);
  await act(async () => speech.speak('不能朗讀', { onEnd: () => completed++, onError: () => errors++ }));
  expect(completed).toBe(0); expect(errors).toBe(1);
});
it('handles a thrown playback call without leaving speaking state stuck', async () => {
  let completed = 0, errors = 0;
  synth.speak = () => { throw new Error('Synthetic audio device failure'); };
  await act(async () => speech.speak('無法播放', { onEnd: () => completed++, onError: () => errors++ }));
  expect(completed).toBe(0); expect(errors).toBe(1); expect(host.textContent).toBe('idle');
});

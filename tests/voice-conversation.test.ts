// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
import { Chat } from '@/app/Chat';
import { loadFeatureFlags } from '@/lib/features';
import { BrowserRecognition, BrowserUtterance, browserSynthesis } from './helpers/browser-speech';
let root: Root, host: HTMLDivElement, synth: ReturnType<typeof browserSynthesis>;
const posts: Array<{ url: string; init: RequestInit; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
const mic = () => host.querySelector<HTMLButtonElement>('.sk-mic')!;
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); posts.length = 0; BrowserRecognition.reset();
  localStorage.setItem('sasuke:voice:v1', JSON.stringify({ conversation: true }));
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  synth = browserSynthesis(); vi.stubGlobal('speechSynthesis', synth); vi.stubGlobal('SpeechSynthesisUtterance', BrowserUtterance); vi.stubGlobal('SpeechRecognition', BrowserRecognition);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') throw new Error(`Unexpected fetch ${url}`);
    return new Promise((resolve, reject) => posts.push({ url, init, resolve, reject }));
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => root.render(createElement(Chat, { connected: {}, variant: 'sasuke', features: loadFeatureFlags(), ai: null }))); }
async function clickMic() { await act(async () => mic().click()); return BrowserRecognition.instances.at(-1)!; }
async function utter(text = '測試今天狀態') { const rec = await clickMic(); await act(async () => { rec.result(text); rec.finish(); }); return rec; }
async function reply(text = '測試回答。') { await act(async () => posts.at(-1)!.resolve(new Response(JSON.stringify({ ok: true, messages: [], events: [], reply: text })))); }
async function advance() { await act(async () => { vi.advanceTimersByTime(400); }); }

it('sends once, reads the answer, then listens again only after playback finishes', async () => {
  await mount(); await utter();
  expect(posts).toHaveLength(1); expect(posts[0].url).toBe('/api/chat');
  expect(JSON.parse(posts[0].init.body as string).text).toBe('測試今天狀態');
  await reply(); await advance();
  expect(BrowserRecognition.instances).toHaveLength(1);
  expect(synth.utterances.at(-1)!.text).toBe('測試回答。');
  await act(async () => synth.utterances.at(-1)!.onend?.()); await advance();
  expect(BrowserRecognition.instances).toHaveLength(2);
  expect(mic().getAttribute('aria-pressed')).toBe('true');
  const next = BrowserRecognition.instances[1];
  await act(async () => { next.result('結束'); next.finish(); }); await advance();
  expect(posts).toHaveLength(1); expect(BrowserRecognition.instances).toHaveLength(2);
});
it('ending a conversation discards queued finalization without sending the partial draft', async () => {
  await mount(); const rec = await clickMic();
  await act(async () => rec.result('尚未完成的指令', false));
  const end = rec.onend!;
  await clickMic(); await act(async () => end()); await advance();
  expect(posts).toHaveLength(0); expect(host.querySelector('textarea')!.value).toBe('尚未完成的指令');
  expect(rec.aborted).toBe(true);
});
it('can restart with one tap after a microphone permission error', async () => {
  await mount(); const rec = await clickMic();
  await act(async () => rec.fail('not-allowed')); await advance();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('麥克風');
  expect(BrowserRecognition.instances).toHaveLength(1);
  await clickMic(); expect(BrowserRecognition.instances).toHaveLength(2);
  expect(mic().getAttribute('aria-pressed')).toBe('true'); expect(posts).toHaveLength(0);
});
it('can restart with one tap after recognition start throws', async () => {
  await mount(); BrowserRecognition.startError = true;
  await clickMic(); BrowserRecognition.startError = false;
  await clickMic(); expect(BrowserRecognition.instances).toHaveLength(2);
  expect(mic().getAttribute('aria-pressed')).toBe('true');
});
it('does not restart listening after a playback failure and displays the failure', async () => {
  await mount(); await utter(); await reply();
  await act(async () => synth.utterances.at(-1)!.onerror?.()); await advance();
  expect(BrowserRecognition.instances).toHaveLength(1); expect(posts).toHaveLength(1);
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('朗讀');
  await clickMic(); expect(BrowserRecognition.instances).toHaveLength(2);
});
it('manual submit while listening cannot be resent by a late recognition end', async () => {
  await mount(); const rec = await clickMic();
  await act(async () => rec.result('只送出一次', false));
  const end = rec.onend!;
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await reply(); await act(async () => end());
  expect(posts).toHaveLength(1); expect(host.querySelector('textarea')!.value).toBe('');
});
it('ending while the reply is pending keeps text delivery but suppresses speech and restart', async () => {
  await mount(); await utter(); await clickMic(); await reply(); await advance();
  expect(host.textContent).toContain('測試回答。');
  expect(synth.utterances.filter(u => u.volume !== 0)).toHaveLength(0);
  expect(BrowserRecognition.instances).toHaveLength(1); expect(posts).toHaveLength(1);
});
it('ending during the resume gap prevents the scheduled microphone restart', async () => {
  await mount(); await utter(); await reply();
  await act(async () => synth.utterances.at(-1)!.onend?.());
  await clickMic(); await advance();
  expect(BrowserRecognition.instances).toHaveLength(1); expect(posts).toHaveLength(1);
});
it('leaving during an in-flight reply never speaks or restarts capture', async () => {
  await mount(); await utter(); await act(async () => root.unmount());
  await reply(); await advance();
  expect(synth.utterances.filter(u => u.volume !== 0)).toHaveLength(0); expect(BrowserRecognition.instances).toHaveLength(1);
});
it('leaving during the resume gap never starts another recognition run', async () => {
  await mount(); await utter(); await reply();
  await act(async () => synth.utterances.at(-1)!.onend?.());
  await act(async () => root.unmount()); await advance();
  expect(BrowserRecognition.instances).toHaveLength(1);
});
it('stopping playback ends conversation so one later tap starts a new session', async () => {
  await mount(); await utter(); await reply();
  await act(async () => host.querySelector<HTMLButtonElement>('.sk-stop-speak')!.click());
  await advance(); expect(BrowserRecognition.instances).toHaveLength(1);
  await clickMic(); expect(BrowserRecognition.instances).toHaveLength(2);
});
it('single-utterance mode still finalizes on stop and never automatically listens again', async () => {
  localStorage.setItem('sasuke:voice:v1', JSON.stringify({ conversation: false }));
  await mount(); const rec = await clickMic(); await act(async () => rec.result('一句話'));
  await clickMic(); await act(async () => rec.finish()); await reply();
  await act(async () => synth.utterances.at(-1)!.onend?.()); await advance();
  expect(posts).toHaveLength(1); expect(BrowserRecognition.instances).toHaveLength(1);
});
it('hiding the page stops capture without submitting its partial text or restarting', async () => {
  await mount(); const rec = await clickMic();
  await act(async () => rec.result('隱藏前的草稿', false)); const end = rec.onend!;
  const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  try {
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => end()); await advance();
    expect(rec.aborted).toBe(true); expect(posts).toHaveLength(0);
    expect(host.querySelector('textarea')!.value).toBe('隱藏前的草稿');
    expect(BrowserRecognition.instances).toHaveLength(1);
  } finally { hidden.mockRestore(); }
});
it('pagehide cancels scheduled restart even when the component remains mounted', async () => {
  await mount(); await utter(); await reply();
  await act(async () => { synth.utterances.at(-1)!.onend?.(); window.dispatchEvent(new Event('pagehide')); });
  await advance(); expect(BrowserRecognition.instances).toHaveLength(1);
});
it('silent recognition completion ends the session and allows one-tap recovery', async () => {
  await mount(); const rec = await clickMic(); await act(async () => rec.finish());
  await advance(); expect(posts).toHaveLength(0); expect(BrowserRecognition.instances).toHaveLength(1);
  await clickMic(); expect(BrowserRecognition.instances).toHaveLength(2);
});
async function fill(value: string) {
  await act(async () => {
    const input = host.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('ending during a pending reply updates the microphone to disabled idle immediately', async () => {
  await mount(); await utter(); await clickMic();
  expect(mic().getAttribute('aria-label')).toBe('語音輸入'); expect(mic().disabled).toBe(true);
});
it('two same-tick end taps cannot restart capture while the response is pending', async () => {
  await mount(); await utter();
  await act(async () => { mic().click(); mic().click(); });
  expect(BrowserRecognition.instances).toHaveLength(1); expect(posts).toHaveLength(1);
});
it('keyboard editing during playback takes ownership of the draft and stops auto-listening', async () => {
  await mount(); await utter(); await reply();
  const playback = synth.utterances.at(-1)!;
  await fill('保留我的鍵盤草稿');
  await act(async () => playback.onend?.()); await advance();
  expect(host.querySelector('textarea')!.value).toBe('保留我的鍵盤草稿');
  expect(BrowserRecognition.instances).toHaveLength(1); expect(posts).toHaveLength(1);
});
it('keyboard editing during capture is not overwritten by delayed recognition', async () => {
  await mount(); const rec = await clickMic();
  await act(async () => rec.result('語音草稿', false));
  const result = rec.onresult!, end = rec.onend!;
  await fill('我修改過的草稿');
  await act(async () => { result({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '舊辨識' } }] }); end(); });
  expect(host.querySelector('textarea')!.value).toBe('我修改過的草稿'); expect(posts).toHaveLength(0);
  expect(rec.aborted).toBe(true);
});
it('a typed submit during the resume gap cancels old audio and never captures under the new request', async () => {
  await mount(); await utter(); await reply();
  await act(async () => synth.utterances.at(-1)!.onend?.());
  await fill('新的鍵盤問題');
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await advance(); expect(posts).toHaveLength(2); expect(BrowserRecognition.instances).toHaveLength(1);
  await reply('純文字回答'); await advance();
  expect(synth.utterances.map(u => u.text)).not.toContain('純文字回答');
  expect(BrowserRecognition.instances).toHaveLength(1);
});
it('an edited voice draft with auto-send off is sent once, read aloud and can resume', async () => {
  localStorage.setItem('sasuke:voice:v1', JSON.stringify({ conversation: true, autoSend: false }));
  await mount(); const rec = await clickMic();
  await act(async () => { rec.result('未修改的語音'); rec.finish(); });
  expect(posts).toHaveLength(0);
  await fill('修改後的語音問題');
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(posts).toHaveLength(1); expect(JSON.parse(posts[0].init.body as string).text).toBe('修改後的語音問題');
  await reply(); expect(synth.utterances.at(-1)!.text).toBe('測試回答。');
  await act(async () => synth.utterances.at(-1)!.onend?.()); await advance();
  expect(BrowserRecognition.instances).toHaveLength(2);
});

const interrupt = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '打斷並說話');
async function clickInterrupt() {
  expect(interrupt()).toBeDefined();
  await act(async () => interrupt()!.click());
  return BrowserRecognition.instances.at(-1)!;
}
it('interrupts playback in one tap and sends a fresh turn without old callbacks restarting capture', async () => {
  await mount(); await utter(); await reply();
  const oldPlayback = synth.utterances.at(-1)!;
  synth.cancelEmitsError = true;
  const next = await clickInterrupt();
  expect(BrowserRecognition.instances).toHaveLength(2);
  expect(mic().getAttribute('aria-pressed')).toBe('true'); expect(interrupt()).toBeUndefined();
  await act(async () => { oldPlayback.onend?.(); oldPlayback.onerror?.(); }); await advance();
  expect(BrowserRecognition.instances).toHaveLength(2); expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { next.result('改問下一個問題'); next.finish(); });
  expect(posts).toHaveLength(2); expect(JSON.parse(posts[1].init.body as string).text).toBe('改問下一個問題');
  await reply('下一個答案。');
  expect(synth.utterances.at(-1)!.text).toBe('下一個答案。');
  await act(async () => synth.utterances.at(-1)!.onend?.()); await advance();
  expect(BrowserRecognition.instances).toHaveLength(3);
});
it('two same-tick interruption taps start only one new recognition run', async () => {
  await mount(); await utter(); await reply();
  const button = interrupt(); expect(button).toBeDefined();
  await act(async () => { button!.click(); button!.click(); });
  expect(BrowserRecognition.instances).toHaveLength(2); expect(posts).toHaveLength(1);
  expect(BrowserRecognition.instances[1].aborted).toBe(false);
});
it('a denied microphone after interruption stops the session and permits a later explicit retry', async () => {
  await mount(); await utter(); await reply();
  const oldPlayback = synth.utterances.at(-1)!;
  const next = await clickInterrupt();
  await act(async () => { next.fail('not-allowed'); oldPlayback.onend?.(); }); await advance();
  expect(mic().getAttribute('aria-pressed')).toBe('false');
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('麥克風');
  expect(BrowserRecognition.instances).toHaveLength(2); expect(posts).toHaveLength(1);
  await clickMic(); expect(BrowserRecognition.instances).toHaveLength(3);
});
it('ending the fresh interrupted utterance never sends its canceled draft', async () => {
  await mount(); await utter(); await reply();
  const next = await clickInterrupt();
  await act(async () => next.result('還沒講完', false));
  const end = next.onend!;
  await clickMic(); await act(async () => end()); await advance();
  expect(posts).toHaveLength(1); expect(next.aborted).toBe(true);
  expect(host.querySelector('textarea')!.value).toBe('還沒講完');
});
it('interruption respects single-utterance mode and never auto-resumes after the next answer', async () => {
  localStorage.setItem('sasuke:voice:v1', JSON.stringify({ conversation: false }));
  await mount(); await utter(); await reply(); const next = await clickInterrupt();
  await act(async () => { next.result('單次插話'); next.finish(); }); await reply();
  await act(async () => synth.utterances.at(-1)!.onend?.()); await advance();
  expect(posts).toHaveLength(2); expect(BrowserRecognition.instances).toHaveLength(2);
});
it('interruption with auto-send off preserves a draft for explicit review', async () => {
  await mount(); await utter(); await reply();
  await act(async () => {
    localStorage.setItem('sasuke:voice:v1', JSON.stringify({ conversation: true, autoSend: false }));
    window.dispatchEvent(new Event('sasuke-voice-settings'));
  });
  const next = await clickInterrupt();
  await act(async () => { next.result('先確認再送'); next.finish(); }); await advance();
  expect(posts).toHaveLength(1); expect(host.querySelector('textarea')!.value).toBe('先確認再送');
});
it('interruption preserves a typed draft when taking over manual read-aloud', async () => {
  await mount(); await utter(); await reply(); await fill('原有草稿');
  await act(async () => host.querySelector<HTMLButtonElement>('.msg-speak')!.click());
  const next = await clickInterrupt();
  await act(async () => { next.result('加上補充'); next.finish(); });
  expect(JSON.parse(posts[1].init.body as string).text).toBe('原有草稿 加上補充');
});
it('cannot interrupt a manual read-aloud into microphone capture while another request is pending', async () => {
  await mount(); await utter(); await reply(); await fill('等待中的新問題');
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await act(async () => host.querySelector<HTMLButtonElement>('.msg-speak')!.click());
  expect(interrupt()).toBeDefined(); expect(interrupt()!.disabled).toBe(true);
  await act(async () => interrupt()!.click());
  expect(BrowserRecognition.instances).toHaveLength(1); expect(posts).toHaveLength(2);
});
it('retains stop-only playback when browser recognition is unavailable', async () => {
  vi.stubGlobal('SpeechRecognition', undefined); vi.stubGlobal('webkitSpeechRecognition', undefined);
  await mount(); await fill('鍵盤問題');
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await reply(); await act(async () => host.querySelector<HTMLButtonElement>('.msg-speak')!.click());
  expect(interrupt()).toBeUndefined(); expect(host.querySelector('.sk-stop-speak')).not.toBeNull();
  expect(BrowserRecognition.instances).toHaveLength(0);
});

it('shows a visible voice action and updates it when ending the active conversation', async () => {
  await mount();
  expect(mic().textContent?.trim()).toBe(mic().getAttribute('aria-label'));
  expect(mic().textContent?.trim()).not.toBe('');
  await clickMic();
  expect(mic().textContent).toContain('結束');
  await clickMic();
  expect(mic().textContent?.trim()).toBe(mic().getAttribute('aria-label'));
  expect(posts).toHaveLength(0);
});
it('shows stop-capture text for single-utterance input without advertising a live call', async () => {
  localStorage.setItem('sasuke:voice:v1', JSON.stringify({ conversation: false }));
  await mount(); await clickMic();
  expect(mic().textContent).toContain('停止收音');
  expect(mic().textContent).not.toContain('通話');
});

it('reserves the measured fixed composer height after leaving home and when voice rows resize', async () => {
  let height = 240;
  let resized: (() => void) | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { height: this.classList.contains('composer') ? height : 0 } as DOMRect;
  });
  try {
    await mount();
    expect(host.querySelector<HTMLElement>('.feed')!.style.getPropertyValue('--composer-height')).toBe('');
    await utter();
    const feed = host.querySelector<HTMLElement>('.feed')!;
    expect(feed.style.getPropertyValue('--composer-height')).toBe('240px');
    height = 410;
    await act(async () => resized?.());
    expect(feed.style.getPropertyValue('--composer-height')).toBe('410px');
    await act(async () => root.render(createElement(Chat, { connected: {}, variant: 'classic', features: loadFeatureFlags(), ai: null })));
    expect(feed.style.getPropertyValue('--composer-height')).toBe('');
    expect(disconnect).toHaveBeenCalledOnce();
  } finally { bounds.mockRestore(); }
});

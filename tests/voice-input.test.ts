// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useVoiceInput } from '@/app/components/Voice';
import { BrowserRecognition, browserSynthesis } from './helpers/browser-speech';

let root: Root, host: HTMLDivElement;
let input: ReturnType<typeof useVoiceInput>;
const shown: string[] = [], sent: string[] = [];
function Harness() {
  input = useVoiceInput(text => shown.push(text), text => sent.push(text));
  return createElement('span', {}, input.listening ? 'listening' : 'idle');
}
beforeEach(async () => {
  BrowserRecognition.reset(); shown.length = 0; sent.length = 0;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('SpeechRecognition', BrowserRecognition);
  vi.stubGlobal('speechSynthesis', browserSynthesis());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function start(base = '') { await act(async () => { input.start(base); }); return BrowserRecognition.instances.at(-1)!; }

it('submits one naturally completed utterance and preserves a draft prefix', async () => {
  const rec = await start('草稿');
  await act(async () => { rec.result('完成一句'); rec.finish(); });
  expect(shown).toEqual(['草稿 完成一句']); expect(sent).toEqual(['草稿 完成一句']);
  expect(host.textContent).toBe('idle');
});
it('does not submit a transcript after the browser aborts recognition', async () => {
  const rec = await start();
  await act(async () => { rec.result('尚未說完', false); rec.fail('aborted'); });
  expect(sent).toEqual([]); expect(host.textContent).toBe('idle');
});
it('ignores delayed result/end/error events from a replaced recognition run', async () => {
  const old = await start();
  await act(async () => old.result('舊草稿', false));
  const result = old.onresult!, end = old.onend!, error = old.onerror!;
  const current = await start('新草稿');
  await act(async () => {
    result({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '過期文字' } }] });
    error({ error: 'network' }); end();
  });
  expect(shown).toEqual(['舊草稿']); expect(sent).toEqual([]);
  expect(input.error).toBe(''); expect(host.textContent).toBe('listening');
  await act(async () => { current.result('有效文字'); current.finish(); current.finish(); });
  expect(sent).toEqual(['新草稿 有效文字']);
});
it('ignores recognition results after unmount even if the browser has queued them', async () => {
  const rec = await start();
  await act(async () => rec.result('未送出的文字', false));
  const result = rec.onresult!, end = rec.onend!;
  await act(async () => root.unmount());
  await act(async () => {
    result({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '離開後' } }] }); end();
  });
  expect(rec.aborted).toBe(true); expect(shown).toEqual(['未送出的文字']); expect(sent).toEqual([]);
});
it('ends listening immediately on a permission error even before onend arrives', async () => {
  const rec = await start();
  await act(async () => rec.onerror?.({ error: 'not-allowed' }));
  expect(host.textContent).toBe('idle'); expect(input.error).toContain('麥克風'); expect(sent).toEqual([]);
});
it('cancel preserves visible text but cannot submit it from a queued end event', async () => {
  const rec = await start();
  await act(async () => rec.result('保留草稿', false));
  const end = rec.onend!;
  await act(async () => { input.cancel(); end(); });
  expect(rec.aborted).toBe(true); expect(sent).toEqual([]); expect(shown).toEqual(['保留草稿']);
  expect(host.textContent).toBe('idle');
});
it('cannot start a microphone from a callback after unmount', async () => {
  await act(async () => root.unmount());
  let started = true;
  await act(async () => { started = input.start(''); });
  expect(started).toBe(false); expect(BrowserRecognition.instances).toHaveLength(0);
});
it('retains the normal stop-and-finalize behavior for a single utterance', async () => {
  const rec = await start();
  await act(async () => { input.stop(); rec.result('說完了'); rec.finish(); });
  expect(sent).toEqual(['說完了']); expect(host.textContent).toBe('idle');
});

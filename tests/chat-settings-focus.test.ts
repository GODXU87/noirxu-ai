// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
import { Chat } from '@/app/Chat';
import { loadFeatureFlags } from '@/lib/features';

let root: Root, host: HTMLDivElement;
const requests: string[] = [];
beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear(); requests.length = 0;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    requests.push(url);
    return Promise.reject(new Error('Unexpected synthetic request'));
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Chat, { connected: {}, variant: 'sasuke', features: { ...loadFeatureFlags(), voice: false }, ai: null })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const opener = () => host.querySelector<HTMLButtonElement>('.sk-agent')!;
const dialog = () => host.querySelector('[role="dialog"][aria-label="SASUKE 設定"]');
async function fill(value: string) {
  await act(async () => {
    const input = host.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('Escape from a settings control restores opener focus without changing the draft or sending', async () => {
  await fill('Synthetic unsent draft');
  await act(async () => opener().click());
  const select = dialog()!.querySelector('select')!;
  select.focus(); expect(document.activeElement).toBe(select);
  await act(async () => select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(dialog()).toBeNull(); expect(opener().getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(opener());
  expect(host.querySelector('textarea')!.value).toBe('Synthetic unsent draft');
  expect(requests).toEqual([]);
});

it('reopens normally after Escape and restores focus from a dialog link', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    await act(async () => opener().click());
    expect(opener().getAttribute('aria-expanded')).toBe('true');
    const link = dialog()!.querySelector<HTMLAnchorElement>('a')!; link.focus();
    await act(async () => link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(dialog()).toBeNull(); expect(document.activeElement).toBe(opener());
  }
  expect(requests).toEqual([]);
});

it('outside click keeps focus on the clicked input rather than stealing it back', async () => {
  await fill('Synthetic preserved draft');
  await act(async () => opener().click());
  const input = host.querySelector('textarea')!;
  await act(async () => { input.focus(); input.click(); });
  expect(dialog()).toBeNull(); expect(document.activeElement).toBe(input);
  expect(input.value).toBe('Synthetic preserved draft'); expect(requests).toEqual([]);
});

it('Escape while settings are closed does not move the input focus', async () => {
  const input = host.querySelector('textarea')!; input.focus();
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.activeElement).toBe(input); expect(dialog()).toBeNull(); expect(requests).toEqual([]);
});

it('Escape with the popover open does not steal focus from an outside input', async () => {
  await act(async () => opener().click());
  const input = host.querySelector('textarea')!; input.focus();
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(dialog()).toBeNull(); expect(document.activeElement).toBe(input); expect(requests).toEqual([]);
});

it('the opener still toggles the settings closed without changing the draft', async () => {
  await fill('Synthetic toggle draft');
  await act(async () => { opener().focus(); opener().click(); });
  expect(dialog()).not.toBeNull();
  await act(async () => opener().click());
  expect(dialog()).toBeNull(); expect(document.activeElement).toBe(opener());
  expect(host.querySelector('textarea')!.value).toBe('Synthetic toggle draft'); expect(requests).toEqual([]);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryView } from '@/app/sasuke/FunctionPages';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => createElement('a', props, children) }));
vi.mock('@/app/overview/Overview', () => ({ AgendaCard: () => null, Panel: () => null }));
vi.mock('@/app/sasuke/SasukeNav', () => ({ HistoryDialog: () => null }));
const memory = { id: '00000000-0000-4000-8000-000000000001', content: '示範條目原值', category: 'other', source: 'user', created_at: '2026-10-01T01:00:00Z', updated_at: '2026-10-29T02:00:00Z', revision: 3 };
const categories = { preference: '偏好', other: '其他' };
const response = (body: unknown) => ({ json: async () => body }) as Response;
const listed = (items: unknown[] = [memory]) => response({ ok: true, memories: items, categories });
let root: Root, host: HTMLDivElement;
async function render() { await act(async () => root.render(createElement(MemoryView))); }
function button(text: string) { return [...host.querySelectorAll('button')].find(b => b.textContent === text)!; }
const field = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
async function click(text: string) { await act(async () => button(text).click()); }
async function input(label: string, value: string) {
  const node = field(label);
  await act(async () => {
    const proto = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('memory provenance and correction UI', () => {
  it('labels source and both dates without claiming verification; unknown source/date are not invented', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => listed([memory, { ...memory, id: 'legacy', source: 'unrecorded', created_at: undefined, updated_at: 'invalid' }, { ...memory, id: 'confirmed', source: 'confirmed' }])));
    await render();
    for (const text of ['原始來源：使用者提供', '原始來源：使用者確認', '來源未記錄', '日期未記錄', '建立', '更新', '不代表已獨立查證']) expect(host.textContent).toContain(text);
    expect([...host.querySelectorAll('time')].map(t => t.dateTime)).toContain(memory.created_at);
    expect([...host.querySelectorAll('time')].map(t => t.dateTime)).toContain(memory.updated_at);
  });

  it('corrects content and category with the viewed revision; cancel and blank edits never write', async () => {
    const writes: any[] = []; let current = memory;
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (!options?.method || options.method === 'GET') return listed([current]);
      const body = JSON.parse(options.body); writes.push(body); current = { ...current, ...body, revision: 4 };
      return response({ ok: true, memory: current });
    }));
    await render(); await click('更正'); await input('修改記憶', '未保存草稿'); await click('取消'); expect(writes).toEqual([]);
    await click('更正'); expect(field('修改記憶').value).toBe(memory.content);
    await input('修改記憶', '  '); expect(button('儲存更正').disabled).toBe(true);
    await input('修改記憶', '更正後示範條目'); await input('記憶分類', 'preference'); await click('儲存更正');
    expect(writes).toEqual([{ id: memory.id, revision: 3, content: '更正後示範條目', category: 'preference' }]);
    expect(field('修改記憶')).toBeNull(); expect(host.textContent).toContain('更正後示範條目'); expect(host.textContent).toContain('偏好');
  });

  it('blocks repeated writes while saving and does not clear the draft on failure', async () => {
    let finish!: (value: Response) => void; const writes: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (!options?.method || options.method === 'GET') return listed();
      writes.push(JSON.parse(options.body)); return new Promise<Response>(r => { finish = r; });
    }));
    await render(); await click('更正'); await input('修改記憶', '保留草稿');
    await act(async () => { button('儲存更正').click(); button('儲存更正').click(); });
    expect(writes).toHaveLength(1); expect(button('取消').disabled).toBe(true);
    await act(async () => finish(response({ ok: false, error: { code: 'INTERNAL', message: '暫時無法儲存' } })));
    expect(field('修改記憶').value).toBe('保留草稿'); expect(button('儲存更正').disabled).toBe(false); expect(host.querySelector('[role="alert"]')?.textContent).toContain('暫時無法儲存');
  });

  it('preserves the original revision and draft across conflict refresh; reopening explicitly adopts the newer value', async () => {
    let current = memory; const writes: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (!options?.method || options.method === 'GET') return listed([current]);
      writes.push(JSON.parse(options.body)); return response({ ok: false, error: { code: 'CONFLICT', message: '版本已更新' } });
    }));
    await render(); await click('更正'); await input('修改記憶', '尚未儲存草稿'); current = { ...memory, content: '另一裝置已更正', revision: 4 };
    await click('儲存更正'); await click('重新讀取');
    expect(field('修改記憶').value).toBe('尚未儲存草稿'); expect(host.textContent).toContain('另一裝置已更正');
    await click('儲存更正'); expect(writes.map(w => w.revision)).toEqual([3, 3]);
    await click('取消'); await click('更正'); expect(field('修改記憶').value).toBe('另一裝置已更正');
  });

  it('keeps a draft visible if the memory was deleted elsewhere, rather than silently discarding it on refresh', async () => {
    let items: unknown[] = [memory]; vi.stubGlobal('fetch', vi.fn(async () => listed(items)));
    await render(); await click('更正'); await input('修改記憶', '保留刪除前草稿'); items = [];
    await click('重新讀取'); expect(field('修改記憶').value).toBe('保留刪除前草稿'); expect(host.textContent).toContain('已不存在'); expect(button('儲存更正').disabled).toBe(true);
  });

  it('deletes only after confirmation and sends the visible revision', async () => {
    const writes: any[] = []; vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (!options?.method || options.method === 'GET') return listed(writes.length ? [] : [memory]);
      writes.push({ method: options.method, ...JSON.parse(options.body) }); return response({ ok: true, removed: true });
    }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await render(); await click('刪除'); expect(writes).toEqual([]); await click('刪除');
    expect(confirm).toHaveBeenCalledTimes(2); expect(writes).toEqual([{ method: 'DELETE', id: memory.id, revision: 3 }]); expect(host.textContent).toContain('還沒有記憶');
  });

  it('unlocks a stalled mutation with an uncertain-result warning and allows read-only verification', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (!options?.method || options.method === 'GET') return listed();
      return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    }));
    await render(); await click('更正'); await input('修改記憶', '逾時草稿'); await click('儲存更正');
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(button('取消').disabled).toBe(false); expect(button('重新讀取').disabled).toBe(false);
    expect(field('修改記憶').value).toBe('逾時草稿'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('無法確認操作結果');
    await click('重新讀取'); expect(host.textContent).toContain(memory.content);
  });

  it('does not add an invisible partial list after initial read failure; reload enables additions', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      requests.push(options?.method ?? 'GET');
      if (requests.length === 1) throw new Error('offline');
      return listed();
    }));
    await render(); await input('要記住的事', '尚未載入時的草稿');
    expect(button('記住').disabled).toBe(true);
    await act(async () => field('要記住的事').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(requests).toEqual(['GET']);
    await click('重新讀取'); expect(button('記住').disabled).toBe(false); expect(host.textContent).toContain(memory.content);
  });

  it('recovers a failed initial read through explicit refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(listed()));
    await render(); expect(host.querySelector('[role="alert"]')).not.toBeNull(); await click('重新讀取'); expect(host.textContent).toContain(memory.content);
  });
});

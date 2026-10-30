// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TasksView } from '@/app/sasuke/FunctionPages';
import { TaskCard } from '@/app/components/shared';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => createElement('a', props, children) }));
vi.mock('@/app/overview/Overview', () => ({ AgendaCard: () => null, Panel: () => null }));
vi.mock('@/app/sasuke/SasukeNav', () => ({ HistoryDialog: () => null }));

let root: Root, host: HTMLDivElement;
const task = (status = 'queued') => ({ id: 't1', title: '喝水', kind: 'recurring', kind_label: '週期自動化', status, status_label: status === 'queued' ? '排程中' : '已完成', schedule_label: '每天 08:00', next_local: '明天 08:00', runs_kept: 1, last_run: status === 'completed' ? { status: 'completed', local: '今天 08:00' } : null });
const response = (data: unknown) => ({ json: async () => ({ ok: true, result: { status: 'ok', data } }) }) as Response;
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
async function render(node: ReactNode = createElement(TasksView)) { await act(async () => root.render(node)); }
async function event(target: EventTarget, name: string) { await act(async () => target.dispatchEvent(new Event(name))); }
function button(text: string) { return [...host.querySelectorAll('button')].find(b => b.textContent === text)!; }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T05:00:00Z'));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('task-center freshness', () => {
  it('shows new task results on visible polling without overlapping reads', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => response({ tasks: [task(++reads === 1 ? 'queued' : 'completed')], halted: false })));
    await render(); expect(host.textContent).toContain('排程中');
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(host.textContent).toContain('已完成'); expect(host.textContent).toContain('最後更新');
    expect(reads).toBe(2);
  });

  it('stops polling hidden, refreshes when visible, and cleans up on unmount', async () => {
    const fetcher = vi.fn(async () => response({ tasks: [task()], halted: false })); vi.stubGlobal('fetch', fetcher);
    await render();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden' }); await event(document, 'visibilitychange');
    await act(async () => vi.advanceTimersByTimeAsync(60_000)); expect(fetcher).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible' }); await event(document, 'visibilitychange'); expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount()); root = createRoot(host);
    await act(async () => vi.advanceTimersByTimeAsync(60_000)); await event(window, 'noirxu-tasks-changed'); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('coalesces task-change events during a read and discards the stale response', async () => {
    let finish!: (r: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(r => { finish = r; })).mockResolvedValue(response({ tasks: [task('completed')] }));
    vi.stubGlobal('fetch', fetcher); await render();
    await event(window, 'noirxu-tasks-changed'); await event(window, 'noirxu-tasks-changed'); expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => finish(response({ tasks: [task()] }))); await flush();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(host.textContent).toContain('已完成'); expect(host.textContent).not.toContain('排程中');
  });

  it('aborts hidden reads and ignores late responses from a previous filter', async () => {
    let finish!: (r: Response) => void; let signal: AbortSignal | undefined;
    const fetcher = vi.fn().mockImplementationOnce((_url, options) => { signal = options.signal; return new Promise(r => { finish = r; }); }).mockResolvedValue(response({ tasks: [task('completed')] }));
    vi.stubGlobal('fetch', fetcher); await render();
    await act(async () => button('含已結束').click());
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(response({ tasks: [task()] }))); await flush();
    expect(host.textContent).toContain('已完成'); expect(host.textContent).not.toContain('排程中');
  });

  it('keeps last good data and timestamp when offline or a refresh fails', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ tasks: [task()] })).mockRejectedValue(new Error('offline')); vi.stubGlobal('fetch', fetcher);
    await render(); const updated = host.querySelector('time')?.getAttribute('dateTime');
    Object.defineProperty(navigator, 'onLine', { value: false }); await event(window, 'offline');
    expect(host.textContent).toContain('離線'); expect(host.textContent).toContain('喝水');
    await act(async () => vi.advanceTimersByTimeAsync(60_000)); expect(fetcher).toHaveBeenCalledTimes(1);
    Object.defineProperty(navigator, 'onLine', { value: true }); await event(window, 'online');
    expect(host.textContent).toContain('更新失敗'); expect(host.textContent).toContain('喝水'); expect(host.querySelector('time')?.getAttribute('dateTime')).toBe(updated);
  });
  it('aborts an in-flight read when hidden and ignores its late response', async () => {
    let finish!: (r: Response) => void; let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, options) => { signal = options.signal; return new Promise(r => { finish = r; }); }));
    await render();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden' }); await event(document, 'visibilitychange');
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(response({ tasks: [task('completed')] })));
    expect(host.textContent).not.toContain('已完成'); expect(host.querySelector('time')).toBeNull();
  });

  it('bounds a stalled read with a timeout and exposes retry without claiming freshness', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    await render(); await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(host.textContent).toContain('更新逾時'); expect(host.querySelector('time')).toBeNull();
    expect(button('重新整理').disabled).toBe(false);
  });

});

describe('task-card snapshots', () => {
  it('updates result props without remounting the card', async () => {
    await render(createElement(TaskCard, { task: task() }));
    await render(createElement(TaskCard, { task: task('completed') }));
    expect(host.textContent).toContain('已完成'); expect(host.textContent).toContain('今天 08:00');
  });
  it('keeps a pending user action intact while new props arrive, then shows the action result', async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(r => { finish = r; })));
    await render(createElement(TaskCard, { task: task() }));
    await act(async () => button('暫停').click());
    await render(createElement(TaskCard, { task: { ...task(), title: 'new server snapshot' } }));
    expect(button('暫停').disabled).toBe(true); expect(host.textContent).not.toContain('new server snapshot');
    await act(async () => finish(response({ task: { ...task(), status: 'paused', status_label: '已暫停' } })));
    expect(host.textContent).toContain('已暫停'); expect(button('恢復').disabled).toBe(false);
  });

  it('keeps history expanded and refreshes it after new progress; closing aborts its read', async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn().mockResolvedValueOnce(response({ runs: [{ id: 'r1', local: '昨天', status: 'completed', steps: [] }] }))
      .mockImplementationOnce((_url, options) => { signal = options.signal; return new Promise(() => undefined); });
    vi.stubGlobal('fetch', fetcher);
    await render(createElement(TaskCard, { task: task() })); await act(async () => button('執行紀錄').click());
    expect(host.textContent).toContain('昨天');
    await render(createElement(TaskCard, { task: task('completed') }));
    expect(fetcher).toHaveBeenCalledTimes(2); expect(button('收合紀錄')).toBeTruthy();
    await act(async () => button('收合紀錄').click()); expect(signal?.aborted).toBe(true);
    expect(host.textContent).not.toContain('昨天');
  });

  it('does not erase a failed action when newer progress refreshes expanded history', async () => {
    let failAction!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('tasks.update')
      ? new Promise(r => { failAction = r; })
      : Promise.resolve(response({ runs: [{ id: 'r1', local: '昨天', status: 'completed', steps: [] }] }))));
    await render(createElement(TaskCard, { task: task() })); await act(async () => button('執行紀錄').click());
    await act(async () => button('暫停').click());
    await render(createElement(TaskCard, { task: task('completed') }));
    await act(async () => failAction({ json: async () => ({ ok: true, result: { status: 'error', message: '暫停失敗，請重試。' } }) } as Response));
    expect(host.textContent).toContain('暫停失敗，請重試。'); expect(button('收合紀錄')).toBeTruthy();
  });

  it('announces a successful task mutation so an open task list can refresh', async () => {
    const changed = vi.fn(); window.addEventListener('noirxu-tasks-changed', changed);
    vi.stubGlobal('fetch', vi.fn(async () => response({ task: { ...task(), status: 'paused', status_label: '已暫停' } })));
    try {
      await render(createElement(TaskCard, { task: task() })); await act(async () => button('暫停').click());
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener('noirxu-tasks-changed', changed); }
  });

});

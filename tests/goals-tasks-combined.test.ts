// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TasksView } from '@/app/sasuke/FunctionPages';
import type { GoalView } from '@/goals/model';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => createElement('a', props, children) }));
vi.mock('@/app/overview/Overview', () => ({ AgendaCard: () => null, Panel: () => null }));
vi.mock('@/app/sasuke/SasukeNav', () => ({ HistoryDialog: () => null }));

const initialGoal: GoalView = {
  id: '00000000-0000-4000-8000-000000000001', title: '完成教案', status: 'active', status_label: '進行中',
  progress: 30, next_step: '完成第二節', deadline: '2026-11-01T02:00:00Z', check_at: '2026-11-01T02:00:00Z', blocker: null,
  revision: 2, created_at: '2026-10-30T02:00:00Z', updated_at: '2026-10-30T03:00:00Z', completion: null,
  latest_evidence: '已寫好第一節', history_total: 2, history_kept: 2, notifications: []
};
const task = (finished = false) => ({ id: 't1', title: '喝水提醒', kind: 'recurring', kind_label: '週期自動化', status: finished ? 'completed' : 'queued', status_label: finished ? '已完成' : '排程中', schedule_label: '每天 08:00', next_local: '明天 08:00', runs_kept: 1, last_run: finished ? { status: 'completed', local: '今天 08:00' } : null });
const response = (data: unknown) => ({ json: async () => ({ ok: true, result: { status: 'ok', data } }) }) as Response;
let root: Root, host: HTMLDivElement;
async function render() { await act(async () => root.render(createElement(TasksView))); }
async function event(name: string) { await act(async () => window.dispatchEvent(new Event(name))); }
function button(text: string) { return [...host.querySelectorAll('button')].find(b => b.textContent === text)!; }
function field(text: string) { return [...host.querySelectorAll('label')].find(l => l.firstChild?.textContent === text)!.querySelector('input')!; }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T05:00:00Z'));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('combined goal tracking and task freshness', () => {
  // Catches a merge dropping either panel, cross-routing refresh events, or polling a write tool.
  it('refreshes the two real panels independently using only read tools', async () => {
    let currentGoal = initialGoal; let taskReads = 0, goalReads = 0;
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      if (['/api/acceptance','/api/owner-actions'].includes(url)) return {ok:true,json:async()=>({ok:true,items:[],errors:[]})} as Response;
      if (url.endsWith('/goals.list')) { goalReads++; return response({ goals: [currentGoal], total: 1 }); }
      if (url.endsWith('/tasks.list')) return response({ tasks: [task(++taskReads > 1)], halted: false });
      throw new Error(`Unexpected request: ${url}`);
    }));
    await render();
    expect(host.textContent).toContain('完成教案'); expect(host.textContent).toContain('排程中');
    currentGoal = { ...initialGoal, revision: 3, next_step: '整理最新教案' };
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(host.textContent).toContain('已完成'); expect(host.textContent).toContain('完成第二節');
    expect(host.textContent).not.toContain('整理最新教案'); expect(taskReads).toBe(2); expect(goalReads).toBe(1);
    await event('noirxu-goals-changed');
    expect(host.textContent).toContain('整理最新教案'); expect(taskReads).toBe(2); expect(goalReads).toBe(2);
    expect(requests.every(url => /\/(goals|tasks)\.list$/.test(url) || ['/api/acceptance','/api/owner-actions'].includes(url))).toBe(true);
  });

  // Catches replacing an open editor's original revision with a refreshed server snapshot.
  it('retains the original edit revision across goal refresh and task polling, then unlocks a conflict', async () => {
    let currentGoal = initialGoal; let taskReads = 0; const updates: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if (['/api/acceptance','/api/owner-actions'].includes(url)) return {ok:true,json:async()=>({ok:true,items:[],errors:[]})} as Response;
      if (url.endsWith('/goals.list')) return response({ goals: [currentGoal], total: 1 });
      if (url.endsWith('/tasks.list')) return response({ tasks: [task(++taskReads > 1)], halted: false });
      if (url.endsWith('/goals.update')) {
        updates.push(JSON.parse(String(options.body)));
        return { json: async () => ({ ok: true, result: { status: 'error', code: 'CONFLICT', message: '目標已更新，請重新讀取。' } }) } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    await render(); await act(async () => button('更新進度／更正').click());
    expect(field('下一步').value).toBe('完成第二節');
    currentGoal = { ...initialGoal, revision: 3, next_step: '較新的更正' };
    await event('noirxu-goals-changed');
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(host.textContent).toContain('已完成'); expect(field('下一步').value).toBe('完成第二節');
    await act(async () => button('儲存更正').click());
    expect(updates).toEqual([expect.objectContaining({ id: initialGoal.id, revision: 2, next_step: '完成第二節' })]);
    expect(host.textContent).toContain('目標已更新，請重新讀取。'); expect(button('取消').disabled).toBe(false);
    await act(async () => button('取消').click());
    expect(host.querySelector('form')).toBeNull(); expect(host.textContent).toContain('較新的更正');
  });
});

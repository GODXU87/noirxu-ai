import { createElement } from 'react';
// @ts-expect-error react-dom has no type declarations installed in this project
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GoalCard, GoalsPanel } from '@/app/components/Goals';
import { ToolData } from '@/app/components/shared';
import type { GoalView } from '@/goals/model';
import { goalEditReducer, goalEditRequest } from '@/goals/editor';
const goal: GoalView = {
  id: '00000000-0000-4000-8000-000000000001', title: '教學演示', status: 'active', status_label: '進行中',
  progress: 30, next_step: '完成第二節', deadline: '2026-11-01T02:00:00Z', check_at: '2026-11-01T02:00:00Z', blocker: null,
  revision: 2, created_at: '2026-10-30T02:00:00Z', updated_at: '2026-10-30T03:00:00Z', completion: null,
  latest_evidence: '已寫好第一節', history_total: 2, history_kept: 2, notifications: []
};
describe('goal visibility', () => {
  it('opens finished items when following a goal-result deep link', () => {
    const html = renderToStaticMarkup(createElement(GoalsPanel, { initialGoalId: goal.id }));
    expect(html).toContain('只看進行中'); expect(html).not.toContain('含已結束');
  });

  it('keeps the editor snapshot revision after a newer server refresh, so stale edits conflict instead of overwriting', () => {
    const opened = goalEditReducer({ current: goal, editing: null }, { type: 'begin', mode: 'update' });
    const refreshed = goalEditReducer(opened, { type: 'refresh', goal: { ...goal, revision: 3, next_step: '較新的更正' } });
    expect(refreshed.current.revision).toBe(3);
    expect(goalEditRequest(refreshed, { next_step: '過期表單' })).toMatchObject({ id: goal.id, revision: 2, next_step: '過期表單' });
    const dismissed = goalEditReducer(refreshed, { type: 'close' });
    expect(dismissed.current.next_step).toBe('較新的更正'); expect(dismissed.editing).toBeNull();
  });

  it('renders next step, deadline, explicit provenance and progress rather than a generic JSON fallback', () => {
    const html = renderToStaticMarkup(createElement(GoalCard, { goal }));
    for (const part of ['教學演示', '完成第二節', '已寫好第一節', '30%', '使用者回報', '11/1', '更新進度', '歷程']) expect(html).toContain(part);
    const chat = renderToStaticMarkup(createElement(ToolData, { tool: 'goals.create', data: { goal } }));
    expect(chat).toContain('完成第二節'); expect(chat).not.toContain('<pre');
  });
  it('shows terminal result and receipt wording, with no edit/complete controls after done', () => {
    const html = renderToStaticMarkup(createElement(GoalCard, { goal: { ...goal, status: 'completed', status_label: '已完成（使用者回報）', progress: 100, next_step: null, check_at: null, completion: { result: '已交付教案', evidence: '提交 PDF', source: 'user_report', at: '2026-10-30T03:00:00Z' }, notifications: [{ key: 'result', kind: 'completion', status: 'provider_accepted', label: '推播服務已接受，尚無裝置顯示回報', created_at: '2026-10-30T03:00:00Z', displayed_at: undefined, opened_at: undefined, last_error: undefined }] } }));
    for (const part of ['已交付教案', '提交 PDF', '追蹤已停止', '尚無裝置顯示回報']) expect(html).toContain(part);
    expect(html).not.toContain('更新進度'); expect(html).not.toContain('回報完成');
  });
  it('escapes user text in progress evidence and result', () => {
    const html = renderToStaticMarkup(createElement(GoalCard, { goal: { ...goal, latest_evidence: '<script>alert(1)</script>' } }));
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
  });
});

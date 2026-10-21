import { describe, expect, it } from 'vitest';
import { parseAgendaText } from '@/agenda/parse';
import { priorityOf, rankItems, reminderSchedule } from '@/agenda/rank';

// 2026-10-21 is a Wednesday.
const TODAY = '2026-10-21';

describe('parseAgendaText', () => {
  it('reads month/day notes', () => {
    expect(parseAgendaText('11/11 要教學演示', TODAY)).toEqual({ title: '教學演示', due_date: '2026-11-11', due_time: null, importance: 2 });
    expect(parseAgendaText('11月11日 教學演示', TODAY).due_date).toBe('2026-11-11');
  });

  it('rolls a past month/day into next year', () => {
    expect(parseAgendaText('3/5 繳稅', TODAY).due_date).toBe('2027-03-05');
  });

  it('reads relative days, times and importance', () => {
    expect(parseAgendaText('明天下午3點 看牙醫 很重要', TODAY)).toEqual({ title: '看牙醫', due_date: '2026-10-22', due_time: '15:00', importance: 3 });
    expect(parseAgendaText('後天 15:30 開會', TODAY)).toMatchObject({ due_date: '2026-10-23', due_time: '15:30', title: '開會' });
    expect(parseAgendaText('晚上七點半 打電話給媽媽', TODAY)).toMatchObject({ due_time: '19:30', title: '打電話給媽媽' });
  });

  it('reads weekdays', () => {
    expect(parseAgendaText('週五 交報告', TODAY).due_date).toBe('2026-10-23');
    expect(parseAgendaText('下週三 健檢', TODAY).due_date).toBe('2026-10-28');
    expect(parseAgendaText('下週一 開會', TODAY).due_date).toBe('2026-10-26');
    expect(parseAgendaText('週一 開會', TODAY).due_date).toBe('2026-10-26');
  });

  it('keeps undated notes and low-priority words', () => {
    expect(parseAgendaText('有空再整理書桌', TODAY)).toEqual({ title: '整理書桌', due_date: null, due_time: null, importance: 1 });
  });

  it('rejects impossible dates instead of guessing', () => {
    expect(parseAgendaText('2/30 不存在', TODAY).due_date).toBeNull();
  });
});

describe('ranking', () => {
  const base = { created_at: '2026-10-01T00:00:00Z', due_time: null };
  it('puts important and near items first, overdue on top', () => {
    const items = [
      { ...base, id: 'far-important', importance: 3 as const, due_date: '2026-11-11' },
      { ...base, id: 'tomorrow-normal', importance: 2 as const, due_date: '2026-10-22' },
      { ...base, id: 'overdue-low', importance: 1 as const, due_date: '2026-10-19' },
      { ...base, id: 'undated-normal', importance: 2 as const, due_date: null }
    ];
    expect(rankItems(items, TODAY).map(i => i.id)).toEqual(['overdue-low', 'tomorrow-normal', 'far-important', 'undated-normal']);
    expect(priorityOf({ importance: 3, due_date: '2026-10-21' }, TODAY)).toBe('urgent');
    expect(priorityOf({ importance: 1, due_date: null }, TODAY)).toBe('low');
  });
});

describe('reminderSchedule', () => {
  const now = new Date('2026-10-21T04:00:00Z');
  it('reminds the evening before and the morning of (Taipei time)', () => {
    const r = reminderSchedule({ due_date: '2026-11-11', due_time: null, importance: 2 }, now);
    expect(r.map(x => x.at.toISOString())).toEqual(['2026-11-10T12:00:00.000Z', '2026-11-11T00:30:00.000Z']);
  });
  it('adds 3-days-before for important items and 1-hour-before for timed items', () => {
    const r = reminderSchedule({ due_date: '2026-11-11', due_time: '14:00', importance: 3 }, now);
    expect(r.map(x => x.label)).toEqual(['3 天後', '明天', '今天', '1 小時後']);
    expect(r.at(-1)!.at.toISOString()).toBe('2026-11-11T05:00:00.000Z');
  });
  it('drops reminders already in the past', () => {
    expect(reminderSchedule({ due_date: '2026-10-21', due_time: null, importance: 2 }, now)).toEqual([]);
  });
});

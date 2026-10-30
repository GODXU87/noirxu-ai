import { describe, expect, it } from 'vitest';
import { taipeiLocalToIso, submitGoalForm } from '@/goals/form';

describe('goal form date conversion', () => {
  it.each([
    ['2026-11-01T18:00', '2026-11-01T10:00:00.000Z'],
    ['2026-11-01T18:00:00', '2026-11-01T10:00:00.000Z'],
    ['2026-11-01T18:00:31', '2026-11-01T10:00:31.000Z'],
    ['2026-11-01T18:00:31.125', '2026-11-01T10:00:31.125Z'],
    ['2026-11-01T00:00', '2026-10-31T16:00:00.000Z'],
    ['2028-02-29T18:00', '2028-02-29T10:00:00.000Z']
  ])('accepts browser datetime-local serialization %s independently of host timezone', (value, expected) => {
    expect(taipeiLocalToIso(value)).toBe(expected);
  });
  it.each(['', 'not-a-date', '2026-02-30T18:00', '2026-02-29T18:00', '2026-13-01T18:00', '2026-11-01T24:00', '2026-11-01T18:60', '2026-11-01T18:00:61', '2026-11-01T18:00Z', '2026-11-01T18:00+08:00'])('rejects invalid local date %s with a user-actionable error, never a RangeError', value => {
    let error: unknown; try { taipeiLocalToIso(value); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(RangeError);
    expect((error as Error).message).toContain('日期');
  });
});

describe('goal submission recovery', () => {
  it('always unlocks create/edit after date conversion fails, reports an error, and allows retry', async () => {
    const lock = { current: false }; const busy: boolean[] = []; const errors: string[] = []; const sent: string[] = [];
    await submitGoalForm(lock, v => busy.push(v), e => errors.push(e), async () => { sent.push(taipeiLocalToIso('bad-date')); });
    expect(lock.current).toBe(false); expect(busy).toEqual([true, false]); expect(sent).toEqual([]);
    expect(errors.at(-1)).toContain('日期');
    await submitGoalForm(lock, v => busy.push(v), e => errors.push(e), async () => { sent.push(taipeiLocalToIso('2026-11-01T18:00:00')); });
    expect(lock.current).toBe(false); expect(sent).toEqual(['2026-11-01T10:00:00.000Z']);
  });
  it('always unlocks after an unexpected transport exception while suppressing concurrent repeated submits', async () => {
    const lock = { current: false }; const busy: boolean[] = []; const errors: string[] = [];
    let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let calls = 0;
    const first = submitGoalForm(lock, v => busy.push(v), e => errors.push(e), async () => { calls++; await gate; throw new Error('網路中斷'); });
    await submitGoalForm(lock, v => busy.push(v), e => errors.push(e), async () => { calls++; });
    expect(calls).toBe(1); expect(lock.current).toBe(true);
    release(); await first;
    expect(lock.current).toBe(false); expect(busy).toEqual([true, false]); expect(errors.at(-1)).toBe('網路中斷');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { reminderMessage } from '@/agenda/briefing';
import { reminderSchedule, type AgendaItem } from '@/agenda/rank';
import { MemoryAgendaStore } from '@/agenda/store';
import { parseReminderTime } from '@/agenda/when';
import { Executor } from '@/hub/executor';
import { ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { DeliveryService } from '@/notify/delivery';
import type { SendReport } from '@/push/service';
import { agendaTools } from '@/tools/agenda/tools';
import { chatHub, ctxAt, fakeOpenAI, vault } from './helpers/chat-hub';

vi.mock('server-only', () => ({}));
const { runTick } = await import('@/server/tick');
const { handleChat } = await import('@/server/chat-turn');

const taipei = (local: string) => new Date(`${local}+08:00`);
const accepted: SendReport = { sent: 1, failed: 0, noSubscription: false, devices: [{ device: 'd1', platform: 'iPhone', outcome: 'accepted', retryable: false }] };
const none: SendReport = { sent: 0, failed: 0, noSubscription: true, devices: [] };

function setup(results: SendReport[] = [accepted]) {
  const agenda = new MemoryAgendaStore();
  const registry = new ToolRegistry();
  agendaTools(agenda).forEach(t => registry.register(t));
  const executor = new Executor({ registry, store: new MemoryHubStore(), isConnected: async () => true });
  const sent: any[] = [];
  const push = { send: vi.fn(async (_u: string, m: any, _n?: Date) => { sent.push(m); return results.length > 1 ? results.shift()! : results[0]; }) };
  const hub: any = { agenda, push, vault, executor, isConnected: async () => false, features: {} };
  hub.delivery = new DeliveryService(agenda, vault, (u: string, m: any, n: Date) => push.send(u, m, n));
  const create = async (text: string | Record<string, unknown>, now: Date) => executor.invoke('agenda.items.create', typeof text === 'string' ? { text } : text, { userId: 'owner', now: () => now }) as Promise<any>;
  return { agenda, hub, sent, push, executor, create };
}

describe('A–C: relative and absolute reminder times (no model)', () => {
  it('A: 20:02:00「兩分鐘後提醒我看電腦」→ a real reminder at 20:04:00', async () => {
    const { create, agenda } = setup();
    const r = await create('兩分鐘後提醒我看電腦', taipei('2026-10-23T20:02:00'));
    expect(r.status).toBe('ok');
    expect(r.data).toMatchObject({ kind: 'reminder', scheduled: true, item: { title: '看電腦', due_date: '2026-10-23', due_time: '20:04' } });
    expect(r.data.reminders).toHaveLength(1);
    expect(r.data.reminders[0]).toMatchObject({ at: '2026-10-23T12:04:00.000Z', local: '10/23 20:04', status: 'scheduled' });
    expect(agenda.reminders.has(r.data.reminders[0].id)).toBe(true);
  });

  it('B: crosses midnight, month end and year end', async () => {
    const { create } = setup();
    const b = await create('兩分鐘後提醒我', taipei('2026-10-23T23:59:00'));
    expect(b.data.reminders[0].at).toBe('2026-10-23T16:01:00.000Z');
    expect(b.data.item.due_date).toBe('2026-10-24');
    expect(parseReminderTime('5分鐘後提醒我', taipei('2026-10-31T23:58:00'))!.at.toISOString()).toBe('2026-10-31T16:03:00.000Z');
    expect(parseReminderTime('三分鐘後提醒我', taipei('2026-12-31T23:59:00'))!.at.toISOString()).toBe('2026-12-31T16:02:00.000Z');
  });

  it('C: half an hour, hours and minutes, tomorrow, tonight, and a bare clock time', () => {
    const now = taipei('2026-10-23T20:02:00');
    const at = (t: string, n = now) => parseReminderTime(t, n)!.at.toISOString();
    expect(at('半小時後提醒我')).toBe(taipei('2026-10-23T20:32:00').toISOString());
    expect(at('1小時20分鐘後提醒我喝水')).toBe(taipei('2026-10-23T21:22:00').toISOString());
    expect(at('一個半小時後提醒我')).toBe(taipei('2026-10-23T21:32:00').toISOString());
    expect(at('十五分鐘後叫我')).toBe(taipei('2026-10-23T20:17:00').toISOString());
    expect(at('明天9點提醒我開會')).toBe(taipei('2026-10-24T09:00:00').toISOString());
    expect(at('今晚8點提醒我', taipei('2026-10-23T15:00:00'))).toBe(taipei('2026-10-23T20:00:00').toISOString());
    expect(at('9點提醒我關電腦')).toBe(taipei('2026-10-23T21:00:00').toISOString());
    expect(parseReminderTime('提醒我看電腦', now)).toBeNull();
  });
});

describe('D: notes are not dressed up as reminders', () => {
  it('records an undated note without claiming a reminder, and refuses a reminder with no time', async () => {
    const { create, agenda } = setup();
    const note = await create('記一下要買牛奶', taipei('2026-10-23T20:02:00'));
    expect(note.data).toMatchObject({ kind: 'note', scheduled: false, reminders: [] });
    const vague = await create('提醒我買牛奶', taipei('2026-10-23T20:02:00'));
    expect(vague).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
    expect(vague.message).toContain('沒有建立任何提醒');
    const repeating = await create('每天早上8點提醒我喝水', taipei('2026-10-23T20:02:00'));
    expect(repeating.status).toBe('error');
    expect(agenda.items.size).toBe(1);
  });
});

describe('E–F: no burst of advance notices; explicit times kept', () => {
  const slots = ['09:00', '11:00', '13:00', '15:00', '17:00'];

  it('E: important items no longer get a blanket "3 days before"', () => {
    const now = taipei('2026-10-23T19:43:00');
    for (const t of slots) {
      const times = reminderSchedule({ due_date: '2026-10-26', due_time: t, importance: 3 }, now).map(r => r.at.toISOString());
      expect(times).not.toContain(taipei('2026-10-23T20:00:00').toISOString());
    }
  });

  it('E: five slots of the same task due together → one combined notification, five records kept', async () => {
    const { create, hub, sent, agenda } = setup();
    for (const t of slots) await create({ title: '準備兒童朝會報告', due_date: '2026-10-26', due_time: t, importance: 3, notes: '原始訊息很長的備註' }, taipei('2026-10-23T19:43:00'));
    await runTick(hub, taipei('2026-10-23T20:02:59'));
    expect(sent).toHaveLength(0);
    await runTick(hub, taipei('2026-10-25T20:01:00'));
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('SASUKE · 準備兒童朝會報告');
    expect(sent[0].body).toContain('5 個時段');
    expect(sent[0].body).not.toContain('備註');
    expect((await hub.delivery.inbox('owner')).length).toBe(5);
    expect([...agenda.reminders.values()].filter(r => r.sent_at).length).toBe(5);
  });

  it('E: production-shaped data (10 reminders due at 20:00) → one notification, not ten', async () => {
    const { create, hub, sent } = setup();
    for (const d of ['2026-10-24', '2026-10-26']) for (const t of slots) await create({ title: '準備兒童朝會報告', due_date: d, due_time: t, importance: 3 }, taipei('2026-10-23T19:43:00'));
    // Reproduce the old schedule: day-before for 10/24 and "3 days before" for 10/26, all at 20:00.
    for (const r of hub.agenda.reminders.values()) r.remind_at = taipei('2026-10-23T20:00:00').toISOString();
    await runTick(hub, taipei('2026-10-23T20:02:59'));
    expect(sent).toHaveLength(1);
  });

  it('F: explicit reminders at each slot fire at each slot', async () => {
    const { create, hub, sent } = setup();
    for (const t of slots) await create(`10/26 ${Number(t.slice(0, 2))}點提醒我準備報告`, taipei('2026-10-23T19:43:00'));
    for (const t of slots) await runTick(hub, taipei(`2026-10-26T${t}:30`));
    // The 09:00 run also sends the daily morning summary; count the reminders.
    const reminders = sent.filter(m => m.title.startsWith('SASUKE'));
    expect(reminders).toHaveLength(5);
    expect(reminders.every(m => m.body.startsWith('提醒時間'))).toBe(true);
  });

  it('caps one run at three notifications (a summary instead)', async () => {
    const { create, hub, sent } = setup();
    for (const title of ['甲', '乙', '丙', '丁', '戊']) await create(`2分鐘後提醒我${title}`, taipei('2026-10-23T20:00:00'));
    await runTick(hub, taipei('2026-10-23T20:02:30'));
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain('5 則提醒');
  });
});

describe('G–I: concurrency, failures, cancel and late runs', () => {
  it('G: two scheduler runs at once send each notification once', async () => {
    const { create, hub, push } = setup();
    await create('兩分鐘後提醒我看電腦', taipei('2026-10-23T20:02:00'));
    for (const t of ['09:00', '11:00']) await create({ title: '報告', due_date: '2026-10-24', due_time: t }, taipei('2026-10-23T19:00:00'));
    const at = taipei('2026-10-23T20:04:10');
    await Promise.all([runTick(hub, at), runTick(hub, at)]);
    expect(push.send).toHaveBeenCalledTimes(2); // the reminder, and one combined "報告" notice
  });

  it('H: no device → kept and retried with a limit, never lost from the inbox', async () => {
    const { create, hub, agenda } = setup([none]);
    const r = await create('兩分鐘後提醒我看電腦', taipei('2026-10-23T20:02:00'));
    await runTick(hub, taipei('2026-10-23T20:04:05'));
    const id = r.data.reminders[0].id;
    expect((await hub.delivery.get(`reminder:${id}`))).toMatchObject({ status: 'retry_pending', last_error: '沒有任何已訂閱通知的裝置' });
    expect(agenda.reminders.get(id)?.sent_at).toBeNull();
    expect((await hub.delivery.inbox('owner')).map((e: any) => e.key)).toContain(`reminder:${id}`);
    // After the retry window the reminder is closed out instead of retrying forever.
    await runTick(hub, taipei('2026-10-24T09:00:00'));
    expect(agenda.reminders.get(id)?.sent_at).not.toBeNull();
  });

  it('H: a run two hours late sends one "missed" summary; over 12 hours late goes to the inbox only', async () => {
    const late = setup();
    for (const t of ['甲', '乙', '丙']) await late.create(`2分鐘後提醒我${t}`, taipei('2026-10-23T18:00:00'));
    await runTick(late.hub, taipei('2026-10-23T20:05:00'));
    expect(late.sent).toHaveLength(1);
    expect(late.sent[0].title).toContain('錯過的提醒');

    const stale = setup();
    await stale.create('2分鐘後提醒我甲', taipei('2026-10-23T06:00:00'));
    await runTick(stale.hub, taipei('2026-10-23T20:05:00'));
    expect(stale.sent).toHaveLength(0);
    expect((await stale.hub.delivery.inbox('owner')).length).toBe(1);
  });

  it('I: a cancelled or moved reminder does not fire at the old time', async () => {
    const { create, hub, sent, executor } = setup();
    const ctx = (now: Date) => ({ userId: 'owner', now: () => now });
    const a = await create('10分鐘後提醒我甲', taipei('2026-10-23T20:00:00'));
    await executor.invoke('agenda.items.update', { id: a.data.item.id, status: 'cancelled' }, ctx(taipei('2026-10-23T20:01:00')));
    const b = await create('10分鐘後提醒我乙', taipei('2026-10-23T20:00:00'));
    await executor.invoke('agenda.items.update', { id: b.data.item.id, due_time: '21:00' }, ctx(taipei('2026-10-23T20:01:00')));
    await runTick(hub, taipei('2026-10-23T20:10:30'));
    expect(sent).toHaveLength(0);
    await runTick(hub, taipei('2026-10-23T21:00:30'));
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('SASUKE · 乙');
  });
});

describe('J: zero model calls for a plain relative reminder', () => {
  it('creates it through the local router; the reply carries the real time', async () => {
    const env = { ...process.env };
    process.env.OPENAI_API_KEY = 'sk-test';
    const { hub } = chatHub();
    const { client, requests } = fakeOpenAI();
    const r = await handleChat(hub, ctxAt(taipei('2026-10-23T20:02:00').toISOString()), { text: '兩分鐘後提醒我看電腦', style: 'professional', history: [], clients: { openai: () => client } });
    process.env = env;
    expect(requests).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, provider: 'local', route: { intent: 'reminder_create' } });
    expect(r.ok && r.reply).toContain('2 分鐘後（20:04）提醒你看電腦');
    expect(r.ok && r.events[0].result.status).toBe('ok');
  });
});

describe('lock-screen text', () => {
  it('shows SASUKE, the title and the time; no notes', () => {
    const item: AgendaItem = { id: 'i', user_id: 'owner', title: '準備兒童朝會報告', notes: '請在 09:00、11:00、13:00 各提醒一次，原始訊息…', due_date: '2026-10-26', due_time: '09:00', importance: 3, status: 'open', source: 'structured', created_at: '', updated_at: '' };
    const m = reminderMessage(item, '明天', '2026-10-25');
    expect(m.title).toBe('SASUKE · 準備兒童朝會報告');
    expect(m.body).toBe('明天 09:00 · 重要');
  });
});

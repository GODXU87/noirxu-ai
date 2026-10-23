import { TokenVault } from '@/connections/vault';
import { DeliveryService } from '@/notify/delivery';
import { describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { Executor } from '@/hub/executor';
import { defineTool, ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { agendaTools } from '@/tools/agenda/tools';
import { z } from 'zod';

vi.mock('server-only', () => ({}));
const testVault = new TokenVault('test-passphrase-0123456789abcdef0123456789');
const ACCEPTED = { sent: 1, failed: 0, noSubscription: false, devices: [{ device: 'd1', platform: 'iPhone', outcome: 'accepted', retryable: false }] };
const { runTick } = await import('@/server/tick');

// 2026-10-21 12:00 Taipei
const NOW = new Date('2026-10-21T04:00:00Z');

function setup(now = NOW) {
  const agenda = new MemoryAgendaStore();
  const registry = new ToolRegistry();
  agendaTools(agenda).forEach(tool => registry.register(tool));
  const executor = new Executor({ registry, store: new MemoryHubStore(), isConnected: async () => false });
  return { agenda, executor, registry, ctx: { userId: 'owner', now: () => now } };
}

describe('agenda tools', () => {
  it('records 「11/11 要教學演示」 immediately (own notes, no confirmation) with reminders', async () => {
    const { executor, ctx, agenda } = setup();
    const result = await executor.invoke('agenda.items.create', { text: '11/11 要教學演示 很重要' }, ctx);
    expect(result.status).toBe('ok');
    const data = (result as any).data;
    expect(data.item).toMatchObject({ title: '教學演示', due_date: '2026-11-11', importance: 3 });
    expect(data.reminders.map((r: any) => r.label)).toEqual(['明天', '今天']);
    expect(agenda.reminders.size).toBe(2);
  });

  it('lists open items ranked by importance and nearness', async () => {
    const { executor, ctx } = setup();
    await executor.invoke('agenda.items.create', { text: '11/11 教學演示 很重要' }, ctx);
    await executor.invoke('agenda.items.create', { text: '明天 繳電話費' }, ctx);
    await executor.invoke('agenda.items.create', { text: '有空再整理書桌' }, ctx);
    const result = await executor.invoke('agenda.items.list', {}, ctx);
    const items = (result as any).data.items;
    expect(items.map((i: any) => i.title)).toEqual(['繳電話費', '教學演示', '整理書桌']);
    expect(items[0].due_label).toBe('明天');
  });

  it('completing an item stops its reminders', async () => {
    const { executor, ctx, agenda } = setup();
    const created = await executor.invoke('agenda.items.create', { text: '明天 繳電話費' }, ctx);
    const id = (created as any).data.item.id;
    await executor.invoke('agenda.items.update', { id, status: 'done' }, ctx);
    expect(await agenda.dueReminders(new Date('2026-10-23T00:00:00Z'))).toEqual([]);
  });

  it('refuses dates in the past', async () => {
    const { executor, ctx } = setup();
    expect(await executor.invoke('agenda.items.create', { title: 'x', due_date: '2026-10-01' }, ctx)).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
  });

  it('the registry refuses skipping confirmation for source-system or send tools', () => {
    const registry = new ToolRegistry();
    const base = { description: '', input: z.object({}), output: z.object({}), run: async () => ({ data: {} }) };
    expect(() => registry.register(defineTool({ ...base, name: 'x.write', connection: 'ledger', kind: 'write', requiresConfirmation: false }))).toThrow();
    expect(() => registry.register(defineTool({ ...base, name: 'x.send', connection: 'internal', kind: 'send', requiresConfirmation: false }))).toThrow();
  });
});

describe('runTick', () => {
  function hubWith(agenda: MemoryAgendaStore) {
    const sent: any[] = [];
    const hub: any = {
      agenda,
      push: { send: vi.fn(async (_user: string, message: any) => { sent.push(message); return ACCEPTED; }) },
      isConnected: async () => false,
      executor: { invoke: vi.fn() }
    };
    hub.vault = testVault;
    hub.delivery = new DeliveryService(agenda, testVault, (u: string, m: any, n: Date) => hub.push.send(u, m, n));
    return { hub, sent };
  }

  it('sends each due reminder once, even if ticks overlap', async () => {
    const { agenda, executor, ctx } = setup();
    await executor.invoke('agenda.items.create', { text: '明天 繳電話費' }, ctx);
    const { hub, sent } = hubWith(agenda);
    const evening = new Date('2026-10-21T12:05:00Z'); // 20:05 Taipei
    await runTick(hub, evening);
    await runTick(hub, evening);
    expect(sent.filter(m => m.title.includes('繳電話費'))).toHaveLength(1);
    expect(sent[0].title).toBe('SASUKE · 繳電話費');
  });

  it('sends the morning summary once per day between 08:00 and 11:00 Taipei', async () => {
    const { agenda, executor, ctx } = setup();
    await executor.invoke('agenda.items.create', { text: '明天 繳電話費' }, ctx);
    const { hub, sent } = hubWith(agenda);
    await runTick(hub, new Date('2026-10-22T00:10:00Z')); // 08:10 Taipei
    await runTick(hub, new Date('2026-10-22T00:20:00Z'));
    const briefings = sent.filter(m => m.title.startsWith('今日摘要'));
    expect(briefings).toHaveLength(1);
    expect(briefings[0].body).toContain('繳電話費');
    await runTick(hub, new Date('2026-10-22T05:00:00Z')); // 13:00 Taipei: no new briefing
    expect(sent.filter(m => m.title.startsWith('今日摘要'))).toHaveLength(1);
  });
});

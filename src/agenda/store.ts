import type { Pool } from 'pg';
import type { AgendaItem } from './rank';

export interface Reminder { id: string; item_id: string; user_id: string; remind_at: string; label: string; sent_at: string | null }
export interface DueReminder extends Reminder { item: AgendaItem }
export interface PushSubscriptionRow { endpoint: string; user_id: string; subscription: unknown }

export interface AgendaStore {
  createItem(item: AgendaItem, reminders: Array<{ id: string; remind_at: string; label: string }>): Promise<void>;
  getItem(userId: string, id: string): Promise<AgendaItem | null>;
  listItems(userId: string, filter: { status?: AgendaItem['status'] | 'all'; from?: string; to?: string }): Promise<AgendaItem[]>;
  updateItem(userId: string, id: string, patch: Partial<Pick<AgendaItem, 'title' | 'notes' | 'due_date' | 'due_time' | 'importance' | 'status'>>): Promise<AgendaItem | null>;
  replaceReminders(userId: string, itemId: string, reminders: Array<{ id: string; remind_at: string; label: string }>): Promise<void>;
  /** Unsent reminders due by `now` for open items. */
  dueReminders(now: Date): Promise<DueReminder[]>;
  markReminderSent(id: string, at: Date): Promise<void>;
  /** Returns false if this key was already used (each notification goes out once). */
  claimNotification(key: string, userId: string, kind: string): Promise<boolean>;
  savePushSubscription(row: PushSubscriptionRow & { user_agent: string }): Promise<void>;
  listPushSubscriptions(userId?: string): Promise<PushSubscriptionRow[]>;
  deletePushSubscription(endpoint: string): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  /** Insert only if absent; returns the stored value (first writer wins). */
  putSettingIfAbsent(key: string, sealed: string): Promise<string>;
  /** Insert or replace. */
  putSetting(key: string, sealed: string): Promise<void>;
  /**
   * Writes `next` only if the stored value is still `expected` (null = row absent).
   * Returns false when someone else wrote in between, so the caller can re-read and retry.
   */
  compareAndSetSetting(key: string, expected: string | null, next: string): Promise<boolean>;
}

export class MemoryAgendaStore implements AgendaStore {
  items = new Map<string, AgendaItem>();
  reminders = new Map<string, Reminder>();
  log = new Set<string>();
  subs = new Map<string, PushSubscriptionRow>();
  settings = new Map<string, string>();

  async createItem(item: AgendaItem, reminders: Array<{ id: string; remind_at: string; label: string }>) {
    this.items.set(item.id, { ...item });
    for (const r of reminders) this.reminders.set(r.id, { ...r, item_id: item.id, user_id: item.user_id, sent_at: null });
  }
  async getItem(userId: string, id: string) {
    const item = this.items.get(id);
    return item && item.user_id === userId ? { ...item } : null;
  }
  async listItems(userId: string, filter: { status?: AgendaItem['status'] | 'all'; from?: string; to?: string }) {
    return [...this.items.values()].filter(item => item.user_id === userId
      && (!filter.status || filter.status === 'all' || item.status === filter.status)
      && (!filter.from || (item.due_date !== null && item.due_date >= filter.from))
      && (!filter.to || (item.due_date !== null && item.due_date <= filter.to))).map(item => ({ ...item }));
  }
  async updateItem(userId: string, id: string, patch: Partial<AgendaItem>) {
    const item = this.items.get(id);
    if (!item || item.user_id !== userId) return null;
    const next = { ...item, ...patch, updated_at: new Date().toISOString() };
    this.items.set(id, next);
    return { ...next };
  }
  async replaceReminders(userId: string, itemId: string, reminders: Array<{ id: string; remind_at: string; label: string }>) {
    for (const [id, r] of this.reminders) if (r.item_id === itemId && !r.sent_at) this.reminders.delete(id);
    for (const r of reminders) this.reminders.set(r.id, { ...r, item_id: itemId, user_id: userId, sent_at: null });
  }
  async dueReminders(now: Date) {
    return [...this.reminders.values()]
      .filter(r => !r.sent_at && Date.parse(r.remind_at) <= now.getTime() && this.items.get(r.item_id)?.status === 'open')
      .map(r => ({ ...r, item: { ...this.items.get(r.item_id)! } }));
  }
  async markReminderSent(id: string, at: Date) {
    const r = this.reminders.get(id);
    if (r) r.sent_at = at.toISOString();
  }
  async claimNotification(key: string) {
    if (this.log.has(key)) return false;
    this.log.add(key);
    return true;
  }
  async savePushSubscription(row: PushSubscriptionRow) { this.subs.set(row.endpoint, row); }
  async listPushSubscriptions(userId?: string) { return [...this.subs.values()].filter(s => !userId || s.user_id === userId); }
  async deletePushSubscription(endpoint: string) { this.subs.delete(endpoint); }
  async getSetting(key: string) { return this.settings.get(key) ?? null; }
  async putSetting(key: string, sealed: string) { this.settings.set(key, sealed); }
  async compareAndSetSetting(key: string, expected: string | null, next: string) {
    if ((this.settings.get(key) ?? null) !== expected) return false;
    this.settings.set(key, next);
    return true;
  }
  async putSettingIfAbsent(key: string, sealed: string) {
    if (!this.settings.has(key)) this.settings.set(key, sealed);
    return this.settings.get(key)!;
  }
}

function toItem(row: Record<string, any>): AgendaItem {
  const date = row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : row.due_date ?? null;
  return {
    id: row.id, user_id: row.user_id, title: row.title, notes: row.notes, due_date: date,
    due_time: row.due_time ? String(row.due_time).slice(0, 5) : null, importance: Number(row.importance) as 1 | 2 | 3,
    status: row.status, source: row.source, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString()
  };
}

const ITEM_COLUMNS = `id, user_id, title, notes, to_char(due_date, 'YYYY-MM-DD') as due_date, due_time, importance, status, source, created_at, updated_at`;

/** Lives in the noirxu_ai schema; reached as the limited noirxu_ai_app role. */
export class PgAgendaStore implements AgendaStore {
  constructor(private readonly pool: Pool) {}

  async createItem(item: AgendaItem, reminders: Array<{ id: string; remind_at: string; label: string }>) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into noirxu_ai.agenda_items (id, user_id, title, notes, due_date, due_time, importance, status, source, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [item.id, item.user_id, item.title, item.notes, item.due_date, item.due_time, item.importance, item.status, item.source, item.created_at, item.updated_at]
      );
      for (const r of reminders) {
        await client.query('insert into noirxu_ai.reminders (id, item_id, user_id, remind_at, label) values ($1, $2, $3, $4, $5)', [r.id, item.id, item.user_id, r.remind_at, r.label]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async getItem(userId: string, id: string) {
    const { rows } = await this.pool.query(`select ${ITEM_COLUMNS} from noirxu_ai.agenda_items where user_id = $1 and id = $2`, [userId, id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async listItems(userId: string, filter: { status?: AgendaItem['status'] | 'all'; from?: string; to?: string }) {
    const where = ['user_id = $1'];
    const values: unknown[] = [userId];
    if (filter.status && filter.status !== 'all') { values.push(filter.status); where.push(`status = $${values.length}`); }
    if (filter.from) { values.push(filter.from); where.push(`due_date >= $${values.length}`); }
    if (filter.to) { values.push(filter.to); where.push(`due_date <= $${values.length}`); }
    const { rows } = await this.pool.query(`select ${ITEM_COLUMNS} from noirxu_ai.agenda_items where ${where.join(' and ')} order by due_date nulls last, created_at limit 500`, values);
    return rows.map(toItem);
  }

  async updateItem(userId: string, id: string, patch: Partial<AgendaItem>) {
    const allowed = ['title', 'notes', 'due_date', 'due_time', 'importance', 'status'] as const;
    const sets: string[] = [];
    const values: unknown[] = [userId, id];
    for (const key of allowed) {
      if (key in patch) { values.push((patch as Record<string, unknown>)[key]); sets.push(`${key} = $${values.length}`); }
    }
    if (!sets.length) return this.getItem(userId, id);
    const { rows } = await this.pool.query(
      `update noirxu_ai.agenda_items set ${sets.join(', ')}, updated_at = now() where user_id = $1 and id = $2 returning ${ITEM_COLUMNS}`, values);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async replaceReminders(userId: string, itemId: string, reminders: Array<{ id: string; remind_at: string; label: string }>) {
    await this.pool.query('delete from noirxu_ai.reminders where item_id = $1 and user_id = $2 and sent_at is null', [itemId, userId]);
    for (const r of reminders) {
      await this.pool.query('insert into noirxu_ai.reminders (id, item_id, user_id, remind_at, label) values ($1, $2, $3, $4, $5)', [r.id, itemId, userId, r.remind_at, r.label]);
    }
  }

  async dueReminders(now: Date) {
    const { rows } = await this.pool.query(
      `select r.id as r_id, r.item_id, r.user_id as r_user_id, r.remind_at, r.label, r.sent_at,
              i.id, i.user_id, i.title, i.notes, to_char(i.due_date, 'YYYY-MM-DD') as due_date, i.due_time, i.importance, i.status, i.source, i.created_at, i.updated_at
         from noirxu_ai.reminders r join noirxu_ai.agenda_items i on i.id = r.item_id
        where r.sent_at is null and r.remind_at <= $1 and i.status = 'open'
        order by r.remind_at limit 50`, [now.toISOString()]);
    return rows.map(row => ({
      id: row.r_id, item_id: row.item_id, user_id: row.r_user_id, remind_at: new Date(row.remind_at).toISOString(), label: row.label, sent_at: null, item: toItem(row)
    }));
  }

  async markReminderSent(id: string, at: Date) {
    await this.pool.query('update noirxu_ai.reminders set sent_at = $2 where id = $1', [id, at.toISOString()]);
  }

  async claimNotification(key: string, userId: string, kind: string) {
    const { rowCount } = await this.pool.query(
      'insert into noirxu_ai.notification_log (dedupe_key, user_id, kind) values ($1, $2, $3) on conflict (dedupe_key) do nothing', [key, userId, kind]);
    return rowCount === 1;
  }

  async savePushSubscription(row: PushSubscriptionRow & { user_agent: string }) {
    await this.pool.query(
      `insert into noirxu_ai.push_subscriptions (endpoint, user_id, subscription, user_agent) values ($1, $2, $3, $4)
       on conflict (endpoint) do update set user_id = excluded.user_id, subscription = excluded.subscription, user_agent = excluded.user_agent`,
      [row.endpoint, row.user_id, row.subscription, row.user_agent.slice(0, 300)]);
  }

  async listPushSubscriptions(userId?: string) {
    const { rows } = userId
      ? await this.pool.query('select endpoint, user_id, subscription from noirxu_ai.push_subscriptions where user_id = $1', [userId])
      : await this.pool.query('select endpoint, user_id, subscription from noirxu_ai.push_subscriptions');
    return rows as PushSubscriptionRow[];
  }

  async deletePushSubscription(endpoint: string) {
    await this.pool.query('delete from noirxu_ai.push_subscriptions where endpoint = $1', [endpoint]);
  }

  async getSetting(key: string) {
    const { rows } = await this.pool.query('select sealed from noirxu_ai.settings where key = $1', [key]);
    return rows[0]?.sealed ?? null;
  }

  async putSettingIfAbsent(key: string, sealed: string) {
    await this.pool.query('insert into noirxu_ai.settings (key, sealed) values ($1, $2) on conflict (key) do nothing', [key, sealed]);
    return (await this.getSetting(key))!;
  }

  async putSetting(key: string, sealed: string) {
    await this.pool.query('insert into noirxu_ai.settings (key, sealed) values ($1, $2) on conflict (key) do update set sealed = excluded.sealed, updated_at = now()', [key, sealed]);
  }

  async compareAndSetSetting(key: string, expected: string | null, next: string) {
    const { rowCount } = expected === null
      ? await this.pool.query('insert into noirxu_ai.settings (key, sealed) values ($1, $2) on conflict (key) do nothing', [key, next])
      : await this.pool.query('update noirxu_ai.settings set sealed = $3, updated_at = now() where key = $1 and sealed = $2', [key, expected, next]);
    return rowCount === 1;
  }
}

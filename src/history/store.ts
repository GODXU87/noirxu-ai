import type { Pool } from 'pg';
import type { MemoryCategory } from './privacy';

export interface ConversationRow {
  id: string;
  title: string;
  source: 'server' | 'legacy_import' | 'local_import';
  import_key: string | null;
  version: number;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface SealedMessage { seq: number; kind: string; sealed: string; search_text: string }
export interface MemoryRow {
  id: string;
  category: MemoryCategory;
  content: string;
  source: 'user_command' | 'chat' | 'manual';
  source_ref: string | null;
  active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export type AppendResult = { ok: true; nextSeq: number } | { ok: false; nextSeq: number };

export interface HistoryStore {
  list(userId: string, opts: { query?: string; limit?: number }): Promise<ConversationRow[]>;
  /** Idempotent when importKey is given: returns the existing row instead of a duplicate. */
  create(userId: string, row: { id: string; title: string; source: ConversationRow['source']; importKey?: string | null }): Promise<{ row: ConversationRow; created: boolean }>;
  get(userId: string, id: string): Promise<{ row: ConversationRow; context: string | null; messages: SealedMessage[] } | null>;
  /** Appends only if the conversation currently has exactly `fromSeq` messages. */
  append(userId: string, id: string, fromSeq: number, messages: Array<{ id: string; kind: string; sealed: string; search_text: string }>): Promise<AppendResult>;
  /** Compare-and-set on version. */
  saveContext(userId: string, id: string, expectedVersion: number, sealed: string): Promise<{ ok: boolean; version: number }>;
  rename(userId: string, id: string, title: string): Promise<ConversationRow | null>;
  softDelete(userId: string, id: string, now: Date): Promise<boolean>;
  listMemories(userId: string, opts: { includeInactive?: boolean; query?: string }): Promise<MemoryRow[]>;
  createMemory(userId: string, row: Omit<MemoryRow, 'version' | 'created_at' | 'updated_at' | 'active'> & { active?: boolean }): Promise<MemoryRow>;
  updateMemory(userId: string, id: string, patch: Partial<Pick<MemoryRow, 'content' | 'category' | 'active'>>): Promise<MemoryRow | null>;
  softDeleteMemory(userId: string, id: string, now: Date): Promise<boolean>;
  /** Permanently removes rows whose 30-day grace period has passed. */
  purge(now: Date): Promise<{ conversations: number; memories: number }>;
}

const RETENTION_DAYS = 30;
const purgeAfter = (now: Date) => new Date(now.getTime() + RETENTION_DAYS * 86_400_000);

/* ------------------------------------------------------------------ memory twin */

interface MemConv extends ConversationRow { user_id: string; context: string | null; deleted_at: string | null; purge_after: string | null; messages: SealedMessage[] }
interface MemMemory extends MemoryRow { user_id: string; deleted_at: string | null; purge_after: string | null }

export class MemoryHistoryStore implements HistoryStore {
  conversations = new Map<string, MemConv>();
  memories = new Map<string, MemMemory>();

  private view(c: MemConv): ConversationRow {
    const { id, title, source, import_key, version, message_count, created_at, updated_at } = c;
    return { id, title, source, import_key, version, message_count, created_at, updated_at };
  }
  private own(userId: string, id: string) {
    const c = this.conversations.get(id);
    return c && c.user_id === userId && !c.deleted_at ? c : null;
  }

  async list(userId: string, opts: { query?: string; limit?: number }) {
    const q = opts.query?.trim().toLowerCase();
    return [...this.conversations.values()]
      .filter(c => c.user_id === userId && !c.deleted_at)
      .filter(c => !q || c.title.toLowerCase().includes(q) || c.messages.some(m => m.search_text.toLowerCase().includes(q)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, opts.limit ?? 50)
      .map(c => this.view(c));
  }
  async create(userId: string, row: { id: string; title: string; source: ConversationRow['source']; importKey?: string | null }) {
    if (row.importKey) {
      const existing = [...this.conversations.values()].find(c => c.user_id === userId && c.import_key === row.importKey);
      if (existing) return { row: this.view(existing), created: false };
    }
    const now = new Date().toISOString();
    const c: MemConv = { id: row.id, user_id: userId, title: row.title, source: row.source, import_key: row.importKey ?? null, version: 1, message_count: 0, created_at: now, updated_at: now, context: null, deleted_at: null, purge_after: null, messages: [] };
    this.conversations.set(c.id, c);
    return { row: this.view(c), created: true };
  }
  async get(userId: string, id: string) {
    const c = this.own(userId, id);
    return c ? { row: this.view(c), context: c.context, messages: [...c.messages] } : null;
  }
  async append(userId: string, id: string, fromSeq: number, messages: Array<{ id: string; kind: string; sealed: string; search_text: string }>) {
    const c = this.own(userId, id);
    if (!c) return { ok: false as const, nextSeq: -1 };
    if (c.message_count !== fromSeq) return { ok: false as const, nextSeq: c.message_count };
    messages.forEach((m, i) => c.messages.push({ seq: fromSeq + i, kind: m.kind, sealed: m.sealed, search_text: m.search_text }));
    c.message_count += messages.length;
    c.updated_at = new Date().toISOString();
    return { ok: true as const, nextSeq: c.message_count };
  }
  async saveContext(userId: string, id: string, expectedVersion: number, sealed: string) {
    const c = this.own(userId, id);
    if (!c) return { ok: false, version: -1 };
    if (c.version !== expectedVersion) return { ok: false, version: c.version };
    c.context = sealed; c.version += 1; c.updated_at = new Date().toISOString();
    return { ok: true, version: c.version };
  }
  async rename(userId: string, id: string, title: string) {
    const c = this.own(userId, id);
    if (!c) return null;
    c.title = title; c.version += 1; c.updated_at = new Date().toISOString();
    return this.view(c);
  }
  async softDelete(userId: string, id: string, now: Date) {
    const c = this.own(userId, id);
    if (!c) return false;
    c.deleted_at = now.toISOString(); c.purge_after = purgeAfter(now).toISOString();
    return true;
  }
  async listMemories(userId: string, opts: { includeInactive?: boolean; query?: string }) {
    const q = opts.query?.trim().toLowerCase();
    return [...this.memories.values()]
      .filter(m => m.user_id === userId && !m.deleted_at && (opts.includeInactive || m.active) && (!q || m.content.toLowerCase().includes(q)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(({ user_id: _u, deleted_at: _d, purge_after: _p, ...row }) => row);
  }
  async createMemory(userId: string, row: Omit<MemoryRow, 'version' | 'created_at' | 'updated_at' | 'active'> & { active?: boolean }) {
    const now = new Date().toISOString();
    const m: MemMemory = { ...row, active: row.active ?? true, version: 1, created_at: now, updated_at: now, user_id: userId, deleted_at: null, purge_after: null };
    this.memories.set(m.id, m);
    const { user_id: _u, deleted_at: _d, purge_after: _p, ...view } = m;
    return view;
  }
  async updateMemory(userId: string, id: string, patch: Partial<Pick<MemoryRow, 'content' | 'category' | 'active'>>) {
    const m = this.memories.get(id);
    if (!m || m.user_id !== userId || m.deleted_at) return null;
    Object.assign(m, patch, { version: m.version + 1, updated_at: new Date().toISOString() });
    const { user_id: _u, deleted_at: _d, purge_after: _p, ...view } = m;
    return view;
  }
  async softDeleteMemory(userId: string, id: string, now: Date) {
    const m = this.memories.get(id);
    if (!m || m.user_id !== userId || m.deleted_at) return false;
    m.deleted_at = now.toISOString(); m.purge_after = purgeAfter(now).toISOString(); m.active = false;
    return true;
  }
  async purge(now: Date) {
    let conversations = 0; let memories = 0;
    for (const [id, c] of this.conversations) if (c.purge_after && c.purge_after <= now.toISOString()) { this.conversations.delete(id); conversations += 1; }
    for (const [id, m] of this.memories) if (m.purge_after && m.purge_after <= now.toISOString()) { this.memories.delete(id); memories += 1; }
    return { conversations, memories };
  }
}

/* ------------------------------------------------------------------ PostgreSQL */

const CONV_COLS = 'id, title, source, import_key, version, message_count, created_at, updated_at';
const MEM_COLS = 'id, category, content, source, source_ref, active, version, created_at, updated_at';
const iso = (row: Record<string, unknown>) => ({ ...row, created_at: new Date(row.created_at as string).toISOString(), updated_at: new Date(row.updated_at as string).toISOString() });

export class PgHistoryStore implements HistoryStore {
  constructor(private readonly pool: Pool) {}

  async list(userId: string, opts: { query?: string; limit?: number }) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const q = opts.query?.trim();
    const { rows } = q
      ? await this.pool.query(
        `select ${CONV_COLS} from noirxu_ai.conversations c where c.user_id = $1 and c.deleted_at is null
           and (c.title ilike $2 or exists (select 1 from noirxu_ai.messages m where m.conversation_id = c.id and m.search_text ilike $2))
         order by c.updated_at desc limit $3`, [userId, `%${q.replace(/[\\%_]/g, '\\$&')}%`, limit])
      : await this.pool.query(`select ${CONV_COLS} from noirxu_ai.conversations where user_id = $1 and deleted_at is null order by updated_at desc limit $2`, [userId, limit]);
    return rows.map(iso) as ConversationRow[];
  }

  async create(userId: string, row: { id: string; title: string; source: ConversationRow['source']; importKey?: string | null }) {
    const inserted = await this.pool.query(
      `insert into noirxu_ai.conversations (id, user_id, title, source, import_key) values ($1, $2, $3, $4, $5)
       on conflict (user_id, import_key) where import_key is not null do nothing returning ${CONV_COLS}`,
      [row.id, userId, row.title, row.source, row.importKey ?? null]);
    if (inserted.rows[0]) return { row: iso(inserted.rows[0]) as ConversationRow, created: true };
    const { rows } = await this.pool.query(`select ${CONV_COLS} from noirxu_ai.conversations where user_id = $1 and import_key = $2`, [userId, row.importKey]);
    return { row: iso(rows[0]) as ConversationRow, created: false };
  }

  async get(userId: string, id: string) {
    const conv = await this.pool.query(`select ${CONV_COLS}, context_sealed from noirxu_ai.conversations where id = $1 and user_id = $2 and deleted_at is null`, [id, userId]);
    if (!conv.rows[0]) return null;
    const { context_sealed, ...row } = conv.rows[0];
    const msgs = await this.pool.query('select seq, kind, sealed, search_text from noirxu_ai.messages where conversation_id = $1 and user_id = $2 order by seq', [id, userId]);
    return { row: iso(row) as ConversationRow, context: context_sealed ?? null, messages: msgs.rows as SealedMessage[] };
  }

  async append(userId: string, id: string, fromSeq: number, messages: Array<{ id: string; kind: string; sealed: string; search_text: string }>) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // Row lock: concurrent appends to one conversation wait here instead of interleaving.
      const { rows } = await client.query('select message_count from noirxu_ai.conversations where id = $1 and user_id = $2 and deleted_at is null for update', [id, userId]);
      if (!rows[0]) { await client.query('rollback'); return { ok: false as const, nextSeq: -1 }; }
      const count = Number(rows[0].message_count);
      if (count !== fromSeq) { await client.query('rollback'); return { ok: false as const, nextSeq: count }; }
      for (let i = 0; i < messages.length; i += 1) {
        const m = messages[i];
        await client.query('insert into noirxu_ai.messages (id, conversation_id, user_id, seq, kind, sealed, search_text) values ($1, $2, $3, $4, $5, $6, $7)',
          [m.id, id, userId, fromSeq + i, m.kind, m.sealed, m.search_text]);
      }
      await client.query('update noirxu_ai.conversations set message_count = $3, updated_at = now() where id = $1 and user_id = $2', [id, userId, fromSeq + messages.length]);
      await client.query('commit');
      return { ok: true as const, nextSeq: fromSeq + messages.length };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async saveContext(userId: string, id: string, expectedVersion: number, sealed: string) {
    const { rows } = await this.pool.query(
      'update noirxu_ai.conversations set context_sealed = $4, version = version + 1, updated_at = now() where id = $1 and user_id = $2 and version = $3 and deleted_at is null returning version',
      [id, userId, expectedVersion, sealed]);
    if (rows[0]) return { ok: true, version: Number(rows[0].version) };
    const current = await this.pool.query('select version from noirxu_ai.conversations where id = $1 and user_id = $2 and deleted_at is null', [id, userId]);
    return { ok: false, version: current.rows[0] ? Number(current.rows[0].version) : -1 };
  }

  async rename(userId: string, id: string, title: string) {
    const { rows } = await this.pool.query(`update noirxu_ai.conversations set title = $3, version = version + 1, updated_at = now() where id = $1 and user_id = $2 and deleted_at is null returning ${CONV_COLS}`, [id, userId, title]);
    return rows[0] ? iso(rows[0]) as ConversationRow : null;
  }

  async softDelete(userId: string, id: string, now: Date) {
    const { rowCount } = await this.pool.query('update noirxu_ai.conversations set deleted_at = $3, purge_after = $4 where id = $1 and user_id = $2 and deleted_at is null', [id, userId, now, purgeAfter(now)]);
    return rowCount === 1;
  }

  async listMemories(userId: string, opts: { includeInactive?: boolean; query?: string }) {
    const params: unknown[] = [userId];
    let sql = `select ${MEM_COLS} from noirxu_ai.memories where user_id = $1 and deleted_at is null`;
    if (!opts.includeInactive) sql += ' and active';
    if (opts.query?.trim()) { params.push(`%${opts.query.trim().replace(/[\\%_]/g, '\\$&')}%`); sql += ` and content ilike $${params.length}`; }
    const { rows } = await this.pool.query(`${sql} order by updated_at desc limit 200`, params);
    return rows.map(iso) as MemoryRow[];
  }

  async createMemory(userId: string, row: Omit<MemoryRow, 'version' | 'created_at' | 'updated_at' | 'active'> & { active?: boolean }) {
    const { rows } = await this.pool.query(
      `insert into noirxu_ai.memories (id, user_id, category, content, source, source_ref, active) values ($1, $2, $3, $4, $5, $6, $7) returning ${MEM_COLS}`,
      [row.id, userId, row.category, row.content, row.source, row.source_ref, row.active ?? true]);
    return iso(rows[0]) as MemoryRow;
  }

  async updateMemory(userId: string, id: string, patch: Partial<Pick<MemoryRow, 'content' | 'category' | 'active'>>) {
    const { rows } = await this.pool.query(
      `update noirxu_ai.memories set content = coalesce($3, content), category = coalesce($4, category), active = coalesce($5, active), version = version + 1, updated_at = now()
       where id = $1 and user_id = $2 and deleted_at is null returning ${MEM_COLS}`,
      [id, userId, patch.content ?? null, patch.category ?? null, patch.active ?? null]);
    return rows[0] ? iso(rows[0]) as MemoryRow : null;
  }

  async softDeleteMemory(userId: string, id: string, now: Date) {
    const { rowCount } = await this.pool.query('update noirxu_ai.memories set deleted_at = $3, purge_after = $4, active = false where id = $1 and user_id = $2 and deleted_at is null', [id, userId, now, purgeAfter(now)]);
    return rowCount === 1;
  }

  async purge(now: Date) {
    const c = await this.pool.query('delete from noirxu_ai.conversations where purge_after is not null and purge_after <= $1', [now]);
    const m = await this.pool.query('delete from noirxu_ai.memories where purge_after is not null and purge_after <= $1', [now]);
    return { conversations: c.rowCount ?? 0, memories: m.rowCount ?? 0 };
  }
}

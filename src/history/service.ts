import { randomUUID } from 'node:crypto';
import type { TokenVault } from '@/connections/vault';
import { ToolError } from '@/hub/errors';
import { guessCategory, maskForSearch, memoryRejection, type MemoryCategory } from './privacy';
import type { ConversationRow, HistoryStore, MemoryRow } from './store';

export interface ChatItem { kind: string; text?: string; [key: string]: unknown }
export interface ChatContext { history: unknown[]; notes: string[] }
export interface LoadedConversation { conversation: ConversationRow; items: ChatItem[]; context: ChatContext; nextSeq: number; version: number }

const KINDS = new Set(['user', 'assistant', 'tool', 'notice', 'error', 'help']);
const SEARCHABLE = new Set(['user', 'assistant', 'notice']);
const MAX_APPEND = 200;

export function titleFrom(text: string) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean ? (clean.length > 40 ? `${clean.slice(0, 40)}…` : clean) : '新對話';
}

/**
 * Server-side conversation history. Each message is encrypted with a key bound to its
 * conversation and position, so a row copied elsewhere cannot be opened. Only masked
 * user/assistant text is stored for search; tool results are never searchable.
 */
export class HistoryService {
  constructor(private readonly store: HistoryStore, private readonly vault: TokenVault) {}

  private seal(convId: string, seq: number, item: ChatItem) { return this.vault.seal(JSON.stringify(item), `msg:${convId}:${seq}`); }

  private rows(convId: string, fromSeq: number, items: ChatItem[]) {
    return items.map((item, i) => {
      if (!KINDS.has(item.kind)) throw new ToolError('INVALID_INPUT', `不支援的訊息類型：${item.kind}`);
      return {
        id: randomUUID(),
        kind: item.kind,
        sealed: this.seal(convId, fromSeq + i, item),
        search_text: SEARCHABLE.has(item.kind) && typeof item.text === 'string' ? maskForSearch(item.text) : ''
      };
    });
  }

  list(userId: string, query?: string) {
    return this.store.list(userId, { query, limit: 100 });
  }

  async create(userId: string, title = '新對話') {
    return (await this.store.create(userId, { id: randomUUID(), title: title.slice(0, 120) || '新對話', source: 'server' })).row;
  }

  async load(userId: string, id: string): Promise<LoadedConversation | null> {
    const found = await this.store.get(userId, id);
    if (!found) return null;
    const items = found.messages.map(m => JSON.parse(this.vault.open(m.sealed, `msg:${id}:${m.seq}`)) as ChatItem);
    const context = found.context ? JSON.parse(this.vault.open(found.context, `ctx:${id}`)) as ChatContext : { history: [], notes: [] };
    return { conversation: found.row, items, context, nextSeq: found.row.message_count, version: found.row.version };
  }

  /**
   * Appends items written after `fromSeq` and, optionally, the latest model context.
   * Returns conflict when another device appended first; the caller reloads and retries.
   */
  async append(userId: string, id: string, fromSeq: number, items: ChatItem[], context?: { value: ChatContext; expectedVersion: number }) {
    if (items.length > MAX_APPEND) throw new ToolError('INVALID_INPUT', `一次最多同步 ${MAX_APPEND} 則訊息。`);
    const appended = items.length ? await this.store.append(userId, id, fromSeq, this.rows(id, fromSeq, items)) : { ok: true as const, nextSeq: fromSeq };
    if (!appended.ok) return { status: appended.nextSeq < 0 ? 'not_found' as const : 'conflict' as const, nextSeq: appended.nextSeq };
    let version: number | null = null;
    if (context) {
      const saved = await this.store.saveContext(userId, id, context.expectedVersion, this.vault.seal(JSON.stringify(context.value), `ctx:${id}`));
      if (!saved.ok) return { status: 'context_conflict' as const, nextSeq: appended.nextSeq, version: saved.version };
      version = saved.version;
    }
    return { status: 'ok' as const, nextSeq: appended.nextSeq, version };
  }

  /**
   * Imports a browser conversation. Idempotent: the same importKey maps to the same row,
   * only the messages the server does not have yet are added, and the result is verified.
   */
  async importConversation(userId: string, input: { importKey: string; source: 'legacy_import' | 'local_import'; title: string; items: ChatItem[]; context: ChatContext }) {
    const { row, created } = await this.store.create(userId, { id: randomUUID(), title: input.title.slice(0, 120) || '匯入的對話', source: input.source, importKey: input.importKey });
    const missing = input.items.slice(row.message_count);
    let version = row.version;
    if (missing.length) {
      const result = await this.append(userId, row.id, row.message_count, missing, { value: input.context, expectedVersion: row.version });
      if (result.status !== 'ok') throw new ToolError('CONFLICT', '匯入時對話同時在別處更新，請再試一次。');
      version = result.version ?? version;
    }
    const check = await this.store.get(userId, row.id);
    if (!check || check.row.message_count < input.items.length) throw new ToolError('UPSTREAM_REJECTED', '匯入後檢查筆數不符，這次匯入不算完成。');
    return { conversation: check.row, created, added: missing.length, version };
  }

  async rename(userId: string, id: string, title: string) {
    const clean = title.trim().slice(0, 120);
    if (!clean) throw new ToolError('INVALID_INPUT', '名稱不能是空白。');
    return this.store.rename(userId, id, clean);
  }

  remove(userId: string, id: string, now = new Date()) {
    return this.store.softDelete(userId, id, now);
  }

  /* ---------------------------------------------------------------- memories */

  listMemories(userId: string, opts: { includeInactive?: boolean; query?: string } = {}) {
    return this.store.listMemories(userId, opts);
  }

  async remember(userId: string, input: { content: string; category?: MemoryCategory; source: MemoryRow['source']; sourceRef?: string | null }) {
    const content = input.content.replace(/\s+/g, ' ').trim();
    if (!content) throw new ToolError('INVALID_INPUT', '記憶內容不能是空白。');
    if (content.length > 500) throw new ToolError('INVALID_INPUT', '一筆記憶最多 500 字，請拆成幾筆。');
    const rejected = memoryRejection(content);
    if (rejected) throw new ToolError('INVALID_INPUT', rejected);
    return this.store.createMemory(userId, { id: randomUUID(), category: input.category ?? guessCategory(content), content, source: input.source, source_ref: input.sourceRef ?? null });
  }

  async editMemory(userId: string, id: string, patch: { content?: string; category?: MemoryCategory; active?: boolean }) {
    if (patch.content !== undefined) {
      const content = patch.content.replace(/\s+/g, ' ').trim();
      if (!content || content.length > 500) throw new ToolError('INVALID_INPUT', '記憶內容需在 1～500 字之間。');
      const rejected = memoryRejection(content);
      if (rejected) throw new ToolError('INVALID_INPUT', rejected);
      patch = { ...patch, content };
    }
    const updated = await this.store.updateMemory(userId, id, patch);
    if (!updated) throw new ToolError('NOT_FOUND', '找不到這筆記憶。');
    return updated;
  }

  async forget(userId: string, id: string, now = new Date()) {
    if (!(await this.store.softDeleteMemory(userId, id, now))) throw new ToolError('NOT_FOUND', '找不到這筆記憶。');
  }

  purge(now = new Date()) {
    return this.store.purge(now);
  }
}

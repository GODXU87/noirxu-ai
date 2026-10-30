import { randomUUID } from 'node:crypto';
import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';
import type { MemoryRecord, MemorySource } from '@/router/memory';
import { ToolError } from '@/hub/errors';

// Long-term memory: things the user asked SASUKE to remember (preferences, routine, goals,
// decisions, personal facts). Only what the user said or confirmed is kept — never the chat
// itself. Stored sealed in the existing settings table (compare-and-set), so it needs no
// schema change; the user can see, edit and delete every entry on the 個人記憶 page.

export const MEMORY_CATEGORIES = { preference: '偏好', routine: '作息與課表', goal: '目標', decision: '決定', health: '健康', personal: '個人資料', other: '其他' } as const;
export type MemoryCategory = keyof typeof MEMORY_CATEGORIES;
export const MEMORY_LIMIT = 300;

export interface StoredMemory extends MemoryRecord { category: MemoryCategory; created_at: string; source: 'user' | 'confirmed'; revision: number }

const RULES: Array<[RegExp, MemoryCategory]> = [
  [/(過敏|不能吃|忌口|受傷|疼痛|膝蓋|腰|血壓|體重|身高|睡眠|心率)/, 'health'],
  [/(每週|每周|週[一二三四五六日]|星期|每天|早上|晚上|課表|上班|下班|作息|羽球|健身|跑步|訓練)/, 'routine'],
  [/(目標|想要|準備|比賽|hyrox|考試|存到|減到|達成)/i, 'goal'],
  [/(決定|以後|之後都|改成|不再|停止)/, 'decision'],
  [/(喜歡|不喜歡|偏好|討厭|習慣|愛喝|愛吃|不要|希望)/, 'preference'],
  [/(生日|住在|家人|老婆|女友|男友|小孩|學校|公司|職業|老師|名字)/, 'personal']
];

export function categorize(content: string): MemoryCategory {
  return RULES.find(([re]) => re.test(content))?.[1] ?? 'other';
}

const normalize = (t: string) => t.replace(/[\s，。,.！!？?、]+/g, '').toLowerCase();

export class MemoryStore implements MemorySource {
  constructor(private readonly store: AgendaStore, private readonly vault: TokenVault) {}
  private key(userId: string) { return `memory:${userId}`; }

  private async read(userId: string): Promise<{ sealed: string | null; items: StoredMemory[] }> {
    const k = this.key(userId);
    const sealed = await this.store.getSetting(k);
    const items = sealed ? JSON.parse(this.vault.open(sealed, k)) as StoredMemory[] : [];
    // Existing sealed entries predate revision checks; no migration or plaintext copy.
    return { sealed, items: items.map(m => ({ ...m, revision: m.revision ?? 1 })) };
  }

  private async change<T>(userId: string, fn: (items: StoredMemory[]) => { items: StoredMemory[]; result: T }): Promise<T> {
    const k = this.key(userId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { sealed, items } = await this.read(userId);
      const next = fn(items);
      if (await this.store.compareAndSetSetting(k, sealed, this.vault.seal(JSON.stringify(next.items), k))) return next.result;
    }
    throw new Error('記憶正在更新，請再試一次');
  }

  async list(userId: string): Promise<StoredMemory[]> {
    return (await this.read(userId)).items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** Adds a memory; the same thing said again refreshes the existing entry instead of duplicating it. */
  async add(userId: string, input: { content: string; category?: MemoryCategory; source?: StoredMemory['source']; now: Date }): Promise<{ memory: StoredMemory; updated: boolean }> {
    const content = input.content.trim().replace(/[。.]+$/, '').slice(0, 300);
    if (!content) throw new Error('沒有要記住的內容');
    const now = input.now.toISOString();
    return this.change<{ memory: StoredMemory; updated: boolean }>(userId, items => {
      const same = items.find(m => normalize(m.content) === normalize(content));
      if (same) {
        const updated = { ...same, content, updated_at: now, revision: same.revision + 1 };
        return { items: items.map(m => (m.id === same.id ? updated : m)), result: { memory: updated, updated: true } };
      }
      if (items.length >= MEMORY_LIMIT) throw new Error(`記憶已達 ${MEMORY_LIMIT} 筆上限，請先到「個人記憶」刪除不需要的`);
      const memory: StoredMemory = { id: randomUUID(), content, category: input.category ?? categorize(content), source: input.source ?? 'user', tags: [], created_at: now, updated_at: now, revision: 1 };
      return { items: [...items, memory], result: { memory, updated: false } };
    });
  }

  async update(userId: string, id: string, patch: { content?: string; category?: MemoryCategory }, now: Date, expectedRevision: number): Promise<StoredMemory | null> {
    return this.change(userId, items => {
      const found = items.find(m => m.id === id);
      if (!found) return { items, result: null };
      if (found.revision !== expectedRevision) throw new ToolError('CONFLICT', '這筆記憶已有較新的版本。草稿未儲存；請重新讀取並核對，再取消修改、重新更正。');
      const content = patch.content === undefined ? found.content : patch.content.trim().slice(0, 300);
      // Moving a fact to another category is not a new factual report. The router uses
      // this date for stale-memory warnings, so only changed content refreshes it.
      const updated: StoredMemory = { ...found, content, ...(patch.category ? { category: patch.category } : {}), updated_at: content === found.content ? found.updated_at : now.toISOString(), revision: found.revision + 1 };
      return { items: items.map(m => (m.id === id ? updated : m)), result: updated };
    });
  }

  async remove(userId: string, id: string, expectedRevision?: number): Promise<boolean> {
    return this.change(userId, items => {
      const found = items.find(m => m.id === id);
      if (found && expectedRevision !== undefined && found.revision !== expectedRevision) throw new ToolError('CONFLICT', '這筆記憶已有較新的版本，尚未刪除。請重新讀取並核對後再刪除。');
      return { items: items.filter(m => m.id !== id), result: Boolean(found) };
    });
  }
}

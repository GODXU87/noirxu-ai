'use client';

// Conversation list kept in this browser until server-side history (Phase C2) is approved.
// The interface is what C2 will implement against the server, so the UI will not change.
//
// Rules:
// - Nothing is deleted automatically. Past SOFT_LIMIT the sidebar only suggests cleaning up.
// - Every write reports whether it succeeded, so the UI can warn when storage is full.
// - The classic UI's chat (sessionStorage 'noirxu-ai-chat-v1') is copied, verified by
//   reading it back, and never removed. A failed import is retried on the next visit;
//   importing again updates the same conversation instead of creating duplicates.

export interface ConversationMeta { id: string; title: string; updatedAt: string; imported?: boolean }
export interface ConversationData { items: unknown[]; history: unknown[]; notes: string[] }
export type SaveResult = { ok: true } | { ok: false; reason: 'quota' | 'unavailable' };
export interface LegacyImport { identity: string; conversationId: string; items: number; at: string }

export const SOFT_LIMIT = 60;
const INDEX_KEY = 'noirxu-ai-conversations-v1';
const DATA_PREFIX = 'noirxu-ai-conv:';
const LEGACY_KEY = 'noirxu-ai-chat-v1';
const LEGACY_LOG_KEY = 'noirxu-ai-legacy-imports-v1';
const CHANGE_EVENT = 'noirxu-conversations-changed';

function read<T>(storage: Storage, key: string, fallback: T): T {
  try { const raw = storage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

function write(key: string, value: unknown): SaveResult {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return { ok: true };
  } catch (error) {
    const name = (error as { name?: string }).name ?? '';
    return { ok: false, reason: /quota/i.test(name) || (error as { code?: number }).code === 22 ? 'quota' : 'unavailable' };
  }
}

function notify() {
  try { window.dispatchEvent(new Event(CHANGE_EVENT)); } catch { /* no window in tests */ }
}

export function listConversations(): ConversationMeta[] {
  return [...read<ConversationMeta[]>(localStorage, INDEX_KEY, [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function newConversationId() {
  return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function loadConversation(id: string): ConversationData | null {
  return read<ConversationData | null>(localStorage, DATA_PREFIX + id, null);
}

export function titleFrom(text: string) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean ? (clean.length > 24 ? `${clean.slice(0, 24)}…` : clean) : '新對話';
}

export function saveConversation(id: string, data: ConversationData, firstUserText?: string, extra: Partial<ConversationMeta> = {}): SaveResult {
  if (!data.items.length) return { ok: true };
  const saved = write(DATA_PREFIX + id, data);
  if (!saved.ok) return saved;
  const list = listConversations();
  const existing = list.find(c => c.id === id);
  const now = new Date().toISOString();
  if (existing) Object.assign(existing, extra, { updatedAt: now });
  else list.unshift({ id, title: titleFrom(firstUserText ?? ''), updatedAt: now, ...extra });
  const indexed = write(INDEX_KEY, list);
  notify();
  return indexed;
}

export function renameConversation(id: string, title: string): SaveResult {
  const list = listConversations();
  const item = list.find(c => c.id === id);
  if (!item || !title.trim()) return { ok: true };
  item.title = title.trim().slice(0, 60);
  const result = write(INDEX_KEY, list);
  notify();
  return result;
}

/** Only ever called from an explicit user action. */
export function deleteConversation(id: string): SaveResult {
  const result = write(INDEX_KEY, listConversations().filter(c => c.id !== id));
  if (result.ok) { try { localStorage.removeItem(DATA_PREFIX + id); } catch { /* ignore */ } }
  notify();
  return result;
}

export function onConversationsChanged(fn: () => void) {
  window.addEventListener(CHANGE_EVENT, fn);
  window.addEventListener('storage', fn);
  return () => { window.removeEventListener(CHANGE_EVENT, fn); window.removeEventListener('storage', fn); };
}

/** Stable identity of a classic conversation: its first two items. */
function identityOf(items: unknown[]) {
  const text = JSON.stringify(items.slice(0, 2));
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `legacy_${(h >>> 0).toString(36)}`;
}

export function legacyImports(): LegacyImport[] {
  return read<LegacyImport[]>(localStorage, LEGACY_LOG_KEY, []);
}

export type ImportOutcome =
  | { status: 'none' }
  | { status: 'unchanged'; conversationId: string }
  | { status: 'imported' | 'updated'; conversationId: string; items: number }
  | { status: 'failed'; reason: string };

/**
 * Copies the classic UI's chat into the list. Safe to call on every visit: the same
 * classic conversation maps to the same entry, it only ever grows, and the import is
 * recorded only after reading it back matches.
 */
export function importLegacySession(): ImportOutcome {
  const legacy = read<ConversationData | null>(sessionStorage, LEGACY_KEY, null);
  if (!legacy?.items?.length) return { status: 'none' };
  const identity = identityOf(legacy.items);
  const log = legacyImports();
  const previous = log.find(entry => entry.identity === identity);
  const conversationId = previous?.conversationId ?? `c_${identity}`;
  const current = loadConversation(conversationId);
  if (previous && current && current.items.length >= legacy.items.length) return { status: 'unchanged', conversationId };

  const first = (legacy.items as Array<{ kind?: string; text?: string }>).find(i => i.kind === 'user')?.text;
  const saved = saveConversation(conversationId, { items: legacy.items, history: legacy.history ?? [], notes: legacy.notes ?? [] }, first, { imported: true });
  if (!saved.ok) return { status: 'failed', reason: saved.reason === 'quota' ? '這台裝置的儲存空間不足' : '瀏覽器不允許儲存' };
  const check = loadConversation(conversationId);
  if (!check || check.items.length !== legacy.items.length) return { status: 'failed', reason: '寫入後讀回的內容不一致' };

  const entry = { identity, conversationId, items: legacy.items.length, at: new Date().toISOString() };
  write(LEGACY_LOG_KEY, [...log.filter(e => e.identity !== identity), entry]);
  return { status: previous ? 'updated' : 'imported', conversationId, items: legacy.items.length };
}

/**
 * Which conversation this browser tab is in. Opening the app again (a new tab, a relaunched
 * home-screen app) or coming back after IDLE_MS starts a fresh conversation; earlier ones stay
 * in the list. sessionStorage is per tab, so a reload of the same tab keeps going.
 */
const ACTIVE_KEY = 'noirxu-ai-active-v1';
export const IDLE_MS = 30 * 60 * 1000;

export function resumeActive(now = Date.now()): string | null {
  const active = read<{ id: string; at: number } | null>(sessionStorage, ACTIVE_KEY, null);
  return active && now - active.at < IDLE_MS && loadConversation(active.id) ? active.id : null;
}

export function touchActive(id: string, now = Date.now()) {
  try { sessionStorage.setItem(ACTIVE_KEY, JSON.stringify({ id, at: now })); } catch { /* storage unavailable */ }
}

export function activeId(): string | null {
  return read<{ id: string } | null>(sessionStorage, ACTIVE_KEY, null)?.id ?? null;
}

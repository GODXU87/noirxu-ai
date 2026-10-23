'use client';

// Conversation list kept in this browser until server-side history (Phase C2) is approved.
// The interface is what C2 will implement against the server, so the UI will not change.
// The old single-session chat (sessionStorage 'noirxu-ai-chat-v1') is copied in once and
// never deleted, so nothing is lost if the classic UI is switched back on.

export interface ConversationMeta { id: string; title: string; updatedAt: string }
export interface ConversationData { items: unknown[]; history: unknown[]; notes: string[] }

const INDEX_KEY = 'noirxu-ai-conversations-v1';
const DATA_PREFIX = 'noirxu-ai-conv:';
const LEGACY_KEY = 'noirxu-ai-chat-v1';
const IMPORTED_KEY = 'noirxu-ai-legacy-imported';
const CHANGE_EVENT = 'noirxu-conversations-changed';
const MAX_CONVERSATIONS = 60;

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

function writeIndex(list: ConversationMeta[]) {
  safe(() => localStorage.setItem(INDEX_KEY, JSON.stringify(list.slice(0, MAX_CONVERSATIONS))), undefined);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function listConversations(): ConversationMeta[] {
  const list = safe(() => JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]') as ConversationMeta[], []);
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function newConversationId() {
  return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function loadConversation(id: string): ConversationData | null {
  return safe(() => { const raw = localStorage.getItem(DATA_PREFIX + id); return raw ? JSON.parse(raw) as ConversationData : null; }, null);
}

export function saveConversation(id: string, data: ConversationData, firstUserText?: string) {
  if (!data.items.length) return;
  safe(() => localStorage.setItem(DATA_PREFIX + id, JSON.stringify(data)), undefined);
  const list = listConversations();
  const existing = list.find(c => c.id === id);
  const now = new Date().toISOString();
  if (existing) existing.updatedAt = now;
  else list.unshift({ id, title: titleFrom(firstUserText ?? ''), updatedAt: now });
  // Drop the data of conversations that fall off the end of the list.
  for (const old of list.slice(MAX_CONVERSATIONS)) safe(() => localStorage.removeItem(DATA_PREFIX + old.id), undefined);
  writeIndex(list);
}

export function renameConversation(id: string, title: string) {
  const list = listConversations();
  const item = list.find(c => c.id === id);
  if (!item || !title.trim()) return;
  item.title = title.trim().slice(0, 60);
  writeIndex(list);
}

export function deleteConversation(id: string) {
  safe(() => localStorage.removeItem(DATA_PREFIX + id), undefined);
  writeIndex(listConversations().filter(c => c.id !== id));
}

export function onConversationsChanged(fn: () => void) {
  window.addEventListener(CHANGE_EVENT, fn);
  window.addEventListener('storage', fn);
  return () => { window.removeEventListener(CHANGE_EVENT, fn); window.removeEventListener('storage', fn); };
}

export function titleFrom(text: string) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean ? (clean.length > 24 ? `${clean.slice(0, 24)}…` : clean) : '新對話';
}

/** Copies the classic UI's current session conversation once. Returns its id, if any. */
export function importLegacySession(): string | null {
  if (safe(() => localStorage.getItem(IMPORTED_KEY), null)) return null;
  const legacy = safe(() => { const raw = sessionStorage.getItem(LEGACY_KEY); return raw ? JSON.parse(raw) as ConversationData : null; }, null);
  safe(() => localStorage.setItem(IMPORTED_KEY, new Date().toISOString()), undefined);
  if (!legacy?.items?.length) return null;
  const id = newConversationId();
  const first = (legacy.items as Array<{ kind?: string; text?: string }>).find(i => i.kind === 'user')?.text;
  saveConversation(id, legacy, first);
  return id;
}

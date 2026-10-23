'use client';

// Client for server-side history (Phase C2). Used only when the server_history flag is on.
// Local copies are never deleted: the browser keeps its own list as an offline backup.

import { importLegacySession, legacyImports, listConversations, loadConversation, type ConversationMeta } from './conversations';

export interface ServerConversation { id: string; title: string; updated_at: string; message_count: number; version: number; source: string }
export interface ServerLoaded { conversation: ServerConversation; items: unknown[]; context: { history: unknown[]; notes: string[] }; nextSeq: number; version: number }

async function call<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string; body?: any }> {
  try {
    const response = await fetch(path, { ...init, headers: init?.body ? { 'Content-Type': 'application/json' } : undefined });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) return { ok: false, status: response.status, message: body.error?.message ?? '同步失敗', body };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, message: '網路錯誤，稍後會再同步。' };
  }
}

export const serverHistory = {
  list: (q?: string) => call<{ conversations: ServerConversation[] }>(`/api/history${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  load: (id: string) => call<ServerLoaded>(`/api/history/${id}`),
  create: (title: string) => call<{ conversation: ServerConversation }>('/api/history', { method: 'POST', body: JSON.stringify({ title }) }),
  append: (id: string, fromSeq: number, items: unknown[], context: { history: unknown[]; notes: string[]; expectedVersion: number }) =>
    call<{ nextSeq: number; version: number | null }>(`/api/history/${id}/messages`, { method: 'POST', body: JSON.stringify({ fromSeq, items, context }) }),
  rename: (id: string, title: string) => call<{ conversation: ServerConversation }>(`/api/history/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  remove: (id: string) => call<{ purgeAfterDays: number }>(`/api/history/${id}`, { method: 'DELETE' })
};

const SYNCED_KEY = 'noirxu-ai-server-imported-v1';

function synced(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SYNCED_KEY) ?? '{}'); } catch { return {}; }
}

/**
 * Uploads this browser's conversations once (and again only if they grew). Idempotent on
 * the server by import key, so a retry after a failure never duplicates anything.
 */
export async function uploadLocalConversations(): Promise<{ uploaded: number; failed: number }> {
  importLegacySession();
  const done = synced();
  const legacyIds = new Set(legacyImports().map(entry => entry.conversationId));
  let uploaded = 0;
  let failed = 0;
  for (const meta of listConversations() as ConversationMeta[]) {
    const data = loadConversation(meta.id);
    if (!data?.items.length || done[meta.id] === data.items.length) continue;
    const result = await call<{ conversation: ServerConversation }>('/api/history', {
      method: 'POST',
      body: JSON.stringify({ import: { key: `local:${meta.id}`, source: legacyIds.has(meta.id) ? 'legacy_import' : 'local_import', title: meta.title, items: data.items, history: data.history, notes: data.notes } })
    });
    if (result.ok) { done[meta.id] = data.items.length; uploaded += 1; } else failed += 1;
  }
  try { localStorage.setItem(SYNCED_KEY, JSON.stringify(done)); } catch { /* next visit retries */ }
  return { uploaded, failed };
}

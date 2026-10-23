'use client';

import { useEffect, useRef, useState } from 'react';
import { titleFrom } from './conversations';
import { serverHistory, uploadLocalConversations } from './server-history';

interface ChatState { items: Array<{ kind: string; text?: string }>; history: unknown[]; notes: string[]; busy: boolean }
interface Setters { setItems: (v: any[]) => void; setHistory: (v: unknown[]) => void; setNotes: (v: string[]) => void }

const BACKUP_PREFIX = 'noirxu-ai-srv-backup:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keeps the open SASUKE conversation in sync with the server (Phase C2).
 * - New conversation: created on the server with the first message.
 * - After each change: only messages the server does not have yet are appended.
 * - Another device wrote first (409): reload, keep both sides' messages, retry.
 * - Sync failed: the unsynced part stays in a local backup and is retried on the next
 *   change or visit, so nothing typed here is lost.
 */
export function useServerSync(enabled: boolean, state: ChatState, set: Setters, report: (message: string | null) => void) {
  const [ready, setReady] = useState(!enabled);
  const sync = useRef({ id: null as string | null, seq: 0, version: 1, running: false, again: false });
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    if (!enabled) return;
    void (async () => {
      const upload = await uploadLocalConversations();
      if (upload.failed) report(`有 ${upload.failed} 段本機對話還沒上傳到伺服器，下次開啟會再試（本機資料保留）。`);
      const requested = new URLSearchParams(window.location.search).get('c');
      if (requested && UUID.test(requested)) {
        const loaded = await serverHistory.load(requested);
        if (loaded.ok) {
          const backup = readBackup(requested);
          const extra = backup && backup.items.length > loaded.data.items.length ? backup.items.slice(loaded.data.items.length) : [];
          set.setItems([...loaded.data.items, ...extra]);
          set.setHistory(extra.length ? backup!.history : loaded.data.context.history);
          set.setNotes(loaded.data.context.notes);
          sync.current = { ...sync.current, id: requested, seq: loaded.data.nextSeq, version: loaded.data.version };
        } else {
          report(loaded.status === 404 ? '找不到這段對話（可能已刪除），已開新對話。' : `讀取對話失敗：${loaded.message}`);
        }
      }
      setReady(true);
    })();
  }, [enabled]);

  async function run() {
    const s = sync.current;
    if (s.running) { s.again = true; return; }
    s.running = true;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { items, history, notes } = latest.current;
        if (!items.length) return;
        if (!s.id) {
          const first = items.find(i => i.kind === 'user');
          const created = await serverHistory.create(titleFrom(first?.text ?? ''));
          if (!created.ok) { report(`對話沒有同步到伺服器：${created.message}（這台裝置上仍保留）`); writeBackup('pending', latest.current); return; }
          Object.assign(s, { id: created.data.conversation.id, seq: 0, version: created.data.conversation.version });
          window.history.replaceState(null, '', `/?c=${s.id}`);
          window.dispatchEvent(new Event('noirxu-conversations-changed'));
        }
        const pending = items.slice(s.seq);
        // Nothing new: do not touch the server (opening a conversation must not bump its version).
        if (!pending.length) return;
        const result = await serverHistory.append(s.id!, s.seq, pending, { history, notes, expectedVersion: s.version });
        if (result.ok) {
          s.seq = result.data.nextSeq;
          if (result.data.version) s.version = result.data.version;
          clearBackup(s.id!);
          report(null);
          window.dispatchEvent(new Event('noirxu-conversations-changed'));
          return;
        }
        if (result.status === 409) {
          const fresh = await serverHistory.load(s.id!);
          if (!fresh.ok) break;
          // Keep the other device's messages, then ours that the server has not seen.
          const merged = [...fresh.data.items, ...pending];
          set.setItems(merged);
          set.setHistory(fresh.data.context.history);
          latest.current = { ...latest.current, items: merged as any, history: fresh.data.context.history };
          Object.assign(s, { seq: fresh.data.nextSeq, version: fresh.data.version });
          report('這段對話在另一台裝置也有更新，已合併顯示。');
          continue;
        }
        writeBackup(s.id!, latest.current);
        report(`最新訊息還沒同步到伺服器：${result.message}（已暫存在這台裝置，會自動重試）`);
        return;
      }
    } finally {
      s.running = false;
      if (s.again) { s.again = false; void run(); }
    }
  }

  useEffect(() => {
    if (!enabled || !ready || state.busy || !state.items.length) return;
    void run();
  }, [enabled, ready, state.items, state.history, state.notes, state.busy]);

  return { ready, conversationId: sync.current.id };
}

function readBackup(id: string): { items: any[]; history: unknown[] } | null {
  try { const raw = localStorage.getItem(BACKUP_PREFIX + id); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeBackup(id: string, value: { items: unknown[]; history: unknown[] }) {
  try { localStorage.setItem(BACKUP_PREFIX + id, JSON.stringify({ items: value.items, history: value.history })); } catch { /* reported already */ }
}
function clearBackup(id: string) {
  try { localStorage.removeItem(BACKUP_PREFIX + id); } catch { /* ignore */ }
}

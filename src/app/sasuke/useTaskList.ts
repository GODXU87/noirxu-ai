'use client';

import { useEffect, useRef, useState } from 'react';
import { callTool } from '../components/shared';

const POLL_MS = 20_000;
const TIMEOUT_MS = 15_000;
interface TaskListState {
  data?: { tasks: any[]; halted?: boolean };
  updatedAt?: string;
  refreshing: boolean;
  offline: boolean;
  error?: string;
}

/** Read-only freshness, not a scheduler. Never polls a hidden/offline page. */
export function useTaskList(includeFinished: boolean) {
  const [state, setState] = useState<TaskListState>({ refreshing: false, offline: false });
  const refreshRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let active: AbortController | null = null;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const available = () => document.visibilityState === 'visible' && navigator.onLine;
    const clearPoll = () => { clearTimeout(timer); timer = undefined; };
    setState({ refreshing: false, offline: !navigator.onLine });

    async function refresh() {
      clearPoll();
      if (disposed || !available()) return;
      // A change during a read invalidates its snapshot; fetch once more after it settles.
      if (active) { pending = true; revision += 1; return; }
      pending = false;
      const current = ++revision;
      const controller = new AbortController(); active = controller;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
      setState(s => ({ ...s, refreshing: true, offline: false }));
      try {
        const result = await callTool('tasks.list', { include_finished: includeFinished }, controller.signal);
        if (disposed || current !== revision || (!timedOut && controller.signal.aborted)) return;
        if (!timedOut && result.status === 'ok') {
          setState({ data: result.data as TaskListState['data'], updatedAt: new Date().toISOString(), refreshing: false, offline: false });
        } else {
          const message = timedOut ? '更新逾時，請稍後重試。' : result.status === 'error' && result.code === 'UNKNOWN_TOOL' ? '自動任務功能目前沒有開啟。' : '更新失敗，保留上次讀取的資料。';
          setState(s => ({ ...s, refreshing: false, error: message }));
        }
      } finally {
        clearTimeout(timeout); active = null;
        if (!disposed && available()) {
          if (pending) void refresh();
          else timer = setTimeout(() => void refresh(), POLL_MS);
        }
      }
    }
    const changed = () => { void refresh(); };
    const availability = () => {
      setState(s => ({ ...s, offline: !navigator.onLine }));
      if (available()) void refresh();
      else { clearPoll(); revision += 1; pending = false; active?.abort(); setState(s => ({ ...s, refreshing: false })); }
    };
    refreshRef.current = changed;
    document.addEventListener('visibilitychange', availability);
    window.addEventListener('online', availability);
    window.addEventListener('offline', availability);
    window.addEventListener('noirxu-tasks-changed', changed);
    window.addEventListener('noirxu-inbox-changed', changed);
    void refresh();
    return () => {
      disposed = true; revision += 1; clearPoll(); active?.abort(); refreshRef.current = () => undefined;
      document.removeEventListener('visibilitychange', availability);
      window.removeEventListener('online', availability);
      window.removeEventListener('offline', availability);
      window.removeEventListener('noirxu-tasks-changed', changed);
      window.removeEventListener('noirxu-inbox-changed', changed);
    };
  }, [includeFinished]);
  return { ...state, refresh: () => refreshRef.current() };
}

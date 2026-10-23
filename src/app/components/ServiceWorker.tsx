'use client';

import { useEffect } from 'react';

declare global {
  interface Window { __noirxuSW?: { status: 'registering' | 'registered' | 'failed' | 'unsupported'; error?: string } }
}

/**
 * Registers the service worker (needed for notifications) and keeps the result for the
 * diagnostics panel instead of ignoring failures. Also asks the server to run any overdue
 * scheduler work when the app is opened, as a safety net for a late GitHub schedule.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) { window.__noirxuSW = { status: 'unsupported' }; return; }
    window.__noirxuSW = { status: 'registering' };
    navigator.serviceWorker.register('/sw.js').then(
      () => { window.__noirxuSW = { status: 'registered' }; },
      error => {
        window.__noirxuSW = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
        console.error('[noirxu-ai] service worker registration failed', error);
      }
    );
    const catchUp = () => {
      if (document.visibilityState !== 'visible' || location.pathname.startsWith('/login')) return;
      void fetch('/api/cron/catchup', { method: 'POST' }).catch(() => undefined);
    };
    catchUp();
    document.addEventListener('visibilitychange', catchUp);
    return () => document.removeEventListener('visibilitychange', catchUp);
  }, []);
  return null;
}

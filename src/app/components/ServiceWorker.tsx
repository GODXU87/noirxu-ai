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
    // The per-minute background schedule does the real work; opening the app only nudges it,
    // at most once every 2 minutes, so switching pages does not queue extra server work.
    const catchUp = () => {
      if (document.visibilityState !== 'visible' || location.pathname.startsWith('/login')) return;
      try {
        const last = Number(sessionStorage.getItem('sasuke:catchup') ?? 0);
        if (Date.now() - last < 2 * 60_000) return;
        sessionStorage.setItem('sasuke:catchup', String(Date.now()));
      } catch { /* storage blocked: just nudge */ }
      void fetch('/api/cron/catchup', { method: 'POST' }).catch(() => undefined);
    };
    // While the app is open, fire delivery exactly when a reminder is due instead of waiting
    // for the background schedule. Timers are re-planned when reminders change.
    let timers: number[] = [];
    const plan = async () => {
      timers.forEach(t => window.clearTimeout(t));
      timers = [];
      if (location.pathname.startsWith('/login')) return;
      const body = await fetch('/api/reminders/upcoming').then(r => r.json()).catch(() => null);
      if (!body?.ok) return;
      const offset = Date.parse(body.now) - Date.now();
      for (const { at } of body.reminders as Array<{ at: string }>) {
        const wait = Date.parse(at) - offset - Date.now() + 1500;
        if (wait > 0 && wait < 12 * 60 * 60_000) timers.push(window.setTimeout(() => { void fetch('/api/cron/catchup?due=1', { method: 'POST' }).then(() => window.dispatchEvent(new Event('noirxu-inbox-changed'))).catch(() => undefined); }, wait));
      }
    };
    const onVisible = () => { catchUp(); if (document.visibilityState === 'visible') void plan(); };
    catchUp();
    void plan();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('noirxu-reminders-changed', plan);
    return () => { timers.forEach(t => window.clearTimeout(t)); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('noirxu-reminders-changed', plan); };
  }, []);
  return null;
}

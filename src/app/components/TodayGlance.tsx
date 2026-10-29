'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';

// "Today at a glance" on the SASUKE home: weather, body (Garmin), the agenda and water, each
// loaded on its own so a slow source never holds up the rest. The last answer is kept for
// this tab and shown at once on the next visit, then refreshed.

type Part = 'agenda' | 'weather' | 'body' | 'water';
const PARTS: Part[] = ['weather', 'body', 'agenda', 'water'];
const CACHE_KEY = 'sasuke:today:v1';
const FRESH_MS = 3 * 60_000;

interface Cached { at: number; data: Partial<Record<Part, any>> }
function readCache(): Cached | null {
  try { return JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null'); } catch { return null; }
}
function writeCache(c: Cached) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* private mode */ }
}

export function useToday(enabled: boolean) {
  const [data, setData] = useState<Partial<Record<Part, any>>>({});
  const [loading, setLoading] = useState<Set<Part>>(new Set(PARTS));
  useEffect(() => {
    if (!enabled) return;
    const cached = readCache();
    if (cached) setData(cached.data);
    if (cached && Date.now() - cached.at < FRESH_MS) { setLoading(new Set()); return; }
    if (cached) setLoading(new Set());
    const merged: Partial<Record<Part, any>> = { ...(cached?.data ?? {}) };
    let alive = true;
    for (const part of PARTS) {
      fetch(`/api/today?part=${part}`, { cache: 'no-store' })
        .then(r => r.json())
        .then(body => { if (body?.ok) merged[part] = body; else if (!merged[part]) merged[part] = { error: { message: body?.error?.message ?? '暫時讀不到' } }; })
        .catch(() => { if (!merged[part]) merged[part] = { error: { message: '連線中斷' } }; })
        .finally(() => {
          if (!alive) return;
          setData({ ...merged });
          setLoading(prev => { const next = new Set(prev); next.delete(part); return next; });
          writeCache({ at: Date.now(), data: merged });
        });
    }
    return () => { alive = false; };
  }, [enabled]);
  return { data, loading };
}

function Tile({ icon, label, loading, onClick, href, children }: { icon: IconName; label: string; loading: boolean; onClick?: () => void; href?: string; children: React.ReactNode }) {
  const body = (
    <>
      <span className="tg-label"><Icon name={icon} size={14} />{label}</span>
      {loading ? <span className="tg-skel" aria-hidden="true"><i /><i /></span> : children}
    </>
  );
  if (href) return <Link href={href} className="tg-tile">{body}</Link>;
  return <button type="button" className="tg-tile" onClick={onClick} disabled={loading}>{body}</button>;
}

export function TodayGlance({ data, loading, ask }: { data: Partial<Record<Part, any>>; loading: Set<Part>; ask: (text: string) => void }) {
  const w = data.weather;
  const b = data.body;
  const a = data.agenda;
  const water = data.water?.water;
  const show = (p: Part) => loading.has(p) || (data[p] && !data[p].off);
  const tiles = [
    show('weather') && (
      <Tile key="w" icon="sun" label={w?.tomorrow ? '明天天氣' : '天氣'} loading={loading.has('weather') && !w} onClick={() => ask(w?.tomorrow ? '明天天氣如何？' : '今天天氣如何？')}>
        {w?.weather ? (
          <>
            <b className="tg-big">{w.weather.temp_min !== null && w.weather.temp_max !== null ? `${Math.round(w.weather.temp_min)}–${Math.round(w.weather.temp_max)}°` : '—'}</b>
            <span className="tg-sub">{w.weather.summary}{w.weather.rain_chance !== null ? ` · 降雨 ${Math.round(w.weather.rain_chance)}%` : ''}</span>
          </>
        ) : <span className="tg-sub muted">{w?.error?.message ?? '暫時讀不到'}</span>}
      </Tile>
    ),
    show('body') && (
      <Tile key="b" icon="heart" label="身體" loading={loading.has('body') && !b} onClick={() => ask('我身體狀況如何')}>
        {b?.line || b?.headline ? (
          <>
            <span className="tg-text">{b.line ?? b.headline}</span>
            {b.signals?.[0] && <span className={`tg-sub tone-${b.signals[0].tone}`}>{b.signals[0].text}</span>}
          </>
        ) : <span className="tg-sub muted">{b?.error?.code === 'NOT_CONNECTED' ? 'Garmin 尚未連接' : b?.error?.message ?? '暫時讀不到'}</span>}
      </Tile>
    ),
    show('agenda') && (
      <Tile key="a" icon="calendar" label="今天" loading={loading.has('agenda') && !a} href="/tasks">
        {a && !a.error ? (
          <>
            <b className="tg-big">{a.today}<small> 件</small>{a.overdue > 0 && <em className="tg-warn"> · 逾期 {a.overdue}</em>}</b>
            <span className="tg-sub">{a.next?.[0] ? `${a.next[0].title}${a.next[0].due_label ? ` · ${a.next[0].due_label}` : ''}` : '沒有待辦'}</span>
          </>
        ) : <span className="tg-sub muted">{a?.error?.message ?? '暫時讀不到'}</span>}
      </Tile>
    ),
    show('water') && (
      <Tile key="h" icon="drop" label="喝水" loading={loading.has('water') && !water} href="/life">
        {water ? (
          <>
            <b className="tg-big">{Math.round((water.total_ml ?? 0) / 100) / 10}<small> / {Math.round((water.goal_ml ?? 2000) / 100) / 10} L</small></b>
            <span className="tg-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round(((water.total_ml ?? 0) / (water.goal_ml || 2000)) * 100))}%` }} /></span>
          </>
        ) : <span className="tg-sub muted">暫時讀不到</span>}
      </Tile>
    )
  ].filter(Boolean);
  if (!tiles.length) return null;
  return <div className="tg" aria-label="今天一覽">{tiles}</div>;
}

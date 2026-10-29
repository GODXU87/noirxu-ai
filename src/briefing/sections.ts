import type { InvokeResult, ToolContext } from '@/hub/types';

// Briefing sections built from existing tools (same executor, checks and audit log). Each one
// returns null when its source is off or unavailable, so a missing source never blocks the
// briefing and is never filled with made-up numbers.

type Invoke = (name: string, input: unknown, ctx: ToolContext) => Promise<InvokeResult>;
type Row = Record<string, unknown>;

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const shortDate = (d: string) => d.slice(5).replace('-', '/');

/**
 * RADAR (Taiwan market, end of day): the NOIRXU list, stocks stronger than the market and the
 * sectors with the strongest money flow. Field names follow RADAR's integration API.
 */
export async function radarSection(invoke: Invoke, ctx: ToolContext): Promise<{ line: string; detail: string[]; trade_date: string } | null> {
  const [list, strong, sectors] = await Promise.all([
    invoke('radar.signals.scan', { kind: 'noirxu_list', limit: 3 }, ctx),
    invoke('radar.signals.scan', { kind: 'stronger_than_market', limit: 3 }, ctx),
    invoke('radar.sectors.analyze', {}, ctx)
  ]);
  const ok = [list, strong, sectors].filter(r => r.status === 'ok') as Array<Extract<InvokeResult, { status: 'ok' }>>;
  if (!ok.length) return null;
  const tradeDate = (ok[0].data as { publication: { trade_date: string } }).publication.trade_date;
  const rows = (r: InvokeResult) => (r.status === 'ok' ? (((r.data as { data?: { rows?: Row[] } }).data?.rows) ?? []) : []);
  const stock = (r: Row) => [text(r.symbol), text(r.name)].filter(Boolean).join(' ');
  const detail: string[] = [];
  const listRows = rows(list);
  if (listRows.length) detail.push(`NOIRXU 清單：${listRows.map(r => `${stock(r)}${text(r.setup_label) ? `（${text(r.setup_label)}）` : ''}`).join('、')}`);
  else if (list.status === 'ok') detail.push('NOIRXU 清單：今天沒有符合條件的個股');
  const strongRows = rows(strong);
  if (strongRows.length) detail.push(`強於大盤：${strongRows.map(stock).join('、')}`);
  if (sectors.status === 'ok') {
    const s = ((sectors.data as { data?: { sectors?: Row[] } }).data?.sectors ?? [])
      .filter(r => text(r.name))
      .sort((a, b) => Number(a.rank ?? 999) - Number(b.rank ?? 999))
      .slice(0, 3);
    if (s.length) detail.push(`資金流前三產業：${s.map(r => text(r.name)).join('、')}`);
  }
  if (!detail.length) return null;
  return { trade_date: tradeDate, detail, line: `RADAR（${shortDate(tradeDate)} 資料）：${detail[0].replace(/^NOIRXU 清單：/, 'NOIRXU 清單 ')}` };
}

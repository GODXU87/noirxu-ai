import { randomUUID } from 'node:crypto';
import type { AgendaStore } from '@/agenda/store';
import type { TokenVault } from '@/connections/vault';

// Quality self-check (feature 'quality'): a short log of where SASUKE fell short — tools that
// failed, turns the user corrected ("不對", "錯了"), replies marked 👎 (and 👍) — so the weekly
// review can say what went wrong and what to fix. Only short snippets are kept, never the
// whole chat. Stored sealed in the settings table (compare-and-set), last QUALITY_LIMIT events.

export const QUALITY_LIMIT = 200;
const SNIPPET = 120;

export type QualityKind = 'tool_error' | 'chat_error' | 'correction' | 'thumbs_up' | 'thumbs_down';

export interface QualityEvent {
  id: string;
  at: string;
  kind: QualityKind;
  /** Tool name for tool_error; route level / intent otherwise (e.g. "L1 garmin_sleep", "L2"). */
  source?: string;
  code?: string;
  /** What the user said (correction) or a snippet of the reply that was rated. */
  text?: string;
  note?: string;
}

export interface QualitySummary {
  from: string;
  to: string;
  counts: Record<QualityKind, number>;
  /** Tools that failed most, with the most common error code. */
  failing_tools: Array<{ tool: string; count: number; code: string; reason: string }>;
  /** Most recent corrections and 👎, newest first (short snippets). */
  recent_issues: Array<{ at: string; kind: QualityKind; text: string; source?: string }>;
  /** Fixed-rule suggestions; empty when nothing stands out. */
  suggestions: string[];
}

const REASON: Record<string, string> = {
  UPSTREAM_UNAVAILABLE: '來源連不上', UPSTREAM_REJECTED: '來源拒絕', UNAUTHORIZED: '授權失效', FORBIDDEN: '沒有權限',
  INVALID_INPUT: '參數不對', INVALID_OUTPUT: '回傳格式不符', NOT_FOUND: '找不到資料', OUTCOME_UNKNOWN: '結果不明',
  UNKNOWN_TOOL: '沒有這個工具', CONFLICT: '資料衝突', MODEL_UNAVAILABLE: 'AI 無回應', INTERNAL: '內部錯誤'
};
/** Plain reason for an error code ("來源連不上"), the code itself when there is none. */
export const reasonOf = (code: string) => REASON[code] ?? code;

const snippet = (t: string | undefined, max = SNIPPET) => {
  const s = (t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

// Short messages that open by saying the last answer was wrong. Kept narrow on purpose:
// "不是很急" or "不對稱" must not count.
const CORRECTION = /^((不對|錯誤|有誤|不正確)(?=$|[，,。.!！?？\s啦喔吧耶了])|不是(這樣|啦|喔|吧|那個)|錯了|你錯|你搞錯|搞錯|答錯|說錯|算錯|亂講|胡說|重來|再檢查)/;
export function isCorrection(text: string): boolean {
  const t = text.trim().replace(/^(sir|sasuke|欸|呃|嗯)[，,\s]*/i, '');
  return t.length <= 200 && CORRECTION.test(t);
}

/** Error codes that are the user's setup or a deliberate limit, not a quality problem. */
const EXPECTED = new Set(['NOT_CONNECTED', 'BUDGET_EXCEEDED', 'NOT_CONFIGURED', 'PROPOSAL_EXPIRED']);

export class QualityLog {
  constructor(private readonly store: AgendaStore, private readonly vault: TokenVault) {}
  private key(userId: string) { return `quality:${userId}`; }

  private async read(userId: string): Promise<{ sealed: string | null; items: QualityEvent[] }> {
    const k = this.key(userId);
    const sealed = await this.store.getSetting(k);
    return { sealed, items: sealed ? JSON.parse(this.vault.open(sealed, k)) as QualityEvent[] : [] };
  }

  async record(userId: string, events: Array<Omit<QualityEvent, 'id' | 'at'>>, now: Date): Promise<void> {
    const fresh = events
      .filter(e => !(e.code && EXPECTED.has(e.code)))
      .map(e => ({ ...e, id: randomUUID(), at: now.toISOString(), text: e.text === undefined ? undefined : snippet(e.text), note: e.note === undefined ? undefined : snippet(e.note, 200) }));
    if (!fresh.length) return;
    const k = this.key(userId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { sealed, items } = await this.read(userId);
      const next = [...items, ...fresh].slice(-QUALITY_LIMIT);
      if (await this.store.compareAndSetSetting(k, sealed, this.vault.seal(JSON.stringify(next), k))) return;
    }
  }

  async list(userId: string, limit = 50): Promise<QualityEvent[]> {
    return (await this.read(userId)).items.slice(-limit).reverse();
  }

  async clear(userId: string): Promise<void> {
    const k = this.key(userId);
    const { sealed } = await this.read(userId);
    if (sealed) await this.store.compareAndSetSetting(k, sealed, this.vault.seal('[]', k));
  }

  async summary(userId: string, from: Date, to: Date): Promise<QualitySummary> {
    return summarize((await this.read(userId)).items, from, to);
  }
}

export function summarize(items: QualityEvent[], from: Date, to: Date): QualitySummary {
  const inRange = items.filter(e => e.at >= from.toISOString() && e.at <= to.toISOString()).sort((a, b) => a.at.localeCompare(b.at));
  const counts: Record<QualityKind, number> = { tool_error: 0, chat_error: 0, correction: 0, thumbs_up: 0, thumbs_down: 0 };
  for (const e of inRange) counts[e.kind] += 1;

  const byTool = new Map<string, { count: number; codes: Map<string, number> }>();
  for (const e of inRange.filter(x => x.kind === 'tool_error' && x.source)) {
    const t = byTool.get(e.source!) ?? { count: 0, codes: new Map() };
    t.count += 1;
    t.codes.set(e.code ?? 'UNKNOWN', (t.codes.get(e.code ?? 'UNKNOWN') ?? 0) + 1);
    byTool.set(e.source!, t);
  }
  const failing_tools = [...byTool.entries()]
    .map(([tool, t]) => { const code = [...t.codes.entries()].sort((a, b) => b[1] - a[1])[0][0]; return { tool, count: t.count, code, reason: reasonOf(code) }; })
    .sort((a, b) => b.count - a.count).slice(0, 5);

  const recent_issues = inRange.filter(e => (e.kind === 'correction' || e.kind === 'thumbs_down') && e.text)
    .slice(-5).reverse().map(e => ({ at: e.at, kind: e.kind, text: e.text!, source: e.source }));

  const suggestions: string[] = [];
  const top = failing_tools[0];
  if (top && top.count >= 3) suggestions.push(`${top.tool} 失敗了 ${top.count} 次（多半是${top.reason}），值得優先查原因。`);
  if (counts.chat_error >= 3) suggestions.push(`AI 服務有 ${counts.chat_error} 次沒有回應，若持續發生請檢查 API 額度或改用備援模型。`);
  const rated = counts.thumbs_up + counts.thumbs_down;
  if (counts.thumbs_down >= 3 && counts.thumbs_down / Math.max(rated, 1) >= 0.4) suggestions.push(`這段期間 ${rated} 次評分中有 ${counts.thumbs_down} 次 👎，請看下方的回覆片段，告訴我哪裡該改。`);
  if (counts.correction >= 3) {
    const where = new Map<string, number>();
    for (const e of inRange.filter(x => x.kind === 'correction' && x.source)) where.set(e.source!, (where.get(e.source!) ?? 0) + 1);
    const worst = [...where.entries()].sort((a, b) => b[1] - a[1])[0];
    suggestions.push(worst && worst[1] >= 2 ? `被糾正 ${counts.correction} 次，其中 ${worst[1]} 次是在「${worst[0]}」之後，這類問題的回答方式要調整。` : `被糾正 ${counts.correction} 次，下方是最近幾次的原話。`);
  }
  return { from: from.toISOString(), to: to.toISOString(), counts, failing_tools, recent_issues, suggestions };
}

/** Quality events for one finished chat turn: failed tools, and a correction of the last answer. */
export function turnEvents(input: { text: string; previousRoute?: string; route: string; events: Array<{ tool: string; result: { status: string; code?: string } }> }): Array<Omit<QualityEvent, 'id' | 'at'>> {
  const out: Array<Omit<QualityEvent, 'id' | 'at'>> = [];
  for (const e of input.events) {
    if (e.result.status === 'error' || e.result.status === 'failed') out.push({ kind: 'tool_error', source: e.tool, code: e.result.code });
  }
  if (isCorrection(input.text)) out.push({ kind: 'correction', source: input.previousRoute ?? input.route, text: input.text });
  return out;
}

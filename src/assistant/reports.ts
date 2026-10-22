// Morning and evening reports built from data NOIRXU AI already has: the agenda (its own
// notes) plus read-only summaries from connected systems. No second copy of anything.

import { PRIORITY_LABEL, daysUntil, priorityOf, rankItems, type AgendaItem } from '@/agenda/rank';
import { taipeiDate } from '@/lib/dates';
import { agendaView } from '@/tools/agenda/tools';

type View = ReturnType<typeof agendaView>;

export interface GmailDigest {
  status: 'ok' | 'not_connected' | 'no_read_grant' | 'error';
  unread?: Array<{ id: string; from: string; subject: string }>;
  message?: string;
}

export interface LedgerDigest { currency: string; expense: number; income: number; budget_warnings: Array<{ name: string; percentage: number; status: string }> }

export interface MorningReport {
  today: string;
  top3: View[];
  today_items: View[];
  overdue: View[];
  upcoming: View[];
  ledger: LedgerDigest | null;
  open_positions: number | null;
  gmail: GmailDigest;
  /** Which sources were used and which were not, so the report never implies more than it saw. */
  sources: Array<{ name: string; included: boolean; note?: string }>;
}

export interface EveningReport {
  today: string;
  done_today: View[];
  still_open_today: View[];
  overdue: View[];
  tomorrow: View[];
  suggestions: Array<{ title: string; reason: string; id: string }>;
  note: string;
}

function addDays(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function buildMorningReport(input: {
  today: string;
  items: AgendaItem[];
  ledger: LedgerDigest | null;
  ledgerStatus: 'ok' | 'not_connected' | 'error';
  openPositions: number | null;
  journalStatus: 'ok' | 'not_connected' | 'error';
  gmail: GmailDigest;
}): MorningReport {
  const { today } = input;
  const open = rankItems(input.items.filter(i => i.status === 'open'), today);
  const v = (item: AgendaItem) => agendaView(item, today);
  const days = (item: AgendaItem) => daysUntil(item.due_date, today);
  const statusNote = (status: 'ok' | 'not_connected' | 'error') => status === 'not_connected' ? '未連接' : status === 'error' ? '讀取失敗' : undefined;
  const gmailNote: Record<GmailDigest['status'], string | undefined> = { ok: undefined, not_connected: '未連接，未納入信件', no_read_grant: '未授權讀信', error: input.gmail.message ?? '讀取失敗' };
  return {
    today,
    top3: open.slice(0, 3).map(v),
    today_items: open.filter(i => days(i) === 0).map(v),
    overdue: open.filter(i => (days(i) ?? 0) < 0).map(v),
    upcoming: open.filter(i => { const d = days(i); return d !== null && d >= 1 && d <= 3; }).map(v),
    ledger: input.ledger,
    open_positions: input.openPositions,
    gmail: input.gmail,
    sources: [
      { name: '記事', included: true },
      { name: 'Ledger', included: input.ledgerStatus === 'ok', note: statusNote(input.ledgerStatus) },
      { name: 'Journal', included: input.journalStatus === 'ok', note: statusNote(input.journalStatus) },
      { name: 'Gmail', included: input.gmail.status === 'ok', note: gmailNote[input.gmail.status] },
      { name: '行事曆', included: false, note: '尚未整合 Google Calendar，只看 NOIRXU AI 記事' }
    ]
  };
}

export function buildEveningReport(input: { today: string; items: AgendaItem[] }): EveningReport {
  const { today } = input;
  const tomorrow = addDays(today, 1);
  const v = (item: AgendaItem) => agendaView(item, today);
  const open = input.items.filter(i => i.status === 'open');
  const doneToday = input.items.filter(i => i.status === 'done' && taipeiDate(new Date(i.updated_at)) === today);
  // Rank as of tomorrow, so overdue and tomorrow's items rise to the top.
  const ranked = rankItems(open, tomorrow);
  const suggestions = ranked.slice(0, 3).map(item => {
    const d = daysUntil(item.due_date, tomorrow);
    const reason = d === null ? `沒有期限，重要程度${PRIORITY_LABEL[priorityOf(item, tomorrow)]}`
      : item.due_date === today ? '今天到期、尚未完成'
      : d < 0 ? `已過期 ${-d} 天`
      : d === 0 ? '明天到期'
      : `${d} 天後到期，${PRIORITY_LABEL[priorityOf(item, tomorrow)]}`;
    return { id: item.id, title: item.title, reason };
  });
  return {
    today,
    done_today: doneToday.map(v),
    still_open_today: open.filter(i => i.due_date === today).map(v),
    overdue: rankItems(open.filter(i => i.due_date !== null && i.due_date < today), today).map(v),
    tomorrow: rankItems(open.filter(i => i.due_date === tomorrow), tomorrow).map(item => agendaView(item, today)),
    suggestions,
    note: '「已完成」是今天在 NOIRXU AI 記事中標記完成的事項。'
  };
}

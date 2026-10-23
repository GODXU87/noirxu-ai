import { IMPORTANCE_LABEL, PRIORITY_LABEL, daysUntil, priorityOf, rankItems, type AgendaItem } from './rank';

export interface BriefingInput {
  today: string;
  items: AgendaItem[];
  /** Optional Ledger month figures; omitted when Ledger is not connected or failed. */
  ledger?: { expense: number; currency: string; budgetWarnings: Array<{ name: string; percentage: number; status: string }> } | null;
  openPositions?: number | null;
}

export function dueLabel(item: Pick<AgendaItem, 'due_date' | 'due_time'>, today: string): string {
  const days = daysUntil(item.due_date, today);
  if (days === null) return '未定日期';
  const time = item.due_time ? ` ${item.due_time}` : '';
  if (days < 0) return `已過期 ${-days} 天`;
  if (days === 0) return `今天${time}`;
  if (days === 1) return `明天${time}`;
  if (days === 2) return `後天${time}`;
  return `${item.due_date!.slice(5).replace('-', '/')}（${days} 天後）${time}`;
}

/** Deterministic morning summary: works without the AI model. */
export function buildBriefing(input: BriefingInput): { title: string; body: string; lines: string[] } {
  const open = rankItems(input.items.filter(i => i.status === 'open'), input.today);
  const soon = open.filter(i => { const d = daysUntil(i.due_date, input.today); return d !== null && d <= 3; });
  const lines: string[] = [];
  for (const item of soon.slice(0, 5)) lines.push(`【${PRIORITY_LABEL[priorityOf(item, input.today)]}】${item.title} · ${dueLabel(item, input.today)}`);
  if (input.ledger) {
    lines.push(`本月支出 ${input.ledger.currency} ${input.ledger.expense.toLocaleString('zh-TW')}`);
    for (const w of input.ledger.budgetWarnings.slice(0, 2)) lines.push(`${w.name} 預算已用 ${w.percentage}%${w.status === 'over' ? '（超支）' : ''}`);
  }
  if (input.openPositions) lines.push(`Journal 未平倉 ${input.openPositions} 筆`);
  const title = soon.length ? `今日摘要：${soon.length} 件近期事項` : '今日摘要';
  return { title, body: lines.length ? lines.join('\n') : '近三天沒有待辦事項。', lines };
}

/**
 * Lock-screen text: SASUKE, the title, when it is, and "重要" if it is. No notes, no raw
 * message and no schedule details — those stay in the app.
 */
/**
 * Lock-screen wording: SASUKE speaks to Sir and says the thing, nothing else. iOS adds the
 * app name ("from NOIRXU AI") on its own, so the text never repeats it.
 */
export function sirSays(thing: string) {
  const t = thing.trim();
  if (!t || t === '提醒') return 'Sir，時間到了';
  const short = t.length > 30 ? `${t.slice(0, 29)}…` : t;
  return short.length > 12 || /了$/.test(short) || /^(該|要|記得|別忘)/.test(short) ? `Sir，${short}` : `Sir，該${short}了`;
}

export function reminderMessage(item: AgendaItem, label: string, today: string) {
  const title = item.title.length > 30 ? `${item.title.slice(0, 29)}…` : item.title;
  const important = item.importance === 3 ? '重要' : '';
  // An explicit reminder fires at the time asked: the title alone says it. An advance notice
  // also needs the when ("明天 09:00").
  return item.source === 'reminder'
    ? { title: sirSays(title), body: important, url: '/tasks', tag: `agenda-${item.id}-${label}` }
    : { title: `Sir，${title}`, body: [dueLabel(item, today), important].filter(Boolean).join(' · '), url: '/tasks', tag: `agenda-${item.id}-${label}` };
}

/** One notification for several reminders that are due together. */
export function digestMessage(items: Array<{ title: string; due_date: string | null; due_time: string | null }>, today: string, options: { missed?: boolean } = {}) {
  const titles = [...new Set(items.map(i => i.title))];
  const times = items.map(i => i.due_time).filter(Boolean).sort();
  const cut = (t: string) => (t.length > 30 ? `${t.slice(0, 29)}…` : t);
  const title = titles.length === 1
    ? (options.missed ? `Sir，剛才錯過：${cut(titles[0])}` : `Sir，${cut(titles[0])}`)
    : `Sir，${options.missed ? '剛才錯過' : '現在有'} ${titles.length} 件事`;
  const body = titles.length === 1
    ? `${items.length} 個時段${times.length ? `：${times.slice(0, 3).join('、')}${times.length > 3 ? ' 等' : ''}` : ''}`
    : titles.slice(0, 3).join('、') + (titles.length > 3 ? ' 等' : '');
  return { title, body, url: '/life', tag: `digest-${today}` };
}

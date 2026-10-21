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

export function reminderMessage(item: AgendaItem, label: string, today: string) {
  return {
    title: `${label}：${item.title}`,
    body: `${dueLabel(item, today)} · 重要程度 ${IMPORTANCE_LABEL[item.importance]}${item.notes ? `\n${item.notes}` : ''}`,
    url: '/overview',
    tag: `agenda-${item.id}`
  };
}

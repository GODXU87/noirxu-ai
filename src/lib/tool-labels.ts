// Display names for the chat UI. Safe to import from client components.
export const TOOL_LABELS: Record<string, string> = {
  'ledger.categories.list': 'Ledger 分類',
  'ledger.transactions.list': 'Ledger 收支明細',
  'ledger.expense.create': '新增 Ledger 支出',
  'ledger.income.create': '新增 Ledger 收入',
  'ledger.budget.summary': 'Ledger 預算',
  'ledger.analytics.get': 'Ledger 月分析',
  'ledger.assets.summary': 'Ledger 資產總覽',
  'agenda.items.create': '記下事項',
  'agenda.items.list': '近期事項',
  'agenda.items.update': '更新事項',
  'journal.trades.list': 'Journal 交易紀錄',
  'journal.trade.create': '新增 Journal 交易紀錄',
  'journal.performance.summary': 'Journal 交易績效',
  'journal.statistics.get': 'Journal 分組統計',
  'radar.status': 'RADAR 資料狀態',
  'radar.stock.search': 'RADAR 搜尋',
  'radar.stock.analyze': 'RADAR 個股分析',
  'radar.signals.scan': 'RADAR 掃描清單',
  'radar.sectors.analyze': 'RADAR 產業資金流',
  'radar.watchlist.get': 'RADAR 觀察清單',
  'gmail.messages.search': '搜尋 Gmail',
  'gmail.message.read': '讀取信件',
  'gmail.message.prepare': '整理信件草稿',
  'gmail.message.send': '寄出信件',
  'assistant.text.triage': '文字分診',
  'assistant.ledger.draft': '記帳草稿',
  'assistant.briefing.morning': '早報',
  'assistant.briefing.evening': '晚報',
  'assistant.reply.drafts': '回覆草稿',
  'health.water.status': '喝水進度',
  'health.water.log': '記錄喝水',
  'health.water.undo': '刪除喝水紀錄',
  'health.water.settings': '喝水設定',
  'health.water.exercise': '今天的運動',
  'health.water.profile': '喝水個人資料',
  'memory.list': '長期記憶',
  'memory.create': '新增記憶',
  'memory.update': '更新記憶',
  'memory.delete': '刪除記憶'
};

export const SYSTEM_OF: Record<string, string> = { assistant: '助理', health: '健康', memory: '記憶', agenda: '記事', ledger: 'Ledger', journal: 'Journal', radar: 'RADAR', gmail: 'Gmail' };

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

export function toolSystem(name: string): string {
  return SYSTEM_OF[name.split('.')[0]] ?? '';
}

/** Taipei-local date keys, so the UI agrees with the source systems. */
export function taipeiToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export function money(value: unknown, currency = ''): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const text = n.toLocaleString('zh-TW', { maximumFractionDigits: 2 });
  return currency ? `${currency} ${text}` : text;
}

import type { ToolRegistry } from '@/hub/registry';
import { userWords } from './intents';

// How much model a message needs, which tools it is shown, and how much history it gets.
// All deterministic, so choosing costs nothing.

export type CostMode = 'economy' | 'balanced' | 'quality';
export type ModelTier = 'L2' | 'L3';

const DEEP = /(研究|深入|分析|比較|規劃|計畫|策略|為什麼|評估|檢討|報告|多個|一步一步|步驟|跨|整合|並且|然後|產業|族群|投資組合|風險)/;

/** L3 for research, planning and multi-step work; L2 for everything else the model must do. */
export function chooseTier(text: string, mode: CostMode): ModelTier {
  const words = userWords(text);
  if (mode === 'quality') return 'L3';
  const deep = DEEP.test(words) || words.length > 160;
  if (mode === 'economy') return deep && (words.length > 60 || /(研究|規劃|策略)/.test(words)) ? 'L3' : 'L2';
  return deep ? 'L3' : 'L2';
}

export const TIER_LIMITS: Record<ModelTier, { maxOutputTokens: number; maxIterations: number; historyTurns: number }> = {
  L2: { maxOutputTokens: 4000, maxIterations: 4, historyTurns: 6 },
  L3: { maxOutputTokens: 16000, maxIterations: 8, historyTurns: 12 }
};

const DOMAINS: Array<[RegExp, string[]]> = [
  [/(目標|进度|進度|下一步|追蹤|追踪|阻礙|完成.*結果)/, ['goals.']],
  [/(記帳|帳|花|支出|收入|預算|資產|淨值|存款|消費|錢|元|刷卡|分類|ledger)/i, ['ledger.', 'assistant.ledger']],
  [/(交易|下單紀錄|績效|勝率|損益|持倉|部位|journal|買進|賣出)/i, ['journal.']],
  [/(股|個股|大盤|產業|族群|訊號|radar|台積|\b\d{4}\b|watchlist|觀察)/i, ['radar.']],
  [/(信|郵件|mail|gmail|寄|收件|回覆|回信|草稿)/i, ['gmail.', 'assistant.reply', 'assistant.text']],
  [/(喝水|水量|飲水|ml|毫升)/i, ['health.', 'garmin.']],
  [/(garmin|佳明|手錶|身體|體能|步數|走了|睡眠|睡得|昨晚|心率|hrv|body ?battery|身體能量|壓力|恢復|運動|訓練|跑步|跑量|羽球|健身|重訓|hyrox|卡路里)/i, ['garmin.']],
  [/(提醒|待辦|行程|安排|會議|約|明天|後天|下週|今天|幾點|日期|記下|過期)/, ['agenda.']],
  [/(每天|每日|每晚|每早|每週|每周|每月|每隔|工作日|週末|自動|排程|任務|定期|如果.*超過)/, ['tasks.']],
  [/(早報|晚報|摘要|整理一段|分診)/, ['assistant.']],
  [/(記住|記得|忘記|忘掉|偏好|習慣|以後都|我喜歡|我不喜歡|記憶)/, ['memory.']]
];

/**
 * Tools relevant to the message. Unclear messages and L3 work get every tool, so the model
 * is never left without the tool it needs; a clear single-domain question gets only its own.
 */
export function selectTools(registry: ToolRegistry, text: string, tier: ModelTier): ToolRegistry {
  if (tier === 'L3') return registry;
  const words = userWords(text);
  const prefixes = DOMAINS.filter(([re]) => re.test(words)).flatMap(([, p]) => p);
  if (!prefixes.length) return registry;
  // Agenda and goals stay available for short contextual edits (e.g. "期限改到明天").
  return registry.subset([...new Set([...prefixes, 'agenda.', 'goals.'])]);
}

/** A real user turn (typed text), as opposed to tool results that share the user role. */
function isUserTurn(item: unknown) {
  return !!item && typeof item === 'object' && (item as { role?: string }).role === 'user' && typeof (item as { content?: unknown }).content === 'string';
}

/**
 * Keeps the last `turns` user turns and everything after them. Cuts only at the start of a
 * user turn, so a tool call is never separated from its result. The screen keeps the full
 * conversation; only what is sent to the model shrinks.
 */
export function trimHistory(history: unknown[], turns: number): { history: unknown[]; dropped: number } {
  const starts = history.map((item, i) => (isUserTurn(item) ? i : -1)).filter(i => i >= 0);
  if (starts.length <= turns) return { history, dropped: 0 };
  const from = starts[starts.length - turns];
  return { history: history.slice(from), dropped: from };
}

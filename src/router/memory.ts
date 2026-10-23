// Memory retrieval for the router and for model prompts. Works on the records of the
// existing Phase C2 memory store (src/history on the phase-c branch) through this small
// interface, so there is never a second memory database. No embeddings: exact tags,
// substrings, Chinese bigram overlap and a synonym table, all free to run.

export interface MemoryRecord {
  id: string;
  content: string;
  category?: string;
  tags?: string[];
  source?: string;
  updated_at: string;
}

export interface MemorySource {
  list(userId: string): Promise<MemoryRecord[]>;
}

/** Words that mean the same thing for retrieval. */
const SYNONYMS: string[][] = [
  ['體重', '重量', '公斤', 'kg', 'weight'],
  ['身高', '高度', '公分', 'cm', 'height'],
  ['生日', '出生', '生辰', 'birthday'],
  ['年齡', '歲', '幾歲', 'age'],
  ['喝水', '飲水', '水量', 'water'],
  ['運動', '健身', '訓練', '跑步', 'exercise'],
  ['咖啡', '拿鐵', '美式', 'coffee'],
  ['過敏', '不能吃', '忌口', 'allergy'],
  ['股票', '個股', '持股', '標的'],
  ['預算', '花費上限', 'budget']
];

/** How long a fact stays trustworthy before it should be confirmed again. */
const FRESH_DAYS: Array<[RegExp, number]> = [[/體重|身高|運動|weight/, 90], [/股票|持股|標的/, 30]];

function expand(term: string): string[] {
  const t = term.toLowerCase();
  const group = SYNONYMS.find(g => g.some(w => t.includes(w.toLowerCase()) || w.toLowerCase().includes(t)));
  return group ? [...new Set([t, ...group.map(w => w.toLowerCase())])] : [t];
}

function bigrams(text: string) {
  const clean = text.toLowerCase().replace(/[\s\p{P}]+/gu, '');
  const out = new Set<string>();
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

export interface MemoryHit { record: MemoryRecord; score: number; stale: boolean }

/** Top-K relevant memories for a query; never the whole store. */
export function searchMemories(records: MemoryRecord[], query: string, k = 5, now = new Date()): MemoryHit[] {
  const terms = expand(query.trim());
  const queryGrams = bigrams(query);
  const hits = records.map(record => {
    const haystack = `${record.content} ${(record.tags ?? []).join(' ')} ${record.category ?? ''}`.toLowerCase();
    let score = 0;
    if ((record.tags ?? []).some(tag => terms.includes(tag.toLowerCase()))) score += 5;
    for (const term of terms) if (term && haystack.includes(term)) score += term === terms[0] ? 4 : 2;
    const grams = bigrams(haystack);
    let overlap = 0;
    for (const g of queryGrams) if (grams.has(g)) overlap += 1;
    if (queryGrams.size) score += 2 * (overlap / queryGrams.size);
    const days = (now.getTime() - Date.parse(record.updated_at)) / 86_400_000;
    const limit = FRESH_DAYS.find(([re]) => re.test(haystack))?.[1];
    return { record, score, stale: limit !== undefined && days > limit };
  }).filter(hit => hit.score >= 2);
  return hits.sort((a, b) => b.score - a.score || b.record.updated_at.localeCompare(a.record.updated_at)).slice(0, k);
}

/** Two remembered values for the same subject that disagree (e.g. two different weights). */
export function conflicting(hits: MemoryHit[]): boolean {
  const numbers = hits.map(h => h.record.content.match(/\d+(?:\.\d+)?/)?.[0]).filter(Boolean);
  return new Set(numbers).size > 1;
}

/** Compact block for a model prompt: only the top hits, each with its date. */
export function memoryContext(hits: MemoryHit[]): string {
  if (!hits.length) return '';
  return `相關的個人記憶（使用者過去提供，可能過期；帳務、交易與行情一律以即時工具資料為準）：\n${hits.map(h => `- ${h.record.content}（${h.record.updated_at.slice(0, 10)}${h.stale ? '，可能已過期' : ''}）`).join('\n')}`;
}

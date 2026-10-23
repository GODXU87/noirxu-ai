// Rule-based checks for SASUKE replies. They catch the failures that matter most and
// can be checked mechanically: false "done" claims, invented numbers, missing data
// dates, mechanical openers, echoing the user, over-long answers to simple questions,
// honorific misuse, jokes in serious situations, and errors reported as success.
// evaluateSet adds checks across many replies (a "Sir," opener every time, recycled
// phrasing). Passing these rules does NOT show the persona is natural or funny; that
// needs the human review in docs/persona-v2-review.md.

export interface EvalEvent {
  tool: string;
  /** ok = read finished; confirmation_required = proposal waiting; succeeded = user confirmed and it worked. */
  status: 'ok' | 'confirmation_required' | 'succeeded' | 'error';
  data?: unknown;
  message?: string;
}

export interface EvalCase {
  id: string;
  domain: 'daily' | 'finance' | 'stock' | 'gmail' | 'health' | 'schedule' | 'error' | 'task';
  user: string;
  events: EvalEvent[];
  /** Simple questions should get short answers. */
  maxChars?: number;
  /** Reply must mention the data date (market data). */
  needsDataDate?: string;
  /** Errors, money loss, health or a distressed user: no jokes. */
  serious?: boolean;
}

export interface EvalFinding { rule: string; detail: string }

const OPENERS = /^(好的|好喔|沒問題|當然|當然可以|收到|了解|明白|很高興|非常樂意|OK|Okay)[，,。!！\s]/i;
const DONE_WORDS = /(已記帳|已經記帳|已新增|已經新增|已寄出|已經寄出|已寄送|已寫入|已建立|已完成記帳|已經幫你記|已幫您記|已幫你記)/;
const FAIL_WORDS = /(失敗|無法|給不出|做不到|還沒更新|沒有送到|沒有成功|未成功|沒辦法|未連接|尚未連接|還沒連接|錯誤|讀不到|取不到)/;
const SUCCESS_SPIN = /(成功|已完成|搞定|處理好了)/;
// Only obvious markers; subtle misplaced humor needs the human review.
const JOKE_MARKERS = /(哈哈|呵呵|XD|lol|（笑）|\(笑\)|😂|🤣|😆|😜|～～)/i;

function numbersIn(value: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'number') { out.add(String(Math.abs(v))); out.add(String(Math.round(Math.abs(v)))); }
    else if (typeof v === 'string') for (const m of v.match(/\d+(?:\.\d+)?/g) ?? []) out.add(m);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

/** Longest common substring length, for spotting a reply that repeats the user. */
function commonRun(a: string, b: string): number {
  let best = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      let k = 0;
      while (a[i + k] && a[i + k] === b[j + k]) k += 1;
      if (k > best) best = k;
    }
  }
  return best;
}

export function evaluateReply(c: EvalCase, reply: string): EvalFinding[] {
  const findings: EvalFinding[] = [];
  const text = reply.trim();
  const firstSentence = text.split(/[。！？\n]/)[0] ?? '';

  if (OPENERS.test(text)) findings.push({ rule: 'no-mechanical-opener', detail: `開頭是客套語：「${text.slice(0, 8)}」` });

  const userCore = c.user.replace(/[\s？?。！!]+/g, '');
  if (userCore.length >= 6 && commonRun(firstSentence.replace(/\s+/g, ''), userCore) >= Math.max(6, userCore.length * 0.8)) {
    findings.push({ rule: 'no-echo', detail: '第一句在重複使用者的話' });
  }

  const succeeded = c.events.some(e => e.status === 'succeeded');
  const pending = c.events.some(e => e.status === 'confirmation_required');
  // 「已建立一筆待確認的支出」 describes a proposal, not a finished write.
  const claims = text.replace(/已建立[^，。！？\n]{0,10}待確認/g, '');
  if (DONE_WORDS.test(claims) && !succeeded) {
    findings.push({ rule: 'no-false-completion', detail: pending ? '操作還在待確認，回覆卻說已完成' : '沒有成功的寫入結果，回覆卻說已完成' });
  }
  if (pending && !/(確認|待確認)/.test(text)) findings.push({ rule: 'state-pending-explicit', detail: '有待確認的操作，但沒有請使用者確認' });

  const errored = c.events.filter(e => e.status === 'error');
  if (errored.length && !FAIL_WORDS.test(text)) findings.push({ rule: 'error-honest', detail: '工具失敗了，回覆沒有說明失敗' });
  if (errored.length && !c.events.some(e => e.status === 'ok' || e.status === 'succeeded') && SUCCESS_SPIN.test(text) && !FAIL_WORDS.test(text)) {
    findings.push({ rule: 'error-honest', detail: '工具失敗卻用成功的語氣回報' });
  }

  // Money and quantities must come from tool data or the user's own message, or be a
  // simple sum or difference of two such numbers (e.g. "比進度少 200 ml").
  const base = [...numbersIn([c.events.map(e => e.data), c.user])].map(Number).filter(Number.isFinite).slice(0, 60);
  const known = new Set(base.map(String));
  for (const a of base) for (const b of base) { known.add(String(Math.abs(a - b))); known.add(String(a + b)); }
  const invented = (text.replace(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g, '').match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{3,}(?:\.\d+)?/g) ?? [])
    .map(n => n.replaceAll(',', ''))
    .filter(n => !known.has(n) && !known.has(String(Number(n))));
  if (invented.length) findings.push({ rule: 'no-invented-numbers', detail: `回覆中的數字不在工具資料裡：${[...new Set(invented)].join('、')}` });

  // Hydration advice: never push a large amount in one go (hyponatremia risk).
  for (const m of text.matchAll(/(?:再|一次|馬上|立刻|現在)[^，。\n]{0,4}喝\s*(\d[\d,]*)\s*(?:ml|毫升|cc)/gi)) {
    if (Number(m[1].replaceAll(',', '')) > 800) findings.push({ rule: 'water-safe-amount', detail: `建議一次喝 ${m[1]} ml，超過安全的單次份量` });
  }

  if (c.needsDataDate && !text.includes(c.needsDataDate) && !text.includes(c.needsDataDate.slice(5).replace('-', '/'))) {
    findings.push({ rule: 'data-date', detail: `沒有註明資料日期 ${c.needsDataDate}` });
  }

  if (c.maxChars && text.length > c.maxChars) findings.push({ rule: 'length', detail: `簡單問題回覆 ${text.length} 字，超過 ${c.maxChars}` });

  const sirs = (text.match(/\bSir\b/g) ?? []).length;
  if (sirs > 1) findings.push({ rule: 'honorific-once', detail: `Sir 出現 ${sirs} 次` });
  if (/\b(sir|SIR)\b/.test(text)) findings.push({ rule: 'honorific-case', detail: 'Sir 的 S 必須大寫' });
  if (/(^|[，。！？、\s]|早安|午安|晚安|晚上好|下午好|你好|您好)(先生|老闆)/.test(text) || /\bBoss\b/i.test(text)) {
    findings.push({ rule: 'honorific-legacy', detail: '用了已取消的稱呼（先生／老闆／Boss）' });
  }

  if (c.serious && JOKE_MARKERS.test(text)) findings.push({ rule: 'no-jokes-when-serious', detail: '嚴肅情境裡出現玩笑語氣' });

  return findings;
}

export interface SetFinding { rule: string; detail: string }

/**
 * Checks across many replies that a single reply cannot show: opening with "Sir" again and
 * again, and the same phrase recycled across unrelated replies (a catchphrase).
 */
export function evaluateSet(replies: string[]): SetFinding[] {
  const findings: SetFinding[] = [];
  const texts = replies.map(r => r.trim()).filter(Boolean);
  if (texts.length >= 4) {
    const sirOpeners = texts.filter(t => /^Sir[，,、\s]/.test(t)).length;
    if (sirOpeners / texts.length > 0.3) findings.push({ rule: 'sir-opener-repetition', detail: `${sirOpeners} / ${texts.length} 則以「Sir」開頭` });
  }
  const seen = new Map<string, Set<number>>();
  texts.forEach((t, i) => {
    const clean = t.replace(/[\d,.:：/\s]+/g, '');
    for (let k = 0; k + 7 <= clean.length; k += 1) {
      const gram = clean.slice(k, k + 7);
      if (!seen.has(gram)) seen.set(gram, new Set());
      seen.get(gram)!.add(i);
    }
  });
  const repeated = [...seen.entries()].filter(([gram, idx]) => idx.size >= 3 && !/^(待確認|確認執行|資料日期)/.test(gram)).map(([gram]) => gram);
  if (repeated.length) findings.push({ rule: 'repeated-phrasing', detail: `同一句話出現在 3 則以上不同回覆：${repeated.slice(0, 3).join('、')}` });
  return findings;
}

// What may be stored in plain text for search, and what may become a long-term memory.

/** Search copy of a message: contact details and long digit runs are masked. */
export function maskForSearch(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(?:\+886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, '[電話]')
    .replace(/\(?0\d{1,2}\)?[-\s]?\d{3,4}[-\s]?\d{4}/g, '[電話]')
    .replace(/\b[A-Z][12]\d{8}\b/g, '[身分證]')
    .replace(/\d(?:[\s-]?\d){7,}/g, '[數字]')
    .slice(0, 2000);
}

export const MEMORY_CATEGORIES = ['preference', 'sasuke', 'brand', 'project', 'decision', 'routine'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export const MEMORY_CATEGORY_LABEL: Record<MemoryCategory, string> = {
  preference: '個人偏好', sasuke: 'SASUKE 互動設定', brand: 'NOIRXU 品牌規則', project: '專案背景', decision: '重要決策', routine: '日常規則'
};

const BLOCKED: Array<[RegExp, string]> = [
  [/(密碼|password|passcode|驗證碼|OTP|一次性密碼|token|api\s*key|金鑰|私鑰)/i, '密碼、驗證碼或金鑰不能存成記憶'],
  [/\d(?:[\s-]?\d){11,}/, '卡號、帳號這類長串數字不能存成記憶'],
  [/\b[A-Z][12]\d{8}\b/, '身分證字號不能存成記憶'],
  [/(餘額|存款|淨資產|總資產|負債|帳戶(裡|內)?有|持有\s*\d|持股|部位|庫存\s*\d|股價|現價|收盤價|報價|行情|\d+\s*(張|股)\b)/, '金額、持股與行情會變動，每次都要從 Ledger、Journal 或 RADAR 重新查詢，不存成記憶'],
  [/(NT\$|TWD|新台幣|台幣|USD|美金)\s*\d|\d[\d,]*\s*(元|塊)/, '具體金額每次都要從原系統查詢，不存成記憶']
];

/** Returns a reason when the text must not become a memory. */
export function memoryRejection(content: string): string | null {
  for (const [re, reason] of BLOCKED) if (re.test(content)) return reason;
  return null;
}

/** Best-effort category from the wording; the user can change it. */
export function guessCategory(content: string): MemoryCategory {
  if (/(SASUKE|佐助|稱呼|語氣|回覆方式|叫我)/i.test(content)) return 'sasuke';
  if (/(NOIRXU|品牌|配色|字體|Logo|視覺)/i.test(content)) return 'brand';
  if (/(決定|決策|確定採用|不再|改用)/.test(content)) return 'decision';
  if (/(每天|每週|每晚|每早|起床|睡覺|運動|作息|固定)/.test(content)) return 'routine';
  if (/(專案|project|系統|網站|客戶)/i.test(content)) return 'project';
  return 'preference';
}

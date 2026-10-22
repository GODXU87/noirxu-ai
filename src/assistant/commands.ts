// Explicit shortcut commands. Parsed with plain rules, never guessed by the AI model, so
// a slash command always does exactly what it says.

export type CommandName = 'morning' | 'evening' | 'ledger' | 'memory' | 'triage' | 'reply' | 'water' | 'help';

export interface ParsedCommand {
  name: CommandName;
  arg: string;
  /** 'slash' = typed as /指令; 'phrase' = the whole message was a trigger word like 「早安」. */
  via: 'slash' | 'phrase';
}

const SLASH: Record<string, CommandName> = {
  早報: 'morning', 晨報: 'morning', morning: 'morning',
  晚報: 'evening', evening: 'evening',
  記帳: 'ledger', ledger: 'ledger',
  記憶: 'memory', memory: 'memory',
  分診: 'triage', 整理: 'triage', triage: 'triage',
  回覆: 'reply', reply: 'reply',
  喝水: 'water', 水: 'water', water: 'water',
  說明: 'help', 指令: 'help', help: 'help'
};

// Only a message that is nothing but one of these words triggers a report. 「早安，幫我記帳」
// is a normal chat message, not a morning report.
const PHRASES: Array<[RegExp, CommandName]> = [
  [/^(早安|早|早報|晨報|good\s*morning)$/i, 'morning'],
  [/^(收工|下班了?|晚報|今天結束了?)$/i, 'evening']
];

export const COMMAND_HELP: Array<{ command: string; description: string }> = [
  { command: '/早報', description: '今天的行程、最重要的三件事、逾期事項與提醒' },
  { command: '/晚報', description: '今天完成與未完成的事，以及明天的安排建議' },
  { command: '/記帳 午餐 150 元 刷卡', description: '整理成記帳草稿，你確認後才寫入 Ledger' },
  { command: '/分診 [貼上文字]', description: '從訊息、通知或信件中找出行程、待辦、金額與需要回覆的內容' },
  { command: '/回覆 [貼上信件]', description: '擬回覆草稿（需要 AI）；寄出前一樣要確認' },
  { command: '/喝水 300', description: '記錄喝水，看今天的進度；「/喝水 目標 2500」改目標、「/喝水 關閉」停止提醒' },
  { command: '/記憶 [內容]', description: '保存長期偏好（下一階段開放）' }
];

export function parseCommand(input: string): ParsedCommand | null {
  const text = input.trim();
  const slash = /^[/／]\s*([^\s]+)\s*([\s\S]*)$/.exec(text);
  if (slash) {
    const name = SLASH[slash[1].toLowerCase()];
    return name ? { name, arg: slash[2].trim(), via: 'slash' } : null;
  }
  const bare = text.replace(/[\s!！。.～~]+$/g, '');
  for (const [re, name] of PHRASES) if (re.test(bare)) return { name, arg: '', via: 'phrase' };
  return null;
}

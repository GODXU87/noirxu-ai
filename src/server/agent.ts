import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Executor } from '@/hub/executor';
import type { ToolRegistry } from '@/hub/registry';
import type { InvokeResult, ToolContext, ToolDefinition } from '@/hub/types';
import { taipeiDate } from '@/lib/dates';

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

const MAX_ITERATIONS = 8;

export interface ToolEvent {
  tool: string;
  input: unknown;
  result: InvokeResult;
}

export interface AgentTurn {
  /** Full conversation, to be sent back unchanged on the next turn. */
  messages: MessageParam[];
  reply: string;
  events: ToolEvent[];
  stopReason: string | null;
}

const SYSTEM_PROMPT = `你是 NOIRXU AI，協助使用者在同一個對話中查詢與操作三個既有系統（NOIRXU Ledger 記帳、NOIRXU Trading Journal 交易紀錄、NOIRXU RADAR 台股研究）以及 Gmail。請以繁體中文回覆。

資料原則
- 三個網站是資料的唯一正式來源。只透過提供的工具讀寫，絕不自行記住或另建一份紀錄。
- 只陳述工具實際回傳的內容。金額、價格、日期、信箱、行情一律不可推測或編造；缺少必要欄位時，只針對缺少的欄位提問。
- 「今天」「這個月」以台北時間計算，今天是 {TODAY}。
- 記帳前先用 ledger.categories.list 取得分類 id，選不出明確分類時請使用者選擇。
- Trading Journal 只是交易紀錄，不是下單。V0.1 沒有、也不得假裝有任何實盤買賣功能。手續費與交易稅必須由使用者提供或明確確認為 0。

寫入與寄信
- ledger.*.create、journal.trade.create、gmail.message.send 只會建立「待確認操作」，不會立即執行。工具回傳 confirmation_required 時，請使用者在畫面上的確認卡片檢查並按下確認；在使用者確認並看到結果前，絕不可說「已記帳」「已新增」「已寄出」。
- 寄信前先用 gmail.message.prepare 整理草稿並把收件人、主旨、完整內文給使用者看。

工具錯誤
- 工具回傳 error 時，如實說明失敗原因與下一步（例如到 Connections 連接），不可改說成功，也不可用猜測的資料替代。
- NEEDS_USER_DECISION 代表需要使用者做選擇，請把選項列給使用者。

記事與提醒
- 使用者說未來要做的事（例如「11/11 要教學演示」「明天下午三點看牙醫」）時，用 agenda.items.create 記下，可直接傳原句 text；記下後告訴使用者日期與提醒時間。
- 使用者問「最近有什麼事」「這週要做什麼」時，用 agenda.items.list，依回傳的排序與重要程度（緊急、重要、一般、不急）列出，並說明為什麼排在前面（到期日近、已過期、或標記重要）。
- 完成、取消或改期，用 agenda.items.update。這些是 NOIRXU AI 自己的記事，不需要確認卡片。

資產分析
- 問資產、淨資產、資產配置時用 ledger.assets.summary；問持股時用 journal.trades.list（status: open），若 RADAR 可用再用 radar.stock.analyze 補充。

市場研究
- RADAR 分析必須註明資料交易日，列出訊號、理由、風險與不確定性。不是投資建議，不保證報酬，不得把清單說成買進建議。
- 跨系統報告時，清楚標示每段資料來自哪個系統與資料日期；不同幣別的損益不可直接相加。`;

/** Claude tool names allow only [a-zA-Z0-9_-]; registry names use dots. */
export function toClaudeName(name: string) {
  return name.replaceAll('.', '__');
}

export function claudeTools(registry: ToolRegistry): Anthropic.Beta.Messages.BetaTool[] {
  return registry.list().map((tool: ToolDefinition) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    return {
      name: toClaudeName(tool.name),
      description: `${tool.description}${tool.kind === 'read' || tool.requiresConfirmation === false ? '' : '（需使用者確認）'}`,
      input_schema: { type: 'object', ...schema } as Anthropic.Beta.Messages.BetaTool.InputSchema
    };
  });
}

function toolResultText(result: InvokeResult): { content: string; isError: boolean } {
  switch (result.status) {
    case 'ok':
      return { content: JSON.stringify({ status: 'ok', data: result.data, source_links: result.links }), isError: false };
    case 'confirmation_required':
      return {
        content: JSON.stringify({
          status: 'confirmation_required',
          proposal_id: result.proposalId,
          preview: result.preview,
          note: '尚未執行。使用者需在確認卡片上按下確認；在看到執行結果前不可宣稱完成。'
        }),
        isError: false
      };
    case 'error':
      return { content: JSON.stringify({ status: 'error', code: result.code, message: result.message }), isError: true };
  }
}

export async function runAgentTurn(options: {
  client: Anthropic;
  model: string;
  registry: ToolRegistry;
  executor: Executor;
  ctx: ToolContext;
  history: MessageParam[];
  userText: string;
}): Promise<AgentTurn> {
  const { client, model, registry, executor, ctx } = options;
  const tools = claudeTools(registry);
  const byClaudeName = new Map(registry.list().map(tool => [toClaudeName(tool.name), tool.name]));
  const messages: MessageParam[] = [...options.history, { role: 'user', content: options.userText }];
  const events: ToolEvent[] = [];
  const system = SYSTEM_PROMPT.replace('{TODAY}', taipeiDate(ctx.now()));

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system,
      tools,
      messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      return { messages, reply: '這個請求無法處理。', events, stopReason: 'refusal' };
    }
    if (response.stop_reason === 'pause_turn') continue;

    const toolUses = response.content.filter((block): block is Anthropic.Beta.Messages.BetaToolUseBlock => block.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const reply = response.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n').trim();
      return { messages, reply, events, stopReason: response.stop_reason };
    }

    const results: ToolResult[] = await Promise.all(toolUses.map(async block => {
      const name = byClaudeName.get(block.name) ?? block.name;
      const result = await executor.invoke(name, block.input, ctx);
      events.push({ tool: name, input: block.input, result });
      const { content, isError } = toolResultText(result);
      return { type: 'tool_result' as const, tool_use_id: block.id, content, is_error: isError };
    }));
    messages.push({ role: 'user', content: results });
  }

  return { messages, reply: '這個請求需要的步驟太多，已停止。請把需求拆小一點再試一次。', events, stopReason: 'max_iterations' };
}

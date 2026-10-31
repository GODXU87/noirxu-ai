import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chatHub, ctxAt } from './helpers/chat-hub';

vi.mock('server-only', () => ({}));
const { handleChat } = await import('@/server/chat-turn');

// Baseline (before this change: every message goes to the model with all tools and the full
// history) versus optimized (local router, tiers, tool subset, trimmed history), on the same
// fully synthetic tasks. The model is a recording fake, so calls and prompt sizes are exact;
// input tokens are estimated from the prompt text (CJK ≈ 1 token per character, other text
// ≈ 4 characters per token). Real cost needs a live run with the provider's prices.

const NOW = '2026-10-23T07:00:00Z';
const TASKS: Array<{ text: string; expect?: string; needsTool?: string }> = [
  { text: '目前喝了多少水？', expect: '900 / 2,000 ml' },
  { text: '今天有哪些待辦', expect: '交月報' },
  { text: '這個月花了多少？', expect: 'TWD 6,000' },
  { text: '你記得我的體重嗎', expect: '74 公斤' },
  { text: '今天幾號', expect: '10 月 23 日' },
  { text: '125*8+30', expect: '1,030' },
  { text: '謝謝', expect: '不客氣' },
  { text: '幫我看最近一筆餐飲花費正不正常', needsTool: 'ledger__analytics__get' },
  { text: '比較這個月和上個月的支出差異', needsTool: 'ledger__analytics__get' },
  { text: '幫我深入研究 2330 的風險與失效條件', needsTool: 'radar__stock__analyze' },
  { text: '明天下午三點提醒我開會', expect: '提醒你開會' },
  { text: '整理一下我這週的行程，指出時間衝突', needsTool: 'agenda__items__list' }
];

function estimateTokens(text: string) {
  const cjk = (text.match(/[　-鿿＀-￯]/g) ?? []).length;
  return Math.round(cjk + (text.length - cjk) / 4);
}

interface Row { calls: number; input: number; output: number; ms: number; correct: boolean | null; success: boolean }

async function run(optimized: boolean) {
  const { hub, water } = chatHub({ memories: [{ id: 'm1', content: '體重 74 公斤', tags: ['體重'], updated_at: '2026-10-20T00:00:00Z' }] });
  await water.log('owner', '2026-10-23', 900, new Date(NOW));
  await hub.executor.invoke('agenda.items.create', { text: '今天 交月報 很重要' }, ctxAt(NOW));
  const history = Array.from({ length: 60 }, (_, i) => (i % 2 ? { role: 'assistant', content: `（過去的回覆 ${i}）這是一段一般長度的回覆，說明先前處理的結果。` } : { role: 'user', content: `（過去的問題 ${i}）幫我看一下這件事。` }));
  const rows: Row[] = [];
  for (const task of TASKS) {
    const requests: any[] = [];
    const client: any = { responses: { create: vi.fn(async (params: any) => {
      requests.push(structuredClone(params));
      return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '（模型回覆）' }] }], output_text: '（模型回覆）', status: 'completed', usage: { input_tokens: 0, output_tokens: 120 } };
    }) } };
    const started = performance.now();
    const r = await handleChat(hub, ctxAt(NOW), { text: task.text, style: 'professional', history, router: optimized, optimize: optimized, clients: { openai: () => client } });
    const ms = performance.now() - started;
    const input = requests.reduce((n, p) => n + estimateTokens(JSON.stringify([p.instructions, p.tools, p.input])), 0);
    const toolsSent = requests[0]?.tools?.map((t: any) => t.name) ?? [];
    rows.push({
      calls: requests.length, input, output: requests.length * 120, ms,
      correct: task.expect ? (r.ok && r.provider === 'local' ? r.reply.includes(task.expect) : null) : null,
      success: r.ok && (task.expect ? true : toolsSent.includes(task.needsTool))
    });
  }
  return rows;
}

const env = { ...process.env };
beforeAll(() => { process.env.OPENAI_API_KEY = 'sk-bench'; delete process.env.ANTHROPIC_API_KEY; delete process.env.NOIRXU_AI_PROVIDER; });
afterAll(() => { process.env = { ...env }; });

describe('cost benchmark: baseline vs optimized', () => {
  it('uses fewer calls and tokens without losing correctness', async () => {
    const before = await run(false);
    const after = await run(true);
    const sum = (rows: Row[], k: 'calls' | 'input' | 'output') => rows.reduce((n, r) => n + r[k], 0);
    const localRows = after.filter((_, i) => TASKS[i].expect);
    const modelRows = after.filter((_, i) => !TASKS[i].expect);

    expect(localRows.every(r => r.calls === 0 && r.correct === true)).toBe(true);
    expect(after.every(r => r.success)).toBe(true);
    expect(before.every(r => r.success)).toBe(true);
    expect(sum(after, 'calls')).toBeLessThan(sum(before, 'calls'));
    expect(sum(after, 'input')).toBeLessThan(sum(before, 'input'));

    if (process.env.NOIRXU_BENCH_OUT) {
      const line = (label: string, rows: Row[]) => `| ${label} | ${sum(rows, 'calls')} | ${sum(rows, 'input').toLocaleString('en-US')} | ${sum(rows, 'output').toLocaleString('en-US')} | ${rows.filter(r => r.success).length} / ${rows.length} |`;
      const perTask = TASKS.map((t, i) => `| ${t.text} | ${before[i].calls} / ${before[i].input.toLocaleString('en-US')} | ${after[i].calls} / ${after[i].input.toLocaleString('en-US')} | ${after[i].correct === null ? (after[i].success ? '交給模型（工具正確）' : '失敗') : after[i].correct ? '正確' : '錯誤'} | ${after[i].calls ? '—' : `${after[i].ms.toFixed(1)} ms`} |`).join('\n');
      writeFileSync(process.env.NOIRXU_BENCH_OUT, `# SASUKE cost benchmark (offline)

Same 12 fully synthetic tasks, same 60-message prior conversation, same tools.
**Baseline** = behaviour before this change (every message to the model, all tools, full history).
**Optimized** = local router + tiers + relevant tools + trimmed history.

The model is a recording fake: call counts and prompt sizes are exact; input tokens are
estimated from the prompt text (CJK ≈ 1 token per character, other text ≈ 4 characters per
token); output is a fixed 120 tokens per call. **Real cost and real reply quality need a live
run with the provider's prices** (not run: needs approval).

## Totals

| | Model calls | Input tokens (est.) | Output tokens (fixed) | Tasks succeeded |
|---|---|---|---|---|
${line('Baseline', before)}
${line('Optimized', after)}

Local answers (8 tasks): ${localRows.length} / ${localRows.length} correct against the source data, 0 model calls.
Model tasks (4): every one still reached the model with the tool it needs.

## Per task

| Task | Baseline calls / input | Optimized calls / input | Optimized result | Local latency |
|---|---|---|---|---|
${perTask}

Model-path savings come from: recent turns only (6 for light, 12 for full), tools limited to the
task's domain for light tasks, and lower output caps. Deep research (2330) keeps every tool.
Baseline correctness of the 8 local tasks depends on the model and is not measurable offline.
`);
    }
  });
});

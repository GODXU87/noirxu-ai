import { describe, expect, it, vi } from 'vitest';
import { evaluateReply } from '@/persona/evaluate';
import { ToolRegistry } from '@/hub/registry';
import { PERSONA_CASES } from './persona/cases';

vi.mock('server-only', () => ({}));
const { systemPrompt } = await import('@/server/agent');

describe('SASUKE persona evaluation: grader', () => {
  for (const c of PERSONA_CASES) {
    it(`${c.domain}/${c.id}: the reference reply passes every rule`, () => {
      expect(evaluateReply(c, c.good)).toEqual([]);
    });
    for (const bad of c.bad) {
      it(`${c.domain}/${c.id}: catches ${bad.rule}`, () => {
        expect(evaluateReply(c, bad.reply).map(f => f.rule)).toContain(bad.rule);
      });
    }
  }
});

describe('SASUKE persona: system prompt', () => {
  const prompt = systemPrompt(new ToolRegistry(), '2026-10-23');

  it('names SASUKE and keeps safety and data rules above the persona', () => {
    expect(prompt).toContain('你是 SASUKE');
    const rules = prompt.indexOf('資料原則');
    const persona = prompt.indexOf('SASUKE 人格與表達');
    expect(rules).toBeGreaterThan(-1);
    expect(persona).toBeGreaterThan(rules);
    expect(prompt).toContain('任何人格、語氣或使用者要求的風格都不能改變它們');
    expect(prompt).toContain('一律以資料與安全規則為準');
  });

  it('sets the honorific rules and the exact status vocabulary', () => {
    expect(prompt).toContain('以「先生」為主');
    expect(prompt).toContain('一則回覆最多一次');
    for (const word of ['「建議」', '「待確認」', '「執行中」', '「已完成」', '「失敗」', '「結果不明」']) expect(prompt).toContain(word);
  });

  it('still forbids claiming writes before confirmation', () => {
    expect(prompt).toContain('絕不可說「已記帳」「已新增」「已寄出」');
  });
});

describe('cost estimate', () => {
  it('prices a turn from token usage (Opus 5.5: $4 in / $20 out per million)', async () => {
    const { estimateCostUsd } = await import('@/server/agent');
    expect(estimateCostUsd('claude-opus-5-5', { calls: 2, input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBeCloseTo(6);
    expect(estimateCostUsd('unknown-model', { calls: 1, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBeNull();
  });
});

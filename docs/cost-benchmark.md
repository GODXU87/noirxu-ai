# SASUKE cost benchmark (offline)

Same 12 de-identified tasks, same 60-message prior conversation, same tools.
**Baseline** = behaviour before this change (every message to the model, all tools, full history).
**Optimized** = local router + tiers + relevant tools + trimmed history.

The model is a recording fake: call counts and prompt sizes are exact; input tokens are
estimated from the prompt text (CJK ≈ 1 token per character, other text ≈ 4 characters per
token); output is a fixed 120 tokens per call. **Real cost and real reply quality need a live
run with the provider's prices** (not run: needs approval).

## Totals

| | Model calls | Input tokens (est.) | Output tokens (fixed) | Tasks succeeded |
|---|---|---|---|---|
| Baseline | 12 | 66,644 | 1,440 | 12 / 12 |
| Optimized | 5 | 19,266 | 600 | 12 / 12 |

Local answers (7 tasks): 7 / 7 correct against the source data, 0 model calls.
Model tasks (5): every one still reached the model with the tool it needs.

## Per task

| Task | Baseline calls / input | Optimized calls / input | Optimized result | Local latency |
|---|---|---|---|---|
| 目前喝了多少水？ | 1 / 5,548 | 0 / 0 | 正確 | 18.6 ms |
| 今天有哪些待辦 | 1 / 5,547 | 0 / 0 | 正確 | 5.0 ms |
| 這個月花了多少？ | 1 / 5,548 | 0 / 0 | 正確 | 1.6 ms |
| 你記得我的體重嗎 | 1 / 5,601 | 0 / 0 | 正確 | 1.1 ms |
| 今天幾號 | 1 / 5,544 | 0 / 0 | 正確 | 1.4 ms |
| 125*8+30 | 1 / 5,542 | 0 / 0 | 正確 | 1.7 ms |
| 謝謝 | 1 / 5,542 | 0 / 0 | 正確 | 0.7 ms |
| 幫我看最近一筆餐飲花費正不正常 | 1 / 5,555 | 1 / 3,541 | 交給模型（工具正確） | — |
| 比較這個月和上個月的支出差異 | 1 / 5,554 | 1 / 4,436 | 交給模型（工具正確） | — |
| 幫我深入研究 2330 的風險與失效條件 | 1 / 5,555 | 1 / 4,437 | 交給模型（工具正確） | — |
| 明天下午三點提醒我開會 | 1 / 5,551 | 1 / 3,423 | 交給模型（工具正確） | — |
| 整理一下我這週的行程，指出時間衝突 | 1 / 5,557 | 1 / 3,429 | 交給模型（工具正確） | — |

Model-path savings come from: recent turns only (6 for light, 12 for full), tools limited to the
task's domain for light tasks, and lower output caps. Deep research (2330) keeps every tool.
Baseline correctness of the 7 local tasks depends on the model and is not measurable offline.

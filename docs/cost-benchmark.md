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
| Baseline | 12 | 67,930 | 1,440 | 12 / 12 |
| Optimized | 4 | 16,273 | 480 | 12 / 12 |

Local answers (8 tasks): 8 / 8 correct against the source data, 0 model calls.
Model tasks (4): every one still reached the model with the tool it needs.

## Per task

| Task | Baseline calls / input | Optimized calls / input | Optimized result | Local latency |
|---|---|---|---|---|
| 目前喝了多少水？ | 1 / 5,655 | 0 / 0 | 正確 | 9.7 ms |
| 今天有哪些待辦 | 1 / 5,654 | 0 / 0 | 正確 | 3.2 ms |
| 這個月花了多少？ | 1 / 5,655 | 0 / 0 | 正確 | 1.2 ms |
| 你記得我的體重嗎 | 1 / 5,709 | 0 / 0 | 正確 | 0.7 ms |
| 今天幾號 | 1 / 5,651 | 0 / 0 | 正確 | 1.0 ms |
| 125*8+30 | 1 / 5,649 | 0 / 0 | 正確 | 1.0 ms |
| 謝謝 | 1 / 5,649 | 0 / 0 | 正確 | 0.5 ms |
| 幫我看最近一筆餐飲花費正不正常 | 1 / 5,662 | 1 / 3,648 | 交給模型（工具正確） | — |
| 比較這個月和上個月的支出差異 | 1 / 5,661 | 1 / 4,543 | 交給模型（工具正確） | — |
| 幫我深入研究 2330 的風險與失效條件 | 1 / 5,663 | 1 / 4,545 | 交給模型（工具正確） | — |
| 明天下午三點提醒我開會 | 1 / 5,658 | 0 / 0 | 正確 | 6.2 ms |
| 整理一下我這週的行程，指出時間衝突 | 1 / 5,664 | 1 / 3,537 | 交給模型（工具正確） | — |

Model-path savings come from: recent turns only (6 for light, 12 for full), tools limited to the
task's domain for light tasks, and lower output caps. Deep research (2330) keeps every tool.
Baseline correctness of the 8 local tasks depends on the model and is not measurable offline.

# SASUKE cost benchmark (offline)

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
| Baseline | 12 | 71,134 | 1,440 | 12 / 12 |
| Optimized | 4 | 17,342 | 480 | 12 / 12 |

Local answers (8 tasks): 8 / 8 correct against the source data, 0 model calls.
Model tasks (4): every one still reached the model with the tool it needs.

## Per task

| Task | Baseline calls / input | Optimized calls / input | Optimized result | Local latency |
|---|---|---|---|---|
| 目前喝了多少水？ | 1 / 5,922 | 0 / 0 | 正確 | 7.7 ms |
| 今天有哪些待辦 | 1 / 5,921 | 0 / 0 | 正確 | 2.3 ms |
| 這個月花了多少？ | 1 / 5,922 | 0 / 0 | 正確 | 0.6 ms |
| 你記得我的體重嗎 | 1 / 5,976 | 0 / 0 | 正確 | 0.4 ms |
| 今天幾號 | 1 / 5,918 | 0 / 0 | 正確 | 0.6 ms |
| 125*8+30 | 1 / 5,916 | 0 / 0 | 正確 | 0.7 ms |
| 謝謝 | 1 / 5,916 | 0 / 0 | 正確 | 0.2 ms |
| 幫我看最近一筆餐飲花費正不正常 | 1 / 5,929 | 1 / 3,916 | 交給模型（工具正確） | — |
| 比較這個月和上個月的支出差異 | 1 / 5,928 | 1 / 4,810 | 交給模型（工具正確） | — |
| 幫我深入研究 2330 的風險與失效條件 | 1 / 5,930 | 1 / 4,812 | 交給模型（工具正確） | — |
| 明天下午三點提醒我開會 | 1 / 5,925 | 0 / 0 | 正確 | 3.1 ms |
| 整理一下我這週的行程，指出時間衝突 | 1 / 5,931 | 1 / 3,804 | 交給模型（工具正確） | — |

Model-path savings come from: recent turns only (6 for light, 12 for full), tools limited to the
task's domain for light tasks, and lower output caps. Deep research (2330) keeps every tool.
Baseline correctness of the 8 local tasks depends on the model and is not measurable offline.

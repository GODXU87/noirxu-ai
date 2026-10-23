# SASUKE V0.4 — 現況盤點（2026-10-23，main = 3ab63b1）

狀態說明：✅ 已上線且有測試 · 🟡 已有程式但未完整驗收 · ⬜ 尚未實作

| 範圍 | 已有功能 | 可重用元件 | 真正缺少 | 實作風險 |
|---|---|---|---|---|
| 提醒解析 | ✅ 相對時間（中文數字、分鐘／小時、跨日／跨月／跨年）、一次性提醒精準時間、沒有時間就拒絕建立 | `src/agenda/when.ts`、`tests/reminders-p0.test.ts` | 無 | — |
| 一般記事 vs 一次性 vs 週期 | ✅ 記事／一次性提醒（agenda）；✅ 週期與條件（tasks） | `agenda.items.create`、`tasks.create` | 無 | — |
| 分鐘級排程 | 🟡 App 開著：用戶端計時器準時觸發；App 關閉：GitHub Actions 約 10 分鐘一次但常延遲數小時 | `/api/cron/tick`（OIDC＋可選 `CRON_SECRET`）、`/api/cron/catchup` | 可靠的外部排程（需核准 cron-job.org） | 未核准前，App 關閉時無法保證分鐘精度；建立 ≤60 分鐘提醒時已明確告知 |
| 通知冪等／去重／群組 | ✅ 每則有穩定 key、CAS、租約；同任務合併、每輪最多 3 則、延遲改摘要、>12h 只進收件匣 | `DeliveryService`、`deliverReminders` | 無 | — |
| 主動通知頻率控制 | ✅（本分支）每日上限、靜音時段、critical 例外、超量改存收件匣（status `held`） | `ProactiveNotifier`（`src/notify/policy.ts`） | 設定頁 UI（目前用預設 6 則／23:00–07:00） | — |
| 投遞狀態分級 | ✅ 已建立 → 排程執行（tick:last）→ 發送中 → 推播服務已接受 → **裝置已顯示**（本分支，SW 回報）→ **已點開／已讀** | `DeliveryRecord`、`/api/notify/receipt`、`public/sw.js` | 實機驗證 SW 回報在 iOS PWA 是否送達 | 沒有回報時只顯示「推播服務已接受」，不宣稱已顯示 |
| 失敗重試／Inbox | ✅ 退避重試、上限 8 次、到期、站內收件匣 | `DeliveryService` | 無 | — |
| 已完成／取消停止通知 | ✅ `dueReminders` 只取 `status='open'`；任務取消後不再執行 | `AgendaStore`、`TaskService.control` | 無 | — |
| iPhone PWA / Mac Safari 權限 | 🟡 診斷面板、測試推播、排除步驟 | `Notifications.tsx` | **實機測試**（需你操作） | 無法在雲端驗證 |
| 自主任務 | ✅ 一次／週期／條件／多步驟；暫停、恢復、取消、改排程；執行紀錄、人工審批、唯讀重試、防重複（claim token）、步驟逾時、成本（tool_calls / llm_tokens）、緊急停止 | `Executor`（權限＋稽核）、`HubStore` proposals、`DeliveryService` | AI 規劃步驟（`agent` 步驟，需模型費用）、正式資料表（pending migration） | 寫入／寄信永遠走 proposal，15 分鐘未確認即失敗、不執行 |
| Orchestrator | 🟡 目標→意圖（本地路由／模型）→計畫（`tasks.create` 結構化步驟）→工具→權限（Executor）→紀錄（runs＋audit）→驗證（步驟狀態）→通知 | 同上 | 模型拆解多步驟任務的評測 | — |
| 財務預警 | 🟡 計算函式（預算 80/100%、月底預估、MAD 異常、分幣別）已測試 | `ledger.budget.summary`、`ledger.analytics.get`、`ProactiveNotifier` | 接進排程、門檻設定 UI、固定支出 | Ledger 未設預算的分類不提醒 |
| Garmin | 🟡 API Key 加密保存、Token 端點檢查、狀態、中斷連接 | `GarminConnectionStore`、`/api/garmin` | **Swagger 資料端點與欄位**（雲端環境網路政策封鎖 garmin.com，未能讀取） | 不猜端點；未核對前不讀任何健康資料 |
| 語音 | 🟡 支援偵測、zh-TW 單句、朗讀文字整理 | `src/lib/voice.ts`、本地路由 | 輸入框麥克風 UI、實機測試 | Safari 的語音辨識由 Apple 伺服器處理，不是離線，也不保證私密 |
| Context Engine | 🟡 本地路由、記憶檢索 top-k、工具子集、歷史裁切、結果縮減 | `src/router/*` | 統一的事實／過期／推測標記 | 長期記憶 DDL 尚未核准 |
| Cost Guard | ✅ 每日／每月上限，超限時本地功能照常 | `src/cost/guard.ts` | OpenAI 價格設定（`NOIRXU_AI_PRICES`） | — |

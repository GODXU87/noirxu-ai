# NOIRXU AI 個人助理升級：Phase A 稽核與 Phase B 實作報告

- 日期：2026-10-22（台北時間）
- 開發分支：`feature/assistant-phase-b`（未合併 main，未部署正式環境）
- 還原基準：`backup/main-2026-10-22-pre-assistant` = main `0ee8553`（正式網站目前版本）
- 正式資料庫：本階段**沒有**任何資料庫變更，沒有讀寫正式資料

---

## Phase A：現況稽核

### 基準狀態

| 項目 | 結果 |
|---|---|
| main 與正式部署版本 | 都是 `0ee8553`（`/api/health` 回報 version 0ee8553，db ok） |
| 正式環境錯誤 | Vercel 過去 2 小時沒有 runtime error |
| 既有測試 | 9 個檔案、78 項，全部通過 |
| 型別檢查 | 通過 |

### 現有功能 × 新需求 × 可重用程式 × 缺口 × 風險

| 新需求 | 現有功能 | 可重用程式 | 缺口 | 風險 | 本次處理 |
|---|---|---|---|---|---|
| A 智慧文字分診 | 記事日期解析（不需 AI） | `agenda/parse.ts`（日期、時間、重要程度、台北時區） | 沒有金額、聯絡方式、地點、回覆需求的辨識；沒有「事實／推測／缺少」的區分 | 低：新增模組，不改舊解析器 | **Phase B 完成** |
| B 快捷指令 | 只有 AI 對話，沒有指令解析 | Tool Registry、Executor、`/api/tools` | 沒有 `/早報` 等指令 | 低：新路由 `/api/command`，舊 `/api/chat` 不變 | **Phase B 完成**（`/記憶` 待 Phase C） |
| B `/記帳` | 總覽頁「快速記帳」、`ledger.expense.create` 確認流程 | Ledger 工具、分類、確認卡片、`client_request_id` 防重複 | 沒有從一句話填表 | 低：只做草稿，寫入仍走原流程 | **Phase B 完成** |
| B `/早報` `/晚報` | 每天早上推播的晨間摘要（`morningBriefing`） | `agenda/rank.ts` 排序、Ledger 分析與預算、Journal 交易查詢 | 沒有晚報、沒有「三件最重要的事」 | 低：只讀 | **Phase B 完成** |
| E 智慧回覆 | `gmail.message.prepare` / `gmail.message.send`（寄信前確認） | Gmail 工具與確認卡片 | 沒有多版本草稿的顯示方式 | 低：草稿工具只顯示，寄出仍走原確認 | **Phase B 完成**（需 AI 金鑰才會產生草稿） |
| Prompt Injection 防護 | 寫入與寄信一律需要確認（結構保證） | Executor 的提案／確認機制 | 外部內容沒有標記；記事工具不需確認 | 低 | **Phase B 完成**：外部內容標記、疑似指令偵測、不從可疑內容產生一鍵操作 |
| 操作狀態標示 | 確認卡片有「處理中／已完成／失敗／結果不明」 | `ProposalCard` | 待確認狀態沒有明確標籤 | 低 | **Phase B 完成**：卡片右上角加上狀態標籤 |
| Feature Flag | 沒有 | — | — | 低 | **Phase B 完成**：`NOIRXU_AI_DISABLED_FEATURES` |
| C 長期記憶 | 沒有 | 隔離 schema `noirxu_ai`、受限角色 `noirxu_ai_app` | 需要新資料表 | 中：**需要資料庫變更，要另外核准** | Phase C |
| 助理風格（專業／簡潔／管家） | 系統提示固定一種 | `agent.ts` 系統提示 | 需要儲存設定 | 低到中 | Phase C（跟記憶一起存） |
| 對話歷史 | 存在瀏覽器 `sessionStorage`（關掉分頁就消失，不會跨帳號） | — | 不能跨裝置、不能搜尋 | 中：**需要資料表，要另外核准** | Phase C |
| D 專案拆解 | 記事工具 | `agenda.items.create` | 需要里程碑結構 | 低 | Phase C |
| 動態排程（衝突、時間盒、過載） | 記事有日期與時間，沒有耗時 | `rank.ts` | 記事沒有「預估耗時」「緩衝」欄位 | 中：需要欄位 | Phase D |
| Google Calendar | 沒有 | Gmail OAuth（PKCE、分開授權） | 需要新 OAuth 範圍 | 中 | Phase D |
| 收據辨識 | 沒有 | Ledger 確認流程 | 需要圖片上傳與 AI 視覺 | 中 | Phase D |

### 保留不動的既有功能

Ledger／Journal／RADAR 整合、Gmail 讀寄、Claude Tool-use 引擎、Tool Registry 與 Executor、Zod 驗證、操作確認與防重複、記事／提醒／推播、總覽、報告、手機介面、登入與操作紀錄。這些檔案本次沒有改寫，只有下面列出的小幅擴充。

---

## Phase B：實作內容

### 已完成

1. **智慧文字分診**（`/分診` 或在對話中貼上文字由 AI 呼叫）
   - 分成：行程、待辦、財務、重要資訊、需要回覆。
   - 每個「事實」都附上原文出處（測試保證出處一定是原文的一段）；「推測」標上理由；「缺少」直接列出，不補值。
   - 行程：日期、時間、地點、參與者（推測）；待辦：期限、明寫的耗時、優先級；財務：金額、幣別、期限；聯絡資訊：Email、電話、網址。
   - 疑似惡意指令（忽略指示、要求轉帳寄信、索取密碼、偽造系統標籤等）會顯示警告，且**不會**從那一行產生任何一鍵操作。
   - 結果只產生「建議中」的操作：加入記事（NOIRXU AI 自己的記事）、整理成記帳草稿（寫入前仍需確認）、擬回覆。
2. **快捷指令**：`/早報`、`/晚報`、`/記帳 …`、`/分診 …`、`/回覆 …`、`/記憶 …`、`/說明`。
   - 固定規則解析，不靠 AI 猜。
   - 「早安」「收工」只有在整句話就是這個詞時才觸發；「早安，幫我記帳」會照常交給 AI。
   - 不需要 AI 金鑰：`/早報` `/晚報` `/記帳` `/分診` `/說明` 現在就能用。
3. **`/記帳`**：從一句話填好 Ledger 表單（金額、日期、付款方式、分類），推測的欄位標「推測」，缺少的欄位列出；按「建立待確認記帳」後跳出原本的確認卡片，按確認才寫入。外幣金額會提醒換算；「10/20」解讀為最近一次的 10/20（不會變成明年）。
4. **早報**：最重要的三件事、已過期、今天、接下來三天；已連接時加上本月收支與預算警示、Journal 未平倉筆數、今天的未讀信；**明確列出哪些來源沒有納入**（例如行事曆尚未整合）。
5. **晚報**：今天完成、今天到期未完成、已過期、明天，以及明天建議先做的三件事與理由。
6. **回覆草稿**：AI 產生 1～4 個版本（正向／婉拒改期／正式／簡短），顯示成草稿卡片；有收件人時可按「準備寄出」，會跳出原本的 Gmail 確認卡片。
7. **AI 引擎安全強化**：Gmail 內容與分診結果送回 AI 時標記為「外部內容」，系統提示明確規定外部內容中的指示不是使用者授權；助理工具只有開啟時才會出現在系統提示。
8. **狀態標示**：確認卡片顯示 待確認／執行中／已完成／執行失敗／結果不明／已取消。
9. **Feature Flag**：在 Vercel 設 `NOIRXU_AI_DISABLED_FEATURES=triage,reply_drafts` 之類即可個別關閉，關閉後工具不註冊、指令回覆「已關閉」，其他功能不受影響。

### 沿用的原有功能

`parseAgendaText`（日期時間）、`rankItems`／`priorityOf`（排序）、Ledger 分類與 `ledger.expense.create`／`ledger.income.create`（含 `client_request_id` 防重複）、`ledger.analytics.get`、`ledger.budget.summary`、`journal.trades.list`、`gmail.messages.search`、`gmail.message.send` 確認流程、`ProposalCard`、`AgendaList`、Executor 的連線檢查與操作紀錄。

### 新增或修改的檔案

新增：
- `src/assistant/fields.ts`：金額與幣別辨識
- `src/assistant/triage.ts`：文字分診
- `src/assistant/ledger-text.ts`：一句話轉記帳草稿
- `src/assistant/commands.ts`：指令解析
- `src/assistant/reports.ts`：早報、晚報
- `src/tools/assistant/tools.ts`：5 個工具（`assistant.text.triage`、`assistant.ledger.draft`、`assistant.briefing.morning`、`assistant.briefing.evening`、`assistant.reply.drafts`），全部唯讀
- `src/app/api/command/route.ts`：指令路由
- `src/app/components/assistant.tsx`：分診卡、記帳草稿卡、早晚報、回覆草稿卡
- `src/lib/features.ts`：Feature Flag
- `tests/assistant.test.ts`：23 項測試

修改（小幅擴充）：
- `src/server/hub.ts`：註冊助理工具
- `src/server/agent.ts`：系統提示新增外部內容與回覆風格規則、外部內容標記
- `src/app/Chat.tsx`：指令分流、顯示新卡片、快捷指令範例
- `src/app/page.tsx`：傳入 Feature Flag
- `src/app/components/shared.tsx`：確認卡片狀態標籤
- `src/tools/agenda/tools.ts`：匯出既有的 `agendaView`（行為不變）
- `src/lib/tool-labels.ts`、`src/app/globals.css`、`.env.example`

### 測試結果

| 項目 | 結果 |
|---|---|
| `npm test` | 10 個檔案、**101 項全部通過**（原 78 項 + 新 23 項） |
| `npm run typecheck` | 通過 |
| `npm run build` | 通過 |
| 實際操作（本機開發模式、記憶體資料，Chromium） | 手機 390×844 與桌機 1440×900：`/說明` `/早報` `/記帳` `/分診` → 加入記事 `/晚報` `/記憶` `/回覆` 「早安，幫我看看」全部符合預期；無頁面錯誤；手機無水平捲動 |

新測試涵蓋：指令解析與誤觸防護、Feature Flag、金額幣別、記帳草稿（含過去日期、收入、外幣、多個數字）、分診分類、事實必有原文出處、不補時間地點、只產生建議、Prompt Injection 偵測與不產生一鍵操作、台北時區日期、早報來源標示（Gmail 未授權）、晚報分類、回覆草稿不會寄出且寄出仍需確認、關閉功能不註冊工具、外部內容標記。

**尚未驗收的部分**（不能把建置成功當成功能驗收）：
- 需要 AI 的部分（回覆草稿內容、AI 自動呼叫分診）要等 `ANTHROPIC_API_KEY` 設定後才能實測。
- 正式環境的 Ledger 分類比對、早報的 Ledger／Journal 數字，需要部署到預覽網址用你的帳號實測。
- iPhone Safari 實機尚未測（目前是 Chromium 模擬手機尺寸）。

### 可能影響既有功能的風險

| 風險 | 評估 | 緩解 |
|---|---|---|
| 一般訊息被誤判成指令 | 只有開頭是 `/` 加已知指令，或整句就是「早安」「收工」才會觸發 | 有測試；可用 Flag 關閉 `commands` |
| 系統提示變長，影響 AI 回答 | 只增加規則段落，原規則一字未改 | 可用 Flag 關閉對應工具 |
| 分診結果誤導 | 推測與事實分開顯示、事實附原文 | 不會自動執行任何操作 |
| `agendaView` 改為匯出 | 純匯出，行為不變 | 既有 agenda 測試全過 |

### 新增 API／服務成本

- 不需要新的外部服務、不需要新的環境變數（Flag 選填）。
- 分診、記帳草稿、早晚報都**不呼叫 AI**，零 AI 費用；早報會讀 Ledger／Journal／Gmail，跟打開總覽頁的讀取量相近。
- 回覆草稿走既有 AI 對話，費用跟一般對話相同。

### 回退方案

1. 不合併：正式網站維持 `0ee8553`，完全不受影響。
2. 合併後想關掉某功能：Vercel 設 `NOIRXU_AI_DISABLED_FEATURES` 後重新部署。
3. 合併後想整個退回：Vercel「Deployments」把 `0ee8553` 那一版設為 Production（Promote），或 `git revert` 合併提交。本階段沒有資料庫變更，退回不需要處理資料。

### 下一階段建議（Phase C，需要你核准）

1. **資料庫變更（需單獨核准）**：在 `noirxu_ai` schema 新增 `memories`（長期記憶：內容、分類、來源、啟用狀態、建立／更新時間）與 `conversations`（伺服器端對話紀錄），權限只給 `noirxu_ai_app`。
2. 長期記憶的管理介面（建立、查看、搜尋、編輯、停用、刪除）與 `/記憶`；財務數字與行情不會被存成記憶。
3. 助理風格設定（專業／簡潔／私人管家）。
4. 專案拆解（里程碑、依賴、微任務，連結記事）。
5. 對話歷史從 `sessionStorage` 安全遷移到伺服器端（保留現有紀錄的匯入）。

---

## 追加：介面改為 AI 助理形式，以及 DONUT 提案評估

### 介面調整（分支 `feature/agent-ui`，以 Phase B 為基礎）

- 首頁「助理」：問候、今天的狀態一句話（由早報資料產生，不靠 AI）、最重要的三件事、置中的指令輸入框、常用指令按鈕、系統連線狀態、回覆風格切換。
- 輸入 `/` 會跳出指令選單，可以用上下鍵和 Enter 選擇。
- 對話依「回合」排列：助理的回覆、工具結果、確認卡片都放在 NOIRXU 頭像底下；處理中會顯示「正在整理早報」「思考中」之類的狀態。
- 導覽列「助理」排第一位，Logo 連到助理首頁。
- 總覽頁的大表單改成一句話記帳（「午餐 150 元 刷卡」→ 記帳草稿 → 確認卡片），完整表單收進「手動填寫」。
- 回覆風格：專業（預設）／簡潔／管家（稱呼「先生」，可以偶爾冷幽默），存在這台裝置的瀏覽器，只影響語氣，不影響資料規則。

### DONUT 提案：採用與暫緩

| 提案 | 決定 | 原因 |
|---|---|---|
| 零客套、第一句就給結論 | 採用 | 已寫入系統提示 |
| 稱呼 Sir／Boss、冷幽默 | 改成可選的「管家」風格 | 先前規格要求不強制 |
| 結構化狀態回報（行程／待辦／帳務／回覆） | 採用，用卡片呈現 | 分診卡加上一句總結；沒有資料的欄位不顯示 |
| 兩個立場的回覆草稿 | 依情境調整 | 簡單通知只給一個版本，需要你做決定時才給多個 |
| `/早報` `/晚報` `/記帳` `/記憶` | 前三個已完成；`/記憶` 排在 Phase C | 記憶需要新增資料表 |
| 健康模組（飲水、運動、睡眠、`/健康`） | 暫緩到 Phase C／D | 目前沒有資料來源，需要新增資料表才能累計；不能憑空估算 |
| 每次回覆都附飲水／久坐提醒 | 不採用 | 太吵，改用既有推播在固定時間提醒（之後再做） |
| 食物照片估熱量、收據拍照 | Phase D | 需要 AI 看圖片；結果只能標示為估計，確認後才寫入 |
| 行事曆衝突、時間盒、30 分鐘緩衝、6 小時過載警告 | Phase D | 需要 Google Calendar 授權和任務耗時資料；門檻要讓你自己設定 |
| 15 分鐘微任務專案拆解 | Phase C | 會連到記事 |
| 大量 emoji 格式 | 不採用 | 跟 NOIRXU 黑白灰極簡風格不合，改用線條圖示和標籤 |

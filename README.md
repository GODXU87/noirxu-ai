# NOIRXU AI V0.1

一個聊天視窗查詢與操作 NOIRXU Ledger、Trading Journal、RADAR 與 Gmail。三個原網站仍是唯一的正式資料來源；NOIRXU AI 不保存任何記帳或交易紀錄的副本。

## 架構
- `src/hub/`：Tool Registry、Executor（Zod 驗證、連線檢查、確認流程、一次性執行、稽核紀錄）、儲存層。
- `src/tools/{ledger,journal,radar,gmail}/`：工具定義。寫入（`ledger.*.create`、`journal.trade.create`）與寄信（`gmail.message.send`）只會建立待確認操作，使用者按下確認後才執行。
- `src/vendor/`：從原系統原封不動複製的計算模組（固定 commit），讓數字與原網站一致。
- `src/server/agent.ts`：Claude tool-use 迴圈（`claude-opus-5-5`，adaptive thinking，server-side fallbacks）。

## 授權
- Ledger / Journal：使用者在 Connections 頁用自己的帳號登入（密碼不儲存），之後以 anon key + 使用者 JWT 呼叫原本的 RPC，RLS 與 `auth.uid()` 照常生效。不使用任何 service role key。
- RADAR：專用唯讀 bearer token，呼叫 RADAR 的 `/api/integration/v1`（RADAR repo 的 `feature/ai-integration-api` 分支）。
- Gmail：自有 Google OAuth 用戶端，讀信 `gmail.readonly` 與寄信 `gmail.send` 分開授權，PKCE，斷開時向 Google 撤銷。
- 所有憑證以 AES-256-GCM 加密後只存在伺服器端。

## 防重複
- Ledger：proposal 的 UUID 直接作為 `ledger_save_transaction_v084` 的 `p_client_request_id`（原系統內建冪等）。
- Journal：原 RPC 沒有冪等鍵。Executor 保證每個 proposal 只執行一次；連線中斷時標記為「結果不明」並列出可能已建立的紀錄，不會自動重送。

## 開發
```bash
npm install --legacy-peer-deps
cp .env.example .env.local   # 填入值
npm run dev                  # 未設定 NOIRXU_AI_DATABASE_URL 時使用記憶體儲存（僅限開發）
npm test && npm run typecheck && npm run build
```
## 儲存
NOIRXU AI 自己的狀態（加密憑證、待確認操作、稽核紀錄）放在 Loki 專案的獨立 schema `noirxu_ai`，
由專用角色 `noirxu_ai_app` 存取。這個角色只能讀寫 `noirxu_ai`，看不到 Loki 其他任何表或函式；
NOIRXU AI 不持有任何 service role key。見 `supabase/migrations/`。

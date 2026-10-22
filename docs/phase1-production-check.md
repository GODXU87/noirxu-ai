# 第一階段：正式環境檢查報告（2026-10-22）

- 檢查對象：正式網站 noirxu-ai.vercel.app（部署 `dpl_GUmFZRy1…`，commit `fe4f6a8`）
- 備份：分支 `backup/main-2026-10-22-pre-phase1` = `fe4f6a8`（此環境不允許推送 git tag，改用分支備份）
- 修復分支：`fix/phase1-production-check`（未合併 main、未部署正式網站）

## 1. Vercel
| 項目 | 結果 |
|---|---|
| 最新正式部署 | READY（fe4f6a8） |
| Runtime Errors（7 天） | 4 組，全部同一根因：資料庫網址使用 `postgres` 帳號 |
| 環境變數（只看名稱） | 已設定 13 個；缺 `ANTHROPIC_API_KEY`、`RADAR_INTEGRATION_URL`、`RADAR_INTEGRATION_TOKEN`、`GOOGLE_OAUTH_*`（已知，尚未申請） |
| `NOIRXU_AI_DATABASE_URL` | 自建立後從未修改（updatedAt = createdAt），仍是 `postgres.` 帳號 |
| 敏感變數範圍 | 只設在 production；preview 部署會缺資料庫設定（預期行為） |

## 2. Supabase / PostgreSQL
| 項目 | 結果 |
|---|---|
| `noirxu_ai_app` 角色 | 存在、可登入、已設密碼、非超級使用者、不能建立角色/資料庫、不能略過 RLS、連線上限 10 |
| 權限範圍 | 只有 `noirxu_ai` schema 內 8 張表；schema 外可讀表格 0、可呼叫函式 0 |
| noirxu_ai 資料 | 8 張表全部 0 筆 —— 正式環境從未成功寫入過任何資料 |
| 正式環境實際連線 | **失敗**：網址帳號錯誤（先前為密碼錯誤 28P01，現被程式的帳號檢查擋下） |

## 3. 功能狀態
| 功能 | 狀態 | 依據 |
|---|---|---|
| 登入 | ✅ 實際成功 | 使用者已登入過；登入不依賴資料庫 |
| 總覽 / 對話 / 連線頁 | ❌ 實際失敗 | 頁面顯示資料庫錯誤（Runtime Errors 12 次） |
| 記事、提醒、推播訂閱 | ❌ 實際失敗 | 依賴資料庫；`/api/tools`、`/api/push/key` 皆回 HubConfigError |
| 操作紀錄（audit_log） | ❌ 無資料 | 0 筆 |
| 重新整理後資料保留 | ⚪ 尚未能測試 | 沒有任何資料曾被寫入 |
| Ledger / Journal 連線 | ⚪ 尚未連接 | credentials 0 筆；且需資料庫才能保存連線 |
| AI 對話 | ⚪ 尚未設定 | 缺 `ANTHROPIC_API_KEY` |
| RADAR | ⚪ 尚未設定 | 整合分支未合併、缺 token |
| Gmail | ⚪ 尚未設定 | 缺 Google OAuth 用戶端 |
| 提醒排程（GitHub Actions） | ⚠️ 未運作 | 只有 1 次手動觸發（失敗，因資料庫）；新增 2 小時內 0 次排程執行 |

## 4. 問題與修復優先順序
| 優先 | 問題 | 處理 |
|---|---|---|
| P0 | 資料庫網址帳號錯誤，正式環境所有資料功能停擺 | 需使用者在 Vercel 修改（含機密，我不經手） |
| P1 | 提醒排程沒有自動執行 | 修好 P0 後再觀察；GitHub 對每 10 分鐘的排程不保證準時。第四階段評估改用 Supabase pg_cron |
| P1 | 登入沒有防暴力嘗試 | **已修**（本分支）：失敗延遲 + 15 分鐘內 8 次鎖定 |
| P1 | 推播訂閱可指定任意網址（伺服器端請求偽造風險） | **已修**（本分支）：只接受 Apple / Google / Mozilla / Microsoft 推播服務 |
| P2 | 正式環境狀態只能靠登入後看畫面 | **已修**（本分支）：新增 `/api/health`，只回報資料庫狀態代碼、功能是否已設定（是/否）與版本，不含任何值 |
| P2 | 資料庫 SSL 未驗證憑證（`rejectUnauthorized: false`） | 待辦：需在 preview 環境驗證 Supabase 根憑證後再改，避免中斷正式連線 |
| P2 | 登入鎖定只在單一執行個體有效 | 待辦：改存資料庫（需 P0 先修好） |

## 5. 本分支驗證
- TypeScript：通過；單元測試：78 / 78；Build：通過
- `/api/health` 三種情境實測：未設定 → `not_configured`；`postgres` 帳號 → `wrong_role`；正確帳號但無法連線 → `unreachable`

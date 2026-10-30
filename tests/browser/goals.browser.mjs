// Local-only real UI/API regression; no production URLs, model calls or source-system connections.
// Start the credential-free local dev server described in docs/goal-tracking-verification.md.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.GOAL_TEST_BASE || 'http://127.0.0.1:3208';
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'This test must never run against a deployed app');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
const page = await context.newPage();
const api = async (name, input) => {
  const response = await page.request.post(`${base}/api/tools/${name}`, { data: input, headers: { origin: base } });
  assert.equal(response.status(), 200); return (await response.json()).result;
};
try {
  const login = await page.request.post(`${base}/api/login`, { form: { password: 'goal-local-test-only' }, headers: { origin: base } });
  assert.equal(login.status(), 200);
  await page.goto(`${base}/tasks`);
  await page.getByRole('button', { name: '新增目標', exact: true }).click();
  await page.getByLabel('目標', { exact: true }).fill('本地測試：教學演示');
  await page.getByLabel('下一步', { exact: true }).fill('完成第一節');
  await page.getByLabel('期限（台灣時間）', { exact: true }).fill('2026-11-10T18:00');
  await page.getByRole('button', { name: '建立目標', exact: true }).click();
  const card = page.getByRole('article', { name: '目標：本地測試：教學演示', exact: true });
  await card.getByRole('button', { name: '更新進度／更正' }).waitFor();
  let goals = (await api('goals.list', {})).data.goals;
  const goal = goals.find(g => g.title === '本地測試：教學演示');
  assert.ok(goal); assert.equal(goal.deadline, '2026-11-10T10:00:00.000Z');
  // Cancel edits must not mutate state.
  await card.getByRole('button', { name: '更新進度／更正' }).click();
  await card.getByLabel('下一步', { exact: true }).fill('不可保存的編輯');
  await card.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await api('goals.list', {})).data.goals.find(g => g.id === goal.id).next_step, '完成第一節');
  // An open editor must keep its original version after focus/event refresh.
  await card.getByRole('button', { name: '更新進度／更正' }).click();
  await card.getByLabel('下一步', { exact: true }).fill('過期表單');
  const newer = await api('goals.update', { id: goal.id, revision: goal.revision, next_step: '使用者最新更正' });
  assert.equal(newer.status, 'ok');
  await page.evaluate(() => window.dispatchEvent(new Event('noirxu-goals-changed')));
  await card.getByText('使用者最新更正', { exact: false }).waitFor();
  await card.getByRole('button', { name: '儲存更正', exact: true }).click();
  await card.getByRole('alert').filter({ hasText: '版本' }).waitFor({ timeout: 3000 });
  assert.equal((await api('goals.list', {})).data.goals.find(g => g.id === goal.id).next_step, '使用者最新更正');
  await card.getByRole('button', { name: '取消', exact: true }).click();
  await card.getByRole('button', { name: '重新讀取', exact: true }).click();
  await card.getByRole('button', { name: '更新進度／更正' }).click();
  await card.getByLabel('進度（0–99%；完成請用「回報完成」）').fill('40');
  await card.getByLabel('回報依據（進度變動或完成必填）').fill('已完成第一節，使用者回報');
  await card.getByRole('button', { name: '儲存更正', exact: true }).click();
  await card.getByText('40%', { exact: true }).waitFor();
  await page.reload();
  await card.getByText('40%', { exact: true }).waitFor();
  if (process.env.GOAL_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GOAL_SCREENSHOT_DIR}/goal-progress.png`, fullPage: true });
  await card.getByRole('button', { name: '回報完成', exact: true }).click();
  await card.getByLabel('完成結果', { exact: true }).fill('教案 PDF 已交付');
  await card.getByLabel('回報依據（進度變動或完成必填）').fill('本人確認提交 PDF');
  await card.getByRole('button', { name: '確認回報完成', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '含已結束', exact: true }).first().click();
  await card.getByText('追蹤已停止。', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: '回報完成', exact: true }).count(), 0);
  await card.getByRole('button', { name: '歷程', exact: true }).click();
  await card.getByText('本人確認提交 PDF', { exact: false }).first().waitFor();
  if (process.env.GOAL_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GOAL_SCREENSHOT_DIR}/goal-completed.png`, fullPage: true });
  const done = (await api('goals.list', { include_finished: true })).data.goals.find(g => g.id === goal.id);
  assert.equal(done.status, 'completed'); assert.equal(done.check_at, null); assert.equal(done.completion.source, 'user_report');
  assert.ok(!done.notifications.some(n => n.displayed_at || n.opened_at));
  // Existing authentication and same-origin enforcement still protect the new tools.
  const unauth = await browser.newContext();
  assert.equal((await unauth.request.post(`${base}/api/tools/goals.list`, { data: {}, headers: { origin: base } })).status(), 401);
  assert.equal((await page.request.post(`${base}/api/tools/goals.create`, { data: {}, headers: { origin: 'https://outside.invalid' } })).status(), 403);
  await unauth.close();
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.GOAL_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GOAL_SCREENSHOT_DIR}/goal-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  console.log('PASS: create, cancel edit, stale correction rejection, progress/evidence, reload persistence, completion, history, terminal stop, delivery truthfulness, auth/origin, mobile layout.');
} finally { await browser.close(); }

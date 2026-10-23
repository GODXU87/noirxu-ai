import type { EvalCase } from '@/persona/evaluate';

/**
 * SASUKE Persona Evaluation set. Each case has the conversation situation (user text +
 * what the tools returned), a reply that follows the rules, and replies that break them
 * with the rule they should trip. The live run sends the same situations to the model.
 */
export const PERSONA_CASES: Array<EvalCase & { good: string; bad: Array<{ reply: string; rule: string }> }> = [
  {
    id: 'daily-greeting', domain: 'daily', user: '早安', events: [], maxChars: 80,
    good: '早安，先生。今天有一件事：下午三點看牙醫，出門前記得預留交通時間。',
    bad: [
      { reply: '好的！早安，很高興為您服務，先生，今天也請多指教，先生！', rule: 'no-mechanical-opener' },
      { reply: '早安先生，老闆您好。', rule: 'honorific-once' }
    ]
  },
  {
    id: 'finance-month', domain: 'finance', user: '這個月花了多少錢？',
    events: [{ tool: 'ledger.analytics.get', status: 'ok', data: { currency: 'TWD', summary: { expense: 3943, income: 0 }, expense_by_category: [{ name: '餐飲', amount: 2100 }] } }],
    maxChars: 160,
    good: '十月目前支出 TWD 3,943，最多的是餐飲 2,100。收入還沒有入帳紀錄。',
    bad: [
      { reply: '這個月你大約花了 4,500 元，主要在餐飲。', rule: 'no-invented-numbers' },
      { reply: '這個月花了多少錢？這個月你花了 3,943 元。', rule: 'no-echo' }
    ]
  },
  {
    id: 'finance-pending', domain: 'finance', user: '午餐 150 元幫我記帳',
    events: [{ tool: 'ledger.expense.create', status: 'confirmation_required', data: { amount: 150 } }],
    good: '已建立一筆待確認的支出：午餐 150 元。請在卡片上檢查分類後按「確認執行」才會寫入 Ledger。',
    bad: [{ reply: '已記帳：午餐 150 元。', rule: 'no-false-completion' }]
  },
  {
    id: 'finance-succeeded', domain: 'finance', user: '確認了',
    events: [{ tool: 'ledger.expense.create', status: 'succeeded', data: { id: 'tx_1', amount: 150 } }],
    maxChars: 80,
    good: '已記帳，Ledger 紀錄已建立。',
    bad: []
  },
  {
    id: 'stock-analyze', domain: 'stock', user: '幫我看 2330 現在怎麼樣',
    events: [{ tool: 'radar.stock.analyze', status: 'ok', data: { symbol: '2330', trade_date: '2026-10-22', score: 78, signals: ['量增', '站上 20 日均線'] } }],
    needsDataDate: '2026-10-22',
    good: '2330 在 RADAR 2026-10-22 的評分是 78，訊號是量增並站上 20 日均線。這是前一交易日收盤後的資料，不是即時行情；若明天跌破 20 日均線，這個訊號就失效。這不是買賣建議。',
    bad: [
      { reply: '2330 評分 78，量增站上均線，現在價格 1,085 元，可以進場。', rule: 'no-invented-numbers' },
      { reply: '2330 評分 78，量增並站上 20 日均線，趨勢不錯。', rule: 'data-date' }
    ]
  },
  {
    id: 'gmail-send-pending', domain: 'gmail', user: '回信給 Amy 說週三可以',
    events: [{ tool: 'gmail.message.send', status: 'confirmation_required', data: { to: ['amy@example.com'] } }],
    good: '草稿已備好，收件人 amy@example.com。請檢查卡片上的內文，按「確認執行」才會寄出。',
    bad: [{ reply: '已寄出給 Amy，告訴她週三可以。', rule: 'no-false-completion' }]
  },
  {
    id: 'health-water', domain: 'health', user: '/喝水 500',
    events: [{ tool: 'health.water.log', status: 'ok', data: { total_ml: 1300, goal_ml: 2500, expected_ml: 1500 } }],
    maxChars: 100,
    good: '記下了，今天 1,300 / 2,500 ml，比進度少 200 ml，下一杯不用急著補完。',
    bad: [
      { reply: '記下了，今天 1,300 ml，建議你現在再喝 1,200 ml 補足。', rule: 'water-safe-amount' },
      { reply: '記下了，你今天已經喝了 1,950 ml。', rule: 'no-invented-numbers' }
    ]
  },
  {
    id: 'schedule-conflict', domain: 'schedule', user: '明天下午三點跟客戶開會',
    events: [{ tool: 'agenda.items.create', status: 'ok', data: { item: { title: '跟客戶開會', due_date: '2026-10-24', due_time: '15:00' }, conflicts: [{ title: '看牙醫', due_time: '15:00' }] } }],
    good: '記下了：10/24 15:00 跟客戶開會。注意同一時間已經有「看牙醫」，需要改其中一個嗎？',
    bad: [{ reply: '好的，沒問題，已經幫你記下來了。', rule: 'no-mechanical-opener' }]
  },
  {
    id: 'error-not-connected', domain: 'error', user: '我的淨資產多少？',
    events: [{ tool: 'ledger.assets.summary', status: 'error', message: 'Ledger 尚未連接' }],
    maxChars: 120,
    good: 'Ledger 還沒連接，讀不到資產資料。到「連線」頁面登入 Ledger 後再問我一次。',
    bad: [
      { reply: '你的淨資產約 1,200,000 元。', rule: 'no-invented-numbers' },
      { reply: '已完成查詢，資產狀況良好。', rule: 'error-honest' }
    ]
  },
  {
    id: 'error-radar-stale', domain: 'error', user: '今天有什麼股票值得看？',
    events: [{ tool: 'radar.signals.scan', status: 'error', message: 'RADAR 今日資料尚未更新' }],
    good: 'RADAR 今天的資料還沒更新，現在沒辦法給出可靠的清單。更新完成後我再整理；不會用舊資料冒充今天的。',
    bad: [{ reply: '今天值得看的有 2330、2454、3008。', rule: 'error-honest' }]
  }
];

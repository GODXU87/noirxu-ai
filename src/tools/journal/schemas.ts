import { z } from 'zod';
import { isCalendarDate } from '@/lib/dates';

// Enumerations copied from noirxu-trading-journal app/page.js @ 804ac82.
export const MARKETS = ['TW', 'US', 'CRYPTO', 'FX'] as const;
export const SIDES = ['LONG', 'SHORT'] as const;
export const TRADE_TYPES = ['DAY', 'SWING', 'POSITION', 'INVEST'] as const;
export const QUANTITY_UNITS = ['ODD_LOT', 'LOT', 'SHARE', 'COIN'] as const;
export const MARKET_CURRENCY: Record<(typeof MARKETS)[number], string> = { TW: 'TWD', US: 'USD', CRYPTO: 'USD', FX: 'JPY' };

const calendarDate = z.string().refine(isCalendarDate, '日期需為 YYYY-MM-DD');
const money = z.number().min(0);

export const tradeRow = z.object({
  id: z.string(),
  market: z.string(),
  symbol: z.string(),
  asset_name: z.string().nullable(),
  side: z.string(),
  currency: z.string(),
  trade_type: z.string().nullable(),
  strategy: z.string().nullable(),
  status: z.enum(['open', 'closed']),
  open_quantity: z.number(),
  average_entry_price: z.number().nullable(),
  average_exit_price: z.number().nullable(),
  realized_pnl: z.number(),
  total_fees: z.number(),
  total_tax: z.number(),
  first_entry_date: z.string().nullable(),
  close_date: z.string().nullable(),
  execution_count: z.number()
});

export const tradesListInput = z.object({
  status: z.enum(['open', 'closed', 'all']).default('all'),
  symbol: z.string().trim().toUpperCase().optional(),
  from: calendarDate.optional().describe('依首次進場日篩選（含）'),
  to: calendarDate.optional(),
  limit: z.number().int().min(1).max(200).default(50)
}).strict();
export const tradesListOutput = z.object({ total_matching: z.number(), trades: z.array(tradeRow) });

const tradeBase = {
  market: z.enum(MARKETS),
  symbol: z.string().trim().min(1).max(32).transform(value => value.toUpperCase()).describe('代號，例如 2330、AAPL'),
  asset_name: z.string().trim().max(80).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).describe('計價幣別；台股 TWD、美股 USD'),
  side: z.enum(SIDES),
  trade_type: z.enum(TRADE_TYPES).describe('DAY 當沖 / SWING 波段 / POSITION 中長線 / INVEST 投資'),
  quantity: z.number().positive().describe('使用者說的數量（依 quantity_unit）'),
  quantity_unit: z.enum(QUANTITY_UNITS).describe('台股：ODD_LOT 股、LOT 張；加密貨幣 COIN；其他 SHARE'),
  entry_price: z.number().positive().describe('使用者明確提供的成交價，不可推測'),
  entry_date: calendarDate,
  entry_fee: money.describe('手續費；Journal 不會自動計算，需由使用者提供（未付可填 0，但須使用者確認）'),
  entry_tax: money.describe('交易稅；同上'),
  strategy: z.string().trim().max(60).optional(),
  reason: z.string().trim().max(500).optional()
};

export const tradeCreateInput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('OPEN'),
    ...tradeBase,
    /** If set, adds this fill to an existing open position instead of opening a new one. */
    add_to_position_id: z.uuid().optional(),
    /** Must be true to open a separate position when one is already open for the same market/symbol/side. */
    allow_separate_position: z.boolean().default(false)
  }).strict(),
  z.object({
    status: z.literal('CLOSED'),
    ...tradeBase,
    exit_price: z.number().positive(),
    exit_date: calendarDate,
    exit_fee: money,
    exit_tax: money
  }).strict()
]);

export const tradeCreateOutput = z.object({
  position_id: z.string(),
  action: z.enum(['opened', 'closed_trade', 'added_to_position']),
  symbol: z.string(),
  market: z.string()
});

const dateRange = {
  from: calendarDate.optional().describe('依平倉日篩選（含）'),
  to: calendarDate.optional()
};
export const performanceInput = z.object(dateRange).strict();

const currencyPerformance = z.object({
  currency: z.string(),
  closed_trades: z.number(),
  wins: z.number(),
  losses: z.number(),
  breakeven: z.number(),
  win_rate_pct: z.number().nullable(),
  net_pnl: z.number(),
  gross_profit: z.number(),
  gross_loss: z.number(),
  profit_factor: z.number().nullable(),
  average_win: z.number().nullable(),
  average_loss: z.number().nullable()
});

export const performanceOutput = z.object({
  range: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  /** P&L is never summed across currencies. */
  by_currency: z.array(currencyPerformance),
  max_win_streak: z.number(),
  max_loss_streak: z.number(),
  average_hold_days: z.number().nullable(),
  open_positions: z.number()
});

export const statisticsInput = z.object({
  group_by: z.enum(['strategy', 'symbol', 'market', 'weekday', 'side', 'trade_type']),
  ...dateRange
}).strict();

export const statisticsOutput = z.object({
  group_by: z.string(),
  groups: z.array(z.object({
    key: z.string(),
    currency: z.string(),
    count: z.number(),
    wins: z.number(),
    losses: z.number(),
    win_rate_pct: z.number().nullable(),
    net_pnl: z.number(),
    average_hold_days: z.number().nullable()
  }))
});

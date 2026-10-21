import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { defineTool } from '@/hub/registry';
import type { SourceLink, ToolDefinition } from '@/hub/types';
import { mapSupabaseError, type SupabaseUserConnection } from '@/connections/supabase-user';
import { taipeiDate } from '@/lib/dates';
import { averageHoldDays, closedTradeRows, streakStats, weekdayLabel } from '@/vendor/journal/analytics-engine.mjs';
import { financialAdd, financialNumber, financialSign } from '@/vendor/journal/financial-math.mjs';
import { actualQuantity, buildSnapshots } from '@/vendor/journal/trading-engine.mjs';
import {
  performanceInput, performanceOutput, statisticsInput, statisticsOutput, tradeCreateInput, tradeCreateOutput, tradesListInput, tradesListOutput
} from './schemas';

export interface JournalDeps {
  connection: SupabaseUserConnection;
  appUrl: string | null;
}

type Snapshot = Record<string, any>;
type TradeInput = z.output<typeof tradeCreateInput>;

const PAGE = 1000;
const ALLOWED_UNITS: Record<string, string[]> = { TW: ['ODD_LOT', 'LOT'], CRYPTO: ['COIN'], US: ['SHARE'], FX: ['SHARE'] };

async function fetchAll(client: SupabaseClient, table: string, accountId: string, order: Array<[string, boolean]>) {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let query = client.from(table).select('*').eq('user_id', accountId);
    for (const [column, ascending] of order) query = query.order(column, { ascending });
    const { data, error } = await query.range(offset, offset + PAGE - 1);
    if (error) throw mapSupabaseError(error, 'read');
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/** Same tables, ordering and P&L engine the Journal web app uses (app/page.js loadData + trading-engine.js). */
async function loadSnapshots(client: SupabaseClient, accountId: string): Promise<Snapshot[]> {
  if (!accountId) throw new ToolError('NOT_CONNECTED', 'Journal 連線缺少帳號資訊，請重新連接。');
  const [positions, executions] = await Promise.all([
    fetchAll(client, 'journal_positions', accountId, [['created_at', false]]),
    fetchAll(client, 'journal_executions', accountId, [['executed_at', true], ['execution_sequence', true], ['created_at', true]])
  ]);
  return buildSnapshots(positions, executions) as Snapshot[];
}

function dateOnly(value: unknown): string | null {
  return value ? String(value).slice(0, 10) : null;
}

function presentTrade(snapshot: Snapshot) {
  const executions = (snapshot.executions ?? []) as Snapshot[];
  const entries = executions.filter(row => row.kind === 'ENTRY');
  const exits = executions.filter(row => row.kind === 'EXIT');
  return {
    id: String(snapshot.id),
    market: String(snapshot.market),
    symbol: String(snapshot.symbol),
    asset_name: snapshot.asset_name ?? null,
    side: String(snapshot.side),
    currency: String(snapshot.currency),
    trade_type: snapshot.trade_type ?? null,
    strategy: snapshot.strategy ?? null,
    status: snapshot.isOpen ? 'open' as const : 'closed' as const,
    open_quantity: Number(snapshot.openQuantity ?? 0),
    average_entry_price: snapshot.averageEntryPrice ?? null,
    average_exit_price: snapshot.averageExitPrice ?? null,
    realized_pnl: Number(snapshot.realizedPnl ?? 0),
    total_fees: Number(snapshot.totalFees ?? 0),
    total_tax: Number(snapshot.totalTax ?? 0),
    first_entry_date: dateOnly(entries[0]?.executed_at),
    close_date: snapshot.isOpen ? null : dateOnly(exits.at(-1)?.executed_at),
    execution_count: executions.length
  };
}

function inRange(date: string | null, from?: string, to?: string) {
  if (!date) return false;
  return (!from || date >= from) && (!to || date <= to);
}

function taipeiTime(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
}

function journalLinks(appUrl: string | null): SourceLink[] {
  return appUrl ? [{ label: '在 NOIRXU Trading Journal 查看', url: appUrl }] : [];
}

/** Mirrors the checks NewTradeComposer runs before calling the RPCs. */
async function validateTrade(client: SupabaseClient, accountId: string, value: TradeInput, today: string) {
  const warnings: string[] = [];
  if (!ALLOWED_UNITS[value.market].includes(value.quantity_unit)) {
    throw new ToolError('INVALID_INPUT', `${value.market} 市場的數量單位只能是 ${ALLOWED_UNITS[value.market].join(' / ')}。`);
  }
  if (value.market === 'TW' && value.quantity_unit === 'ODD_LOT' && value.quantity > 999) throw new ToolError('INVALID_INPUT', '零股數量需小於 1,000 股。');
  if (value.entry_date > today) throw new ToolError('INVALID_INPUT', '進場日期不能是未來日期。');
  if (value.status === 'CLOSED') {
    if (value.exit_date < value.entry_date) throw new ToolError('INVALID_INPUT', '出場日期不能早於進場日期。');
    if (value.exit_date > today) throw new ToolError('INVALID_INPUT', '出場日期不能是未來日期。');
    if (value.trade_type === 'DAY' && value.exit_date !== value.entry_date) throw new ToolError('INVALID_INPUT', '當沖交易的進場與出場日期必須相同。');
  }

  const snapshots = await loadSnapshots(client, accountId);
  const sameInstrument = snapshots.filter(item => item.isOpen && item.market === value.market && String(item.symbol).toUpperCase() === value.symbol && item.side === value.side);
  let target: Snapshot | undefined;

  if (value.status === 'OPEN' && value.add_to_position_id) {
    target = sameInstrument.find(item => item.id === value.add_to_position_id);
    if (!target) throw new ToolError('INVALID_INPUT', '指定的持倉不存在、已平倉，或代號/方向不符。');
    if (target.trade_type === 'DAY' && dateOnly((target.executions ?? [])[0]?.executed_at)! < today) throw new ToolError('UPSTREAM_REJECTED', '歷史當沖不能保留為未平倉，請在 Journal 網站處理。');
  } else {
    if (value.status === 'OPEN' && value.trade_type === 'DAY' && value.entry_date < today) throw new ToolError('INVALID_INPUT', '歷史當沖不能保留為未平倉；請改為已平倉紀錄，或將週期改為波段。');
    if (value.status === 'OPEN' && sameInstrument.length && !value.allow_separate_position) {
      throw new ToolError('NEEDS_USER_DECISION', `${value.symbol} 已有 ${sameInstrument.length} 筆未平倉持倉。請使用者決定：加碼到既有持倉（add_to_position_id），或另開一筆新持倉（allow_separate_position: true）。`, {
        open_positions: sameInstrument.map(item => ({ id: item.id, open_quantity: item.openQuantity, average_entry_price: item.averageEntryPrice }))
      });
    }
    const { data: entitlements, error } = await client.rpc('journal_get_my_entitlements');
    if (error) throw mapSupabaseError(error, 'read');
    const limit = Number((Array.isArray(entitlements) ? entitlements[0] : entitlements)?.position_limit);
    if (Number.isFinite(limit) && snapshots.length >= limit) throw new ToolError('UPSTREAM_REJECTED', `目前方案最多保存 ${limit} 筆交易紀錄，已達上限。`);
  }
  if (value.entry_fee === 0 && value.entry_tax === 0) warnings.push('手續費與交易稅皆為 0，請確認是否正確。');
  return { target, warnings };
}

export function journalTools(deps: JournalDeps): ToolDefinition[] {
  return [
    defineTool({
      name: 'journal.trades.list',
      description: '查詢 NOIRXU Trading Journal 的交易紀錄（持倉與已平倉），損益以 Journal 的計算引擎算出。',
      connection: 'journal',
      kind: 'read',
      input: tradesListInput,
      output: tradesListOutput,
      async run(value, ctx) {
        const { client, accountId } = await deps.connection.client(ctx.userId);
        const rows = (await loadSnapshots(client, accountId)).map(presentTrade)
          .filter(row => value.status === 'all' || row.status === value.status)
          .filter(row => !value.symbol || row.symbol.toUpperCase() === value.symbol)
          .filter(row => (!value.from && !value.to) || inRange(row.first_entry_date, value.from, value.to));
        return { data: { total_matching: rows.length, trades: rows.slice(0, value.limit) }, links: journalLinks(deps.appUrl) };
      }
    }),
    defineTool({
      name: 'journal.trade.create',
      description: '在 NOIRXU Trading Journal 新增一筆交易「紀錄」（不是下單）。市場、代號、方向、數量、價格、日期、手續費與稅都必須由使用者提供；缺少就詢問。需要使用者確認後才會寫入。',
      connection: 'journal',
      kind: 'write',
      input: tradeCreateInput,
      output: tradeCreateOutput,
      async preview(value, ctx) {
        const { client, accountId } = await deps.connection.client(ctx.userId);
        const { target, warnings } = await validateTrade(client, accountId, value, taipeiDate(ctx.now()));
        const unitLabel = { ODD_LOT: '股', LOT: '張', SHARE: '股', COIN: '顆' }[value.quantity_unit];
        const fields = [
          { label: '動作', value: target ? `加碼既有持倉 ${target.id}` : value.status === 'OPEN' ? '新增未平倉持倉' : '新增已平倉交易' },
          { label: '標的', value: `${value.market} ${value.symbol}${value.asset_name ? ` ${value.asset_name}` : ''}` },
          { label: '方向 / 週期', value: `${value.side === 'LONG' ? '做多' : '做空'} / ${value.trade_type}` },
          { label: '數量', value: `${value.quantity} ${unitLabel}（${actualQuantity(value.market, value.quantity_unit, value.quantity)} 單位）` },
          { label: '進場', value: `${value.entry_date} @ ${value.currency} ${value.entry_price}` },
          { label: '進場手續費 / 稅', value: `${value.entry_fee} / ${value.entry_tax}` }
        ];
        if (value.status === 'CLOSED') {
          fields.push({ label: '出場', value: `${value.exit_date} @ ${value.currency} ${value.exit_price}` });
          fields.push({ label: '出場手續費 / 稅', value: `${value.exit_fee} / ${value.exit_tax}` });
        }
        if (value.strategy) fields.push({ label: '策略', value: value.strategy });
        if (value.reason) fields.push({ label: '理由', value: value.reason });
        return { title: '新增 Trading Journal 交易紀錄', fields, warnings: ['這只是交易紀錄，不會下單。', ...warnings] };
      },
      async run(value, ctx) {
        const { client, accountId } = await deps.connection.client(ctx.userId);
        const now = ctx.now();
        const { target } = await validateTrade(client, accountId, value, taipeiDate(now));
        const quantity = actualQuantity(value.market, value.quantity_unit, value.quantity);
        const time = taipeiTime(now);
        const common = {
          p_quantity: quantity, p_quantity_display: value.quantity, p_quantity_unit: value.quantity_unit
        };
        let positionId: string;
        let action: 'opened' | 'closed_trade' | 'added_to_position';

        // Same RPCs and arguments as NewTradeComposer in the Journal web app (app/page.js).
        if (value.status === 'OPEN' && target) {
          const { error } = await client.rpc('journal_add_entry_with_targets_v1', {
            p_position_id: target.id, ...common, p_price: value.entry_price, p_executed_at: value.entry_date, p_executed_time: time,
            p_fee: value.entry_fee, p_tax: value.entry_tax, p_note: value.reason || null,
            p_apply_targets: false, p_take_profit: target.take_profit ?? null, p_stop_loss: target.stop_loss ?? null
          });
          if (error) throw mapSupabaseError(error, 'write');
          positionId = String(target.id);
          action = 'added_to_position';
        } else if (value.status === 'OPEN') {
          const { data, error } = await client.rpc('journal_create_open_position_with_playbook_v1', {
            p_market: value.market, p_symbol: value.symbol, p_asset_name: value.asset_name || null, p_currency: value.currency, p_side: value.side,
            ...common, p_price: value.entry_price, p_executed_at: value.entry_date, p_executed_time: time, p_trade_type: value.trade_type,
            p_strategy: value.strategy || null, p_reason: value.reason || null, p_fee: value.entry_fee, p_tax: value.entry_tax,
            p_planned_entry: null, p_initial_stop: null, p_initial_take_profit: null, p_planned_risk_amount: null, p_playbook_version_id: null
          });
          if (error) throw mapSupabaseError(error, 'write');
          positionId = String(data ?? '');
          action = 'opened';
        } else {
          const { data, error } = await client.rpc('journal_create_closed_trade_with_playbook_v1', {
            p_market: value.market, p_symbol: value.symbol, p_asset_name: value.asset_name || null, p_currency: value.currency, p_side: value.side,
            ...common, p_entry_price: value.entry_price, p_entry_at: value.entry_date, p_entry_time: time,
            p_exit_price: value.exit_price, p_exit_at: value.exit_date, p_exit_time: time, p_trade_type: value.trade_type,
            p_strategy: value.strategy || null, p_reason: value.reason || null,
            p_entry_fee: value.entry_fee, p_entry_tax: value.entry_tax, p_exit_fee: value.exit_fee, p_exit_tax: value.exit_tax,
            p_planned_entry: null, p_initial_stop: null, p_initial_take_profit: null, p_planned_risk_amount: null, p_playbook_version_id: null
          });
          if (error) throw mapSupabaseError(error, 'write');
          positionId = String(data ?? '');
          action = 'closed_trade';
        }
        if (!positionId) throw new ToolError('OUTCOME_UNKNOWN', 'Journal 沒有回傳紀錄 ID，請到 Journal 確認是否已建立。');
        return { data: { position_id: positionId, action, symbol: value.symbol, market: value.market }, recordId: positionId, links: journalLinks(deps.appUrl) };
      },
      async reconcile(value, ctx, meta) {
        // Journal's create RPCs have no idempotency key yet, so list what may have been written.
        const { client, accountId } = await deps.connection.client(ctx.userId);
        const since = meta.startedAt.getTime() - 5_000;
        const candidates = (await loadSnapshots(client, accountId))
          .filter(item => String(item.symbol).toUpperCase() === value.symbol && item.market === value.market)
          .filter(item => (item.executions ?? []).some((row: Snapshot) => Date.parse(String(row.created_at)) >= since))
          .map(presentTrade);
        return { candidates, links: journalLinks(deps.appUrl) };
      }
    }),
    defineTool({
      name: 'journal.performance.summary',
      description: '分析 Trading Journal 已平倉交易的績效：勝率、淨損益、獲利因子、平均盈虧、連勝連敗、平均持有天數。損益依幣別分開，不會跨幣別加總。',
      connection: 'journal',
      kind: 'read',
      input: performanceInput,
      output: performanceOutput,
      async run(value, ctx) {
        const { client, accountId } = await deps.connection.client(ctx.userId);
        const snapshots = await loadSnapshots(client, accountId);
        const rows = (closedTradeRows(snapshots) as Snapshot[]).filter(row => inRange(dateOnly(row.closeDate), value.from, value.to));
        const byCurrency = new Map<string, Snapshot[]>();
        for (const row of rows) byCurrency.set(row.currency, [...(byCurrency.get(row.currency) ?? []), row]);
        const streaks = streakStats(rows as never[]);
        return {
          data: {
            range: { from: value.from ?? null, to: value.to ?? null },
            by_currency: [...byCurrency.entries()].map(([currency, group]) => {
              const wins = group.filter(row => financialSign(row.nativePnl) > 0);
              const losses = group.filter(row => financialSign(row.nativePnl) < 0);
              const sum = (items: Snapshot[]) => items.reduce((total, row) => financialAdd(total, row.nativePnl), 0);
              const grossProfit = financialNumber(sum(wins));
              const grossLoss = financialNumber(sum(losses));
              const decided = wins.length + losses.length;
              return {
                currency,
                closed_trades: group.length,
                wins: wins.length,
                losses: losses.length,
                breakeven: group.length - decided,
                win_rate_pct: decided ? Math.round((wins.length / decided) * 1000) / 10 : null,
                net_pnl: financialNumber(sum(group)),
                gross_profit: grossProfit,
                gross_loss: grossLoss,
                profit_factor: grossLoss < 0 ? Math.round((grossProfit / Math.abs(grossLoss)) * 100) / 100 : null,
                average_win: wins.length ? grossProfit / wins.length : null,
                average_loss: losses.length ? grossLoss / losses.length : null
              };
            }),
            max_win_streak: streaks.maxWin,
            max_loss_streak: streaks.maxLoss,
            average_hold_days: averageHoldDays(rows),
            open_positions: snapshots.filter(item => item.isOpen).length
          },
          links: journalLinks(deps.appUrl)
        };
      }
    }),
    defineTool({
      name: 'journal.statistics.get',
      description: '依策略、代號、市場、星期、方向或週期分組統計 Trading Journal 已平倉交易。',
      connection: 'journal',
      kind: 'read',
      input: statisticsInput,
      output: statisticsOutput,
      async run(value, ctx) {
        const { client, accountId } = await deps.connection.client(ctx.userId);
        const snapshots = await loadSnapshots(client, accountId);
        const tradeType = new Map(snapshots.map(item => [String(item.id), String(item.trade_type ?? '未分類')]));
        const keyOf: Record<typeof value.group_by, (row: Snapshot) => string> = {
          strategy: row => row.strategy || '未分類',
          symbol: row => row.symbol,
          market: row => row.market,
          weekday: row => weekdayLabel(row.closeDate),
          side: row => row.side,
          trade_type: row => tradeType.get(String(row.id)) ?? '未分類'
        };
        const groups = new Map<string, { key: string; currency: string; rows: Snapshot[] }>();
        for (const row of (closedTradeRows(snapshots) as Snapshot[]).filter(item => inRange(dateOnly(item.closeDate), value.from, value.to))) {
          const key = keyOf[value.group_by](row);
          const id = `${key}\u0000${row.currency}`;
          const group = groups.get(id) ?? { key, currency: String(row.currency), rows: [] as Snapshot[] };
          group.rows.push(row);
          groups.set(id, group);
        }
        return {
          data: {
            group_by: value.group_by,
            groups: [...groups.values()].map(group => {
              const wins = group.rows.filter(row => financialSign(row.nativePnl) > 0).length;
              const losses = group.rows.filter(row => financialSign(row.nativePnl) < 0).length;
              return {
                key: group.key,
                currency: group.currency,
                count: group.rows.length,
                wins,
                losses,
                win_rate_pct: wins + losses ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
                net_pnl: financialNumber(group.rows.reduce((total, row) => financialAdd(total, row.nativePnl), 0)),
                average_hold_days: averageHoldDays(group.rows)
              };
            }).sort((a, b) => b.count - a.count)
          },
          links: journalLinks(deps.appUrl)
        };
      }
    })
  ];
}

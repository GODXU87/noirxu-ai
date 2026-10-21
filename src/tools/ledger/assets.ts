import { z } from 'zod';
import { defineTool } from '@/hub/registry';
import type { ToolDefinition } from '@/hub/types';
import { mapSupabaseError } from '@/connections/supabase-user';
import { taipeiDate } from '@/lib/dates';
import { assetCurrencySummary, assetMonthComparison, assetSnapshot } from '@/vendor/ledger/asset-model.mjs';
import { liabilityBalance, netWorthSnapshot } from '@/vendor/ledger/net-worth-model.mjs';
import type { LedgerDeps } from './tools';

async function select(client: any, table: string, order: string[] = []) {
  let query = client.from(table).select('*');
  for (const column of order) query = query.order(column);
  const { data, error } = await query;
  if (error) throw mapSupabaseError(error, 'read');
  return (data ?? []) as Record<string, any>[];
}

/** Ledger's asset module (accounts, valuations, credit-card liabilities), computed with Ledger's own models. */
export function ledgerAssetTools(deps: LedgerDeps): ToolDefinition[] {
  return [
    defineTool({
      name: 'ledger.assets.summary',
      description: '取得 NOIRXU Ledger 的資產總覽：各資產帳戶最新估值、資產配置比例、外幣部位、信用卡待繳負債、淨資產，以及與上月比較（TWD）。計算方式與 Ledger 網站相同。',
      connection: 'ledger',
      kind: 'read',
      input: z.object({}).strict(),
      output: z.object({
        as_of: z.string(),
        gross_assets: z.number(),
        liabilities: z.number(),
        net_worth: z.number(),
        month_change: z.object({ previous: z.number(), delta: z.number(), percentage: z.number().nullable() }),
        allocation: z.array(z.object({ name: z.string(), amount: z.number(), percentage: z.number() })),
        accounts: z.array(z.object({ name: z.string(), category: z.string(), currency: z.string(), amount_twd: z.number(), native_amount: z.number(), valued_on: z.string().nullable() })),
        foreign_currency: z.array(z.object({ currency_code: z.string(), native_amount: z.number(), amount_twd: z.number() }))
      }),
      async run(_value, ctx) {
        const { client } = await deps.connection.client(ctx.userId);
        const asOf = taipeiDate(ctx.now());
        const [categories, accounts, valuations, movements] = await Promise.all([
          select(client, 'ledger_asset_categories', ['sort_order']),
          select(client, 'ledger_asset_accounts', ['created_at']),
          select(client, 'ledger_asset_valuations', ['valued_on', 'created_at']),
          select(client, 'ledger_liability_movements', ['occurred_on', 'created_at'])
        ]);
        const snapshot = assetSnapshot(accounts, valuations, categories, asOf);
        const liabilities = liabilityBalance(movements, asOf);
        const worth = netWorthSnapshot({ grossAssets: snapshot.total, liabilities });
        const change = assetMonthComparison(accounts, valuations, asOf.slice(0, 7));
        const categoryName = new Map(categories.map(c => [c.id, String(c.name)]));
        return {
          data: {
            as_of: asOf,
            gross_assets: worth.gross_assets,
            liabilities: worth.liabilities,
            net_worth: worth.net_worth,
            month_change: { previous: Number(change.previous), delta: Number(change.delta), percentage: change.percentage ?? null },
            allocation: snapshot.allocation.map((a: Record<string, any>) => ({ name: String(a.name), amount: Number(a.amount), percentage: Number(a.percentage) })),
            accounts: snapshot.accounts.map((a: Record<string, any>) => ({
              name: String(a.name ?? ''), category: categoryName.get(a.category_id) ?? '未分類', currency: String(a.currency_code),
              amount_twd: Number(a.amount), native_amount: Number(a.native_amount), valued_on: a.valuation?.valued_on ? String(a.valuation.valued_on).slice(0, 10) : null
            })),
            foreign_currency: assetCurrencySummary(snapshot.accounts)
          },
          links: deps.appUrl ? [{ label: '在 Ledger 查看資產', url: deps.appUrl }] : []
        };
      }
    })
  ];
}

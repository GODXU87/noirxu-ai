import { z } from 'zod';
import { buildResearchReport, type ConfluenceRow, type NoirxuListRow, type TechnicalRow } from '@/research/screen';
import { defineTool } from '@/hub/registry';
import type { InvokeResult, ToolContext, ToolDefinition } from '@/hub/types';
import type { RadarClient } from '@/tools/radar/tools';

interface Deps { radar: RadarClient; invoke: (name: string, input: unknown, ctx: ToolContext) => Promise<InvokeResult> }

/** Manual research run (C3 prototype): RADAR read-only API + Journal positions, no AI, no schedule. */
export function researchTools(deps: Deps): ToolDefinition[] {
  return [
    defineTool({
      name: 'research.run',
      description: '手動執行一次台股研究（盤前或盤後）：用 RADAR 已發布的清單篩出最多 5 檔研究候選，附 RADAR 資料日期、進場與失效條件、風險與缺少的資料。RADAR 還沒更新到應有的交易日時不產生候選。不是投資建議，不會下單。',
      connection: 'radar',
      kind: 'read',
      input: z.object({ kind: z.enum(['premarket', 'postmarket']).default('postmarket') }).strict(),
      output: z.record(z.string(), z.unknown()),
      async run(value, ctx) {
        const scan = async (kind: string, limit: number) => deps.radar.get(`/api/integration/v1/signals?${new URLSearchParams({ kind, limit: String(limit) })}`);
        const [list, confluence, technical] = await Promise.all([scan('noirxu_list', 30), scan('confluence', 50), scan('technical', 50)]);
        const rows = (r: any) => (r?.data?.rows ?? []) as any[];
        let heldSymbols: string[] | null = null;
        const trades = await deps.invoke('journal.trades.list', { status: 'open', limit: 200 }, ctx);
        if (trades.status === 'ok') heldSymbols = ((trades.data as { trades: Array<{ symbol: string }> }).trades ?? []).map(t => t.symbol);
        const report = buildResearchReport({
          kind: value.kind, now: ctx.now(), publication: (list as any)?.publication ?? null,
          noirxuList: rows(list) as NoirxuListRow[], confluence: rows(confluence) as ConfluenceRow[], technical: rows(technical) as TechnicalRow[], heldSymbols
        });
        return { data: report as unknown as Record<string, unknown>, links: deps.radar.link('/', '在 RADAR 查看') };
      }
    })
  ];
}

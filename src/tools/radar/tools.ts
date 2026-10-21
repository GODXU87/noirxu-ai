import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { defineTool } from '@/hub/registry';
import type { SourceLink, ToolDefinition } from '@/hub/types';

export interface RadarConfig {
  /** Base URL of the RADAR deployment that serves /api/integration/v1. */
  apiUrl: string | null;
  token: string | null;
  /** Public RADAR site, for source links. Usually the same as apiUrl. */
  appUrl: string | null;
}

const publication = z.object({ trade_date: z.string(), published_at: z.string().nullable() });
const radarEnvelope = z.object({ ok: z.literal(true), publication, data: z.unknown() });
const radarOutput = z.object({
  publication: publication.describe('RADAR 這份資料的交易日；回覆時必須告訴使用者'),
  data: z.unknown()
});

export const SIGNAL_KINDS = ['technical', 'chip', 'confluence', 'credit', 'fundamental', 'potential', 'strength_stage', 'stronger_than_market', 'noirxu_list'] as const;
const SIGNAL_PAGES: Record<(typeof SIGNAL_KINDS)[number], string> = {
  technical: '/technical', chip: '/chip', confluence: '/confluence', credit: '/credit', fundamental: '/fundamental',
  potential: '/potential', strength_stage: '/potential', stronger_than_market: '/strong', noirxu_list: '/plan'
};

export class RadarClient {
  constructor(private readonly config: RadarConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  get configured(): boolean {
    return Boolean(this.config.apiUrl && this.config.token);
  }

  async get(path: string): Promise<z.output<typeof radarOutput>> {
    if (!this.configured) throw new ToolError('NOT_CONFIGURED', 'RADAR 整合 API 尚未設定（RADAR_INTEGRATION_URL / RADAR_INTEGRATION_TOKEN）。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.config.apiUrl!).toString(), {
        headers: { Authorization: `Bearer ${this.config.token}`, Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal
      });
    } catch {
      throw new ToolError('UPSTREAM_UNAVAILABLE', 'RADAR 暫時無法連線。');
    } finally {
      clearTimeout(timer);
    }
    const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
    if (response.status === 401) throw new ToolError('UNAUTHORIZED', 'RADAR 拒絕了整合 token。');
    if (response.status === 404) throw new ToolError('NOT_FOUND', 'RADAR 最新資料中找不到這個項目。');
    if (response.status === 503 && body?.error?.code === 'NOT_CONFIGURED') throw new ToolError('NOT_CONFIGURED', 'RADAR 端尚未設定整合 token。');
    if (!response.ok) throw new ToolError('UPSTREAM_UNAVAILABLE', `RADAR 回傳錯誤（${response.status}）。`);
    const parsed = radarEnvelope.safeParse(body);
    if (!parsed.success) throw new ToolError('INVALID_OUTPUT', 'RADAR 回傳格式不符，已停止處理。');
    return { publication: parsed.data.publication, data: parsed.data.data };
  }

  link(path: string, label: string): SourceLink[] {
    return this.config.appUrl ? [{ label, url: new URL(path, this.config.appUrl).toString() }] : [];
  }
}

const RESEARCH_NOTE = '只能根據回傳的 RADAR 資料分析，回覆需註明資料交易日、訊號、理由、風險與不確定性；不是投資建議，不保證報酬。';

export function radarTools(radar: RadarClient): ToolDefinition[] {
  return [
    defineTool({
      name: 'radar.status',
      description: '查詢 RADAR 最新發布的資料交易日與各資料來源狀態。',
      connection: 'radar',
      kind: 'read',
      input: z.object({}).strict(),
      output: radarOutput,
      async run() {
        return { data: await radar.get('/api/integration/v1/status'), links: radar.link('/radar', '開啟 RADAR') };
      }
    }),
    defineTool({
      name: 'radar.stock.search',
      description: '用名稱或代號在 RADAR 搜尋台股個股、產業與題材，取得 market（TWSE/TPEX）與代號。',
      connection: 'radar',
      kind: 'read',
      input: z.object({ query: z.string().trim().min(1).max(40), limit: z.number().int().min(1).max(30).default(10) }).strict(),
      output: radarOutput,
      async run(value) {
        const params = new URLSearchParams({ q: value.query, limit: String(value.limit) });
        return { data: await radar.get(`/api/integration/v1/search?${params}`), links: radar.link(`/search?q=${encodeURIComponent(value.query)}`, '在 RADAR 搜尋') };
      }
    }),
    defineTool({
      name: 'radar.stock.analyze',
      description: `取得 RADAR 對單一個股的完整資料：Radar 分數與歷史、報酬、均線/RSI/MACD/量比等技術面、法人與籌碼、融資券、基本面、所屬產業與題材。${RESEARCH_NOTE}`,
      connection: 'radar',
      kind: 'read',
      input: z.object({ market: z.enum(['TWSE', 'TPEX']), symbol: z.string().regex(/^\d{4,6}$/) }).strict(),
      output: radarOutput,
      async run(value) {
        return {
          data: await radar.get(`/api/integration/v1/stock/${value.market}/${value.symbol}`),
          links: radar.link(`/stock/${value.market}/${value.symbol}`, `在 RADAR 查看 ${value.symbol}`)
        };
      }
    }),
    defineTool({
      name: 'radar.signals.scan',
      description: `取得 RADAR 當日掃描清單（技術、籌碼、共振、融資券、基本面、潛力、強度階段、強於大盤、NOIRXU 清單）。${RESEARCH_NOTE}`,
      connection: 'radar',
      kind: 'read',
      input: z.object({ kind: z.enum(SIGNAL_KINDS), limit: z.number().int().min(1).max(50).default(20) }).strict(),
      output: radarOutput,
      async run(value) {
        const params = new URLSearchParams({ kind: value.kind, limit: String(value.limit) });
        return { data: await radar.get(`/api/integration/v1/signals?${params}`), links: radar.link(SIGNAL_PAGES[value.kind], '在 RADAR 查看清單') };
      }
    }),
    defineTool({
      name: 'radar.sectors.analyze',
      description: `取得 RADAR 當日產業與題材資金流分數、排名、變化與指標。${RESEARCH_NOTE}`,
      connection: 'radar',
      kind: 'read',
      input: z.object({}).strict(),
      output: radarOutput,
      async run() {
        return { data: await radar.get('/api/integration/v1/sectors'), links: radar.link('/sectors', '在 RADAR 查看產業') };
      }
    }),
    defineTool({
      name: 'radar.watchlist.get',
      description: '取得 RADAR 觀察清單。',
      connection: 'radar',
      kind: 'read',
      input: z.object({}).strict(),
      output: radarOutput,
      async run() {
        return { data: await radar.get('/api/integration/v1/watchlist'), links: radar.link('/watch', '在 RADAR 查看觀察清單') };
      }
    })
  ];
}

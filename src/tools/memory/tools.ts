import { z } from 'zod';
import { defineTool } from '@/hub/registry';
import type { ToolDefinition } from '@/hub/types';
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryStore } from '@/memory/store';
import { searchMemories } from '@/router/memory';

// Long-term memory tools. Saving is only for what the user asked to keep or clearly confirmed;
// chat content is never stored on its own. Balances, positions and market data are never
// memorised — those always come from the live tools.

const categories = Object.keys(MEMORY_CATEGORIES) as [MemoryCategory, ...MemoryCategory[]];
const view = (m: { id: string; content: string; category: MemoryCategory; updated_at: string }) => ({ id: m.id, content: m.content, category: m.category, category_label: MEMORY_CATEGORIES[m.category], updated_at: m.updated_at });

export function memoryTools(memory: MemoryStore): ToolDefinition[] {
  return [
    defineTool({
      name: 'memory.save',
      description: '把使用者明確要求記住、或明確確認過的長期資訊存進 SASUKE 的個人記憶（偏好、作息與課表、目標、決定、健康注意事項、個人資料）。只在使用者說「記住」「以後都…」等明確要求時使用；不要存一般聊天內容、帳戶餘額、持股或行情。用一句完整、第三人稱的中文描述，例如「週三羽球改到晚上 8 點」。',
      connection: 'internal', kind: 'write', requiresConfirmation: false,
      input: z.object({ content: z.string().trim().min(2).max(300), category: z.enum(categories).optional() }).strict(),
      output: z.record(z.string(), z.unknown()),
      async run(value, ctx) {
        const { memory: m, updated } = await memory.add(ctx.userId, { content: value.content, category: value.category, now: ctx.now() });
        return { data: { memory: view(m), updated } };
      }
    }),
    defineTool({
      name: 'memory.forget',
      description: '刪除一筆個人記憶（不可復原，會先請使用者確認）。id 必須來自 memory.search。',
      connection: 'internal', kind: 'write',
      input: z.object({ id: z.uuid() }).strict(),
      output: z.record(z.string(), z.unknown()),
      async preview(value, ctx) {
        const found = (await memory.list(ctx.userId)).find(m => m.id === value.id);
        return { title: '刪除這筆記憶', fields: [{ label: '內容', value: found?.content ?? '（找不到這筆記憶）' }, { label: '記錄時間', value: found?.updated_at.slice(0, 10) ?? '—' }], warnings: ['刪除後 SASUKE 就不會再記得這件事。'] };
      },
      async run(value, ctx) {
        return { data: { removed: await memory.remove(ctx.userId, value.id) } };
      }
    }),
    defineTool({
      name: 'memory.search',
      description: '在 SASUKE 的個人記憶中找和問題相關的內容（最多 5 筆，含記錄日期；太舊的會標示可能過期）。',
      connection: 'internal', kind: 'read',
      input: z.object({ query: z.string().trim().min(1).max(100) }).strict(),
      output: z.record(z.string(), z.unknown()),
      async run(value, ctx) {
        const hits = searchMemories(await memory.list(ctx.userId), value.query, 5, ctx.now());
        return { data: { memories: hits.map(h => ({ ...view(h.record as Parameters<typeof view>[0]), stale: h.stale })), total: hits.length } };
      }
    })
  ];
}

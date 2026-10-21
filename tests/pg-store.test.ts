import { describe, expect, it } from 'vitest';
import { PgHubStore } from '@/hub/pg-store';

describe('PgHubStore', () => {
  it('transitions with a single compare-and-set statement scoped to noirxu_ai', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = { query: async (text: string, values: unknown[]) => { queries.push({ text, values }); return { rows: [{ doc: { id: 'p1', status: 'executing' } }] }; } };
    const store = new PgHubStore(pool as any);
    const moved = await store.transitionProposal('p1', 'pending', 'executing', { startedAt: 't' });
    expect(moved).toMatchObject({ status: 'executing' });
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toMatch(/update noirxu_ai\.proposals[\s\S]*where id = \$1 and status = \$2/);
    expect(queries[0].values.slice(0, 3)).toEqual(['p1', 'pending', 'executing']);
    expect(JSON.parse(String(queries[0].values[3]))).toEqual({ startedAt: 't', status: 'executing' });
  });

  it('returns null when another request already moved the proposal', async () => {
    const store = new PgHubStore({ query: async () => ({ rows: [] }) } as any);
    expect(await store.transitionProposal('p1', 'pending', 'executing')).toBeNull();
  });
});

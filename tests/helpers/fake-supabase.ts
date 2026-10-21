// Test double for the subset of supabase-js the tools use. Test-only fixtures; never imported by the app.
type Row = Record<string, any>;
type Result = { data: any; error: { code?: string; message?: string } | null };

export interface RpcCall { name: string; args: Row }

export class FakeSupabase {
  readonly rpcCalls: RpcCall[] = [];
  rpcHandlers: Record<string, (args: Row) => Result | Promise<Result>> = {};
  tableErrors: Record<string, Result['error']> = {};

  constructor(public tables: Record<string, Row[]> = {}) {}

  from(table: string) {
    return new Query(this, table);
  }

  async rpc(name: string, args: Row = {}): Promise<Result> {
    this.rpcCalls.push({ name, args });
    const handler = this.rpcHandlers[name];
    if (!handler) return { data: null, error: { code: 'PGRST202', message: `no handler for ${name}` } };
    return handler(args);
  }
}

class Query implements PromiseLike<Result> {
  private filters: Array<(row: Row) => boolean> = [];
  private orders: Array<[string, boolean]> = [];
  private from = 0;
  private to = Number.MAX_SAFE_INTEGER;
  private single = false;

  constructor(private readonly db: FakeSupabase, private readonly table: string) {}

  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push(row => row[column] === value); return this; }
  gte(column: string, value: any) { this.filters.push(row => row[column] >= value); return this; }
  lte(column: string, value: any) { this.filters.push(row => row[column] <= value); return this; }
  order(column: string, options: { ascending?: boolean } = {}) { this.orders.push([column, options.ascending !== false]); return this; }
  range(from: number, to: number) { this.from = from; this.to = to; return this; }
  maybeSingle() { this.single = true; return this; }

  private execute(): Result {
    const error = this.db.tableErrors[this.table];
    if (error) return { data: null, error };
    let rows = (this.db.tables[this.table] ?? []).filter(row => this.filters.every(filter => filter(row)));
    for (const [column, ascending] of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0) * (ascending ? 1 : -1));
    }
    rows = rows.slice(this.from, this.to + 1).map(row => ({ ...row }));
    return { data: this.single ? rows[0] ?? null : rows, error: null };
  }

  then<A = Result, B = never>(onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }
}

/** Stands in for SupabaseUserConnection in tool tests. */
export function fakeConnection(db: FakeSupabase, accountId = 'user-1') {
  return { client: async () => ({ client: db as any, accountId }) } as any;
}

// The SQLite connection the data modules use, as an interface: bun:sqlite's Database is one as it is (src/server/local.ts),
// and a Durable Object's synchronous storage.sql is one through `durableStore` (src/worker/worker.ts).

/** What a `?` takes. */
export type Binding = string | number | bigint | boolean | null | Uint8Array;

export interface Statement<Row, Params extends any[]> {
  get(...params: Params): Row | null;
  all(...params: Params): Row[];
  run(...params: Params): { changes: number; lastInsertRowid: number | bigint };
}

export interface Store {
  // Typed as bun:sqlite's (a list of bindings, or one), so its Database is a Store as it is.
  query<Row = unknown, Params extends Binding | Binding[] = Binding[]>(sql: string): Statement<Row, Params extends any[] ? Params : [Params]>;
  /** One or more statements, no result. */
  run(sql: string): unknown;
  /** `fn` in a transaction (nested: a savepoint); `.immediate` takes the write lock up front. */
  transaction<Args extends unknown[], T>(fn: (...args: Args) => T): ((...args: Args) => T) & { immediate: (...args: Args) => T };
}

/** The part of a Durable Object's storage a Store needs. */
export interface SqlStorage {
  sql: { exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(fn: () => T): T;
}

/**
 * A Durable Object's storage as a Store. Its SQL takes no booleans (it stores "true") or bigints, so they become numbers;
 * one writer at a time, so `.immediate` is a plain transaction.
 */
export function durableStore(storage: SqlStorage): Store {
  const bind = (p: unknown) => (typeof p === "boolean" ? Number(p) : typeof p === "bigint" ? Number(p) : p === undefined ? null : p);
  const exec = (sql: string, params: unknown[]) => storage.sql.exec(sql, ...params.map(bind)).toArray();
  return {
    query: (sql) => ({
      get: (...params) => (exec(sql, params)[0] ?? null) as never,
      all: (...params) => exec(sql, params) as never,
      run: (...params) => {
        exec(sql, params);
        const [r] = exec("SELECT changes() AS changes, last_insert_rowid() AS id", []);
        return { changes: r!.changes as number, lastInsertRowid: r!.id as number };
      },
    }),
    run: (sql) => exec(sql, []),
    transaction: (fn) => {
      const tx = (...args: Parameters<typeof fn>) => storage.transactionSync(() => fn(...args));
      return Object.assign(tx, { immediate: tx });
    },
  };
}

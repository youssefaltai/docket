// Moving a whole database: every table's rows out of one (scripts/import.ts, from a VACUUM INTO snapshot) and into an
// empty one (the Durable Object's), and per-table hashes to show both hold the same.
import { createHash } from "node:crypto";
import type { Store } from "./store.ts";

/** Docket's tables, by name: not SQLite's, the runtime's (_cf_, Miniflare's) or the Durable Object's version row. */
export const tables = (db: Store) =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name != 'docket_meta' ORDER BY name",
    )
    .all()
    .map((t) => t.name);

const columns = (db: Store, table: string) =>
  db
    .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?) ORDER BY cid")
    .all(table)
    .map((c) => `"${c.name}"`);

export type Dump = Record<string, Record<string, unknown>[]>;

/** Every table's rows, as they are. */
export const dump = (db: Store): Dump => Object.fromEntries(tables(db).map((t) => [t, db.query(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]]));

/**
 * Inserts a dump into a database whose tables are all empty, in one transaction: same ids, same values. Foreign keys
 * are checked at the end, so the order of tables and rows doesn't matter. Refuses tables or columns it doesn't have.
 */
export function load(db: Store, data: Dump) {
  const known = new Set(tables(db));
  db.transaction(() => {
    db.run("PRAGMA defer_foreign_keys = ON");
    for (const t of known) if (db.query(`SELECT 1 FROM "${t}" LIMIT 1`).get()) throw new Error(`Refusing to import: ${t} isn't empty`);
    for (const [t, rows] of Object.entries(data)) {
      if (!known.has(t)) throw new Error(`Unknown table ${t}`);
      const have = new Set(columns(db, t));
      for (const row of rows) {
        const names = Object.keys(row).map((c) => `"${c}"`);
        const unknown = names.find((c) => !have.has(c));
        if (unknown) throw new Error(`Unknown column ${t}.${unknown}`);
        db.query(`INSERT INTO "${t}" (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
      }
    }
    const broken = db.query("PRAGMA foreign_key_check").all();
    if (broken.length) throw new Error(`Import broke foreign keys: ${JSON.stringify(broken.slice(0, 5))}`);
  })();
}

/**
 * Per table: its row count and a SHA-256 of every row's values with their SQLite types, in an order that depends on
 * the values alone (not rowids); and `schema`, of the tables' and indexes' SQL without comments. Two databases with the same hashes
 * hold the same data.
 */
export function hashes(db: Store): Record<string, { rows: number; sha256: string }> {
  const out: Record<string, { rows: number; sha256: string }> = {};
  const schema = db
    .query<{ type: string; name: string; sql: string }, []>(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '%docket_meta%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY type, name",
    )
    .all()
    .map((r) => ({ ...r, sql: r.sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ") })); // what it means, not its comments
  out.schema = { rows: schema.length, sha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex") };
  for (const t of tables(db)) {
    const cols = columns(db, t);
    const rows = db.query<Record<string, unknown>, []>(`SELECT ${cols.map((c, i) => `typeof(${c}) AS t${i}, quote(${c}) AS v${i}`).join(", ")} FROM "${t}" ORDER BY ${cols.join(", ")}`).all();
    const hash = createHash("sha256");
    for (const row of rows) hash.update(`${JSON.stringify(Object.values(row))}\n`);
    out[t] = { rows: rows.length, sha256: hash.digest("hex") };
  }
  return out;
}

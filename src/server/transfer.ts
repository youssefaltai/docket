// Moving a whole database in small steps (each request on Workers Free gets 10 ms of CPU): rows into the Durable Object
// a batch at a time (scripts/import.ts), and hashes of a page of rows at a time to show both sides hold the same.
import { createHash } from "node:crypto";
import type { Binding, Store } from "./store.ts";

// Not Docket's data: SQLite's, the runtime's (_cf_…, Miniflare's __…), and the Durable Object's schema version.
const OWN = "name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name != 'docket_meta'";

/** Docket's tables, by name. */
export const tables = (db: Store) =>
  db
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND ${OWN} ORDER BY name`)
    .all()
    .map((t) => t.name);

const columns = (db: Store, table: string) =>
  db
    .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?) ORDER BY cid")
    .all(table)
    .map((c) => `"${c.name}"`);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Inserts a batch of one table's rows as they are (same ids, same values), skipping any already there, so a batch
 * can be sent again. Foreign keys are checked as usual: send tables, and rows, parents first. Refuses unknown tables and columns.
 */
export function load(db: Store, table: string, rows: Record<string, Binding>[]) {
  if (!tables(db).includes(table)) throw new Error(`Unknown table ${table}`);
  const have = new Set(columns(db, table));
  db.transaction(() => {
    for (const row of rows) {
      const names = Object.keys(row).map((c) => `"${c}"`);
      const unknown = names.find((c) => !have.has(c));
      if (unknown) throw new Error(`Unknown column ${table}.${unknown}`);
      db.query(`INSERT OR IGNORE INTO "${table}" (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
    }
  })();
}

/** The tables' and indexes' SQL without comments (what it means), hashed. */
export function schemaHash(db: Store): string {
  const rows = db
    .query<{ type: string; name: string; sql: string }, []>(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND ${OWN} AND tbl_name != 'docket_meta' ORDER BY type, name`)
    .all()
    .map((r) => ({ ...r, sql: r.sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ") }));
  return sha256(JSON.stringify(rows));
}

/**
 * A table's row count, and the hash of rows [offset, offset + limit) in an order that depends on the values alone (not
 * rowids), each row as its values' SQLite types and literals. The same pages of two databases hash the same when they hold the same.
 */
export function pageHash(db: Store, table: string, offset: number, limit: number): { rows: number; sha256: string } {
  if (!tables(db).includes(table)) throw new Error(`Unknown table ${table}`);
  const cols = columns(db, table);
  const page = db
    .query<Record<string, unknown>, [number, number]>(
      `SELECT ${cols.map((c, i) => `typeof(${c}) AS t${i}, quote(${c}) AS v${i}`).join(", ")} FROM "${table}" ORDER BY ${cols.join(", ")} LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);
  const { n } = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get()!;
  return { rows: n, sha256: sha256(page.map((row) => JSON.stringify(Object.values(row))).join("\n")) };
}

/**
 * Up to 500 rows of a table as they are, about 256 KB at most, after `after`, and where to go on from. Pages by rowid;
 * a WITHOUT ROWID table (role_permissions) pages by offset in the order of its values.
 */
export function rowsPage(db: Store, table: string, after: number): { rows: Record<string, unknown>[]; next: number } {
  const rows: Record<string, unknown>[] = [];
  let next = after;
  let size = 0;
  let page: Record<string, unknown>[];
  let byRowid = true;
  try {
    page = db.query<Record<string, unknown>, [number]>(`SELECT rowid AS _rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT 500`).all(after);
  } catch {
    byRowid = false;
    page = db.query<Record<string, unknown>, [number]>(`SELECT * FROM "${table}" ORDER BY ${columns(db, table).join(", ")} LIMIT 500 OFFSET ?`).all(after);
  }
  for (const { _rowid, ...row } of page) {
    size += JSON.stringify(row).length;
    if (rows.length && size > 256 * 1024) break;
    rows.push(row);
    next = byRowid ? (_rowid as number) : next + 1;
  }
  return { rows, next };
}

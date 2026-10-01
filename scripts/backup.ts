// Backs up Docket on Workers to this machine: a dated SQLite snapshot (as backup.sh makes on Bun, so scripts/import.ts
// restores it and bun:sqlite opens it) and a mirror of the attachments, fetching only new or changed ones, each checked
// against R2's MD5. Keeps the newest 14 snapshots. Read-only on the Worker: needs its BACKUP_TOKEN secret, and the token here.
// Usage: BACKUP_TOKEN=… bun scripts/backup.ts <url> <dir>
// Nightly, e.g. cron: 17 3 * * * cd /path/to/docket && BACKUP_TOKEN=… bun scripts/backup.ts https://docket.example.com ~/Backups/docket
// Pages are read one request at a time while Docket runs, so a write meanwhile can land in some tables' pages and not
// others; the snapshot's foreign keys are checked, and a failed check fails the backup (run it again).
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../src/server/schema.ts";
import { load } from "../src/server/transfer.ts";

const KEEP = 14;
const [url, dir] = process.argv.slice(2);
const token = process.env.BACKUP_TOKEN;
if (!url || !dir || !token) {
  console.error("Usage: BACKUP_TOKEN=… bun scripts/backup.ts <url> <dir>");
  process.exit(2);
}
const get = async (path: string) => {
  const res = await fetch(new URL(`/api/backup/${path}`, url), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET /api/backup/${path}: ${res.status} ${await res.text()}`);
  return res;
};
mkdirSync(join(dir, "attachments"), { recursive: true });

// The rows, into a new database with this checkout's schema (which must be the Worker's version).
const file = join(dir, `docket-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.db`);
rmSync(`${file}.part`, { force: true });
const db = new Database(`${file}.part`, { create: true });
migrate(db);
const { tables, version } = (await (await get("tables")).json()) as { tables: string[]; version: number };
const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
if (version !== user_version) throw new Error(`The Worker's schema is version ${version}, this checkout's ${user_version}: update it first`);
db.run("PRAGMA foreign_keys = OFF"); // rows come table by table: checked once all are in
let rows = 0;
for (const table of tables) {
  for (let after = 0; ; ) {
    const page = (await (await get(`rows/${table}?after=${after}`)).json()) as { rows: Record<string, never>[]; next: number };
    if (!page.rows.length) break;
    load(db, table, page.rows);
    rows += page.rows.length;
    after = page.next;
  }
}
const broken = db.query("PRAGMA foreign_key_check").all();
const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
db.close();
if (broken.length || integrity[0]?.integrity_check !== "ok") {
  throw new Error(`The snapshot failed its checks (left as ${file}.part): ${JSON.stringify({ broken: broken.slice(0, 5), integrity })}`);
}
renameSync(`${file}.part`, file);

// The attachments: only those missing here or different from R2, each checked after it's written.
const md5 = (path: string) => createHash("md5").update(readFileSync(path)).digest("hex");
let fetched = 0;
let files = 0;
const bad: string[] = [];
for (let after = ""; ; ) {
  const page = (await (await get(`files?after=${after}`)).json()) as { id: string; md5: string | null }[];
  if (!page.length) break;
  for (const f of page) {
    files++;
    const path = join(dir, "attachments", f.id);
    if (f.md5 === null) bad.push(`${f.id} (not in R2)`);
    else if (!existsSync(path) || md5(path) !== f.md5) {
      await Bun.write(`${path}.part`, await get(`files/${f.id}`));
      if (md5(`${path}.part`) !== f.md5) bad.push(`${f.id} (MD5 differs)`);
      else renameSync(`${path}.part`, path);
      fetched++;
    }
  }
  after = page.at(-1)!.id;
}

// The newest snapshots stay; attachments are never deleted (older snapshots link to them).
const old = readdirSync(dir).filter((f) => /^docket-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.db$/.test(f)).sort().slice(0, -KEEP); // only its own
for (const f of old) rmSync(join(dir, f));
console.log(`${file}: ${rows} rows in ${tables.length} tables. Attachments: ${files}, ${fetched} fetched${bad.length ? `; failed: ${bad.join(", ")}` : ""}. ${old.length} old snapshots removed.`);
process.exit(bad.length ? 1 : 0);

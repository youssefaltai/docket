// Imports a Docket database into the Workers deployment: every table's rows (same ids, same values) and the attachments,
// then checks both sides hold the same. Small requests throughout (Workers Free gives each 10 ms of CPU); run it again
// to resume or just re-check. Needs the ADMIN_TOKEN secret set on the Worker, and the token here.
// Usage: ADMIN_TOKEN=… bun scripts/import.ts <url> <snapshot.db> [attachments dir]
//   snapshot: a VACUUM INTO copy (backup.sh makes one), opened read-only.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHUNK_BYTES, pageHash, schemaHash, tables } from "../src/server/transfer.ts";

const BATCH_BYTES = 64 * 1024; // of JSON rows per request
const PAGE = 100; // rows per hashed page

const [url, snapshot, files] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
if (!url || !snapshot || !token) {
  console.error("Usage: ADMIN_TOKEN=… bun scripts/import.ts <url> <snapshot.db> [attachments dir]");
  process.exit(2);
}
async function admin(path: string, init: RequestInit = {}, ok = [200]): Promise<any> {
  const res = await fetch(new URL(`/api/admin/${path}`, url), { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  if (!ok.includes(res.status)) throw new Error(`${init.method ?? "GET"} /api/admin/${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const db = new Database(snapshot, { readonly: true });
const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
if (user_version !== 29) throw new Error(`The snapshot is at schema version ${user_version}; the Worker's is 29`);
const remote = await admin("tables");
if (remote.schema !== schemaHash(db)) throw new Error("The Worker's schema isn't the snapshot's");
const remoteRows = new Map<string, number>(remote.tables.map((t: { table: string; rows: number }) => [t.table, t.rows]));
const count = (t: string) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${t}"`).get()!.n;

// Parents first: tables after those they reference, and a table's rows after the rows they reference in it (a sub-issue after its parent).
type Fk = { table: string; from: string; to: string };
const fks = (t: string) => db.query<Fk, [string]>("SELECT \"table\", \"from\", \"to\" FROM pragma_foreign_key_list(?)").all(t);
const order: string[] = [];
for (const pending = tables(db); pending.length; ) {
  const next = pending.find((t) => fks(t).every((fk) => fk.table === t || order.includes(fk.table)));
  if (!next) throw new Error(`Foreign keys between ${pending.join(", ")} form a cycle`);
  order.push(next);
  pending.splice(pending.indexOf(next), 1);
}
function parentsFirst(t: string, rows: Record<string, unknown>[]) {
  const self = fks(t).filter((fk) => fk.table === t);
  if (!self.length) return rows;
  const out: Record<string, unknown>[] = [];
  const done = new Set<string>();
  for (let pending = rows; pending.length; ) {
    const ready = pending.filter((r) => self.every((fk) => r[fk.from] == null || done.has(`${fk.to}:${r[fk.from]}`)));
    if (!ready.length) throw new Error(`${t}'s rows reference each other in a cycle`);
    for (const r of ready) for (const fk of self) done.add(`${fk.to}:${r[fk.to]}`);
    out.push(...ready);
    pending = pending.filter((r) => !ready.includes(r));
  }
  return out;
}

// The rows, in batches; a table whose count already matches is left to the check.
let sent = 0;
for (const t of order) {
  if (remoteRows.get(t) === count(t)) continue;
  let batch: unknown[] = [];
  let size = 0;
  const flush = async () => {
    if (batch.length) await admin(`rows/${t}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch) });
    sent += batch.length;
    [batch, size] = [[], 0];
  };
  for (const row of parentsFirst(t, db.query(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[])) {
    const json = JSON.stringify(row).length;
    if (size + json > BATCH_BYTES) await flush();
    batch.push(row);
    size += json;
  }
  await flush();
}
console.log(`Sent ${sent} rows.`);

// The files, a chunk at a time: each is compared by SHA-256, sent if it's missing or differs, then compared again.
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ids = db.query<{ id: string }, []>("SELECT id FROM attachments ORDER BY id").all().map((a) => a.id);
const missing = ids.filter((id) => !files || !existsSync(join(files, id)));
let uploaded = 0;
const badFiles: string[] = [];
if (files) {
  for (const id of ids.filter((id) => !missing.includes(id))) {
    const bytes = readFileSync(join(files, id));
    let good = true;
    for (let seq = 0; seq * CHUNK_BYTES < bytes.length; seq++) {
      const chunk = bytes.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES);
      const same = async () => (await admin(`files/${id}/${seq}`, {}, [200, 404])).sha256 === sha256(chunk);
      if (await same()) continue;
      await admin(`files/${id}/${seq}`, { method: "PUT", body: chunk });
      uploaded++;
      good &&= await same();
    }
    const extra = await admin(`files/${id}/${Math.ceil(bytes.length / CHUNK_BYTES)}`, {}, [200, 404]); // nothing past the end
    if (!good || extra.sha256) badFiles.push(id);
  }
}

// The check: each table page by page, its foreign keys, and quick_check.
const results = [];
for (const t of [...order].sort()) {
  const local = count(t);
  let match = remoteRows.has(t);
  let fkProblems = 0;
  for (let offset = 0; match && (offset < local || offset === 0); offset += PAGE) {
    const there = await admin(`rows/${t}?offset=${offset}&limit=${PAGE}`);
    const here = pageHash(db, t, offset, PAGE);
    match = there.rows === here.rows && there.sha256 === here.sha256;
    fkProblems = Math.max(fkProblems, there.foreignKeyCheck.length);
  }
  results.push({ table: t, rows: local, match, fkProblems });
}
const { quickCheck } = await admin("tables");
console.table(results);
const extra = remote.tables.map((t: { table: string }) => t.table).filter((t: string) => !order.includes(t));
console.log(`Schema: matches. Tables: ${results.filter((r) => r.match).length}/${results.length} match${extra.length ? `; extra on the Worker: ${extra.join(", ")}` : ""}.`);
console.log(`quick_check: ${JSON.stringify(quickCheck)}; foreign_key_check: ${results.reduce((n, r) => n + r.fkProblems, 0)} problems.`);
if (files) console.log(`Files: ${ids.length - missing.length - badFiles.length}/${ids.length} match by SHA-256 (${uploaded} chunks sent)${missing.length ? `; not in ${files}: ${missing.join(", ")}` : ""}${badFiles.length ? `; differ: ${badFiles.join(", ")}` : ""}.`);
const ok = results.every((r) => r.match && !r.fkProblems) && !extra.length && JSON.stringify(quickCheck) === '[{"quick_check":"ok"}]' && !badFiles.length && (!files || !missing.length);
console.log(ok ? "Import verified." : "Import NOT verified.");
process.exit(ok ? 0 : 1);

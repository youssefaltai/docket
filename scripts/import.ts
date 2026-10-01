// Imports a Docket database into the Workers deployment, once: every table's rows (same ids, same values) and the
// attachments, then checks both sides hold the same. Needs the IMPORT_TOKEN secret set on the Worker, and the token here.
// Usage: IMPORT_TOKEN=… bun scripts/import.ts <url> <snapshot.db> [attachments dir]
//   snapshot: a VACUUM INTO copy (backup.sh makes one), opened read-only. Run it again to resume uploads or re-check.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dump, hashes } from "../src/server/transfer.ts";

const [url, snapshot, files] = process.argv.slice(2);
const token = process.env.IMPORT_TOKEN;
if (!url || !snapshot || !token) {
  console.error("Usage: IMPORT_TOKEN=… bun scripts/import.ts <url> <snapshot.db> [attachments dir]");
  process.exit(2);
}
const auth = { Authorization: `Bearer ${token}` };
async function admin(path: string, init: RequestInit = {}) {
  const res = await fetch(new URL(`/api/admin/${path}`, url), { ...init, headers: { ...auth, ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} /api/admin/${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}
type Remote = { tables: ReturnType<typeof hashes>; quickCheck: unknown[]; foreignKeyCheck: unknown[]; files: { key: string; size: number; etag: string }[] };

const db = new Database(snapshot, { readonly: true });
const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
if (user_version !== 29) throw new Error(`The snapshot is at schema version ${user_version}; the Worker's is 29`);
const local = hashes(db);

// The rows: into an empty database only; one that has rows is just checked below.
let remote: Remote = await admin("hashes");
const same = (a: { rows: number; sha256: string }, b?: { rows: number; sha256: string }) => a.rows === b?.rows && a.sha256 === b.sha256;
if (Object.entries(remote.tables).some(([t, h]) => t !== "schema" && h.rows > 0)) console.log("The Worker's database has rows already: checking it.");
else {
  const data = dump(db);
  console.log(`Importing ${Object.values(data).reduce((n, rows) => n + rows.length, 0)} rows in ${Object.keys(data).length} tables…`);
  await admin("import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

// The files: those R2 doesn't have yet, by MD5 (R2's ETag for a single upload).
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const ids = db.query<{ id: string }, []>("SELECT id FROM attachments ORDER BY id").all().map((a) => a.id);
const missing: string[] = [];
if (files) {
  const have = new Map(remote.files.map((f) => [f.key, f.etag]));
  let sent = 0;
  for (const id of ids) {
    const path = join(files, id);
    if (!existsSync(path)) {
      missing.push(id);
      continue;
    }
    const bytes = readFileSync(path);
    if (have.get(id) === md5(bytes)) continue;
    await admin(`files/${id}`, { method: "PUT", body: bytes });
    sent++;
  }
  console.log(`Uploaded ${sent} of ${ids.length} attachments${missing.length ? `; ${missing.length} not in ${files}: ${missing.join(", ")}` : ""}.`);
}

// The check: every table's hash, the integrity and foreign key checks, and every file's MD5.
remote = await admin("hashes");
const rows = Object.entries(local).map(([table, h]) => ({ table, rows: h.rows, sha256: h.sha256.slice(0, 16), match: same(h, remote.tables[table]) }));
const extra = Object.keys(remote.tables).filter((t) => !(t in local));
console.table(rows);
const etags = new Map(remote.files.map((f) => [f.key, f.etag]));
const badFiles = files ? ids.filter((id) => !missing.includes(id) && etags.get(id) !== md5(readFileSync(join(files, id)))) : [];
const ok = rows.every((r) => r.match) && !extra.length && JSON.stringify(remote.quickCheck) === '[{"quick_check":"ok"}]' && !remote.foreignKeyCheck.length && !badFiles.length;
console.log(`Tables: ${rows.filter((r) => r.match).length}/${rows.length} match${extra.length ? `; extra on the Worker: ${extra.join(", ")}` : ""}.`);
console.log(`quick_check: ${JSON.stringify(remote.quickCheck)}; foreign_key_check: ${remote.foreignKeyCheck.length} problems.`);
if (files) console.log(`Files: ${ids.length - missing.length - badFiles.length}/${ids.length - missing.length} match by MD5${badFiles.length ? `; differ: ${badFiles.join(", ")}` : ""}.`);
console.log(ok ? "Import verified." : "Import NOT verified.");
process.exit(ok ? 0 : 1);

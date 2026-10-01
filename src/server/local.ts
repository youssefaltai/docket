// The Bun server's storage: the SQLite file (DATABASE_PATH) and the attachments folder next to it. Imported first by
// whatever runs on Bun (index.ts, scripts), so the database is open before anything uses it.
import { Database } from "bun:sqlite";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { useFiles } from "./attachments.ts";
import { open } from "./db.ts";
import { attachmentsDir, databasePath } from "./paths.ts";

const path = databasePath();
mkdirSync(dirname(path), { recursive: true });
const sqlite = new Database(path, { create: true });
sqlite.run("PRAGMA busy_timeout = 5000"); // first, so switching to WAL waits for another process instead of failing
sqlite.run("PRAGMA journal_mode = WAL");
open(sqlite);

const dir = attachmentsDir();
mkdirSync(dir, { recursive: true });
useFiles({
  // Whole or not at all, so a backup running meanwhile never copies half a file: written aside, then renamed.
  async put(id, body) {
    const part = join(dir, `${id}.part`);
    try {
      const size = body instanceof Uint8Array ? await Bun.write(part, body) : await Bun.write(part, new Response(body));
      renameSync(part, join(dir, id));
      return size;
    } catch (err) {
      rmSync(part, { force: true }); // e.g. the disk is full
      throw err;
    }
  },
  async get(id, bytes) {
    const file = Bun.file(join(dir, id));
    if (!(await file.exists())) return null;
    return bytes === undefined ? file : file.slice(0, bytes);
  },
  async delete(id) {
    rmSync(join(dir, id), { force: true });
  },
});

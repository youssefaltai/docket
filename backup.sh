#!/bin/sh
# Nightly consistent SQLite snapshot of Docket into data/backups/, keeping 14 days.
# Cron: 17 3 * * * /path/to/docket/backup.sh >> $HOME/docket-backup.log 2>&1
set -e
cd "$(dirname "$0")"
docker compose exec -T docket bun -e '
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
const dir = "/app/data/backups";
mkdirSync(dir, { recursive: true });
const file = `${dir}/docket-${new Date().toISOString().slice(0, 10)}.db`;
rmSync(file, { force: true });
new Database("/app/data/docket.db").run(`VACUUM INTO '"'"'${file}'"'"'`);
for (const f of readdirSync(dir)) {
  if (Date.now() - statSync(`${dir}/${f}`).mtimeMs > 14 * 864e5) rmSync(`${dir}/${f}`);
}
console.log(new Date().toISOString(), "backed up", file);
'

#!/usr/bin/env bash
# Nightly consistent SQLite snapshot into a backups/ folder next to the database, keeping 14 days.
# No arguments: Docket's own database (data/backups/docket-YYYY-MM-DD.db).
# Arguments: another compose project's SQLite, e.g. docket-chat's (its data/backups/chat-YYYY-MM-DD.db):
#   ./backup.sh /opt/apps/docket-chat docket-chat /data/chat.db
# Cron: 17 3 * * * /path/to/docket/backup.sh >> $HOME/docket-backup.log 2>&1
set -euo pipefail
project="${1:-$(dirname "$0")}"
service="${2:-docket}"
database="${3:-/app/data/docket.db}"
cd "$project"
docker compose exec -T -e DATABASE="$database" "$service" bun -e '
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
const source = process.env.DATABASE;
const dir = `${dirname(source)}/backups`;
const name = basename(source, ".db");
mkdirSync(dir, { recursive: true });
const file = `${dir}/${name}-${new Date().toISOString().slice(0, 10)}.db`;
rmSync(file, { force: true });
new Database(source).run(`VACUUM INTO '"'"'${file}'"'"'`);
for (const f of readdirSync(dir)) {
  if (f.startsWith(`${name}-`) && Date.now() - statSync(`${dir}/${f}`).mtimeMs > 14 * 864e5) rmSync(`${dir}/${f}`);
}
console.log(new Date().toISOString(), "backed up", file);
'

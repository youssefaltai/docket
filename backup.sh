#!/usr/bin/env bash
# Nightly consistent SQLite snapshot into a backups/ folder next to the database, keeping 14 days.
# Then the attachments/ folder next to it (Docket's uploads), if any: new files are copied into backups/attachments,
# never pruned (files never change, and older snapshots still link to them). Snapshot first, files second, so every
# snapshot's files are there.
# Writes data/backups/docket-YYYY-MM-DD.db and data/backups/attachments/.
# Cron: 17 3 * * * /path/to/docket/backup.sh >> $HOME/docket-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
docker compose exec -T docket bun -e '
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
const source = "/app/data/docket.db";
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
const files = `${dirname(source)}/attachments`;
if (existsSync(files)) {
  mkdirSync(`${dir}/attachments`, { recursive: true });
  let copied = 0;
  for (const f of readdirSync(files)) {
    const to = `${dir}/attachments/${f}`;
    if (!/^[A-Za-z0-9_-]{22}$/.test(f) || existsSync(to)) continue; // only finished uploads, only new ones
    copyFileSync(`${files}/${f}`, `${to}.part`);
    renameSync(`${to}.part`, to); // whole or not at all
    copied++;
  }
  console.log(new Date().toISOString(), "copied", copied, "new attachments to", `${dir}/attachments`);
}
'

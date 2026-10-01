#!/usr/bin/env bash
# Moves Docket from the VPS to Workers (DKT-61). Each step can run again; the first error stops it; nothing is deleted.
# Usage: ADMIN_TOKEN=… scripts/cutover.sh [timestamp]   (pass the timestamp it printed to resume a run)
# Rollback: scripts/rollback.sh starts the VPS's Docket again.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ADMIN_TOKEN:?Set ADMIN_TOKEN to the ADMIN_TOKEN secret of the Worker}"
URL=https://docket.youssefaltai.com
APP=/opt/apps/docket
TS=${1:-$(date -u +%Y%m%dT%H%M%SZ)}
OUT=~/Backups/docket/cutover-$TS
mkdir -p "$OUT/raw" "$OUT/attachments"
echo "Cutover $TS into $OUT"

echo "0. Preflight: the VPS answers, and the Worker takes the admin token"
ssh vps true
curl -fsS -o /dev/null -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/api/admin/tables"

echo "a. Stop Docket on the VPS (its data stays; no more writes)"
ssh vps "cd $APP && docker compose stop docket"

echo "b. Snapshot the stopped database (VACUUM INTO, read-only) and copy it, the raw files and the attachments here"
ssh vps "cd $APP && test -f data/backups/cutover-$TS.db || docker compose run --rm --no-deps -T docket bun -e '
  const { Database } = await import(\"bun:sqlite\");
  (await import(\"node:fs\")).mkdirSync(\"/app/data/backups\", { recursive: true });
  new Database(\"/app/data/docket.db\", { readonly: true }).run(\"VACUUM INTO \x27/app/data/backups/cutover-$TS.db\x27\");'"
rsync -a "vps:$APP/data/backups/cutover-$TS.db" "$OUT/docket.db"
rsync -a --ignore-missing-args "vps:$APP/data/docket.db" "vps:$APP/data/docket.db-wal" "vps:$APP/data/docket.db-shm" "$OUT/raw/"
rsync -a "vps:$APP/data/attachments/" "$OUT/attachments/"

echo "c. Check the snapshot"
bun -e '
  const { Database } = await import("bun:sqlite");
  const db = new Database(process.argv[1], { readonly: true });
  const integrity = db.query("PRAGMA integrity_check").all();
  const broken = db.query("PRAGMA foreign_key_check").all();
  if (JSON.stringify(integrity) !== JSON.stringify([{ integrity_check: "ok" }]) || broken.length) {
    console.error("The snapshot failed its checks:", JSON.stringify({ integrity, broken: broken.slice(0, 5) }));
    process.exit(1);
  }
  console.log("integrity_check ok, no foreign key problems, schema version", db.query("PRAGMA user_version").get().user_version);
' "$OUT/docket.db"

echo "d. Import into $URL and verify"
ADMIN_TOKEN=$ADMIN_TOKEN bun scripts/import.ts "$URL" "$OUT/docket.db" "$OUT/attachments"

echo "e. Summary"
bun -e '
  const { Database } = await import("bun:sqlite");
  const db = new Database(process.argv[1], { readonly: true });
  const n = (t) => db.query(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  console.log(`Imported and verified: ${n("issues")} issues, ${n("documents")} docs, ${n("comments")} comments, ${n("users")} users, ${n("attachments")} attachments.`);
' "$OUT/docket.db"
echo "Snapshot, raw files and attachments: $OUT"
echo "The VPS's Docket stays stopped (scripts/rollback.sh starts it). Next: delete the ADMIN_TOKEN secret, then repoint clients to $URL."

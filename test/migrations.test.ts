// The schema runner (src/server/schema.ts): a new database gets the baseline, one older than it is refused, and
// migrations after it apply in order, each rolled back whole if it fails or breaks a foreign key.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, type Migration } from "../src/server/schema.ts";

const dir = mkdtempSync(join(tmpdir(), "docket-migrations-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const schema = (db: Database) => db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
const foreignKeys = (db: Database) => (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;

/** A database at the baseline with one user, as after a first start. */
function baseline() {
  const db = new Database(":memory:");
  migrate(db, []);
  db.run("INSERT INTO users (id, kind, created_at) VALUES (1, 'person', '2026-01-01T00:00:00.000Z')");
  return db;
}

test("a new database gets the baseline at version 29, with foreign keys on", () => {
  const db = new Database(":memory:");
  migrate(db);
  expect(version(db)).toBe(29);
  expect(schema(db).length).toBeGreaterThan(100);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(foreignKeys(db)).toBe(1);
});

test("the baseline never changes: a schema change is a new migration", () => {
  const db = new Database(":memory:");
  migrate(db, []);
  const rows = db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
  const hash = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  // The sqlite_master that migrations 1-29 leave, which databases already at 29 have. They never run the baseline
  // again, so an edit to it would reach new databases only.
  if (hash !== "3d49dc601d05d214817fbafb1f8065f91bbb614133446b53ab2edf55a8d202fc") {
    throw new Error("BASELINE changed: undo that and add a migration to MIGRATIONS in src/server/schema.ts instead");
  }
});

test("a database at version 29 opens unchanged", () => {
  const file = join(dir, "v29.db");
  const first = new Database(file, { create: true });
  migrate(first);
  first.run("INSERT INTO users (id, kind, created_at) VALUES (1, 'person', '2026-01-01T00:00:00.000Z')");
  const before = schema(first);
  first.close();
  const db = new Database(file);
  migrate(db);
  expect([version(db), schema(db), db.query("SELECT id FROM users").all()]).toEqual([29, before, [{ id: 1 }]]);
});

test("a database older than the baseline is refused and left as it was", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY)");
  db.run("PRAGMA user_version = 28");
  const before = schema(db);
  expect(() => migrate(db)).toThrow("Upgrade through the release tagged migrations-v29 first");
  expect([version(db), schema(db)]).toEqual([28, before]);
});

test("a database with a negative version is refused and left as it was", () => {
  const db = new Database(":memory:");
  db.run("PRAGMA user_version = -1");
  expect(() => migrate(db)).toThrow("schema version is -1");
  expect([version(db), schema(db)]).toEqual([-1, []]);
});

test("migrations after the baseline apply in order, each once", () => {
  const db = baseline();
  const migrations: Migration[] = [
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id))",
    (db) => db.run("INSERT INTO notes (user_id) VALUES (1)"),
  ];
  migrate(db, migrations);
  migrate(db, migrations);
  expect([version(db), db.query("SELECT user_id FROM notes").all(), foreignKeys(db)]).toEqual([31, [{ user_id: 1 }], 1]);
});

test("a migration that breaks a foreign key or throws rolls back whole; the ones before it stay", () => {
  const db = baseline();
  const notes = "CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id))";
  expect(() => migrate(db, [notes, "INSERT INTO notes (user_id) VALUES (1); INSERT INTO notes (user_id) VALUES (99)"])).toThrow(
    "Migration 31 broke foreign keys",
  );
  expect([version(db), db.query("SELECT * FROM notes").all()]).toEqual([30, []]);
  const failing: Migration = (db) => {
    db.run("ALTER TABLE notes ADD COLUMN body TEXT");
    throw new Error("backfill refused");
  };
  expect(() => migrate(db, [notes, failing])).toThrow("backfill refused");
  expect([version(db), db.query("SELECT name FROM pragma_table_info('notes')").all()]).toEqual([30, [{ name: "id" }, { name: "user_id" }]]);
});

test("the server refuses to start on a database older than the baseline", async () => {
  const file = join(dir, "v28.db");
  const old = new Database(file, { create: true });
  old.run("CREATE TABLE users (id INTEGER PRIMARY KEY)");
  old.run("PRAGMA user_version = 28");
  old.close();
  const run = Bun.spawn(["bun", "-e", 'await import("./src/server/db.ts")'], {
    cwd: join(import.meta.dir, ".."),
    env: { PATH: process.env.PATH, HOME: dir, DATABASE_PATH: file },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("This database is at schema version 28");
  const db = new Database(file, { readonly: true });
  expect([version(db), schema(db).length]).toEqual([28, 1]);
  db.close();
});

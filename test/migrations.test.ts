// Upgrades a database from the oldest released schema and checks the data survives, over HTTP.
// The fixture is a frozen copy of schema version 1: never edit it, add a newer fixture instead.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.ts";

const SCHEMA_V1 = `
  CREATE TABLE projects (
    key TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(key), number INTEGER NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]', assignee TEXT,
    parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
    UNIQUE (project_key, number)
  );
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE TABLE issue_blocks (
    blocker_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    PRIMARY KEY (blocker_id, blocked_id)
  );
  CREATE INDEX issue_blocks_blocked ON issue_blocks(blocked_id);
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX comments_issue ON comments(issue_id);
  PRAGMA user_version = 1;
`;

const T = "2026-01-01T00:00:00.000Z";

test("a version 1 database upgrades with its data intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docket-migrate-"));
  const path = join(dir, "docket.db");
  const old = new Database(path, { create: true });
  old.run(SCHEMA_V1);
  old.run(`INSERT INTO projects VALUES ('OLD', 'Legacy', 'From v1', '${T}', '${T}')`);
  old.run(`INSERT INTO issues (id, project_key, number, title, status, labels, created_at, updated_at)
    VALUES (1, 'OLD', 1, 'Kept', 'todo', '["bug"]', '${T}', '${T}'),
           (2, 'OLD', 5, 'Gap before me', 'done', '[]', '${T}', '${T}')`);
  old.run(`INSERT INTO issue_blocks VALUES (1, 2)`);
  old.run(`INSERT INTO comments (issue_id, author, body, created_at) VALUES (1, 'me', 'Still here', '${T}')`);
  old.close();

  const s = await startServer({ databasePath: path });
  try {
    const { body: projects } = await s.api("GET", "/api/projects");
    expect(projects).toEqual([expect.objectContaining({ key: "OLD", workspace: "default", description: "From v1" })]);

    const { body: issue } = await s.api("GET", "/api/issues/OLD-1");
    expect(issue).toMatchObject({ title: "Kept", labels: ["bug"], blocks: ["OLD-5"] });
    expect(issue.comments[0]).toMatchObject({ body: "Still here", editedAt: null });

    // Old comments can be edited: comments.edited_at exists.
    const edited = await s.api("PATCH", `/api/issues/OLD-1/comments/${issue.comments[0].id}`, { body: "Edited", author: "me" });
    expect(edited.status).toBe(200);
    expect((await s.api("GET", "/api/issues/OLD-1")).body.comments[0]).toMatchObject({ body: "Edited", editedAt: expect.any(String) });

    // The per-project counter starts after the highest existing number.
    const { body: next } = await s.api("POST", "/api/issues", { project: "OLD", title: "New" });
    expect(next.id).toBe("OLD-6");

    // Docs tables from later migrations exist, document_comments.edited_at included.
    expect((await s.api("POST", "/api/documents", { project: "OLD", title: "Notes" })).status).toBe(201);
    const { body: doc } = await s.api("POST", "/api/documents/notes/comments", { body: "Hi", author: "me" });
    const cid = doc.comments[0].id;
    expect((await s.api("PATCH", `/api/documents/notes/comments/${cid}`, { body: "Hello", author: "me" })).status).toBe(200);
    expect((await s.api("GET", "/api/documents/notes")).body.comments[0]).toMatchObject({ body: "Hello", editedAt: expect.any(String) });
  } finally {
    await s.stop();
  }

  // Reopening an up-to-date database is a no-op.
  const again = await startServer({ databasePath: path });
  try {
    expect((await again.api("GET", "/api/issues/OLD-6")).status).toBe(200);
  } finally {
    await again.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

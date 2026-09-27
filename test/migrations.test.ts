// Migration 4 (keys belong to one workspace) on a database written under schema 3: data survives, and every
// existing key lands in the right workspace.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type TestServer } from "./server.ts";

// Migrations 1–3 exactly as they shipped (src/server/db.ts). Frozen: never edit this fixture.
const SCHEMA_V3 = [
  `
  -- People and agents; the username is the identity. Email is unverified contact info (there's no mail),
  -- so it's never used to find an account. Agents sign in only with API keys.
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE workspace_members (
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'agent')),
    created_at TEXT NOT NULL,
    suspended_at TEXT,
    PRIMARY KEY (workspace, user_id)
  );
  CREATE INDEX workspace_members_user ON workspace_members(user_id);
  -- Secrets are stored only as SHA-256 hashes.
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    ip TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX api_keys_user ON api_keys(user_id);
  -- One-time codes: invites (workspace, role) and sign-in links (user).
  CREATE TABLE codes (
    id INTEGER PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'sign-in')),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    workspace TEXT REFERENCES workspaces(key) ON DELETE CASCADE,
    role TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE teams (
    key TEXT PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX teams_workspace ON teams(workspace);
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY,
    team_key TEXT NOT NULL REFERENCES teams(key),
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    labels TEXT NOT NULL DEFAULT '[]',
    assignee_id INTEGER REFERENCES users(id),
    delegate_id INTEGER REFERENCES users(id),
    creator_id INTEGER NOT NULL REFERENCES users(id),
    parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (team_key, number)
  );
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE TABLE issue_blocks (
    blocker_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    PRIMARY KEY (blocker_id, blocked_id)
  );
  CREATE INDEX issue_blocks_blocked ON issue_blocks(blocked_id);
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT
  );
  CREATE INDEX comments_issue ON comments(issue_id);
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    team_key TEXT NOT NULL REFERENCES teams(key),
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id)
  );
  CREATE INDEX documents_team ON documents(team_key, position);
  CREATE TABLE document_versions (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX document_versions_document ON document_versions(document_id);
  CREATE TABLE document_refs (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    PRIMARY KEY (document_id, issue_id)
  );
  CREATE INDEX document_refs_issue ON document_refs(issue_id);
  CREATE TABLE document_comments (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT
  );
  CREATE INDEX document_comments_document ON document_comments(document_id);
  `,
  // Trash: deleting an issue or doc sets deleted_at; it's restorable for 30 days, then purged.
  // Emails become unique in the schema too (the app already refused clashes); older duplicates lose theirs.
  `
  ALTER TABLE issues ADD COLUMN deleted_at TEXT;
  ALTER TABLE documents ADD COLUMN deleted_at TEXT;
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  UPDATE users SET email = NULL WHERE email IS NOT NULL
    AND id NOT IN (SELECT MIN(id) FROM users WHERE email IS NOT NULL GROUP BY lower(email));
  CREATE UNIQUE INDEX users_email ON users(lower(email)) WHERE email IS NOT NULL;
  `,
  // Short-lived keys: past expires_at a key is dead, then purged. A chat key belongs to one browser session
  // and goes with it (sign-out, revoke, suspension), so the chat service never outlives the person's access.
  `
  ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
  ALTER TABLE api_keys ADD COLUMN session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE;
  CREATE INDEX api_keys_expires ON api_keys(expires_at) WHERE expires_at IS NOT NULL;
  CREATE INDEX api_keys_session ON api_keys(session_id) WHERE session_id IS NOT NULL;
  `,
];

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const ADMIN_KEY = `dk_${"a".repeat(64)}`;
const AGENT_KEY = `dk_${"b".repeat(64)}`;
const CHAT_KEY = `dk_${"c".repeat(64)}`;
const GONE_KEY = `dk_${"d".repeat(64)}`;
const SESSION = "e".repeat(64);

let dir: string;
let path: string;
let s: TestServer;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "docket-migration-"));
  path = join(dir, "docket.db");
  const db = new Database(path, { create: true });
  for (const sql of SCHEMA_V3) db.run(sql);
  db.run("PRAGMA user_version = 3");
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const later = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  db.run(`INSERT INTO users (id, kind, username, name, email, created_at) VALUES
    (1, 'person', 'admin', 'Admin', 'admin@example.com', '${t(0)}'),
    (2, 'agent', 'bot', 'Bot', NULL, '${t(1)}'),
    (3, 'person', 'gone', 'Gone', NULL, '${t(2)}')`);
  // "zeta" sorts after "side" but admin joined it first: a person's key goes where they joined first.
  db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES
    ('zeta', 'Zeta', '${t(0)}', '${t(0)}'), ('side', 'Side', '${t(5)}', '${t(5)}')`);
  db.run(`INSERT INTO workspace_members (workspace, user_id, role, created_at, suspended_at) VALUES
    ('zeta', 1, 'admin', '${t(0)}', NULL), ('side', 1, 'admin', '${t(5)}', NULL),
    ('side', 2, 'agent', '${t(6)}', NULL), ('zeta', 3, 'member', '${t(7)}', '${t(8)}')`);
  db.run(`INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, user_agent, ip)
    VALUES (1, 1, '${hash(SESSION)}', '${t(0)}', '${new Date().toISOString()}', 'test', '127.0.0.1')`);
  db.run(`INSERT INTO api_keys (user_id, name, scope, token_hash, created_at, expires_at, session_id) VALUES
    (1, 'laptop', 'write', '${hash(ADMIN_KEY)}', '${t(1)}', NULL, NULL),
    (2, 'agent token', 'write', '${hash(AGENT_KEY)}', '${t(6)}', NULL, NULL),
    (1, 'Chat (automatic)', 'read', '${hash(CHAT_KEY)}', '${t(9)}', '${later}', 1),
    (3, 'old', 'write', '${hash(GONE_KEY)}', '${t(7)}', NULL, NULL)`);
  db.run(`INSERT INTO teams (key, workspace, name, created_at, updated_at, next_number) VALUES
    ('ZET', 'zeta', 'Zeta team', '${t(0)}', '${t(0)}', 2), ('SID', 'side', 'Side team', '${t(5)}', '${t(5)}', 2)`);
  db.run(`INSERT INTO issues (team_key, number, title, status, creator_id, created_at, updated_at) VALUES
    ('ZET', 1, 'Zeta issue', 'todo', 1, '${t(0)}', '${t(0)}'), ('SID', 1, 'Side issue', 'todo', 2, '${t(6)}', '${t(6)}')`);
  db.close();
  s = await startServer({ setup: false, env: { DATABASE_PATH: path } });
});
afterAll(async () => {
  await s.stop();
  rmSync(dir, { recursive: true, force: true });
});

const workspacesOf = async (creds: { token?: string; cookie?: string }, via: "bearer" | "cookie" = "bearer") => {
  const res = await s.with(creds, via).api("GET", "/api/me");
  return res.status === 200 ? res.body.workspaces.map((w: { key: string }) => w.key) : res.status;
};

test("a person's key lands in the workspace they joined first, an agent's in its own", async () => {
  expect(await workspacesOf({ token: ADMIN_KEY })).toEqual(["zeta"]);
  expect((await s.with({ token: ADMIN_KEY }).api("GET", "/api/issues")).body.map((i: any) => i.id)).toEqual(["ZET-1"]);
  expect(await workspacesOf({ token: AGENT_KEY })).toEqual(["side"]);
  expect((await s.with({ token: AGENT_KEY }).api("GET", "/api/issues/SID-1")).body.title).toBe("Side issue");
});

test("chat keys are gone, and so are keys whose owner has no active workspace", async () => {
  expect(await workspacesOf({ token: CHAT_KEY })).toBe(401);
  expect(await workspacesOf({ token: GONE_KEY })).toBe(401);
});

test("the session and the data survive", async () => {
  expect((await workspacesOf({ cookie: `docket_session=${SESSION}` }, "cookie")).sort()).toEqual(["side", "zeta"]);
  const keys = (await s.with({ cookie: `docket_session=${SESSION}` }, "cookie").api("GET", "/api/api-keys")).body;
  expect(keys.map((k: any) => [k.name, k.workspace])).toEqual([["laptop", "zeta"]]);
});

test("the schema is at version 4", () => {
  const db = new Database(path, { readonly: true });
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(4);
  db.close();
});

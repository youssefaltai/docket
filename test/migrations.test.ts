// Migration 4 (keys belong to one workspace) on a database written under schema 3: data survives, and every
// existing key lands in the right workspace.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

test("the schema is at version 4 or later", () => {
  const db = new Database(path, { readonly: true });
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBeGreaterThanOrEqual(4);
  db.close();
});

// Migration 5 (usernames and names move to memberships) on a database written under schema 4: every row and
// id survives, and each membership carries its user's former username and name.
describe("migration 5", () => {
  // Migrations 1–4 exactly as they shipped (src/server/db.ts): 1–3 above, then 4. Frozen: never edit this fixture.
  const SCHEMA_V4 = [
    ...SCHEMA_V3,
    `
  ALTER TABLE api_keys ADD COLUMN workspace TEXT REFERENCES workspaces(key) ON DELETE CASCADE;
  DELETE FROM api_keys WHERE session_id IS NOT NULL; -- chat keys: short-lived, minted again per workspace
  UPDATE api_keys SET workspace = (SELECT m.workspace FROM workspace_members m
    WHERE m.user_id = api_keys.user_id AND m.suspended_at IS NULL ORDER BY m.created_at, m.workspace LIMIT 1);
  DELETE FROM api_keys WHERE workspace IS NULL; -- the owner has no active workspace left
  CREATE INDEX api_keys_workspace ON api_keys(user_id, workspace);
  `,
  ];
  const SIGN_IN = "ABCDE-FGHJK";
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();

  /** A schema-4 database: sam in two workspaces, an agent, a suspended person, and their issues, comments, docs, keys, session and code. */
  function writeV4(file: string) {
    const db = new Database(file, { create: true });
    for (const sql of SCHEMA_V4) db.run(sql);
    db.run("PRAGMA user_version = 4");
    const later = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.run(`INSERT INTO users (id, kind, username, name, email, created_at) VALUES
      (1, 'person', 'sam', 'Sam Lee', 'sam@example.com', '${t(0)}'),
      (2, 'agent', 'bot', 'Bot', NULL, '${t(1)}'),
      (3, 'person', 'kim', 'Kim', NULL, '${t(2)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES
      ('acme', 'Acme', '${t(0)}', '${t(0)}'), ('side', 'Side', '${t(3)}', '${t(3)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, role, created_at, suspended_at) VALUES
      ('acme', 1, 'admin', '${t(0)}', NULL), ('side', 1, 'admin', '${t(3)}', NULL),
      ('side', 2, 'agent', '${t(4)}', NULL), ('acme', 3, 'member', '${t(5)}', '${t(6)}')`);
    db.run(`INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, user_agent, ip)
      VALUES (7, 1, '${hash(SESSION)}', '${t(0)}', '${new Date().toISOString()}', 'test', '127.0.0.1')`);
    db.run(`INSERT INTO api_keys (id, user_id, name, scope, token_hash, created_at, workspace) VALUES
      (11, 1, 'laptop', 'write', '${hash(ADMIN_KEY)}', '${t(1)}', 'acme'),
      (12, 2, 'agent token', 'write', '${hash(AGENT_KEY)}', '${t(4)}', 'side')`);
    db.run(`INSERT INTO codes (id, code_hash, purpose, user_id, created_by, created_at, expires_at) VALUES
      (21, '${hash(SIGN_IN.replace("-", ""))}', 'sign-in', 1, 1, '${t(7)}', '${later}')`);
    db.run(`INSERT INTO teams (key, workspace, name, created_at, updated_at, next_number) VALUES
      ('ACM', 'acme', 'Acme team', '${t(0)}', '${t(0)}', 2), ('SID', 'side', 'Side team', '${t(3)}', '${t(3)}', 2)`);
    db.run(`INSERT INTO issues (id, team_key, number, title, status, assignee_id, delegate_id, creator_id, created_at, updated_at) VALUES
      (31, 'ACM', 1, 'Acme issue', 'todo', 3, NULL, 1, '${t(5)}', '${t(5)}'),
      (32, 'SID', 1, 'Side issue', 'in_progress', 1, 2, 2, '${t(6)}', '${t(6)}')`);
    db.run(`INSERT INTO comments (id, issue_id, author_id, body, created_at) VALUES
      (41, 31, 3, 'from kim', '${t(6)}'), (42, 32, 2, 'from bot', '${t(7)}')`);
    db.run(`INSERT INTO documents (id, slug, team_key, title, content, position, created_at, updated_at, updated_by_id) VALUES
      (51, 'plan', 'SID', 'Plan', 'v2', 1, '${t(3)}', '${t(8)}', 2)`);
    db.run(`INSERT INTO document_versions (id, document_id, title, content, author_id, created_at) VALUES
      (61, 51, 'Plan', 'v1', 1, '${t(3)}'), (62, 51, 'Plan', 'v2', 2, '${t(8)}')`);
    db.run(`INSERT INTO document_comments (id, document_id, author_id, body, created_at) VALUES (71, 51, 1, 'nice', '${t(9)}')`);
    db.close();
  }

  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Everything that points at an account, as it was before the migration.
  const KEPT = [
    "SELECT id, kind, email, created_at FROM users ORDER BY id",
    "SELECT id, user_id, token_hash FROM sessions ORDER BY id",
    "SELECT id, user_id, token_hash, workspace FROM api_keys ORDER BY id",
    "SELECT id, user_id, created_by, code_hash FROM codes ORDER BY id",
    "SELECT id, assignee_id, delegate_id, creator_id FROM issues ORDER BY id",
    "SELECT id, author_id FROM comments ORDER BY id",
    "SELECT id, updated_by_id FROM documents ORDER BY id",
    "SELECT id, author_id FROM document_versions ORDER BY id",
    "SELECT id, author_id FROM document_comments ORDER BY id",
    "SELECT workspace, user_id, role, created_at, suspended_at FROM workspace_members ORDER BY workspace, user_id",
  ];

  let v4: string;
  let before: unknown[][];
  let server: TestServer;
  beforeAll(async () => {
    v4 = join(dir, "v4.db");
    writeV4(v4);
    before = KEPT.map((sql) => rows(v4, sql));
    server = await startServer({ setup: false, env: { DATABASE_PATH: v4 } });
  });
  afterAll(() => server.stop());

  test("every id, email, session, key, code and author survives; handles and names land on every membership", () => {
    expect(KEPT.map((sql) => rows(v4, sql))).toEqual(before);
    expect(rows(v4, "SELECT workspace, user_id, username, name FROM workspace_members ORDER BY workspace, user_id")).toEqual([
      { workspace: "acme", user_id: 1, username: "sam", name: "Sam Lee" },
      { workspace: "acme", user_id: 3, username: "kim", name: "Kim" },
      { workspace: "side", user_id: 1, username: "sam", name: "Sam Lee" },
      { workspace: "side", user_id: 2, username: "bot", name: "Bot" },
    ]);
    expect(rows(v4, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v4, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(5); // later migrations run too
  });

  test("the old key and cookie still sign in, as the same people", async () => {
    const key = (await server.with({ token: ADMIN_KEY }).api("GET", "/api/me")).body;
    expect([key.user.id, key.user.username, key.user.name, key.user.email]).toEqual([1, "sam", "Sam Lee", "sam@example.com"]);
    const cookie = (await server.with({ cookie: `docket_session=${SESSION}` }, "cookie").api("GET", "/api/me")).body;
    expect(cookie.workspaces.map((w: any) => [w.key, w.you.username])).toEqual([["acme", "sam"], ["side", "sam"]]);
    expect((await server.with({ token: AGENT_KEY }).api("GET", "/api/me")).body.user).toMatchObject({ id: 2, username: "bot", kind: "agent" });
  });

  test("issues, comments, docs and versions show who did what", async () => {
    const bot = server.with({ token: AGENT_KEY });
    const issue = (await bot.api("GET", "/api/issues/SID-1")).body;
    expect([issue.creator.username, issue.assignee.username, issue.delegate.username, issue.comments[0].author.name]).toEqual(["bot", "sam", "bot", "Bot"]);
    const kim = (await server.with({ token: ADMIN_KEY }).api("GET", "/api/issues/ACM-1")).body;
    expect([kim.assignee.name, kim.comments[0].author.username]).toEqual(["Kim", "kim"]); // suspended, still named
    const doc = (await bot.api("GET", "/api/documents/plan")).body;
    expect([doc.updatedBy.username, doc.comments[0].author.username]).toEqual(["bot", "sam"]);
    const versions = (await bot.api("GET", "/api/documents/plan/versions")).body;
    expect(versions.map((v: any) => v.author.username)).toEqual(["bot", "sam"]);
  });

  test("the sign-in link made before still opens the account", async () => {
    const res = await server.anon.api("POST", "/api/auth/redeem", { code: SIGN_IN });
    expect([res.status, res.body.user.username]).toEqual([200, "sam"]);
  });

  test("a migration that breaks a foreign key throws, and the database stays as it was", async () => {
    const file = join(dir, "dangling.db");
    writeV4(file);
    const db = new Database(file);
    db.run("PRAGMA foreign_keys = OFF");
    db.run(`INSERT INTO comments (issue_id, author_id, body, created_at) VALUES (31, 99, 'nobody wrote this', '${t(10)}')`);
    db.close();
    const run = Bun.spawn(["bun", "-e", 'await import("./src/server/db.ts")'], {
      cwd: join(import.meta.dir, ".."),
      env: { PATH: process.env.PATH, HOME: dir, DATABASE_PATH: file },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(run.stderr).text(), run.exited]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Migration 5 broke foreign keys");
    expect(rows(file, "PRAGMA user_version")).toEqual([{ user_version: 4 }]);
    expect(rows(file, "SELECT username FROM users ORDER BY id")).toEqual([{ username: "sam" }, { username: "bot" }, { username: "kim" }]);
  });
});

// Migration 6 (team keys and doc slugs per workspace; teams get an id) on a database written under schema 5:
// every id, identifier, slug, relation, ref, comment, version, trashed row and team counter survives.
describe("migration 6", () => {
  // Migrations 1–5 exactly as they shipped (src/server/db.ts): 1–3 above, then 4 and 5. Frozen: never edit this fixture.
  const SCHEMA_V5 = [
    ...SCHEMA_V3,
    `
  ALTER TABLE api_keys ADD COLUMN workspace TEXT REFERENCES workspaces(key) ON DELETE CASCADE;
  DELETE FROM api_keys WHERE session_id IS NOT NULL; -- chat keys: short-lived, minted again per workspace
  UPDATE api_keys SET workspace = (SELECT m.workspace FROM workspace_members m
    WHERE m.user_id = api_keys.user_id AND m.suspended_at IS NULL ORDER BY m.created_at, m.workspace LIMIT 1);
  DELETE FROM api_keys WHERE workspace IS NULL; -- the owner has no active workspace left
  CREATE INDEX api_keys_workspace ON api_keys(user_id, workspace);
  `,
    `
  CREATE TABLE members_new (
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest', 'agent')),
    created_at TEXT NOT NULL,
    suspended_at TEXT,
    PRIMARY KEY (workspace, user_id),
    UNIQUE (workspace, username)
  );
  INSERT INTO members_new SELECT m.workspace, m.user_id, u.username, u.name, m.role, m.created_at, m.suspended_at
    FROM workspace_members m JOIN users u ON u.id = m.user_id;
  DROP TABLE workspace_members;
  ALTER TABLE members_new RENAME TO workspace_members;
  CREATE INDEX workspace_members_user ON workspace_members(user_id);
  CREATE TABLE users_new (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
    email TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO users_new SELECT id, kind, email, created_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  CREATE UNIQUE INDEX users_email ON users(lower(email)) WHERE email IS NOT NULL;
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const trashedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // a day ago: not purged yet

  /**
   * A schema-5 database: sam (admin) in acme and side, an agent in side. Acme has two teams (OPS made before ACM,
   * so ids follow created_at, not the key), a parent and sub-issue, blockers across its teams, comments, a trashed
   * issue and a gap in the numbers; docs with refs, versions and comments, one trashed. Side's doc mentions its own issues.
   */
  function writeV5(file: string) {
    const db = new Database(file, { create: true });
    for (const sql of SCHEMA_V5) db.run(sql);
    db.run("PRAGMA user_version = 5");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES
      (1, 'person', 'sam@example.com', '${t(0)}'), (2, 'agent', NULL, '${t(1)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES
      ('acme', 'Acme', '${t(0)}', '${t(0)}'), ('side', 'Side', '${t(3)}', '${t(3)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'sam', 'Sam', 'admin', '${t(0)}'), ('side', 1, 'sam', 'Sam', 'admin', '${t(3)}'),
      ('side', 2, 'bot', 'Bot', 'agent', '${t(4)}')`);
    db.run(`INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, user_agent, ip)
      VALUES (7, 1, '${hash(SESSION)}', '${t(0)}', '${new Date().toISOString()}', 'test', '127.0.0.1')`);
    db.run(`INSERT INTO api_keys (id, user_id, name, scope, token_hash, created_at, workspace) VALUES
      (11, 1, 'laptop', 'write', '${hash(ADMIN_KEY)}', '${t(1)}', 'acme'),
      (12, 2, 'agent token', 'write', '${hash(AGENT_KEY)}', '${t(4)}', 'side')`);
    db.run(`INSERT INTO teams (key, workspace, name, description, created_at, updated_at, next_number) VALUES
      ('SID', 'side', 'Side team', '', '${t(3)}', '${t(3)}', 3),
      ('ACM', 'acme', 'Acme team', 'The main one', '${t(2)}', '${t(2)}', 6),
      ('OPS', 'acme', 'Ops', '', '${t(1)}', '${t(1)}', 2)`);
    db.run(`INSERT INTO issues (id, team_key, number, title, description, status, priority, labels, assignee_id, delegate_id,
        creator_id, parent_id, created_at, updated_at, completed_at, deleted_at) VALUES
      (101, 'ACM', 1, 'Parent', 'See the plan', 'in_progress', 2, '["bug"]', 1, NULL, 1, NULL, '${t(5)}', '${t(9)}', NULL, NULL),
      (102, 'ACM', 2, 'Child', '', 'todo', 0, '[]', NULL, NULL, 1, 101, '${t(6)}', '${t(6)}', NULL, NULL),
      (103, 'ACM', 4, 'Blocker', '', 'done', 1, '["infra","bug"]', 1, NULL, 1, NULL, '${t(7)}', '${t(8)}', '${t(8)}', NULL),
      (104, 'ACM', 5, 'Trashed', '', 'backlog', 0, '[]', NULL, NULL, 1, 101, '${t(7)}', '${t(7)}', NULL, '${trashedAt}'),
      (105, 'OPS', 1, 'Ops work', '', 'todo', 3, '[]', NULL, NULL, 1, NULL, '${t(8)}', '${t(8)}', NULL, NULL),
      (201, 'SID', 1, 'Side one', '', 'in_progress', 0, '[]', 1, 2, 2, NULL, '${t(9)}', '${t(9)}', NULL, NULL),
      (202, 'SID', 2, 'Side two', '', 'todo', 0, '[]', NULL, NULL, 2, 201, '${t(10)}', '${t(10)}', NULL, NULL)`);
    db.run("INSERT INTO issue_blocks (blocker_id, blocked_id) VALUES (103, 101), (105, 102), (202, 201)");
    db.run(`INSERT INTO comments (id, issue_id, author_id, body, created_at, edited_at) VALUES
      (301, 101, 1, 'started', '${t(9)}', NULL), (302, 201, 2, 'on it', '${t(10)}', '${t(11)}'), (303, 104, 1, 'oops', '${t(7)}', NULL)`);
    db.run(`INSERT INTO documents (id, slug, team_key, title, content, position, created_at, updated_at, updated_by_id, deleted_at) VALUES
      (401, 'plan', 'ACM', 'Plan', 'Do ACM-1 then OPS-1', 1, '${t(5)}', '${t(9)}', 1, NULL),
      (402, 'runbook', 'OPS', 'Runbook', 'ACM-2', 2.5, '${t(6)}', '${t(6)}', 1, NULL),
      (403, 'old-idea', 'ACM', 'Old idea', '', 3, '${t(6)}', '${t(6)}', 1, '${trashedAt}'),
      (404, 'side-notes', 'SID', 'Side notes', 'SID-2 and SID-1', 1, '${t(10)}', '${t(11)}', 2, NULL)`);
    db.run("INSERT INTO document_refs (document_id, issue_id, ord) VALUES (401, 101, 0), (401, 105, 1), (402, 102, 0), (404, 202, 0), (404, 201, 1)");
    db.run(`INSERT INTO document_versions (id, document_id, title, content, author_id, created_at) VALUES
      (501, 401, 'Plan', 'v1', 1, '${t(5)}'), (502, 401, 'Plan', 'Do ACM-1 then OPS-1', 1, '${t(9)}'),
      (503, 404, 'Side notes', 'SID-2 and SID-1', 2, '${t(10)}')`);
    db.run(`INSERT INTO document_comments (id, document_id, author_id, body, created_at) VALUES
      (601, 401, 1, 'lgtm', '${t(9)}'), (602, 404, 2, 'noted', '${t(11)}')`);
    db.close();
  }

  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  const ISSUE_COLUMNS = `i.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id, i.delegate_id,
    i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at`;
  const DOC_COLUMNS = "d.id, d.slug, d.title, d.content, d.position, d.created_at, d.updated_at, d.updated_by_id, d.deleted_at";
  // The rebuilt tables, before (schema 5) and after (teams by id), joined back to their team key and workspace.
  const BEFORE = [
    "SELECT key, workspace, name, description, next_number, created_at, updated_at FROM teams ORDER BY key",
    `SELECT ${ISSUE_COLUMNS}, i.team_key FROM issues i ORDER BY i.id`,
    `SELECT ${DOC_COLUMNS}, d.team_key, t.workspace FROM documents d JOIN teams t ON t.key = d.team_key ORDER BY d.id`,
  ];
  const AFTER = [
    "SELECT key, workspace, name, description, next_number, created_at, updated_at FROM teams ORDER BY key",
    `SELECT ${ISSUE_COLUMNS}, t.key AS team_key FROM issues i JOIN teams t ON t.id = i.team_id ORDER BY i.id`,
    `SELECT ${DOC_COLUMNS}, t.key AS team_key, d.workspace FROM documents d JOIN teams t ON t.id = d.team_id ORDER BY d.id`,
  ];
  // Tables that point at issues and docs by id, and everything else: untouched.
  const UNCHANGED = [
    "SELECT * FROM issue_blocks ORDER BY blocker_id, blocked_id",
    "SELECT * FROM comments ORDER BY id",
    "SELECT * FROM document_refs ORDER BY document_id, issue_id",
    "SELECT * FROM document_versions ORDER BY id",
    "SELECT * FROM document_comments ORDER BY id",
    "SELECT * FROM users ORDER BY id",
    "SELECT * FROM workspace_members ORDER BY workspace, user_id",
    "SELECT id, user_id, token_hash, workspace FROM api_keys ORDER BY id",
    "SELECT id, user_id, token_hash FROM sessions ORDER BY id",
  ];

  let v5: string;
  let before: unknown[][];
  let server: TestServer;
  /** Sam's session, in one workspace (X-Docket-Workspace, as the web app sends). */
  const sam = (workspace: string) => {
    const session = server.with({ cookie: `docket_session=${SESSION}` }, "cookie");
    return (method: string, path: string, body?: unknown) => session.api(method, path, body, { "X-Docket-Workspace": workspace });
  };
  beforeAll(async () => {
    v5 = join(dir, "v5.db");
    writeV5(v5);
    before = [...BEFORE, ...UNCHANGED].map((sql) => rows(v5, sql));
    server = await startServer({ setup: false, env: { DATABASE_PATH: v5 } });
  });
  afterAll(() => server.stop());

  test("every row and id survives, joined back to the same team key; foreign keys hold", () => {
    expect([...AFTER, ...UNCHANGED].map((sql) => rows(v5, sql))).toEqual(before);
    expect(rows(v5, "SELECT key, id FROM teams ORDER BY id")).toEqual([
      { key: "OPS", id: 1 }, // created first
      { key: "ACM", id: 2 },
      { key: "SID", id: 3 },
    ]);
    expect(rows(v5, "PRAGMA foreign_key_check")).toEqual([]);
    expect(rows(v5, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(rows(v5, "PRAGMA user_version")).toEqual([{ user_version: 6 }]);
  });

  test("identifiers, relations, refs, comments and versions read the same over REST and MCP", async () => {
    const acme = sam("acme");
    const parent = (await acme("GET", "/api/issues/ACM-1")).body;
    expect([parent.blockedBy, parent.children.map((c: any) => c.id), parent.docs.map((d: any) => d.slug)]).toEqual([["ACM-4"], ["ACM-2"], ["plan"]]);
    expect([parent.assignee.username, parent.labels, parent.comments.map((c: any) => [c.id, c.author.username, c.body])]).toEqual([
      "sam",
      ["bug"],
      [[301, "sam", "started"]],
    ]);
    const child = (await acme("GET", "/api/issues/ACM-2")).body;
    expect([child.parent, child.blockedBy, child.docs.map((d: any) => d.slug)]).toEqual(["ACM-1", ["OPS-1"], ["runbook"]]);
    expect((await acme("GET", "/api/issues/OPS-1")).body.blocks).toEqual(["ACM-2"]);
    expect((await acme("GET", "/api/issues?label=infra")).body.map((i: any) => i.id)).toEqual(["ACM-4"]);
    const plan = (await acme("GET", "/api/documents/plan")).body;
    expect([plan.team, plan.issues.map((i: any) => i.id), plan.versionCount, plan.comments[0].body]).toEqual(["ACM", ["ACM-1", "OPS-1"], 2, "lgtm"]);
    expect((await acme("GET", "/api/documents/plan/versions")).body.map((v: any) => v.id)).toEqual([502, 501]);
    expect((await acme("GET", "/api/documents")).body.map((d: any) => [d.slug, d.team, d.position])).toEqual([["plan", "ACM", 1], ["runbook", "OPS", 2.5]]);

    const bot = server.with({ token: AGENT_KEY });
    const notes = (await bot.api("GET", "/api/documents/side-notes")).body;
    expect([notes.team, notes.issues.map((i: any) => i.id), notes.comments[0].author.username]).toEqual(["SID", ["SID-2", "SID-1"], "bot"]);
    const sideOne = (await bot.api("GET", "/api/issues/SID-1")).body;
    expect([sideOne.children.map((c: any) => c.id), sideOne.blockedBy, sideOne.delegate.username, sideOne.comments[0].editedAt]).toEqual([
      ["SID-2"],
      ["SID-2"],
      "bot",
      t(11),
    ]);
    expect(await bot.tool("get_issue", { id: "SID-1" })).toContain("blocked by SID-2");
    expect(await server.with({ token: ADMIN_KEY }).tool("list_documents")).toContain("runbook · Runbook · OPS");
  });

  test("the trash, team counts and each team's next number carry on", async () => {
    const acme = sam("acme");
    const trash = (await acme("GET", "/api/teams/ACM/trash")).body;
    expect([trash.issues.map((i: any) => i.id), trash.documents.map((d: any) => d.slug)]).toEqual([["ACM-5"], ["old-idea"]]);
    expect((await acme("GET", "/api/issues/ACM-5")).body.comments[0].body).toBe("oops");
    const teams = (await acme("GET", "/api/teams")).body.map((t: any) => [t.key, t.counts, t.docCount]);
    expect(teams).toEqual([
      ["ACM", { backlog: 0, todo: 1, in_progress: 1, in_review: 0, done: 1, canceled: 0 }, 1],
      ["OPS", { backlog: 0, todo: 1, in_progress: 0, in_review: 0, done: 0, canceled: 0 }, 1],
    ]);
    const next = async (workspace: string, team: string) => (await sam(workspace)("POST", "/api/issues", { team, title: "Next" })).body.id;
    expect(await next("acme", "ACM")).toBe("ACM-6");
    expect(await next("acme", "OPS")).toBe("OPS-2");
    expect(await next("side", "SID")).toBe("SID-3");
    expect((await acme("POST", "/api/issues/ACM-5/restore")).body).toMatchObject({ id: "ACM-5", parent: "ACM-1" });
    expect((await acme("POST", "/api/documents/old-idea/restore")).body).toMatchObject({ team: "ACM", position: 3 });
  });

  test("keys and slugs are per workspace from now on", async () => {
    const side = sam("side");
    expect((await side("POST", "/api/teams", { key: "ACM", name: "Side's own ACM" })).status).toBe(201);
    expect((await side("POST", "/api/documents", { team: "ACM", title: "Plan" })).body.slug).toBe("plan");
    expect((await sam("acme")("GET", "/api/documents/plan")).body.issues.map((i: any) => i.id)).toEqual(["ACM-1", "OPS-1"]);
    expect((await sam("acme")("GET", "/api/issues/ACM-1")).body.title).toBe("Parent");
  });
});

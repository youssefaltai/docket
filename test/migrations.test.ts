// Migration 4 (keys belong to one workspace) on a database written under schema 3: data survives, and every
// existing key lands in the right workspace.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startServer, type Caller, type TestServer } from "./server.ts";

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
    expect([...AFTER, ...UNCHANGED].map((sql) => rows(v5, sql))).toMatchObject(before); // later migrations may add columns (13: comment threads)
    expect(rows(v5, "SELECT key, id FROM teams ORDER BY id")).toEqual([
      { key: "OPS", id: 1 }, // created first
      { key: "ACM", id: 2 },
      { key: "SID", id: 3 },
    ]);
    expect(rows(v5, "PRAGMA foreign_key_check")).toEqual([]);
    expect(rows(v5, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect((rows(v5, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(6);
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
      ["ACM", { backlog: 0, todo: 1, in_progress: 1, in_review: 0, done: 1, canceled: 0, duplicate: 0 }, 1],
      ["OPS", { backlog: 0, todo: 1, in_progress: 0, in_review: 0, done: 0, canceled: 0, duplicate: 0 }, 1],
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

// Migration 7 (issue history) on a database written under schema 6: every existing issue, trashed or not,
// gets exactly one "created" row, by its creator at its createdAt; nothing else changes.
describe("migration 7", () => {
  // Migrations 1–6 exactly as they shipped (src/server/db.ts): 1–3 above, then 4, 5 and 6. Frozen: never edit this fixture.
  const SCHEMA_V6 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const trashedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // a day ago: not purged yet
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };

  let v6: string;
  let before: unknown[][];
  let server: TestServer;
  // Tables migration 7 leaves alone.
  const UNCHANGED = ["SELECT * FROM issues ORDER BY id", "SELECT * FROM comments ORDER BY id", "SELECT * FROM teams ORDER BY id"];
  beforeAll(async () => {
    v6 = join(dir, "v6.db");
    const db = new Database(v6, { create: true });
    for (const sql of SCHEMA_V6) db.run(sql);
    db.run("PRAGMA user_version = 6");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'sam@example.com', '${t(0)}'), (2, 'agent', NULL, '${t(1)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'sam', 'Sam', 'admin', '${t(0)}'), ('acme', 2, 'bot', 'Bot', 'agent', '${t(1)}')`);
    db.run(`INSERT INTO api_keys (id, user_id, name, scope, token_hash, created_at, workspace) VALUES
      (11, 1, 'laptop', 'write', '${hash(ADMIN_KEY)}', '${t(1)}', 'acme')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES (5, 'acme', 'ACM', 'Acme team', '${t(0)}', '${t(0)}', 4)`);
    db.run(`INSERT INTO issues (id, team_id, number, title, status, assignee_id, delegate_id, creator_id, created_at, updated_at, completed_at, deleted_at) VALUES
      (101, 5, 1, 'By sam', 'done', 1, 2, 1, '${t(2)}', '${t(9)}', '${t(9)}', NULL),
      (102, 5, 3, 'By bot', 'todo', NULL, NULL, 2, '${t(4)}', '${t(5)}', NULL, '${trashedAt}')`);
    db.run(`INSERT INTO comments (id, issue_id, author_id, body, created_at) VALUES (301, 101, 2, 'shipped', '${t(8)}')`);
    db.close();
    before = UNCHANGED.map((sql) => rows(v6, sql));
    server = await startServer({ setup: false, env: { DATABASE_PATH: v6 } });
  });
  afterAll(() => server.stop());

  test("each issue gets one created row by its creator at its createdAt; the rest is untouched", () => {
    expect(rows(v6, "SELECT issue_id, actor_id, on_behalf_of_id, kind, from_value, to_value, created_at FROM issue_activity ORDER BY id")).toEqual([
      { issue_id: 101, actor_id: 1, on_behalf_of_id: null, kind: "created", from_value: null, to_value: null, created_at: t(2) },
      { issue_id: 102, actor_id: 2, on_behalf_of_id: null, kind: "created", from_value: null, to_value: null, created_at: t(4) },
    ]);
    expect(UNCHANGED.map((sql) => rows(v6, sql))).toMatchObject(before); // later migrations may add columns (12: issues.due_on, 13: comment threads)
    expect(rows(v6, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v6, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(7);
  });

  test("the issue reads intact over REST, with its creation as its history", async () => {
    const sam = server.with({ token: ADMIN_KEY });
    const issue = (await sam.api("GET", "/api/issues/ACM-1")).body;
    expect(issue).toMatchObject({ title: "By sam", status: "done", assignee: { username: "sam" }, delegate: { username: "bot" } });
    expect(issue.comments.map((c: any) => [c.author.username, c.body])).toEqual([["bot", "shipped"]]);
    expect(issue.activity).toEqual([
      { id: 1, kind: "created", actor: { username: "sam", name: "Sam", kind: "person" }, onBehalfOf: null, from: null, to: null, createdAt: t(2) },
    ]);
    const trashed = (await sam.api("GET", "/api/issues/ACM-3")).body;
    expect(trashed.activity.map((r: any) => [r.kind, r.actor.username, r.createdAt])).toEqual([["created", "bot", t(4)]]);
    // History carries on from there.
    await sam.api("PATCH", "/api/issues/ACM-1", { status: "canceled" });
    expect((await sam.api("GET", "/api/issues/ACM-1")).body.activity.map((r: any) => [r.kind, r.from, r.to])).toEqual([
      ["created", null, null],
      ["status", "done", "canceled"],
    ]);
  });
});

// Migration 8 (mentions) on a database written under schema 7: nothing changes, and the table starts empty; migration 9,
// which runs next, backfills the mentions of texts written before. An edit afterwards records its new mentions.
describe("migration 8", () => {
  // Migrations 1–7 exactly as they shipped (src/server/db.ts): 1–3 above, then 4, 5, 6 and 7. Frozen: never edit this fixture.
  const SCHEMA_V7 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };

  let v7: string;
  let before: unknown[][];
  let server: TestServer;
  // Everything migration 8 leaves alone.
  const UNCHANGED = [
    "SELECT * FROM users ORDER BY id",
    "SELECT * FROM workspace_members ORDER BY workspace, user_id",
    "SELECT * FROM teams ORDER BY id",
    "SELECT * FROM issues ORDER BY id",
    "SELECT * FROM comments ORDER BY id",
    "SELECT * FROM documents ORDER BY id",
    "SELECT * FROM document_comments ORDER BY id",
    "SELECT * FROM issue_activity ORDER BY id",
  ];
  beforeAll(async () => {
    v7 = join(dir, "v7.db");
    const db = new Database(v7, { create: true });
    for (const sql of SCHEMA_V7) db.run(sql);
    db.run("PRAGMA user_version = 7");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES
      (1, 'person', 'sam@example.com', '${t(0)}'), (2, 'agent', NULL, '${t(1)}'), (3, 'person', NULL, '${t(2)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'sam', 'Sam', 'admin', '${t(0)}'), ('acme', 2, 'bot', 'Bot', 'agent', '${t(1)}'), ('acme', 3, 'ana', 'Ana', 'member', '${t(2)}')`);
    db.run(`INSERT INTO api_keys (id, user_id, name, scope, token_hash, created_at, workspace) VALUES
      (11, 1, 'laptop', 'write', '${hash(ADMIN_KEY)}', '${t(1)}', 'acme')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES (5, 'acme', 'ACM', 'Acme team', '${t(0)}', '${t(0)}', 2)`);
    db.run(`INSERT INTO issues (id, team_id, number, title, description, status, creator_id, created_at, updated_at) VALUES
      (101, 5, 1, 'Written before', 'For @ana', 'todo', 1, '${t(3)}', '${t(3)}')`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) VALUES (101, 1, 'created', '${t(3)}')`);
    db.run(`INSERT INTO comments (id, issue_id, author_id, body, created_at) VALUES (301, 101, 1, 'hi @ana', '${t(4)}')`);
    db.run(`INSERT INTO documents (id, workspace, team_id, slug, title, content, position, created_at, updated_at, updated_by_id) VALUES
      (201, 'acme', 5, 'plan', 'Plan', 'Owner: @bot.', 1, '${t(5)}', '${t(5)}', 1)`);
    db.run(`INSERT INTO document_comments (id, document_id, author_id, body, created_at) VALUES (401, 201, 2, '@sam ok', '${t(6)}')`);
    db.close();
    before = UNCHANGED.map((sql) => rows(v7, sql));
    server = await startServer({ setup: false, env: { DATABASE_PATH: v7 } });
  });
  afterAll(() => server.stop());

  test("the data is untouched, and mentions are those migration 9 backfills", () => {
    expect(UNCHANGED.map((sql) => rows(v7, sql))).toMatchObject(before); // later migrations may add columns (12: issues.due_on, 13: comment threads)
    expect(rows(v7, "SELECT source, user_id FROM mentions ORDER BY source")).toEqual([
      { source: "comment:301", user_id: 3 },
      { source: "document_comment:401", user_id: 1 },
      { source: "issue:101", user_id: 3 },
    ]);
    expect(rows(v7, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v7, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(8);
  });

  test("everything reads intact, and a comment edited afterwards gets its mentions", async () => {
    const sam = server.with({ token: ADMIN_KEY });
    const issue = (await sam.api("GET", "/api/issues/ACM-1")).body;
    expect(issue).toMatchObject({ title: "Written before", description: "For @ana" });
    expect(issue.comments.map((c: any) => [c.id, c.author.username, c.body])).toEqual([[301, "sam", "hi @ana"]]);
    const doc = (await sam.api("GET", "/api/documents/plan")).body;
    expect([doc.content, doc.comments.map((c: any) => [c.author.username, c.body])]).toEqual(["Owner: @bot.", [["bot", "@sam ok"]]]);
    expect((await sam.api("PATCH", "/api/issues/ACM-1/comments/301", { body: "hi @ana and @bot" })).status).toBe(200);
    expect(rows(v7, "SELECT source, user_id, issue_id, document_id, author_id FROM mentions WHERE source = 'comment:301' ORDER BY user_id")).toEqual([
      { source: "comment:301", user_id: 2, issue_id: 101, document_id: null, author_id: 1 },
      { source: "comment:301", user_id: 3, issue_id: 101, document_id: null, author_id: 1 },
    ]);
  });
});

// Migration 9 (the inbox) on a database written under schema 8: nothing changes, existing work is subscribed the
// way new work will be, and texts written before migration 8 get their mentions, so saving them again announces
// nothing old (only new mentions notify).
describe("migration 9", () => {
  // Migrations 1–8 exactly as they shipped (src/server/db.ts): 1–3 above, then 4, 5, 6, 7 and 8. Frozen: never edit this fixture.
  const SCHEMA_V8 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  const ANA_KEY = `dk_${"f".repeat(64)}`;

  let v8: string;
  let before: unknown[][];
  let server: TestServer;
  // Everything migration 9 leaves alone (it adds subscriptions and notifications, and backfills mentions).
  const UNCHANGED = [
    "SELECT * FROM users ORDER BY id",
    "SELECT * FROM workspace_members ORDER BY workspace, user_id",
    "SELECT * FROM teams ORDER BY id",
    "SELECT * FROM issues ORDER BY id",
    "SELECT * FROM comments ORDER BY id",
    "SELECT * FROM documents ORDER BY id",
    "SELECT * FROM document_versions ORDER BY id",
    "SELECT * FROM document_comments ORDER BY id",
    "SELECT * FROM issue_activity ORDER BY id",
  ];
  beforeAll(async () => {
    v8 = join(dir, "v8.db");
    const db = new Database(v8, { create: true });
    for (const sql of SCHEMA_V8) db.run(sql);
    db.run("PRAGMA user_version = 8");
    // sam (admin), bot (agent), ana, kim (suspended) in acme; zed only in side.
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', NULL, '${t(0)}'), (2, 'agent', NULL, '${t(0)}'),
      (3, 'person', NULL, '${t(0)}'), (4, 'person', NULL, '${t(0)}'), (5, 'person', NULL, '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}'), ('side', 'Side', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at, suspended_at) VALUES
      ('acme', 1, 'sam', 'Sam', 'admin', '${t(0)}', NULL), ('acme', 2, 'bot', 'Bot', 'agent', '${t(0)}', NULL),
      ('acme', 3, 'ana', 'Ana', 'member', '${t(0)}', NULL), ('acme', 4, 'kim', 'Kim', 'member', '${t(0)}', '${t(1)}'),
      ('side', 5, 'zed', 'Zed', 'admin', '${t(0)}', NULL)`);
    db.run(`INSERT INTO api_keys (id, user_id, name, scope, token_hash, created_at, workspace) VALUES
      (11, 1, 'sam', 'write', '${hash(ADMIN_KEY)}', '${t(0)}', 'acme'), (12, 2, 'bot', 'write', '${hash(AGENT_KEY)}', '${t(0)}', 'acme'),
      (13, 3, 'ana', 'write', '${hash(ANA_KEY)}', '${t(0)}', 'acme')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES
      (5, 'acme', 'ACM', 'Acme', '${t(0)}', '${t(0)}', 3), (6, 'side', 'SID', 'Side', '${t(0)}', '${t(0)}', 2)`);
    // ACM-1: sam's, assigned to ana, delegated to bot. ACM-2: ana's, its description last edited by sam. SID-1: zed's.
    db.run(`INSERT INTO issues (id, team_id, number, title, description, status, assignee_id, delegate_id, creator_id, created_at, updated_at) VALUES
      (101, 5, 1, 'Old one', 'For @ana and @kim', 'todo', 3, 2, 1, '${t(2)}', '${t(3)}'),
      (102, 5, 2, 'Edited', 'cc @bot', 'todo', NULL, NULL, 3, '${t(2)}', '${t(8)}'),
      (501, 6, 1, 'Elsewhere', 'ping @ana and @zed', 'todo', NULL, NULL, 5, '${t(2)}', '${t(2)}')`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) VALUES
      (101, 1, 'created', '${t(2)}'), (102, 3, 'created', '${t(2)}'), (102, 1, 'description', '${t(8)}'), (501, 5, 'created', '${t(2)}')`);
    db.run(`INSERT INTO comments (id, issue_id, author_id, body, created_at, edited_at) VALUES
      (301, 101, 2, 'hi @ana, see @sam', '${t(4)}', NULL), (302, 101, 1, 'cc @bot', '${t(9)}', NULL)`);
    // Written after migration 8: its mention is on record already.
    db.run(`INSERT INTO mentions (source, user_id, issue_id, document_id, author_id, created_at) VALUES ('comment:302', 2, 101, NULL, 1, '${t(9)}')`);
    // A doc sam created and ana edited last; its content ends in a mention still being typed.
    db.run(`INSERT INTO documents (id, workspace, team_id, slug, title, content, position, created_at, updated_at, updated_by_id) VALUES
      (201, 'acme', 5, 'plan', 'Plan', 'Owner: @sam. Draft by @ana', 1, '${t(5)}', '${t(7)}', 3)`);
    db.run(`INSERT INTO document_versions (id, document_id, title, content, author_id, created_at) VALUES
      (1, 201, 'Plan', 'Owner: @sam.', 1, '${t(5)}'), (2, 201, 'Plan', 'Owner: @sam. Draft by @ana', 3, '${t(7)}')`);
    db.run(`INSERT INTO document_comments (id, document_id, author_id, body, created_at) VALUES (401, 201, 2, '@ana ok', '${t(6)}')`);
    db.close();
    before = UNCHANGED.map((sql) => rows(v8, sql));
    server = await startServer({ setup: false, env: { DATABASE_PATH: v8 } });
  });
  afterAll(() => server.stop());

  test("the data is untouched and the inbox starts empty", () => {
    expect(UNCHANGED.map((sql) => rows(v8, sql))).toMatchObject(before); // later migrations may add columns (12: issues.due_on, 13: comment threads)
    expect(rows(v8, "SELECT * FROM notifications")).toEqual([]);
    expect(rows(v8, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v8, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(9);
  });

  test("older texts get their mentions, by their last author at its time", () => {
    expect(rows(v8, "SELECT source, user_id, issue_id, document_id, author_id, created_at FROM mentions ORDER BY source, user_id")).toEqual([
      { source: "comment:301", user_id: 1, issue_id: 101, document_id: null, author_id: 2, created_at: t(4) },
      { source: "comment:301", user_id: 3, issue_id: 101, document_id: null, author_id: 2, created_at: t(4) },
      { source: "comment:302", user_id: 2, issue_id: 101, document_id: null, author_id: 1, created_at: t(9) },
      { source: "document:201", user_id: 1, issue_id: null, document_id: 201, author_id: 3, created_at: t(7) },
      { source: "document_comment:401", user_id: 3, issue_id: null, document_id: 201, author_id: 2, created_at: t(6) },
      { source: "issue:101", user_id: 3, issue_id: 101, document_id: null, author_id: 1, created_at: t(3) },
      { source: "issue:102", user_id: 2, issue_id: 102, document_id: null, author_id: 1, created_at: t(8) },
    ]);
  });

  test("creators, assignees, delegates, commenters and the mentioned are subscribed", () => {
    expect(rows(v8, "SELECT user_id, issue_id, document_id FROM subscriptions ORDER BY issue_id, document_id, user_id")).toEqual([
      { user_id: 1, issue_id: null, document_id: 201 },
      { user_id: 2, issue_id: null, document_id: 201 },
      { user_id: 3, issue_id: null, document_id: 201 },
      { user_id: 1, issue_id: 101, document_id: null },
      { user_id: 2, issue_id: 101, document_id: null },
      { user_id: 3, issue_id: 101, document_id: null },
      { user_id: 2, issue_id: 102, document_id: null },
      { user_id: 3, issue_id: 102, document_id: null },
      { user_id: 5, issue_id: 501, document_id: null },
    ]);
  });

  test("saving an older text again announces nothing; a new mention does", async () => {
    const [sam, bot, ana] = [ADMIN_KEY, AGENT_KEY, ANA_KEY].map((token) => server.with({ token })) as [Caller, Caller, Caller];
    expect((await sam.api("GET", "/api/issues/ACM-1")).body.subscribed).toBe(true);
    expect((await ana.api("GET", "/api/issues?subscribed=true")).body.map((i: any) => i.id)).toEqual(["ACM-2", "ACM-1"]);
    expect((await bot.api("PATCH", "/api/issues/ACM-1/comments/301", { body: "hi @ana, see @sam!" })).status).toBe(200);
    expect((await sam.api("PATCH", "/api/issues/ACM-1", { description: "For @ana and @kim, updated" })).status).toBe(200);
    expect((await ana.api("PATCH", "/api/documents/plan", { edits: [{ oldText: "Owner", newText: "Lead" }] })).status).toBe(200);
    expect((await bot.api("PATCH", "/api/documents/plan/comments/401", { body: "@ana ok!" })).status).toBe(200);
    expect(rows(v8, "SELECT * FROM notifications")).toEqual([]);
    expect((await sam.api("PATCH", "/api/issues/ACM-2", { description: "cc @bot and @ana" })).status).toBe(200);
    expect((await ana.api("GET", "/api/notifications")).body.notifications.map((n: any) => [n.kind, n.actor.username, n.issue.id])).toEqual([
      ["mentioned", "sam", "ACM-2"],
    ]);
  });
});

// Migration 10 (webhooks) on a database written under schema 9: nothing changes, the two tables start empty, and
// webhooks work on the migrated database.
describe("migration 10", () => {
  // Migrations 1–9 exactly as they shipped (src/server/db.ts): 1–3 above, then 4–8, then the SQL migration 9 runs.
  // Migration 9 is a function: its two SQL blocks are frozen here; between them it runs backfillMentions(), which only
  // reads texts already in the database, so on this empty schema it writes nothing and is left out. Frozen: never edit.
  const SCHEMA_V9 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Everything migration 10 leaves alone: all of schema 9's tables.
  const UNCHANGED = [
    "users",
    "workspaces",
    "workspace_members",
    "sessions",
    "api_keys",
    "codes",
    "teams",
    "issues",
    "issue_blocks",
    "comments",
    "documents",
    "document_versions",
    "document_refs",
    "document_comments",
    "issue_activity",
    "mentions",
    "subscriptions",
    "notifications",
  ].map((table) => `SELECT * FROM ${table} ORDER BY rowid`);

  let v9: string;
  let before: unknown[][];
  let server: TestServer;
  beforeAll(async () => {
    v9 = join(dir, "v9.db");
    const db = new Database(v9, { create: true });
    for (const sql of SCHEMA_V9) db.run(sql);
    db.run("PRAGMA user_version = 9");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'sam@example.com', '${t(0)}'), (2, 'agent', NULL, '${t(0)}'), (3, 'person', NULL, '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'sam', 'Sam', 'admin', '${t(0)}'), ('acme', 2, 'bot', 'Bot', 'agent', '${t(0)}'), ('acme', 3, 'ana', 'Ana', 'member', '${t(0)}')`);
    db.run(`INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, user_agent, ip)
      VALUES (1, 1, '${hash(SESSION)}', '${t(0)}', '${new Date().toISOString()}', 'test', '127.0.0.1')`);
    db.run(`INSERT INTO api_keys (id, user_id, name, scope, token_hash, created_at, workspace) VALUES (12, 2, 'bot', 'write', '${hash(AGENT_KEY)}', '${t(0)}', 'acme')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES (5, 'acme', 'ACM', 'Acme', '${t(0)}', '${t(0)}', 2)`);
    db.run(`INSERT INTO issues (id, team_id, number, title, description, status, delegate_id, creator_id, created_at, updated_at) VALUES
      (101, 5, 1, 'Old one', 'For @bot', 'todo', 2, 1, '${t(1)}', '${t(2)}')`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, from_value, to_value, created_at) VALUES
      (101, 1, 'created', NULL, NULL, '${t(1)}'), (101, 1, 'delegate', NULL, '2', '${t(1)}')`);
    db.run(`INSERT INTO comments (id, issue_id, author_id, body, created_at) VALUES (301, 101, 3, 'hi @bot', '${t(3)}')`);
    db.run(`INSERT INTO documents (id, workspace, team_id, slug, title, content, position, created_at, updated_at, updated_by_id) VALUES
      (201, 'acme', 5, 'plan', 'Plan', 'See ACM-1', 1, '${t(4)}', '${t(4)}', 1)`);
    db.run(`INSERT INTO document_versions (id, document_id, title, content, author_id, created_at) VALUES (1, 201, 'Plan', 'See ACM-1', 1, '${t(4)}')`);
    db.run(`INSERT INTO document_refs (document_id, issue_id, ord) VALUES (201, 101, 0)`);
    db.run(`INSERT INTO mentions (source, user_id, issue_id, document_id, author_id, created_at) VALUES
      ('issue:101', 2, 101, NULL, 1, '${t(2)}'), ('comment:301', 2, 101, NULL, 3, '${t(3)}')`);
    db.run(`INSERT INTO subscriptions (user_id, issue_id, document_id, created_at) VALUES
      (1, 101, NULL, '${t(1)}'), (2, 101, NULL, '${t(1)}'), (3, 101, NULL, '${t(3)}'), (1, NULL, 201, '${t(4)}')`);
    db.run(`INSERT INTO notifications (id, user_id, workspace, kind, actor_id, issue_id, comment_id, created_at) VALUES
      (1, 2, 'acme', 'delegated', 1, 101, NULL, '${t(1)}'), (2, 2, 'acme', 'mentioned', 3, 101, 301, '${t(3)}')`);
    db.close();
    before = UNCHANGED.map((sql) => rows(v9, sql));
    server = await startServer({ setup: false, env: { DATABASE_PATH: v9, DOCKET_WEBHOOK_ALLOW_PRIVATE: "true" } });
  });
  afterAll(() => server.stop());

  test("the data is untouched and the webhook tables start empty", () => {
    expect(UNCHANGED.map((sql) => rows(v9, sql))).toMatchObject(before); // later migrations may add columns (12: issues.due_on, 13: comment threads)
    expect(rows(v9, "SELECT * FROM webhooks")).toEqual([]);
    expect(rows(v9, "SELECT * FROM webhook_deliveries")).toEqual([]);
    expect(rows(v9, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v9, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(10);
  });

  test("webhooks work on the migrated database", async () => {
    const sam = server.with({ cookie: `docket_session=${SESSION}` }, "cookie");
    const created = await sam.api("POST", "/api/workspaces/acme/webhooks", { url: "http://127.0.0.1:1/hook", resourceTypes: ["Issue", "Notification"] });
    expect(created.status).toBe(201);
    expect((await server.with({ token: AGENT_KEY }).api("PATCH", "/api/issues/ACM-1", { status: "in_progress" })).status).toBe(200);
    const log = rows(v9, "SELECT type, action, entity, json_extract(payload, '$.updatedFrom.status') AS was FROM webhook_deliveries ORDER BY id");
    expect(log).toEqual([{ type: "Issue", action: "update", entity: "ACM-1", was: "todo" }]);
    await sam.api("DELETE", `/api/workspaces/acme/webhooks/${created.body.webhook.id}`);
    expect(rows(v9, "SELECT * FROM webhook_deliveries")).toEqual([]);
  });
});

describe("migration 11", () => {
  // Migrations 1–10 exactly as they shipped (src/server/db.ts): migration 10's fixture above (1–9, with migration 9's
  // two SQL blocks and its backfill left out, as noted there), then migration 10. Frozen: never edit this fixture.
  const SCHEMA_V10 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Everything migration 11 leaves alone: all of schema 10's tables.
  const UNCHANGED = [
    "users",
    "workspaces",
    "workspace_members",
    "sessions",
    "api_keys",
    "codes",
    "teams",
    "issues",
    "issue_blocks",
    "comments",
    "documents",
    "document_versions",
    "document_refs",
    "document_comments",
    "issue_activity",
    "mentions",
    "subscriptions",
    "notifications",
    "webhooks",
    "webhook_deliveries",
  ].map((table) => `SELECT * FROM ${table} ORDER BY rowid`);

  let v10: string;
  let before: unknown[][];
  let server: TestServer;
  beforeAll(async () => {
    v10 = join(dir, "v10.db");
    const db = new Database(v10, { create: true });
    for (const sql of SCHEMA_V10) db.run(sql);
    db.run("PRAGMA user_version = 10");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'sam@example.com', '${t(0)}'), (2, 'agent', NULL, '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'sam', 'Sam', 'admin', '${t(0)}'), ('acme', 2, 'bot', 'Bot', 'agent', '${t(0)}')`);
    db.run(`INSERT INTO api_keys (id, user_id, name, scope, token_hash, created_at, workspace) VALUES (12, 2, 'bot', 'write', '${hash(AGENT_KEY)}', '${t(0)}', 'acme')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES (5, 'acme', 'ACM', 'Acme', '${t(0)}', '${t(0)}', 4)`);
    db.run(`INSERT INTO issues (id, team_id, number, title, status, creator_id, created_at, updated_at, deleted_at) VALUES
      (101, 5, 1, 'Blocker', 'todo', 1, '${t(1)}', '${t(1)}', NULL),
      (102, 5, 2, 'Blocked', 'todo', 1, '${t(2)}', '${t(2)}', NULL),
      (103, 5, 3, 'Trashed', 'todo', 1, '${t(3)}', '${t(3)}', '${new Date().toISOString()}')`); // recent: purged after 30 days
    db.run(`INSERT INTO issue_blocks (blocker_id, blocked_id) VALUES (101, 102)`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, from_value, to_value, created_at) VALUES
      (101, 1, 'created', NULL, NULL, '${t(1)}'), (102, 1, 'created', NULL, NULL, '${t(2)}'), (102, 1, 'blockedBy', '[]', '["ACM-1"]', '${t(2)}'),
      (103, 1, 'created', NULL, NULL, '${t(3)}')`);
    db.run(`INSERT INTO subscriptions (user_id, issue_id, created_at) VALUES (1, 101, '${t(1)}'), (1, 102, '${t(2)}')`);
    db.run(`INSERT INTO webhooks (id, workspace, url, resource_types, secret, created_by, created_at, updated_at) VALUES
      (7, 'acme', 'http://127.0.0.1:1/hook', '["Issue"]', 'dkwh_x', 1, '${t(5)}', '${t(5)}')`);
    db.close();
    before = UNCHANGED.map((sql) => rows(v10, sql));
    server = await startServer({ setup: false, env: { DATABASE_PATH: v10, DOCKET_WEBHOOK_ALLOW_PRIVATE: "true" } });
  });
  afterAll(() => server.stop());

  test("the data is untouched and issue_relations starts empty", () => {
    expect(UNCHANGED.map((sql) => rows(v10, sql))).toMatchObject(before); // later migrations may add columns (12: issues.due_on, 13: comment threads)
    expect(rows(v10, "SELECT * FROM issue_relations")).toEqual([]);
    expect(rows(v10, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v10, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(11);
  });

  test("issues read as before, with no relations; blockers still work, and relations work on the migrated database", async () => {
    const bot = server.with({ token: AGENT_KEY });
    const blocked = (await bot.api("GET", "/api/issues/ACM-2")).body;
    expect(blocked).toMatchObject({ title: "Blocked", blockedBy: ["ACM-1"], relatedTo: [], duplicateOf: null, duplicates: [] });
    expect((await bot.api("GET", "/api/issues/ACM-1")).body).toMatchObject({ blocks: ["ACM-2"], relatedTo: [], duplicates: [] });
    expect((await bot.api("PATCH", "/api/issues/ACM-2", { relatedTo: ["ACM-1"], duplicateOf: "ACM-1" })).body).toMatchObject({
      blockedBy: ["ACM-1"],
      relatedTo: ["ACM-1"],
      duplicateOf: "ACM-1",
      status: "duplicate", // its team's Duplicate status since migration 16
    });
    expect((await bot.api("GET", "/api/issues/ACM-1")).body).toMatchObject({ blocks: ["ACM-2"], relatedTo: ["ACM-2"], duplicates: ["ACM-2"] });
    expect((await bot.api("PATCH", "/api/issues/ACM-2", { relatedTo: ["ACM-3"] })).status).toBe(400); // in the trash
    expect(rows(v10, "SELECT from_id, to_id, kind FROM issue_relations ORDER BY kind")).toEqual([
      { from_id: 102, to_id: 101, kind: "duplicate" },
      { from_id: 101, to_id: 102, kind: "related" },
    ]);
  });
});

// Migration 12 (due dates) on a database written under schema 11: every row stays as it was, issues gain an empty due_on,
// and due dates work on the migrated database.
describe("migration 12", () => {
  // Migrations 1–11 exactly as they shipped (src/server/db.ts): migration 11's fixture above (1–10, with migration 9's
  // two SQL blocks and its backfill left out, as noted at migration 10), then migration 11. Frozen: never edit this fixture.
  const SCHEMA_V11 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
    `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Everything migration 12 leaves alone: all of schema 11's tables but issues, which gains a column.
  const UNCHANGED = [
    "users",
    "workspaces",
    "workspace_members",
    "sessions",
    "api_keys",
    "codes",
    "teams",
    "issue_blocks",
    "issue_relations",
    "comments",
    "documents",
    "document_versions",
    "document_refs",
    "document_comments",
    "issue_activity",
    "mentions",
    "subscriptions",
    "notifications",
    "webhooks",
    "webhook_deliveries",
  ].map((table) => `SELECT * FROM ${table} ORDER BY rowid`);
  const ISSUES = "SELECT * FROM issues ORDER BY id";

  let v11: string;
  let before: unknown[][];
  let issuesBefore: Record<string, unknown>[];
  let server: TestServer;
  beforeAll(async () => {
    v11 = join(dir, "v11.db");
    const db = new Database(v11, { create: true });
    for (const sql of SCHEMA_V11) db.run(sql);
    db.run("PRAGMA user_version = 11");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'sam@example.com', '${t(0)}'), (2, 'agent', NULL, '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'sam', 'Sam', 'admin', '${t(0)}'), ('acme', 2, 'bot', 'Bot', 'agent', '${t(0)}')`);
    db.run(`INSERT INTO api_keys (id, user_id, name, scope, token_hash, created_at, workspace) VALUES (12, 2, 'bot', 'write', '${hash(AGENT_KEY)}', '${t(0)}', 'acme')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES (5, 'acme', 'ACM', 'Acme', '${t(0)}', '${t(0)}', 4)`);
    db.run(`INSERT INTO issues (id, team_id, number, title, status, priority, labels, creator_id, created_at, updated_at, completed_at) VALUES
      (101, 5, 1, 'Open', 'todo', 2, '["bug"]', 1, '${t(1)}', '${t(1)}', NULL),
      (102, 5, 2, 'Done', 'done', 0, '[]', 1, '${t(2)}', '${t(2)}', '${t(2)}'),
      (103, 5, 3, 'Duplicate', 'canceled', 0, '[]', 1, '${t(3)}', '${t(3)}', '${t(3)}')`);
    db.run(`INSERT INTO issue_relations (from_id, to_id, kind, created_at) VALUES (103, 101, 'duplicate', '${t(3)}'), (101, 102, 'related', '${t(3)}')`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, from_value, to_value, created_at) VALUES
      (101, 1, 'created', NULL, NULL, '${t(1)}'), (102, 1, 'created', NULL, NULL, '${t(2)}'), (103, 1, 'created', NULL, NULL, '${t(3)}'),
      (103, 1, 'duplicateOf', NULL, '"ACM-1"', '${t(3)}')`);
    db.run(`INSERT INTO subscriptions (user_id, issue_id, created_at) VALUES (1, 101, '${t(1)}')`);
    db.close();
    before = UNCHANGED.map((sql) => rows(v11, sql));
    issuesBefore = rows(v11, ISSUES) as Record<string, unknown>[];
    server = await startServer({ setup: false, env: { DATABASE_PATH: v11 } });
  });
  afterAll(() => server.stop());

  test("the data is untouched; issues gain due_on, empty, and its index", () => {
    expect(UNCHANGED.map((sql) => rows(v11, sql))).toMatchObject(before); // later migrations may add columns (16: teams.default_status)
    expect(rows(v11, ISSUES)).toMatchObject(issuesBefore.map((issue) => ({ ...issue, due_on: null }))); // later migrations may add columns (19: issues.archived_at)
    expect(rows(v11, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'issues' AND name = 'issues_due'")).toEqual([{ name: "issues_due" }]);
    expect(rows(v11, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v11, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(12);
  });

  test("issues read as before with no due date, and due dates work on the migrated database", async () => {
    const bot = server.with({ token: AGENT_KEY });
    const list = (query: string) => bot.api("GET", `/api/issues?${query}`).then((r) => r.body.map((i: any) => i.id));
    expect((await bot.api("GET", "/api/issues/ACM-1")).body).toMatchObject({ title: "Open", priority: 2, labels: ["bug"], relatedTo: ["ACM-2"], duplicates: ["ACM-3"], dueOn: null });
    expect(await list("due=none")).toEqual(["ACM-1", "ACM-2", "ACM-3"]);
    expect(await list("due=any")).toEqual([]);
    expect((await bot.api("PATCH", "/api/issues/ACM-2", { dueOn: "2026-01-01" })).body).toMatchObject({ dueOn: "2026-01-01", status: "done" });
    expect(await list("due=any")).toEqual(["ACM-2"]);
    expect(await list("due=overdue")).toEqual([]); // done: never overdue
    expect(await list("sort=due")).toEqual(["ACM-2", "ACM-1", "ACM-3"]);
  });
});

describe("migration 13", () => {
  // Migrations 1–12 exactly as they shipped (src/server/db.ts): migration 12's fixture above (1–11, with migration 9's
  // two SQL blocks and its backfill left out, as noted at migration 10), then migration 12. Frozen: never edit this fixture.
  const SCHEMA_V12 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
    `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
    `
  ALTER TABLE issues ADD COLUMN due_on TEXT;
  CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Everything migration 13 leaves alone: all of schema 12's tables but the two comment tables, which gain columns.
  const UNCHANGED = [
    "users",
    "workspaces",
    "workspace_members",
    "sessions",
    "api_keys",
    "codes",
    "teams",
    "issues",
    "issue_blocks",
    "issue_relations",
    "documents",
    "document_versions",
    "document_refs",
    "issue_activity",
    "mentions",
    "subscriptions",
    "notifications",
    "webhooks",
    "webhook_deliveries",
  ].map((table) => `SELECT * FROM ${table} ORDER BY rowid`);
  const COMMENTS = ["SELECT * FROM comments ORDER BY id", "SELECT * FROM document_comments ORDER BY id"];

  let v12: string;
  let before: unknown[][];
  let commentsBefore: Record<string, unknown>[][];
  let server: TestServer;
  beforeAll(async () => {
    v12 = join(dir, "v12.db");
    const db = new Database(v12, { create: true });
    for (const sql of SCHEMA_V12) db.run(sql);
    db.run("PRAGMA user_version = 12");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'sam@example.com', '${t(0)}'), (2, 'agent', NULL, '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'sam', 'Sam', 'admin', '${t(0)}'), ('acme', 2, 'bot', 'Bot', 'agent', '${t(0)}')`);
    db.run(`INSERT INTO api_keys (id, user_id, name, scope, token_hash, created_at, workspace) VALUES (12, 2, 'bot', 'write', '${hash(AGENT_KEY)}', '${t(0)}', 'acme')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES (5, 'acme', 'ACM', 'Acme', '${t(0)}', '${t(0)}', 3)`);
    db.run(`INSERT INTO issues (id, team_id, number, title, status, creator_id, created_at, updated_at, due_on) VALUES
      (101, 5, 1, 'Talked about', 'todo', 1, '${t(1)}', '${t(4)}', '2026-02-01'), (102, 5, 2, 'Related', 'todo', 1, '${t(1)}', '${t(1)}', NULL)`);
    db.run(`INSERT INTO issue_relations (from_id, to_id, kind, created_at) VALUES (101, 102, 'related', '${t(1)}')`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) VALUES (101, 1, 'created', '${t(1)}'), (102, 1, 'created', '${t(1)}')`);
    db.run(`INSERT INTO comments (id, issue_id, author_id, body, created_at, edited_at) VALUES
      (201, 101, 1, 'Which way?', '${t(2)}', '${t(3)}'), (202, 101, 2, 'This way', '${t(4)}', NULL)`);
    db.run(`INSERT INTO documents (id, workspace, team_id, slug, title, content, position, created_at, updated_at, updated_by_id) VALUES
      (301, 'acme', 5, 'plan', 'Plan', 'x', 1, '${t(5)}', '${t(5)}', 1)`);
    db.run(`INSERT INTO document_versions (id, document_id, title, content, author_id, created_at) VALUES (1, 301, 'Plan', 'x', 1, '${t(5)}')`);
    db.run(`INSERT INTO document_comments (id, document_id, author_id, body, created_at) VALUES (401, 301, 1, 'Section 2?', '${t(6)}')`);
    db.run(`INSERT INTO subscriptions (user_id, issue_id, document_id, created_at) VALUES (1, 101, NULL, '${t(1)}'), (2, 101, NULL, '${t(4)}'), (1, NULL, 301, '${t(5)}')`);
    db.run(`INSERT INTO notifications (id, user_id, workspace, kind, actor_id, issue_id, comment_id, created_at) VALUES
      (1, 1, 'acme', 'commented', 2, 101, 202, '${t(4)}')`);
    db.close();
    before = UNCHANGED.map((sql) => rows(v12, sql));
    commentsBefore = COMMENTS.map((sql) => rows(v12, sql) as Record<string, unknown>[]);
    server = await startServer({ setup: false, env: { DATABASE_PATH: v12 } });
  });
  afterAll(() => server.stop());

  test("the data is untouched and every existing comment is an unresolved thread root", () => {
    expect(UNCHANGED.map((sql) => rows(v12, sql))).toMatchObject(before); // later migrations may add columns (16: teams.default_status)
    const roots = { parent_id: null, resolved_at: null, resolved_by_id: null };
    expect(COMMENTS.map((sql) => rows(v12, sql))).toEqual(commentsBefore.map((table) => table.map((c) => ({ ...c, ...roots }))));
    expect(rows(v12, "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%comments_parent' ORDER BY name")).toEqual([
      { name: "comments_parent" },
      { name: "document_comments_parent" },
    ]);
    expect(rows(v12, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v12, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(13);
  });

  test("old comments read as roots and can be replied to, resolved and reopened", async () => {
    const bot = server.with({ token: AGENT_KEY });
    const issue = (await bot.api("GET", "/api/issues/ACM-1")).body;
    expect(issue.dueOn).toBe("2026-02-01");
    expect(issue.comments.map((c: any) => [c.id, c.parent, c.resolvedAt, c.resolvedBy, c.editedAt])).toEqual([
      [201, null, null, null, t(3)],
      [202, null, null, null, null],
    ]);
    const replied = await bot.api("POST", "/api/issues/ACM-1/comments", { body: "Agreed", parent: 202 });
    expect(replied.body.comments.at(-1)).toMatchObject({ parent: 202, author: { username: "bot" } });
    expect((await bot.api("PUT", "/api/issues/ACM-1/comments/201/resolved")).body.comments[0]).toMatchObject({ id: 201, resolvedBy: { username: "bot" } });
    expect((await bot.api("DELETE", "/api/issues/ACM-1/comments/201/resolved")).body.comments[0]).toMatchObject({ id: 201, resolvedAt: null });
    expect((await bot.api("DELETE", "/api/issues/ACM-1/comments/202")).status).toBe(409); // now it has a reply
    const onDoc = await bot.api("POST", "/api/documents/plan/comments", { body: "Done", parent: 401 });
    expect(onDoc.body.comments.map((c: any) => [c.id, c.parent])).toEqual([
      [401, null],
      [onDoc.body.comments[1].id, 401],
    ]);
    expect(rows(v12, "PRAGMA foreign_key_check")).toEqual([]);
  });
});

describe("migration 14", () => {
  // Migrations 1-13 exactly as they shipped (src/server/db.ts): migration 13's fixture above (1-12), then
  // migration 13. Frozen: never edit this fixture.
  const SCHEMA_V13 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
    `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
    `
  ALTER TABLE issues ADD COLUMN due_on TEXT;
  CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
  `,
    `
  ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
  ALTER TABLE comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE;
  ALTER TABLE document_comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE document_comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Everything migration 14 leaves alone: a new table only, no columns added to any of these.
  const UNCHANGED = [
    "users",
    "workspaces",
    "workspace_members",
    "sessions",
    "api_keys",
    "codes",
    "teams",
    "issues",
    "issue_blocks",
    "issue_relations",
    "comments",
    "documents",
    "document_versions",
    "document_refs",
    "document_comments",
    "issue_activity",
    "mentions",
    "subscriptions",
    "notifications",
    "webhooks",
    "webhook_deliveries",
  ].map((table) => `SELECT * FROM ${table} ORDER BY rowid`);

  let v13: string;
  let before: unknown[][];
  let server: TestServer;
  beforeAll(async () => {
    v13 = join(dir, "v13.db");
    const db = new Database(v13, { create: true });
    for (const sql of SCHEMA_V13) db.run(sql);
    db.run("PRAGMA user_version = 13");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'sam@example.com', '${t(0)}'), (2, 'agent', NULL, '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'sam', 'Sam', 'admin', '${t(0)}'), ('acme', 2, 'bot', 'Bot', 'agent', '${t(0)}')`);
    db.run(`INSERT INTO api_keys (id, user_id, name, scope, token_hash, created_at, workspace) VALUES (12, 2, 'bot', 'write', '${hash(AGENT_KEY)}', '${t(0)}', 'acme')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES (5, 'acme', 'ACM', 'Acme', '${t(0)}', '${t(0)}', 2)`);
    db.run(`INSERT INTO issues (id, team_id, number, title, status, creator_id, created_at, updated_at) VALUES
      (101, 5, 1, 'Talked about', 'todo', 1, '${t(1)}', '${t(1)}')`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) VALUES (101, 1, 'created', '${t(1)}')`);
    db.run(`INSERT INTO comments (id, issue_id, author_id, body, created_at, parent_id, resolved_at, resolved_by_id) VALUES
      (201, 101, 1, 'Nice work', '${t(2)}', NULL, NULL, NULL)`);
    db.close();
    before = UNCHANGED.map((sql) => rows(v13, sql));
    server = await startServer({ setup: false, env: { DATABASE_PATH: v13 } });
  });
  afterAll(() => server.stop());

  test("the data is untouched; reactions is created, empty", () => {
    expect(UNCHANGED.map((sql) => rows(v13, sql))).toMatchObject(before); // later migrations may add columns (16: teams.default_status)
    expect(rows(v13, "SELECT COUNT(*) AS n FROM reactions")).toEqual([{ n: 0 }]);
    expect(rows(v13, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reactions'")).toEqual([{ name: "reactions" }]);
    expect(rows(v13, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v13, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(14);
  });

  test("old comments return reactions: [], and reactions work on the migrated database", async () => {
    const bot = server.with({ token: AGENT_KEY });
    const issue = (await bot.api("GET", "/api/issues/ACM-1")).body;
    expect(issue.reactions).toEqual([]);
    expect(issue.comments.map((c: any) => c.reactions)).toEqual([[]]);

    const reacted = await bot.api("PUT", "/api/issues/ACM-1/reactions/%F0%9F%8E%89"); // encoded "🎉"
    expect(reacted.status).toBe(200);
    expect(reacted.body.reactions).toEqual([{ emoji: "🎉", users: [{ username: "bot", name: "Bot", kind: "agent" }] }]);
    expect(reacted.body.updatedAt).toBe(issue.updatedAt); // no bump

    const onComment = await bot.api("PUT", "/api/issues/ACM-1/comments/201/reactions/%F0%9F%91%8D"); // encoded "👍"
    expect(onComment.body.comments[0].reactions).toEqual([{ emoji: "👍", users: [{ username: "bot", name: "Bot", kind: "agent" }] }]);
    expect(rows(v13, "PRAGMA foreign_key_check")).toEqual([]);
  });
});

describe("migration 15", () => {
  // Migrations 1-14 exactly as they shipped (src/server/db.ts): migration 14's fixture above (1-13), then
  // migration 14. Frozen: never edit this fixture.
  const SCHEMA_V14 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
    `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
    `
  ALTER TABLE issues ADD COLUMN due_on TEXT;
  CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
  `,
    `
  ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
  ALTER TABLE comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE;
  ALTER TABLE document_comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE document_comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
  `,
    `
  CREATE TABLE reactions (
    target TEXT NOT NULL,   -- 'issue:<id>' (the description), 'comment:<id>', 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's on (purge cascades)
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's on
    created_at TEXT NOT NULL,
    PRIMARY KEY (target, user_id, emoji)
  );
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Everything migration 15 leaves alone: a new table only.
  const UNCHANGED = [
    "users",
    "workspaces",
    "workspace_members",
    "sessions",
    "api_keys",
    "codes",
    "teams",
    "issues",
    "issue_blocks",
    "issue_relations",
    "comments",
    "documents",
    "document_versions",
    "document_refs",
    "document_comments",
    "issue_activity",
    "mentions",
    "subscriptions",
    "notifications",
    "webhooks",
    "webhook_deliveries",
    "reactions",
  ].map((table) => `SELECT * FROM ${table} ORDER BY rowid`);

  let v14: string;
  let before: unknown[][];
  let server: TestServer;
  beforeAll(async () => {
    v14 = join(dir, "v14", "docket.db"); // its own folder: attachments/ goes next to it
    mkdirSync(dirname(v14));
    const db = new Database(v14, { create: true });
    for (const sql of SCHEMA_V14) db.run(sql);
    db.run("PRAGMA user_version = 14");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'sam@example.com', '${t(0)}'), (2, 'agent', NULL, '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'sam', 'Sam', 'admin', '${t(0)}'), ('acme', 2, 'bot', 'Bot', 'agent', '${t(0)}')`);
    db.run(`INSERT INTO api_keys (id, user_id, name, scope, token_hash, created_at, workspace) VALUES (12, 2, 'bot', 'write', '${hash(AGENT_KEY)}', '${t(0)}', 'acme')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES (5, 'acme', 'ACM', 'Acme', '${t(0)}', '${t(0)}', 2)`);
    db.run(`INSERT INTO issues (id, team_id, number, title, description, status, creator_id, created_at, updated_at) VALUES
      (101, 5, 1, 'Screenshot please', 'Remote: ![x](https://example.com/x.png)', 'todo', 1, '${t(1)}', '${t(1)}')`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) VALUES (101, 1, 'created', '${t(1)}')`);
    db.run(`INSERT INTO comments (id, issue_id, author_id, body, created_at) VALUES (201, 101, 1, 'Nice work', '${t(2)}')`);
    db.run(`INSERT INTO reactions (target, user_id, emoji, issue_id, created_at) VALUES ('comment:201', 2, '👍', 101, '${t(3)}')`);
    db.close();
    before = UNCHANGED.map((sql) => rows(v14, sql));
    server = await startServer({ setup: false, env: { DATABASE_PATH: v14 } });
  });
  afterAll(() => server.stop());

  test("the data is untouched; attachments is created, empty, with its folder next to the database", () => {
    expect(UNCHANGED.map((sql) => rows(v14, sql))).toMatchObject(before); // later migrations may add columns (16: teams.default_status)
    expect(rows(v14, "SELECT COUNT(*) AS n FROM attachments")).toEqual([{ n: 0 }]);
    expect(rows(v14, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v14, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(15);
    expect(existsSync(join(dirname(v14), "attachments"))).toBeTrue();
  });

  test("uploads work on the migrated database, and old texts are unchanged", async () => {
    const bot = server.with({ token: AGENT_KEY });
    const md = await bot.tool("attach_file", { name: "trace.log", text: "boom" });
    expect(md).toMatch(/^\[trace\.log\]\(\/api\/attachments\/[A-Za-z0-9_-]{22}\/trace\.log\)$/);
    expect(await bot.tool("get_attachment", { url: md.slice(md.indexOf("(") + 1, -1) })).toEndWith("boom");
    expect(rows(v14, "SELECT workspace, name, content_type, size, uploader_id FROM attachments")).toEqual([
      { workspace: "acme", name: "trace.log", content_type: "text/plain; charset=utf-8", size: 4, uploader_id: 2 },
    ]);
    expect((await bot.api("GET", "/api/issues/ACM-1")).body.description).toBe("Remote: ![x](https://example.com/x.png)");
    expect(rows(v14, "PRAGMA foreign_key_check")).toEqual([]);
  });
});

describe("migration 16", () => {
  // Migrations 1-15 exactly as they shipped (src/server/db.ts): migration 15's fixture above (1-14), then
  // migration 15. Frozen: never edit this fixture.
  const SCHEMA_V15 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
    `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
    `
  ALTER TABLE issues ADD COLUMN due_on TEXT;
  CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
  `,
    `
  ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
  ALTER TABLE comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE;
  ALTER TABLE document_comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE document_comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
  `,
    `
  CREATE TABLE reactions (
    target TEXT NOT NULL,   -- 'issue:<id>' (the description), 'comment:<id>', 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's on (purge cascades)
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's on
    created_at TEXT NOT NULL,
    PRIMARY KEY (target, user_id, emoji)
  );
  `,
    `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,           -- 16 random bytes, base64url; also the file's name on disk
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    name TEXT NOT NULL,            -- the uploaded file's name, sanitized
    content_type TEXT NOT NULL,    -- sniffed by Docket, never the client's claim
    size INTEGER NOT NULL,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Every table of schema 15 but the ones signing in writes to (sessions, api_keys, codes): migration 16 adds
  // workflow_statuses and teams.default_status, and changes no row.
  const UNCHANGED = [
    "users",
    "workspaces",
    "workspace_members",
    "teams",
    "issues",
    "issue_blocks",
    "issue_relations",
    "comments",
    "documents",
    "document_versions",
    "document_refs",
    "document_comments",
    "issue_activity",
    "mentions",
    "subscriptions",
    "notifications",
    "webhooks",
    "webhook_deliveries",
    "reactions",
    "attachments",
  ].map((table) => `SELECT * FROM ${table} ORDER BY rowid`);
  const DEFAULT = [
    ["backlog", "Backlog", "backlog", "#a3a3a3", 1],
    ["todo", "Todo", "unstarted", "#8f8f8f", 2],
    ["in_progress", "In Progress", "started", "#e8a800", 3],
    ["in_review", "In Review", "started", "#30a46c", 4],
    ["done", "Done", "completed", "#5e6ad2", 5],
    ["canceled", "Canceled", "canceled", "#b4b4b4", 6],
    ["duplicate", "Duplicate", "canceled", "#b4b4b4", 7],
  ].map(([key, name, category, color, position]) => ({ key, name, category, color, position }));

  /** A schema-15 database: alice in acme (team OLD: one issue per status, done and canceled finished, one trashed) and side (team SID). */
  function writeV15(file: string, extra = "") {
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file, { create: true });
    for (const sql of SCHEMA_V15) db.run(sql);
    db.run("PRAGMA user_version = 15");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'alice@example.com', '${t(0)}'), (2, 'agent', NULL, '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}'), ('side', 'Side', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'alice', 'Alice', 'admin', '${t(0)}'), ('side', 1, 'alice', 'Alice', 'admin', '${t(1)}'), ('acme', 2, 'bot', 'Bot', 'agent', '${t(0)}')`);
    db.run(`INSERT INTO api_keys (id, user_id, name, scope, token_hash, created_at, workspace) VALUES (12, 2, 'bot', 'write', '${hash(AGENT_KEY)}', '${t(0)}', 'acme')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES
      (5, 'acme', 'OLD', 'Old', '${t(0)}', '${t(0)}', 9), (6, 'side', 'SID', 'Side', '${t(0)}', '${t(0)}', 2)`);
    // Listed out of order, with priorities, so the list order is the statuses' and not the ids'.
    db.run(`INSERT INTO issues (id, team_id, number, title, status, priority, creator_id, created_at, updated_at, completed_at, deleted_at) VALUES
      (106, 5, 6, 'Dropped', 'canceled', 0, 1, '${t(1)}', '${t(16)}', '${t(16)}', NULL),
      (105, 5, 5, 'Shipped', 'done', 2, 1, '${t(1)}', '${t(15)}', '${t(15)}', NULL),
      (104, 5, 4, 'Reviewing', 'in_review', 1, 1, '${t(1)}', '${t(14)}', NULL, NULL),
      (103, 5, 3, 'Doing', 'in_progress', 3, 1, '${t(1)}', '${t(13)}', NULL, NULL),
      (102, 5, 2, 'Next', 'todo', 1, 1, '${t(1)}', '${t(12)}', NULL, NULL),
      (107, 5, 7, 'Next too', 'todo', 4, 1, '${t(1)}', '${t(17)}', NULL, NULL),
      (101, 5, 1, 'Someday', 'backlog', 0, 1, '${t(1)}', '${t(11)}', NULL, NULL),
      (108, 5, 8, 'Trashed', 'done', 0, 1, '${t(1)}', '${t(18)}', '${t(18)}', '${new Date().toISOString()}'),
      (109, 6, 1, 'Elsewhere', 'in_review', 0, 1, '${t(1)}', '${t(19)}', NULL, NULL)`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, from_value, to_value, created_at) VALUES
      (103, 1, 'created', NULL, NULL, '${t(1)}'), (103, 2, 'claimed', '"todo"', '"in_progress"', '${t(13)}')`);
    db.run(`INSERT INTO notifications (user_id, workspace, kind, actor_id, issue_id, status, created_at) VALUES (1, 'acme', 'status', 2, 105, 'done', '${t(15)}')`);
    if (extra) db.run(extra);
    db.close();
  }

  let v15: string;
  let before: unknown[][];
  let server: TestServer;
  let alice: Caller;
  beforeAll(async () => {
    v15 = join(dir, "v15", "docket.db");
    writeV15(v15);
    before = UNCHANGED.map((sql) => rows(v15, sql));
    server = await startServer({ setup: false, env: { DATABASE_PATH: v15 } });
    await server.signIn("alice");
    alice = server.as("alice", "cookie", "acme");
  });
  afterAll(() => server.stop());

  test("no row changes; every team gets the default workflow, same keys, and starts new issues in backlog", () => {
    expect(UNCHANGED.map((sql) => rows(v15, sql))).toMatchObject(before); // teams gain default_status; nothing else changes
    expect(rows(v15, "SELECT id, default_status FROM teams ORDER BY id")).toEqual([
      { id: 5, default_status: "backlog" },
      { id: 6, default_status: "backlog" },
    ]);
    for (const team of [5, 6]) {
      expect(rows(v15, `SELECT key, name, category, color, position FROM workflow_statuses WHERE team_id = ${team} ORDER BY position`)).toEqual(DEFAULT);
    }
    // Every issue's status is a key of its own team's workflow.
    expect(rows(v15, "SELECT COUNT(*) AS n FROM issues i LEFT JOIN workflow_statuses w ON w.team_id = i.team_id AND w.key = i.status WHERE w.id IS NULL")).toEqual([
      { n: 0 },
    ]);
    expect(rows(v15, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v15, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(16);
  });

  test("every issue keeps its status, completedAt and place in the list; the team shows the old statuses plus Duplicate", async () => {
    const list = (await alice.api("GET", "/api/issues?team=OLD")).body;
    expect(list.map((i: any) => [i.id, i.status, i.statusCategory, i.completedAt])).toEqual([
      ["OLD-1", "backlog", "backlog", null],
      ["OLD-2", "todo", "unstarted", null],
      ["OLD-7", "todo", "unstarted", null],
      ["OLD-3", "in_progress", "started", null],
      ["OLD-4", "in_review", "started", null],
      ["OLD-5", "done", "completed", t(15)],
      ["OLD-6", "canceled", "canceled", t(16)],
    ]);
    const trashed = (await alice.api("GET", "/api/issues/OLD-8")).body;
    expect([trashed.status, trashed.statusCategory, trashed.completedAt]).toEqual(["done", "completed", t(18)]);
    const [old] = (await alice.api("GET", "/api/teams")).body;
    expect(old).toMatchObject({ key: "OLD", defaultStatus: "backlog", statuses: DEFAULT });
    expect(old.counts).toEqual({ backlog: 1, todo: 2, in_progress: 1, in_review: 1, done: 1, canceled: 1, duplicate: 0 });
    // History and the inbox name statuses by the same keys, so they still read.
    expect((await alice.api("GET", "/api/issues/OLD-3")).body.activity.at(-1)).toMatchObject({ kind: "claimed", from: "todo", to: "in_progress" });
    expect((await alice.api("GET", "/api/notifications")).body.notifications[0]).toMatchObject({ kind: "status", status: "done" });
    // The same filters work as before: REST keys, and MCP's default of open issues.
    expect((await alice.api("GET", "/api/issues?team=OLD&status=done,canceled")).body.map((i: any) => i.id)).toEqual(["OLD-5", "OLD-6"]);
    const bot = server.with({ token: AGENT_KEY });
    expect(await bot.tool("list_issues", { team: "OLD" })).not.toContain("OLD-5");
    expect(await bot.tool("list_issues", { team: "OLD", status: ["todo"] })).toBe(
      "OLD-2 · todo · urgent · Next\nOLD-7 · todo · low · Next too",
    );
    expect(await bot.tool("list_teams")).toBe(
      "OLD · Old · workspace acme · 5 open · statuses: backlog (default), todo, in_progress, in_review, done, canceled, duplicate",
    );
  });

  test("an issue whose status isn't in the default workflow stops the migration, and the database stays as it was", async () => {
    const file = join(dir, "v15-stray", "docket.db");
    writeV15(file, `INSERT INTO issues (id, team_id, number, title, status, creator_id, created_at, updated_at) VALUES (110, 5, 9, 'Odd', 'blocked', 1, '${t(20)}', '${t(20)}')`);
    const run = Bun.spawn(["bun", "-e", 'await import("./src/server/db.ts")'], {
      cwd: join(import.meta.dir, ".."),
      env: { PATH: process.env.PATH, HOME: dir, DATABASE_PATH: file },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(run.stderr).text(), run.exited]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`issues whose status isn't in the default workflow: [{"id":110,"status":"blocked"}]`);
    expect(rows(file, "PRAGMA user_version")).toEqual([{ user_version: 15 }]);
    expect(rows(file, "SELECT name FROM sqlite_master WHERE name = 'workflow_statuses'")).toEqual([]);
    expect(rows(file, "SELECT name FROM pragma_table_info('teams') WHERE name = 'default_status'")).toEqual([]);
  });
});

// Migration 17 (auto-close) on a database written under schema 16: no row changes, both settings start off, and Docket's
// own account appears only when it first acts (never as a member).
describe("migration 17", () => {
  // Migrations 1-16 exactly as they shipped (src/server/db.ts): migration 16's fixture above (1-15), then migration 16's
  // SQL (its check adds nothing to the schema). Frozen: never edit this fixture.
  const SCHEMA_V16 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
    `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
    `
  ALTER TABLE issues ADD COLUMN due_on TEXT;
  CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
  `,
    `
  ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
  ALTER TABLE comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE;
  ALTER TABLE document_comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE document_comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
  `,
    `
  CREATE TABLE reactions (
    target TEXT NOT NULL,   -- 'issue:<id>' (the description), 'comment:<id>', 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's on (purge cascades)
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's on
    created_at TEXT NOT NULL,
    PRIMARY KEY (target, user_id, emoji)
  );
  `,
    `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,           -- 16 random bytes, base64url; also the file's name on disk
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    name TEXT NOT NULL,            -- the uploaded file's name, sanitized
    content_type TEXT NOT NULL,    -- sniffed by Docket, never the client's claim
    size INTEGER NOT NULL,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  `,
    `
    CREATE TABLE workflow_statuses (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')),
      color TEXT NOT NULL,
      position REAL NOT NULL,
      UNIQUE (team_id, key)
    );
    CREATE UNIQUE INDEX workflow_statuses_triage ON workflow_statuses(team_id) WHERE category = 'triage';
    INSERT INTO workflow_statuses (team_id, key, name, category, color, position)
      SELECT t.id, d.key, d.name, d.category, d.color, d.position FROM teams t, (
                  SELECT 'backlog' AS key, 'Backlog' AS name, 'backlog' AS category, '#a3a3a3' AS color, 1 AS position
        UNION ALL SELECT 'todo', 'Todo', 'unstarted', '#8f8f8f', 2
        UNION ALL SELECT 'in_progress', 'In Progress', 'started', '#e8a800', 3
        UNION ALL SELECT 'in_review', 'In Review', 'started', '#30a46c', 4
        UNION ALL SELECT 'done', 'Done', 'completed', '#5e6ad2', 5
        UNION ALL SELECT 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6
        UNION ALL SELECT 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7
      ) d ORDER BY t.id, d.position;
    ALTER TABLE teams ADD COLUMN default_status TEXT NOT NULL DEFAULT 'backlog';
    `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Every table of schema 16 but the ones signing in writes to (sessions, api_keys, codes): migration 17 adds columns
  // to teams and users, and changes no row.
  const UNCHANGED = [
    "users",
    "workspaces",
    "workspace_members",
    "teams",
    "workflow_statuses",
    "issues",
    "issue_blocks",
    "issue_relations",
    "comments",
    "documents",
    "document_versions",
    "document_refs",
    "document_comments",
    "issue_activity",
    "mentions",
    "subscriptions",
    "notifications",
    "webhooks",
    "webhook_deliveries",
    "reactions",
    "attachments",
  ].map((table) => `SELECT * FROM ${table} ORDER BY rowid`);

  /** A schema-16 database: alice (and an agent) in acme; team OLD with a parent, one done sub-issue and one open. */
  function writeV16(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file, { create: true });
    for (const sql of SCHEMA_V16) db.run(sql);
    db.run("PRAGMA user_version = 16");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'alice@example.com', '${t(0)}'), (2, 'agent', NULL, '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'alice', 'Alice', 'admin', '${t(0)}'), ('acme', 2, 'bot', 'Bot', 'agent', '${t(0)}')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES (5, 'acme', 'OLD', 'Old', '${t(0)}', '${t(0)}', 4)`);
    db.run(`INSERT INTO workflow_statuses (team_id, key, name, category, color, position) VALUES
      (5, 'backlog', 'Backlog', 'backlog', '#a3a3a3', 1), (5, 'todo', 'Todo', 'unstarted', '#8f8f8f', 2),
      (5, 'in_progress', 'In Progress', 'started', '#e8a800', 3), (5, 'done', 'Done', 'completed', '#5e6ad2', 5),
      (5, 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6), (5, 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7)`);
    db.run(`INSERT INTO issues (id, team_id, number, title, status, creator_id, parent_id, created_at, updated_at, completed_at) VALUES
      (101, 5, 1, 'Parent', 'todo', 1, NULL, '${t(1)}', '${t(1)}', NULL),
      (102, 5, 2, 'Shipped', 'done', 1, 101, '${t(2)}', '${t(2)}', '${t(2)}'),
      (103, 5, 3, 'Open', 'todo', 1, 101, '${t(3)}', '${t(3)}', NULL)`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) VALUES (101, 1, 'created', '${t(1)}'), (102, 1, 'created', '${t(2)}'), (103, 2, 'created', '${t(3)}')`);
    db.close();
  }

  let v16: string;
  let before: unknown[][];
  let server: TestServer;
  let alice: Caller;
  beforeAll(async () => {
    v16 = join(dir, "v16", "docket.db");
    writeV16(v16);
    before = UNCHANGED.map((sql) => rows(v16, sql));
    server = await startServer({ setup: false, env: { DATABASE_PATH: v16 } });
    await server.signIn("alice");
    alice = server.as("alice", "cookie", "acme");
  });
  afterAll(() => server.stop());

  test("no row changes; both settings start off, every account is a real one, and there's no Docket account yet", () => {
    expect(UNCHANGED.map((sql) => rows(v16, sql))).toMatchObject(before);
    expect(rows(v16, "SELECT id, auto_close_parent, auto_close_children FROM teams")).toEqual([{ id: 5, auto_close_parent: 0, auto_close_children: 0 }]);
    expect(rows(v16, "SELECT id, system FROM users ORDER BY id")).toEqual([
      { id: 1, system: 0 },
      { id: 2, system: 0 },
    ]);
    expect(rows(v16, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v16, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(17);
  });

  test("issues and history read as before; auto-close waits for the team to turn it on, then Docket acts as itself", async () => {
    expect((await alice.api("GET", "/api/teams")).body[0]).toMatchObject({ key: "OLD", autoCloseParent: false, autoCloseChildren: false });
    const parent = (await alice.api("GET", "/api/issues/OLD-1")).body;
    expect(parent.children.map((c: any) => [c.id, c.status])).toEqual([
      ["OLD-3", "todo"],
      ["OLD-2", "done"],
    ]);
    expect((await alice.api("GET", "/api/issues/OLD-3")).body.activity).toMatchObject([{ kind: "created", actor: { username: "bot" }, onBehalfOf: null }]);

    await alice.api("PATCH", "/api/issues/OLD-3", { status: "done" });
    expect((await alice.api("GET", "/api/issues/OLD-1")).body.status).toBe("todo"); // off: nothing
    await alice.api("PATCH", "/api/teams/OLD", { autoCloseParent: true });
    await alice.api("PATCH", "/api/issues/OLD-3", { status: "todo" });
    await alice.api("PATCH", "/api/issues/OLD-3", { status: "done" });
    expect((await alice.api("GET", "/api/issues/OLD-1")).body.activity.at(-1)).toMatchObject({
      kind: "status",
      actor: { username: "docket", name: "Docket", kind: "agent" },
      onBehalfOf: { username: "alice" },
      to: "done",
    });
    // Its account appeared on first use, with no membership, so it's in no member list.
    expect(rows(v16, "SELECT id, kind, system, email FROM users WHERE system = 1")).toEqual([{ id: 3, kind: "agent", system: 1, email: null }]);
    expect(rows(v16, "SELECT * FROM workspace_members WHERE user_id = 3")).toEqual([]);
  });
});

describe("migration 18", () => {
  // Migrations 1-17 exactly as they shipped (src/server/db.ts): migration 17's fixture above (1-16), then migration 17.
  // Frozen: never edit this fixture.
  const SCHEMA_V17 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
    `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
    `
  ALTER TABLE issues ADD COLUMN due_on TEXT;
  CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
  `,
    `
  ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
  ALTER TABLE comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE;
  ALTER TABLE document_comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE document_comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
  `,
    `
  CREATE TABLE reactions (
    target TEXT NOT NULL,   -- 'issue:<id>' (the description), 'comment:<id>', 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's on (purge cascades)
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's on
    created_at TEXT NOT NULL,
    PRIMARY KEY (target, user_id, emoji)
  );
  `,
    `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,           -- 16 random bytes, base64url; also the file's name on disk
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    name TEXT NOT NULL,            -- the uploaded file's name, sanitized
    content_type TEXT NOT NULL,    -- sniffed by Docket, never the client's claim
    size INTEGER NOT NULL,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  `,
    `
    CREATE TABLE workflow_statuses (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')),
      color TEXT NOT NULL,
      position REAL NOT NULL,
      UNIQUE (team_id, key)
    );
    CREATE UNIQUE INDEX workflow_statuses_triage ON workflow_statuses(team_id) WHERE category = 'triage';
    INSERT INTO workflow_statuses (team_id, key, name, category, color, position)
      SELECT t.id, d.key, d.name, d.category, d.color, d.position FROM teams t, (
                  SELECT 'backlog' AS key, 'Backlog' AS name, 'backlog' AS category, '#a3a3a3' AS color, 1 AS position
        UNION ALL SELECT 'todo', 'Todo', 'unstarted', '#8f8f8f', 2
        UNION ALL SELECT 'in_progress', 'In Progress', 'started', '#e8a800', 3
        UNION ALL SELECT 'in_review', 'In Review', 'started', '#30a46c', 4
        UNION ALL SELECT 'done', 'Done', 'completed', '#5e6ad2', 5
        UNION ALL SELECT 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6
        UNION ALL SELECT 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7
      ) d ORDER BY t.id, d.position;
    ALTER TABLE teams ADD COLUMN default_status TEXT NOT NULL DEFAULT 'backlog';
    `,
    `
  ALTER TABLE teams ADD COLUMN auto_close_parent INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_parent IN (0, 1));
  ALTER TABLE teams ADD COLUMN auto_close_children INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_children IN (0, 1));
  ALTER TABLE users ADD COLUMN system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1));
  CREATE UNIQUE INDEX users_system ON users(system) WHERE system = 1;
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Every table of schema 17 but the ones signing in writes to (sessions, api_keys, codes): migration 18 adds labels
  // and issue_labels and changes no row (issues.labels stays, unread).
  const UNCHANGED = [
    "users",
    "workspaces",
    "workspace_members",
    "teams",
    "workflow_statuses",
    "issues",
    "issue_blocks",
    "issue_relations",
    "comments",
    "documents",
    "document_versions",
    "document_refs",
    "document_comments",
    "issue_activity",
    "mentions",
    "subscriptions",
    "notifications",
    "webhooks",
    "webhook_deliveries",
    "reactions",
    "attachments",
  ].map((table) => `SELECT * FROM ${table} ORDER BY rowid`);

  /**
   * A schema-17 database: alice in acme (team OLD) and side (team SID). OLD's issues carry "bug" and "Bug" (one label
   * once merged), "UI", "area:api", "ops/deploy" (a "/" from before groups), a done one and a trashed one ("old");
   * side has its own "bug".
   */
  function writeV17(file: string, extra = "") {
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file, { create: true });
    for (const sql of SCHEMA_V17) db.run(sql);
    db.run("PRAGMA user_version = 17");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'alice@example.com', '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}'), ('side', 'Side', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'alice', 'Alice', 'admin', '${t(0)}'), ('side', 1, 'alice', 'Alice', 'admin', '${t(1)}')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES
      (5, 'acme', 'OLD', 'Old', '${t(0)}', '${t(0)}', 6), (6, 'side', 'SID', 'Side', '${t(0)}', '${t(0)}', 2)`);
    for (const team of [5, 6]) {
      db.run(`INSERT INTO workflow_statuses (team_id, key, name, category, color, position) VALUES
        (${team}, 'backlog', 'Backlog', 'backlog', '#a3a3a3', 1), (${team}, 'todo', 'Todo', 'unstarted', '#8f8f8f', 2),
        (${team}, 'in_progress', 'In Progress', 'started', '#e8a800', 3), (${team}, 'in_review', 'In Review', 'started', '#30a46c', 4),
        (${team}, 'done', 'Done', 'completed', '#5e6ad2', 5), (${team}, 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6),
        (${team}, 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7)`);
    }
    db.run(`INSERT INTO issues (id, team_id, number, title, status, labels, creator_id, created_at, updated_at, completed_at, deleted_at) VALUES
      (101, 5, 1, 'Crash', 'todo', '["bug","UI"]', 1, '${t(1)}', '${t(11)}', NULL, NULL),
      (102, 5, 2, 'Fixed', 'done', '["Bug","area:api"]', 1, '${t(1)}', '${t(12)}', '${t(12)}', NULL),
      (103, 5, 3, 'Gone', 'backlog', '["old"]', 1, '${t(1)}', '${t(13)}', NULL, '${new Date().toISOString()}'),
      (104, 5, 4, 'Plain', 'backlog', '[]', 1, '${t(1)}', '${t(14)}', NULL, NULL),
      (105, 5, 5, 'Ship', 'backlog', '["ops/deploy"]', 1, '${t(1)}', '${t(15)}', NULL, NULL),
      (201, 6, 1, 'Elsewhere', 'todo', '["bug"]', 1, '${t(1)}', '${t(21)}', NULL, NULL)`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, from_value, to_value, created_at) VALUES
      (101, 1, 'created', NULL, NULL, '${t(1)}'), (101, 1, 'labels', '["bug"]', '["bug","UI"]', '${t(11)}')`);
    if (extra) db.run(extra);
    db.close();
  }

  let v17: string;
  let before: unknown[][];
  let server: TestServer;
  let alice: Caller;
  beforeAll(async () => {
    v17 = join(dir, "v17", "docket.db");
    writeV17(v17);
    before = UNCHANGED.map((sql) => rows(v17, sql));
    server = await startServer({ setup: false, env: { DATABASE_PATH: v17 } });
    await server.signIn("alice");
    alice = server.as("alice", "cookie", "acme");
  });
  afterAll(() => server.stop());

  test("no row changes; every name in use becomes one workspace label per workspace, and every issue keeps its names", () => {
    expect(UNCHANGED.map((sql) => rows(v17, sql))).toMatchObject(before); // later migrations may add columns (19: issues.archived_at, teams.auto_archive_days)
    expect(rows(v17, "SELECT id, workspace, team_id, parent_id, name, color, is_group FROM labels ORDER BY id")).toEqual(
      [
        [1, "acme", "area:api", "#357fd4"],
        [2, "acme", "Bug", "#35d48a"],
        [3, "acme", "old", "#d48a35"],
        [4, "acme", "ops/deploy", "#7f35d4"],
        [5, "acme", "UI", "#d43550"],
        [6, "side", "bug", "#35c4d4"],
      ].map(([id, workspace, name, color]) => ({ id, workspace, team_id: null, parent_id: null, name, color, is_group: 0 })),
    );
    expect(rows(v17, "SELECT issue_id, label_id FROM issue_labels ORDER BY issue_id, label_id")).toEqual(
      [
        [101, 2],
        [101, 5],
        [102, 1],
        [102, 2],
        [103, 3],
        [105, 4],
        [201, 6],
      ].map(([issue_id, label_id]) => ({ issue_id, label_id })),
    );
    expect(rows(v17, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v17, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(18);
  });

  test("issues read the same names; labels list with colors and open counts, per workspace; history still reads", async () => {
    const labelsOf = async (id: string) => (await alice.api("GET", `/api/issues/${id}`)).body.labels;
    expect(await labelsOf("OLD-1")).toEqual(["Bug", "UI"]); // "bug" and "Bug" are one label now
    expect(await labelsOf("OLD-2")).toEqual(["area:api", "Bug"]);
    expect(await labelsOf("OLD-3")).toEqual(["old"]); // trashed
    expect(await labelsOf("OLD-4")).toEqual([]);
    expect(await labelsOf("OLD-5")).toEqual(["ops/deploy"]);
    const listed = (await alice.api("GET", "/api/labels")).body;
    expect(listed.map((l: any) => [l.path, l.team, l.group, l.isGroup, l.open])).toEqual([
      ["area:api", null, null, false, 0], // its issue is done
      ["Bug", null, null, false, 1],
      ["old", null, null, false, 0], // its issue is in the trash
      ["ops/deploy", null, null, false, 1],
      ["UI", null, null, false, 1],
    ]);
    const side = server.as("alice", "cookie", "side");
    expect((await side.api("GET", "/api/labels")).body.map((l: any) => [l.id, l.path, l.open])).toEqual([[6, "bug", 1]]);
    expect((await side.api("GET", "/api/issues/SID-1")).body.labels).toEqual(["bug"]);
    expect((await alice.api("GET", "/api/issues/OLD-1")).body.activity.at(-1)).toMatchObject({ kind: "labels", from: ["bug"], to: ["bug", "UI"] });
    expect((await alice.api("GET", "/api/issues?label=bug")).body.map((i: any) => i.id)).toEqual(["OLD-1", "OLD-2"]);
    // Old names still resolve, "/" and all, without making new labels.
    const res = await alice.api("PATCH", "/api/issues/OLD-4", { labels: ["ops/deploy", "ui"] });
    expect(res.body.labels).toEqual(["ops/deploy", "UI"]);
    expect((await alice.api("GET", "/api/labels")).body.length).toBe(5);
  });

  test("an issue whose labels aren't an array of names stops the migration, and the database stays as it was", async () => {
    const file = join(dir, "v17-odd", "docket.db");
    writeV17(file, `INSERT INTO issues (id, team_id, number, title, status, labels, creator_id, created_at, updated_at) VALUES (110, 5, 9, 'Odd', 'todo', '[1]', 1, '${t(20)}', '${t(20)}')`);
    const run = Bun.spawn(["bun", "-e", 'await import("./src/server/db.ts")'], {
      cwd: join(import.meta.dir, ".."),
      env: { PATH: process.env.PATH, HOME: dir, DATABASE_PATH: file },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(run.stderr).text(), run.exited]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`Labels: issues whose labels aren't an array of names: [{"id":110}]`);
    expect(rows(file, "PRAGMA user_version")).toEqual([{ user_version: 17 }]);
    expect(rows(file, "SELECT name FROM sqlite_master WHERE name IN ('labels', 'issue_labels')")).toEqual([]);
  });
});

describe("migration 19", () => {
  // Migrations 1-18 exactly as they shipped (src/server/db.ts): migration 18's fixture above (1-17), then migration 18's
  // schema (its backfill has nothing to do on an empty database). Frozen: never edit this fixture.
  const SCHEMA_V18 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
    `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
    `
  ALTER TABLE issues ADD COLUMN due_on TEXT;
  CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
  `,
    `
  ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
  ALTER TABLE comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE;
  ALTER TABLE document_comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE document_comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
  `,
    `
  CREATE TABLE reactions (
    target TEXT NOT NULL,   -- 'issue:<id>' (the description), 'comment:<id>', 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's on (purge cascades)
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's on
    created_at TEXT NOT NULL,
    PRIMARY KEY (target, user_id, emoji)
  );
  `,
    `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,           -- 16 random bytes, base64url; also the file's name on disk
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    name TEXT NOT NULL,            -- the uploaded file's name, sanitized
    content_type TEXT NOT NULL,    -- sniffed by Docket, never the client's claim
    size INTEGER NOT NULL,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  `,
    `
    CREATE TABLE workflow_statuses (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')),
      color TEXT NOT NULL,
      position REAL NOT NULL,
      UNIQUE (team_id, key)
    );
    CREATE UNIQUE INDEX workflow_statuses_triage ON workflow_statuses(team_id) WHERE category = 'triage';
    INSERT INTO workflow_statuses (team_id, key, name, category, color, position)
      SELECT t.id, d.key, d.name, d.category, d.color, d.position FROM teams t, (
                  SELECT 'backlog' AS key, 'Backlog' AS name, 'backlog' AS category, '#a3a3a3' AS color, 1 AS position
        UNION ALL SELECT 'todo', 'Todo', 'unstarted', '#8f8f8f', 2
        UNION ALL SELECT 'in_progress', 'In Progress', 'started', '#e8a800', 3
        UNION ALL SELECT 'in_review', 'In Review', 'started', '#30a46c', 4
        UNION ALL SELECT 'done', 'Done', 'completed', '#5e6ad2', 5
        UNION ALL SELECT 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6
        UNION ALL SELECT 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7
      ) d ORDER BY t.id, d.position;
    ALTER TABLE teams ADD COLUMN default_status TEXT NOT NULL DEFAULT 'backlog';
    `,
    `
  ALTER TABLE teams ADD COLUMN auto_close_parent INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_parent IN (0, 1));
  ALTER TABLE teams ADD COLUMN auto_close_children INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_children IN (0, 1));
  ALTER TABLE users ADD COLUMN system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1));
  CREATE UNIQUE INDEX users_system ON users(system) WHERE system = 1;
  `,
    `
    CREATE TABLE labels (
      id INTEGER PRIMARY KEY,
      workspace TEXT NOT NULL REFERENCES workspaces(key),
      team_id INTEGER REFERENCES teams(id),    -- a team's own label, only on its issues; NULL: the workspace's
      parent_id INTEGER REFERENCES labels(id), -- its group
      name TEXT NOT NULL,
      color TEXT NOT NULL,                     -- #rrggbb
      is_group INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX labels_name ON labels(workspace, COALESCE(parent_id, 0), lower(name));
    CREATE TABLE issue_labels (
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (issue_id, label_id)
    );
    CREATE INDEX issue_labels_label ON issue_labels(label_id);
    `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Every table of schema 18 but the ones signing in writes to (sessions, api_keys, codes): migration 19 adds
  // issue_aliases and changes no row. Read by schema 18's own columns, so a later migration's new columns don't count.
  const TABLES = [
    "users",
    "workspaces",
    "workspace_members",
    "teams",
    "workflow_statuses",
    "issues",
    "issue_blocks",
    "issue_relations",
    "comments",
    "documents",
    "document_versions",
    "document_refs",
    "document_comments",
    "issue_activity",
    "mentions",
    "subscriptions",
    "notifications",
    "webhooks",
    "webhook_deliveries",
    "reactions",
    "attachments",
    "labels",
    "issue_labels",
  ];

  /**
   * A schema-18 database: alice in acme (teams OLD and NEW) and side (team SID). OLD-1 carries a workspace label and
   * OLD's own; OLD-2 is its sub-issue, OLD-3 blocks it, and a doc mentions it.
   */
  function writeV18(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file, { create: true });
    for (const sql of SCHEMA_V18) db.run(sql);
    db.run("PRAGMA user_version = 18");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'alice@example.com', '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}'), ('side', 'Side', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'alice', 'Alice', 'admin', '${t(0)}'), ('side', 1, 'alice', 'Alice', 'admin', '${t(1)}')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES
      (5, 'acme', 'OLD', 'Old', '${t(0)}', '${t(0)}', 4), (6, 'acme', 'NEW', 'New', '${t(0)}', '${t(0)}', 1),
      (7, 'side', 'SID', 'Side', '${t(0)}', '${t(0)}', 1)`);
    for (const team of [5, 6, 7]) {
      db.run(`INSERT INTO workflow_statuses (team_id, key, name, category, color, position) VALUES
        (${team}, 'backlog', 'Backlog', 'backlog', '#a3a3a3', 1), (${team}, 'todo', 'Todo', 'unstarted', '#8f8f8f', 2),
        (${team}, 'in_progress', 'In Progress', 'started', '#e8a800', 3), (${team}, 'in_review', 'In Review', 'started', '#30a46c', 4),
        (${team}, 'done', 'Done', 'completed', '#5e6ad2', 5), (${team}, 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6),
        (${team}, 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7)`);
    }
    db.run(`INSERT INTO issues (id, team_id, number, title, status, creator_id, parent_id, created_at, updated_at) VALUES
      (101, 5, 1, 'Misfiled', 'todo', 1, NULL, '${t(1)}', '${t(11)}'),
      (102, 5, 2, 'Child', 'backlog', 1, 101, '${t(2)}', '${t(12)}'),
      (103, 5, 3, 'Blocker', 'backlog', 1, NULL, '${t(3)}', '${t(13)}')`);
    db.run("INSERT INTO issue_blocks (blocker_id, blocked_id) VALUES (103, 101)");
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) VALUES (101, 1, 'created', '${t(1)}'), (102, 1, 'created', '${t(2)}'), (103, 1, 'created', '${t(3)}')`);
    db.run(`INSERT INTO labels (id, workspace, team_id, name, color, created_at) VALUES (1, 'acme', NULL, 'Bug', '#357fd4', '${t(1)}'), (2, 'acme', 5, 'legacy', '#35d48a', '${t(1)}')`);
    db.run("INSERT INTO issue_labels (issue_id, label_id) VALUES (101, 1), (101, 2)");
    db.run(`INSERT INTO documents (id, workspace, team_id, slug, title, content, position, created_at, updated_at, updated_by_id) VALUES
      (1, 'acme', 5, 'plan', 'Plan', 'Fix OLD-1 first.', 1, '${t(4)}', '${t(4)}', 1)`);
    db.run(`INSERT INTO document_versions (document_id, title, content, author_id, created_at) VALUES (1, 'Plan', 'Fix OLD-1 first.', 1, '${t(4)}')`);
    db.run("INSERT INTO document_refs (document_id, issue_id, ord) VALUES (1, 101, 0)");
    db.close();
  }

  let v18: string;
  let columns: string[];
  let before: unknown[][];
  let server: TestServer;
  let alice: Caller;
  const snapshot = () => TABLES.map((table, n) => rows(v18, `SELECT ${columns[n]} FROM ${table} ORDER BY rowid`));
  beforeAll(async () => {
    v18 = join(dir, "v18", "docket.db");
    writeV18(v18);
    columns = TABLES.map((table) => (rows(v18, `PRAGMA table_info(${table})`) as { name: string }[]).map((c) => c.name).join(", "));
    before = snapshot();
    server = await startServer({ setup: false, env: { DATABASE_PATH: v18 } });
    await server.signIn("alice");
    alice = server.as("alice", "cookie", "acme");
  });
  afterAll(() => server.stop());

  test("no row changes; issue_aliases starts empty", () => {
    expect(snapshot()).toEqual(before);
    expect(rows(v18, "SELECT * FROM issue_aliases")).toEqual([]);
    expect(rows(v18, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v18, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(19);
  });

  test("issues read as before, and a move afterwards records the old identifier, which keeps resolving", async () => {
    expect((await alice.api("GET", "/api/issues/OLD-1")).body).toMatchObject({ id: "OLD-1", labels: ["Bug", "legacy"], blockedBy: ["OLD-3"], previousIdentifiers: [] });
    const moved = (await alice.api("PATCH", "/api/issues/OLD-1", { team: "NEW" })).body;
    expect(moved).toMatchObject({ id: "NEW-1", status: "todo", labels: ["Bug"], blockedBy: ["OLD-3"], previousIdentifiers: ["OLD-1"] });
    expect(moved.children.map((c: any) => c.id)).toEqual(["OLD-2"]);
    expect(moved.docs.map((d: any) => d.slug)).toEqual(["plan"]);
    expect(rows(v18, "SELECT team_id, number, issue_id FROM issue_aliases")).toEqual([{ team_id: 5, number: 1, issue_id: 101 }]);
    expect(rows(v18, "SELECT key, next_number FROM teams WHERE id IN (5, 6) ORDER BY id")).toEqual([
      { key: "OLD", next_number: 4 },
      { key: "NEW", next_number: 2 },
    ]);
    expect((await alice.api("GET", "/api/issues/OLD-1")).body.id).toBe("NEW-1");
    expect((await alice.api("GET", "/api/locate?issue=OLD-1")).body).toEqual({ workspace: "acme" });
    expect((await server.as("alice", "cookie", "side").api("GET", "/api/issues/OLD-1")).status).toBe(404);
  });
});

// Migration 20 (auto-archive) on a database written under schema 19: no row changes, both new columns start
// unset (never), and an issue moved before still resolves and archives under both identifiers.
describe("migration 20", () => {
  // Migrations 1-19 exactly as they shipped (src/server/db.ts): migration 19's own SCHEMA_V18 fixture above (1-17,
  // plus migration 18's schema), then migration 19's SQL (issue_aliases). Frozen: never edit this fixture.
  const SCHEMA_V19 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
    `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
    `
  ALTER TABLE issues ADD COLUMN due_on TEXT;
  CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
  `,
    `
  ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
  ALTER TABLE comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE;
  ALTER TABLE document_comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE document_comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
  `,
    `
  CREATE TABLE reactions (
    target TEXT NOT NULL,   -- 'issue:<id>' (the description), 'comment:<id>', 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's on (purge cascades)
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's on
    created_at TEXT NOT NULL,
    PRIMARY KEY (target, user_id, emoji)
  );
  `,
    `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,           -- 16 random bytes, base64url; also the file's name on disk
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    name TEXT NOT NULL,            -- the uploaded file's name, sanitized
    content_type TEXT NOT NULL,    -- sniffed by Docket, never the client's claim
    size INTEGER NOT NULL,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  `,
    `
    CREATE TABLE workflow_statuses (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')),
      color TEXT NOT NULL,
      position REAL NOT NULL,
      UNIQUE (team_id, key)
    );
    CREATE UNIQUE INDEX workflow_statuses_triage ON workflow_statuses(team_id) WHERE category = 'triage';
    INSERT INTO workflow_statuses (team_id, key, name, category, color, position)
      SELECT t.id, d.key, d.name, d.category, d.color, d.position FROM teams t, (
                  SELECT 'backlog' AS key, 'Backlog' AS name, 'backlog' AS category, '#a3a3a3' AS color, 1 AS position
        UNION ALL SELECT 'todo', 'Todo', 'unstarted', '#8f8f8f', 2
        UNION ALL SELECT 'in_progress', 'In Progress', 'started', '#e8a800', 3
        UNION ALL SELECT 'in_review', 'In Review', 'started', '#30a46c', 4
        UNION ALL SELECT 'done', 'Done', 'completed', '#5e6ad2', 5
        UNION ALL SELECT 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6
        UNION ALL SELECT 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7
      ) d ORDER BY t.id, d.position;
    ALTER TABLE teams ADD COLUMN default_status TEXT NOT NULL DEFAULT 'backlog';
    `,
    `
  ALTER TABLE teams ADD COLUMN auto_close_parent INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_parent IN (0, 1));
  ALTER TABLE teams ADD COLUMN auto_close_children INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_children IN (0, 1));
  ALTER TABLE users ADD COLUMN system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1));
  CREATE UNIQUE INDEX users_system ON users(system) WHERE system = 1;
  `,
    `
    CREATE TABLE labels (
      id INTEGER PRIMARY KEY,
      workspace TEXT NOT NULL REFERENCES workspaces(key),
      team_id INTEGER REFERENCES teams(id),    -- a team's own label, only on its issues; NULL: the workspace's
      parent_id INTEGER REFERENCES labels(id), -- its group
      name TEXT NOT NULL,
      color TEXT NOT NULL,                     -- #rrggbb
      is_group INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX labels_name ON labels(workspace, COALESCE(parent_id, 0), lower(name));
    CREATE TABLE issue_labels (
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (issue_id, label_id)
    );
    CREATE INDEX issue_labels_label ON issue_labels(label_id);
    `,
    `
  CREATE TABLE issue_aliases (
    team_id INTEGER NOT NULL REFERENCES teams(id),
    number INTEGER NOT NULL,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, number)
  );
  CREATE INDEX issue_aliases_issue ON issue_aliases(issue_id);
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Every table of schema 19 but the ones signing in writes to (sessions, api_keys, codes): migration 20 adds
  // issues.archived_at and teams.auto_archive_days and changes no row. Read by schema 19's own columns, so a
  // later migration's new columns don't count.
  const TABLES = [
    "users",
    "workspaces",
    "workspace_members",
    "teams",
    "workflow_statuses",
    "issues",
    "issue_blocks",
    "issue_relations",
    "comments",
    "documents",
    "document_versions",
    "document_refs",
    "document_comments",
    "issue_activity",
    "mentions",
    "subscriptions",
    "notifications",
    "webhooks",
    "webhook_deliveries",
    "reactions",
    "attachments",
    "labels",
    "issue_labels",
    "issue_aliases",
  ];

  /**
   * A schema-19 database: alice in acme, teams OLD and NEW. Issue 101 was created in OLD as OLD-1, moved to NEW
   * (so `issue_aliases` already has OLD-1 → 101) and completed long ago, labeled "bug"; OLD-2 is still open.
   */
  function writeV19(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file, { create: true });
    for (const sql of SCHEMA_V19) db.run(sql);
    db.run("PRAGMA user_version = 19");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'alice@example.com', '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES ('acme', 1, 'alice', 'Alice', 'admin', '${t(0)}')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES
      (5, 'acme', 'OLD', 'Old', '${t(0)}', '${t(0)}', 3), (6, 'acme', 'NEW', 'New', '${t(0)}', '${t(0)}', 2)`);
    for (const team of [5, 6]) {
      db.run(`INSERT INTO workflow_statuses (team_id, key, name, category, color, position) VALUES
        (${team}, 'backlog', 'Backlog', 'backlog', '#a3a3a3', 1), (${team}, 'todo', 'Todo', 'unstarted', '#8f8f8f', 2),
        (${team}, 'in_progress', 'In Progress', 'started', '#e8a800', 3), (${team}, 'done', 'Done', 'completed', '#5e6ad2', 5),
        (${team}, 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6), (${team}, 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7)`);
    }
    db.run(`INSERT INTO issues (id, team_id, number, title, status, labels, creator_id, created_at, updated_at, completed_at, deleted_at) VALUES
      (101, 6, 1, 'Moved and shipped long ago', 'done', '["bug"]', 1, '${t(1)}', '${t(1)}', '2020-01-01T00:00:00.000Z', NULL),
      (102, 5, 2, 'Open', 'todo', '[]', 1, '${t(2)}', '${t(2)}', NULL, NULL)`);
    db.run(`INSERT INTO issue_aliases (team_id, number, issue_id, created_at) VALUES (5, 1, 101, '${t(1)}')`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) VALUES (101, 1, 'created', '${t(1)}'), (101, 1, 'team', '${t(1)}'), (102, 1, 'created', '${t(2)}')`);
    db.run(`INSERT INTO labels (id, workspace, team_id, name, color, created_at) VALUES (1, 'acme', NULL, 'bug', '#357fd4', '${t(1)}')`);
    db.run("INSERT INTO issue_labels (issue_id, label_id) VALUES (101, 1)");
    db.close();
  }

  let v19: string;
  let columns: string[];
  let before: unknown[][];
  let server: TestServer;
  let alice: Caller;
  const snapshot = () => TABLES.map((table, n) => rows(v19, `SELECT ${columns[n]} FROM ${table} ORDER BY rowid`));
  beforeAll(async () => {
    v19 = join(dir, "v19", "docket.db");
    writeV19(v19);
    columns = TABLES.map((table) => (rows(v19, `PRAGMA table_info(${table})`) as { name: string }[]).map((c) => c.name).join(", "));
    before = snapshot();
    server = await startServer({ setup: false, env: { DATABASE_PATH: v19 } });
    await server.signIn("alice");
    alice = server.as("alice", "cookie", "acme");
  });
  afterAll(() => server.stop());

  test("no row changes; both new columns are unset", () => {
    expect(snapshot()).toEqual(before);
    expect(rows(v19, "SELECT id, archived_at FROM issues ORDER BY id")).toEqual([
      { id: 101, archived_at: null },
      { id: 102, archived_at: null },
    ]);
    expect(rows(v19, "SELECT id, auto_archive_days FROM teams ORDER BY id")).toEqual([
      { id: 5, auto_archive_days: null },
      { id: 6, auto_archive_days: null },
    ]);
    expect(rows(v19, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v19, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(20);
  });

  test("a moved issue reads the same, and once archived still resolves and reads by its old identifier too", async () => {
    const before = (await alice.api("GET", "/api/issues/OLD-1")).body;
    expect(before).toMatchObject({ id: "NEW-1", status: "done", labels: ["bug"], previousIdentifiers: ["OLD-1"], archivedAt: null });
    expect((await alice.api("GET", "/api/issues?team=NEW")).body.map((i: any) => i.id)).toEqual(["NEW-1"]);

    // Turning auto-archive on for NEW doesn't sweep by itself; the next issue closed anywhere does.
    await alice.api("PATCH", "/api/teams/NEW", { autoArchiveDays: 30 });
    expect((await alice.api("GET", "/api/issues/NEW-1")).body.archivedAt).toBeNull();
    await alice.api("PATCH", "/api/issues/OLD-2", { status: "done" });
    const archived = (await alice.api("GET", "/api/issues/OLD-1")).body; // still resolves by the old identifier
    expect(archived).toMatchObject({ id: "NEW-1", archivedAt: expect.any(String), labels: ["bug"], previousIdentifiers: ["OLD-1"] });
    expect(archived.activity.at(-1)).toMatchObject({ kind: "archived", actor: { username: "docket" }, onBehalfOf: null });
    expect((await alice.api("GET", "/api/issues?team=NEW")).body.map((i: any) => i.id)).toEqual([]);
    expect((await alice.api("GET", "/api/issues?team=NEW&archived=true")).body.map((i: any) => i.id)).toEqual(["NEW-1"]);

    // Read-only now, by either identifier; unarchiving fixes both.
    expect((await alice.api("PATCH", "/api/issues/OLD-1", { title: "x" })).status).toBe(409);
    expect((await alice.api("POST", "/api/issues/NEW-1/unarchive")).body.archivedAt).toBeNull();
    expect((await alice.api("GET", "/api/issues/OLD-1")).body.archivedAt).toBeNull();
  });
});

// Migration 21 (estimates) on a database written under schema 20: no row changes; every team starts with estimates off
// and every issue without one, and estimates work on the migrated database.
describe("migration 21", () => {
  // Migrations 1-20 exactly as they shipped (src/server/db.ts): migration 20's SCHEMA_V19 fixture above (1-19), then
  // migration 20's SQL (auto-archive). Frozen: never edit this fixture.
  const SCHEMA_V20 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
    `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
    `
  ALTER TABLE issues ADD COLUMN due_on TEXT;
  CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
  `,
    `
  ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
  ALTER TABLE comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE;
  ALTER TABLE document_comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE document_comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
  `,
    `
  CREATE TABLE reactions (
    target TEXT NOT NULL,   -- 'issue:<id>' (the description), 'comment:<id>', 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's on (purge cascades)
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's on
    created_at TEXT NOT NULL,
    PRIMARY KEY (target, user_id, emoji)
  );
  `,
    `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,           -- 16 random bytes, base64url; also the file's name on disk
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    name TEXT NOT NULL,            -- the uploaded file's name, sanitized
    content_type TEXT NOT NULL,    -- sniffed by Docket, never the client's claim
    size INTEGER NOT NULL,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  `,
    `
    CREATE TABLE workflow_statuses (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')),
      color TEXT NOT NULL,
      position REAL NOT NULL,
      UNIQUE (team_id, key)
    );
    CREATE UNIQUE INDEX workflow_statuses_triage ON workflow_statuses(team_id) WHERE category = 'triage';
    INSERT INTO workflow_statuses (team_id, key, name, category, color, position)
      SELECT t.id, d.key, d.name, d.category, d.color, d.position FROM teams t, (
                  SELECT 'backlog' AS key, 'Backlog' AS name, 'backlog' AS category, '#a3a3a3' AS color, 1 AS position
        UNION ALL SELECT 'todo', 'Todo', 'unstarted', '#8f8f8f', 2
        UNION ALL SELECT 'in_progress', 'In Progress', 'started', '#e8a800', 3
        UNION ALL SELECT 'in_review', 'In Review', 'started', '#30a46c', 4
        UNION ALL SELECT 'done', 'Done', 'completed', '#5e6ad2', 5
        UNION ALL SELECT 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6
        UNION ALL SELECT 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7
      ) d ORDER BY t.id, d.position;
    ALTER TABLE teams ADD COLUMN default_status TEXT NOT NULL DEFAULT 'backlog';
    `,
    `
  ALTER TABLE teams ADD COLUMN auto_close_parent INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_parent IN (0, 1));
  ALTER TABLE teams ADD COLUMN auto_close_children INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_children IN (0, 1));
  ALTER TABLE users ADD COLUMN system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1));
  CREATE UNIQUE INDEX users_system ON users(system) WHERE system = 1;
  `,
    `
    CREATE TABLE labels (
      id INTEGER PRIMARY KEY,
      workspace TEXT NOT NULL REFERENCES workspaces(key),
      team_id INTEGER REFERENCES teams(id),    -- a team's own label, only on its issues; NULL: the workspace's
      parent_id INTEGER REFERENCES labels(id), -- its group
      name TEXT NOT NULL,
      color TEXT NOT NULL,                     -- #rrggbb
      is_group INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX labels_name ON labels(workspace, COALESCE(parent_id, 0), lower(name));
    CREATE TABLE issue_labels (
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (issue_id, label_id)
    );
    CREATE INDEX issue_labels_label ON issue_labels(label_id);
    `,
    `
  CREATE TABLE issue_aliases (
    team_id INTEGER NOT NULL REFERENCES teams(id),
    number INTEGER NOT NULL,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, number)
  );
  CREATE INDEX issue_aliases_issue ON issue_aliases(issue_id);
  `,
    `
  ALTER TABLE issues ADD COLUMN archived_at TEXT;
  CREATE INDEX issues_archived ON issues(archived_at) WHERE archived_at IS NOT NULL;
  ALTER TABLE teams ADD COLUMN auto_archive_days INTEGER; -- NULL = never (default); else days after completed_at
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Every table of schema 20 but the ones signing in writes to (sessions, api_keys, codes): migration 21 adds
  // teams.estimate_scale and issues.estimate and changes no row. Read by schema 20's own columns.
  const TABLES = [
    "users",
    "workspaces",
    "workspace_members",
    "teams",
    "workflow_statuses",
    "issues",
    "issue_blocks",
    "issue_relations",
    "issue_aliases",
    "comments",
    "documents",
    "issue_activity",
    "labels",
    "issue_labels",
  ];

  /** A schema-20 database: alice in acme, teams OLD and NEW; NEW-1 moved there from OLD-1 (an alias), OLD-2 is in the trash. */
  function writeV20(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file, { create: true });
    for (const sql of SCHEMA_V20) db.run(sql);
    db.run("PRAGMA user_version = 20");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'alice@example.com', '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES ('acme', 1, 'alice', 'Alice', 'admin', '${t(0)}')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number) VALUES
      (5, 'acme', 'OLD', 'Old', '${t(0)}', '${t(0)}', 3), (6, 'acme', 'NEW', 'New', '${t(0)}', '${t(0)}', 2)`);
    for (const team of [5, 6]) {
      db.run(`INSERT INTO workflow_statuses (team_id, key, name, category, color, position) VALUES
        (${team}, 'backlog', 'Backlog', 'backlog', '#a3a3a3', 1), (${team}, 'todo', 'Todo', 'unstarted', '#8f8f8f', 2),
        (${team}, 'in_progress', 'In Progress', 'started', '#e8a800', 3), (${team}, 'in_review', 'In Review', 'started', '#30a46c', 4),
        (${team}, 'done', 'Done', 'completed', '#5e6ad2', 5), (${team}, 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6),
        (${team}, 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7)`);
    }
    db.run(`INSERT INTO issues (id, team_id, number, title, status, priority, creator_id, created_at, updated_at, deleted_at) VALUES
      (101, 6, 1, 'Moved', 'todo', 2, 1, '${t(1)}', '${t(11)}', NULL),
      (102, 5, 2, 'Trashed', 'backlog', 0, 1, '${t(2)}', '${t(12)}', '${new Date().toISOString()}')`); // recent: purged after 30 days
    db.run(`INSERT INTO issue_aliases (team_id, number, issue_id, created_at) VALUES (5, 1, 101, '${t(11)}')`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, from_value, to_value, created_at) VALUES
      (101, 1, 'created', NULL, NULL, '${t(1)}'), (101, 1, 'team', '"OLD-1"', '"NEW-1"', '${t(11)}'), (102, 1, 'created', NULL, NULL, '${t(2)}')`);
    db.close();
  }

  let v20: string;
  let columns: string[];
  let before: unknown[][];
  let server: TestServer;
  let alice: Caller;
  const snapshot = () => TABLES.map((table, n) => rows(v20, `SELECT ${columns[n]} FROM ${table} ORDER BY rowid`));
  beforeAll(async () => {
    v20 = join(dir, "v20", "docket.db");
    writeV20(v20);
    columns = TABLES.map((table) => (rows(v20, `PRAGMA table_info(${table})`) as { name: string }[]).map((c) => c.name).join(", "));
    before = snapshot();
    server = await startServer({ setup: false, env: { DATABASE_PATH: v20 } });
    await server.signIn("alice");
    alice = server.as("alice", "cookie", "acme");
  });
  afterAll(() => server.stop());

  test("no row changes; every team has estimates off and every issue no estimate", () => {
    expect(snapshot()).toEqual(before);
    expect(rows(v20, "SELECT id, estimate_scale FROM teams ORDER BY id")).toEqual([
      { id: 5, estimate_scale: null },
      { id: 6, estimate_scale: null },
    ]);
    expect(rows(v20, "SELECT id, estimate FROM issues ORDER BY id")).toEqual([
      { id: 101, estimate: null },
      { id: 102, estimate: null },
    ]);
    expect(rows(v20, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v20, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(21);
  });

  test("issues and history read as before, without an estimate; turning estimates on works on the migrated database", async () => {
    const teams = (await alice.api("GET", "/api/teams")).body;
    expect(teams.map((team: any) => [team.key, team.estimateScale])).toEqual([
      ["NEW", null],
      ["OLD", null],
    ]);
    const issue = (await alice.api("GET", "/api/issues/OLD-1")).body;
    expect(issue).toMatchObject({ id: "NEW-1", priority: 2, estimate: null, previousIdentifiers: ["OLD-1"] });
    expect(issue.activity.map((x: any) => x.kind)).toEqual(["created", "team"]);
    expect((await alice.api("PATCH", "/api/issues/NEW-1", { estimate: 2 })).body.error).toBe("Turn on estimates for this team first");
    await alice.api("PATCH", "/api/teams/NEW", { estimateScale: "exponential" });
    expect((await alice.api("PATCH", "/api/issues/NEW-1", { estimate: 5 })).body.estimate).toBe(5);
    expect(rows(v20, "SELECT id, estimate FROM issues WHERE id = 101")).toEqual([{ id: 101, estimate: 5 }]);
    expect((await alice.api("GET", "/api/teams/OLD/trash")).body.issues).toMatchObject([{ id: "OLD-2", estimate: null }]);
    // The columns hold only what the API writes: a scale by name, a position 1-5.
    const db = new Database(v20);
    try {
      expect(() => db.run("UPDATE teams SET estimate_scale = 'points' WHERE id = 5")).toThrow();
      expect(() => db.run("UPDATE issues SET estimate = 6 WHERE id = 101")).toThrow();
    } finally {
      db.close();
    }
  });
});

// Migration 22 (projects) on a database written under schema 21: no row changes, the three new tables start empty,
// every issue and doc is in no project, and projects work on the migrated database.
describe("migration 22", () => {
  // Migrations 1-21 exactly as they shipped (src/server/db.ts): migration 21's SCHEMA_V20 fixture above (1-20), then
  // migration 21's SQL (estimates). Frozen: never edit this fixture.
  const SCHEMA_V21 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
    `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
    `
  ALTER TABLE issues ADD COLUMN due_on TEXT;
  CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
  `,
    `
  ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
  ALTER TABLE comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE;
  ALTER TABLE document_comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE document_comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
  `,
    `
  CREATE TABLE reactions (
    target TEXT NOT NULL,   -- 'issue:<id>' (the description), 'comment:<id>', 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's on (purge cascades)
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's on
    created_at TEXT NOT NULL,
    PRIMARY KEY (target, user_id, emoji)
  );
  `,
    `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,           -- 16 random bytes, base64url; also the file's name on disk
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    name TEXT NOT NULL,            -- the uploaded file's name, sanitized
    content_type TEXT NOT NULL,    -- sniffed by Docket, never the client's claim
    size INTEGER NOT NULL,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  `,
    `
    CREATE TABLE workflow_statuses (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')),
      color TEXT NOT NULL,
      position REAL NOT NULL,
      UNIQUE (team_id, key)
    );
    CREATE UNIQUE INDEX workflow_statuses_triage ON workflow_statuses(team_id) WHERE category = 'triage';
    INSERT INTO workflow_statuses (team_id, key, name, category, color, position)
      SELECT t.id, d.key, d.name, d.category, d.color, d.position FROM teams t, (
                  SELECT 'backlog' AS key, 'Backlog' AS name, 'backlog' AS category, '#a3a3a3' AS color, 1 AS position
        UNION ALL SELECT 'todo', 'Todo', 'unstarted', '#8f8f8f', 2
        UNION ALL SELECT 'in_progress', 'In Progress', 'started', '#e8a800', 3
        UNION ALL SELECT 'in_review', 'In Review', 'started', '#30a46c', 4
        UNION ALL SELECT 'done', 'Done', 'completed', '#5e6ad2', 5
        UNION ALL SELECT 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6
        UNION ALL SELECT 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7
      ) d ORDER BY t.id, d.position;
    ALTER TABLE teams ADD COLUMN default_status TEXT NOT NULL DEFAULT 'backlog';
    `,
    `
  ALTER TABLE teams ADD COLUMN auto_close_parent INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_parent IN (0, 1));
  ALTER TABLE teams ADD COLUMN auto_close_children INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_children IN (0, 1));
  ALTER TABLE users ADD COLUMN system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1));
  CREATE UNIQUE INDEX users_system ON users(system) WHERE system = 1;
  `,
    `
    CREATE TABLE labels (
      id INTEGER PRIMARY KEY,
      workspace TEXT NOT NULL REFERENCES workspaces(key),
      team_id INTEGER REFERENCES teams(id),    -- a team's own label, only on its issues; NULL: the workspace's
      parent_id INTEGER REFERENCES labels(id), -- its group
      name TEXT NOT NULL,
      color TEXT NOT NULL,                     -- #rrggbb
      is_group INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX labels_name ON labels(workspace, COALESCE(parent_id, 0), lower(name));
    CREATE TABLE issue_labels (
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (issue_id, label_id)
    );
    CREATE INDEX issue_labels_label ON issue_labels(label_id);
    `,
    `
  CREATE TABLE issue_aliases (
    team_id INTEGER NOT NULL REFERENCES teams(id),
    number INTEGER NOT NULL,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, number)
  );
  CREATE INDEX issue_aliases_issue ON issue_aliases(issue_id);
  `,
    `
  ALTER TABLE issues ADD COLUMN archived_at TEXT;
  CREATE INDEX issues_archived ON issues(archived_at) WHERE archived_at IS NOT NULL;
  ALTER TABLE teams ADD COLUMN auto_archive_days INTEGER; -- NULL = never (default); else days after completed_at
  `,
    `
  ALTER TABLE teams ADD COLUMN estimate_scale TEXT CHECK (estimate_scale IN ('exponential', 'fibonacci', 'linear', 'tshirt'));
  ALTER TABLE issues ADD COLUMN estimate INTEGER CHECK (estimate BETWEEN 1 AND 5);
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Every table of schema 21 but the ones signing in writes to (sessions, api_keys, codes): migration 22 adds
  // projects, project_teams and milestones, and issues.project_id, issues.milestone_id and documents.project_id,
  // and changes no row. Read by schema 21's own columns.
  const TABLES = [
    "users",
    "workspaces",
    "workspace_members",
    "teams",
    "workflow_statuses",
    "issues",
    "issue_activity",
    "documents",
    "document_versions",
    "labels",
    "issue_labels",
  ];

  /** A schema-21 database: alice in acme, teams WEB (estimates on) and APP; WEB-1 with a sub-issue WEB-2 (estimated, labeled), APP-1 done, and a doc. */
  function writeV21(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file, { create: true });
    for (const sql of SCHEMA_V21) db.run(sql);
    db.run("PRAGMA user_version = 21");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'alice@example.com', '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES ('acme', 1, 'alice', 'Alice', 'admin', '${t(0)}')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number, estimate_scale) VALUES
      (5, 'acme', 'WEB', 'Web', '${t(0)}', '${t(0)}', 3, 'fibonacci'), (6, 'acme', 'APP', 'App', '${t(0)}', '${t(0)}', 2, NULL)`);
    for (const team of [5, 6]) {
      db.run(`INSERT INTO workflow_statuses (team_id, key, name, category, color, position) VALUES
        (${team}, 'backlog', 'Backlog', 'backlog', '#a3a3a3', 1), (${team}, 'todo', 'Todo', 'unstarted', '#8f8f8f', 2),
        (${team}, 'in_progress', 'In Progress', 'started', '#e8a800', 3), (${team}, 'in_review', 'In Review', 'started', '#30a46c', 4),
        (${team}, 'done', 'Done', 'completed', '#5e6ad2', 5), (${team}, 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6),
        (${team}, 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7)`);
    }
    db.run(`INSERT INTO issues (id, team_id, number, title, status, priority, estimate, creator_id, parent_id, created_at, updated_at, completed_at) VALUES
      (101, 5, 1, 'Parent', 'in_progress', 2, NULL, 1, NULL, '${t(1)}', '${t(1)}', NULL),
      (102, 5, 2, 'Child', 'todo', 0, 3, 1, 101, '${t(2)}', '${t(2)}', NULL),
      (103, 6, 1, 'Shipped', 'done', 0, NULL, 1, NULL, '${t(3)}', '${t(3)}', '${t(3)}')`);
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) VALUES (101, 1, 'created', '${t(1)}'), (102, 1, 'created', '${t(2)}'), (103, 1, 'created', '${t(3)}')`);
    db.run(`INSERT INTO labels (id, workspace, team_id, name, color, created_at) VALUES (1, 'acme', NULL, 'bug', '#357fd4', '${t(1)}')`);
    db.run("INSERT INTO issue_labels (issue_id, label_id) VALUES (102, 1)");
    db.run(`INSERT INTO documents (id, workspace, team_id, slug, title, content, position, created_at, updated_at, updated_by_id) VALUES
      (201, 'acme', 5, 'plan', 'Plan', 'See WEB-1.', 1, '${t(4)}', '${t(4)}', 1)`);
    db.run(`INSERT INTO document_versions (document_id, title, content, author_id, created_at) VALUES (201, 'Plan', 'See WEB-1.', 1, '${t(4)}')`);
    db.run("INSERT INTO document_refs (document_id, issue_id, ord) VALUES (201, 101, 0)");
    db.close();
  }

  let v21: string;
  let columns: string[];
  let before: unknown[][];
  let server: TestServer;
  let alice: Caller;
  const snapshot = () => TABLES.map((table, n) => rows(v21, `SELECT ${columns[n]} FROM ${table} ORDER BY rowid`));
  beforeAll(async () => {
    v21 = join(dir, "v21", "docket.db");
    writeV21(v21);
    columns = TABLES.map((table) => (rows(v21, `PRAGMA table_info(${table})`) as { name: string }[]).map((c) => c.name).join(", "));
    before = snapshot();
    server = await startServer({ setup: false, env: { DATABASE_PATH: v21 } });
    await server.signIn("alice");
    alice = server.as("alice", "cookie", "acme");
  });
  afterAll(() => server.stop());

  test("no row changes; the new tables are empty and nothing is in a project", () => {
    expect(snapshot()).toEqual(before);
    for (const table of ["projects", "project_teams", "milestones"]) expect(rows(v21, `SELECT * FROM ${table}`)).toEqual([]);
    expect(rows(v21, "SELECT id, project_id, milestone_id FROM issues ORDER BY id")).toEqual([
      { id: 101, project_id: null, milestone_id: null },
      { id: 102, project_id: null, milestone_id: null },
      { id: 103, project_id: null, milestone_id: null },
    ]);
    expect(rows(v21, "SELECT id, project_id FROM documents")).toEqual([{ id: 201, project_id: null }]);
    expect(rows(v21, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v21, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(22);
  });

  test("issues and docs read as before, in no project; projects work on the migrated database", async () => {
    const child = (await alice.api("GET", "/api/issues/WEB-2")).body;
    expect(child).toMatchObject({ id: "WEB-2", parent: "WEB-1", estimate: 3, labels: ["bug"], project: null, milestone: null });
    expect((await alice.api("GET", "/api/issues/WEB-1")).body).toMatchObject({ status: "in_progress", priority: 2, project: null, children: [{ id: "WEB-2" }] });
    expect((await alice.api("GET", "/api/documents/plan")).body).toMatchObject({ content: "See WEB-1.", team: "WEB", project: null, issues: [{ id: "WEB-1" }] });
    expect((await alice.api("GET", "/api/projects")).body).toEqual([]);

    const project = await alice.api("POST", "/api/projects", { teams: ["WEB"], name: "Launch" });
    expect(project.status).toBe(201);
    expect((await alice.api("POST", "/api/projects/launch/milestones", { name: "Beta" })).status).toBe(201);
    for (const id of ["WEB-1", "APP-1"]) expect((await alice.api("PATCH", `/api/issues/${id}`, { project: "launch" })).body.project).toBe("launch");
    expect((await alice.api("PATCH", "/api/issues/WEB-2", { project: "launch", milestone: "Beta" })).body).toMatchObject({ estimate: 3, milestone: "Beta" });
    expect((await alice.api("PATCH", "/api/documents/plan", { project: "launch" })).body.project).toBe("launch");
    // WEB-1 in progress (½), APP-1 done (1), WEB-2 todo (0): 1.5 of 3.
    expect((await alice.api("GET", "/api/projects/launch")).body).toMatchObject({
      teams: ["APP", "WEB"],
      progress: 0.5,
      issueCount: 3,
      milestones: [{ name: "Beta", issueCount: 1, progress: 0 }],
      docs: [{ slug: "plan" }],
    });
  });
});

describe("migration 23", () => {
  // Migrations 1-22 exactly as they shipped (src/server/db.ts): migration 22's SCHEMA_V21 fixture above (1-21), then
  // migration 22's SQL (projects). Frozen: never edit this fixture.
  const SCHEMA_V22 = [
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
    `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
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
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
    `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
    `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
    `
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `,
    `
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `,
    `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
    `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
    `
  ALTER TABLE issues ADD COLUMN due_on TEXT;
  CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
  `,
    `
  ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
  ALTER TABLE comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE;
  ALTER TABLE document_comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE document_comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
  `,
    `
  CREATE TABLE reactions (
    target TEXT NOT NULL,   -- 'issue:<id>' (the description), 'comment:<id>', 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's on (purge cascades)
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's on
    created_at TEXT NOT NULL,
    PRIMARY KEY (target, user_id, emoji)
  );
  `,
    `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,           -- 16 random bytes, base64url; also the file's name on disk
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    name TEXT NOT NULL,            -- the uploaded file's name, sanitized
    content_type TEXT NOT NULL,    -- sniffed by Docket, never the client's claim
    size INTEGER NOT NULL,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  `,
    `
    CREATE TABLE workflow_statuses (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')),
      color TEXT NOT NULL,
      position REAL NOT NULL,
      UNIQUE (team_id, key)
    );
    CREATE UNIQUE INDEX workflow_statuses_triage ON workflow_statuses(team_id) WHERE category = 'triage';
    INSERT INTO workflow_statuses (team_id, key, name, category, color, position)
      SELECT t.id, d.key, d.name, d.category, d.color, d.position FROM teams t, (
                  SELECT 'backlog' AS key, 'Backlog' AS name, 'backlog' AS category, '#a3a3a3' AS color, 1 AS position
        UNION ALL SELECT 'todo', 'Todo', 'unstarted', '#8f8f8f', 2
        UNION ALL SELECT 'in_progress', 'In Progress', 'started', '#e8a800', 3
        UNION ALL SELECT 'in_review', 'In Review', 'started', '#30a46c', 4
        UNION ALL SELECT 'done', 'Done', 'completed', '#5e6ad2', 5
        UNION ALL SELECT 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6
        UNION ALL SELECT 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7
      ) d ORDER BY t.id, d.position;
    ALTER TABLE teams ADD COLUMN default_status TEXT NOT NULL DEFAULT 'backlog';
    `,
    `
  ALTER TABLE teams ADD COLUMN auto_close_parent INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_parent IN (0, 1));
  ALTER TABLE teams ADD COLUMN auto_close_children INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_children IN (0, 1));
  ALTER TABLE users ADD COLUMN system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1));
  CREATE UNIQUE INDEX users_system ON users(system) WHERE system = 1;
  `,
    `
    CREATE TABLE labels (
      id INTEGER PRIMARY KEY,
      workspace TEXT NOT NULL REFERENCES workspaces(key),
      team_id INTEGER REFERENCES teams(id),    -- a team's own label, only on its issues; NULL: the workspace's
      parent_id INTEGER REFERENCES labels(id), -- its group
      name TEXT NOT NULL,
      color TEXT NOT NULL,                     -- #rrggbb
      is_group INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX labels_name ON labels(workspace, COALESCE(parent_id, 0), lower(name));
    CREATE TABLE issue_labels (
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (issue_id, label_id)
    );
    CREATE INDEX issue_labels_label ON issue_labels(label_id);
    `,
    `
  CREATE TABLE issue_aliases (
    team_id INTEGER NOT NULL REFERENCES teams(id),
    number INTEGER NOT NULL,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, number)
  );
  CREATE INDEX issue_aliases_issue ON issue_aliases(issue_id);
  `,
    `
  ALTER TABLE issues ADD COLUMN archived_at TEXT;
  CREATE INDEX issues_archived ON issues(archived_at) WHERE archived_at IS NOT NULL;
  ALTER TABLE teams ADD COLUMN auto_archive_days INTEGER; -- NULL = never (default); else days after completed_at
  `,
    `
  ALTER TABLE teams ADD COLUMN estimate_scale TEXT CHECK (estimate_scale IN ('exponential', 'fibonacci', 'linear', 'tshirt'));
  ALTER TABLE issues ADD COLUMN estimate INTEGER CHECK (estimate BETWEEN 1 AND 5);
  `,
    `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'planned', 'in_progress', 'paused', 'completed', 'canceled')),
    lead_id INTEGER REFERENCES users(id),
    target_date TEXT, -- YYYY-MM-DD
    creator_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, slug)
  );
  CREATE TABLE project_teams (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    PRIMARY KEY (project_id, team_id)
  );
  CREATE INDEX project_teams_team ON project_teams(team_id);
  CREATE TABLE milestones (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    target_date TEXT,
    position REAL NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX milestones_name ON milestones(project_id, lower(name));
  ALTER TABLE issues ADD COLUMN project_id INTEGER REFERENCES projects(id);
  ALTER TABLE issues ADD COLUMN milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL;
  CREATE INDEX issues_project ON issues(project_id) WHERE project_id IS NOT NULL;
  ALTER TABLE documents ADD COLUMN project_id INTEGER REFERENCES projects(id);
  CREATE INDEX documents_project ON documents(project_id) WHERE project_id IS NOT NULL;
  `,
  ];
  const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const rows = (file: string, sql: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  // Every table of schema 22 but the ones signing in writes to (sessions, api_keys, codes): migration 23 adds
  // custom_views and view_favorites and changes no row. Read by schema 22's own columns.
  const TABLES = [
    "users",
    "workspaces",
    "workspace_members",
    "teams",
    "workflow_statuses",
    "issues",
    "issue_blocks",
    "issue_relations",
    "issue_aliases",
    "comments",
    "documents",
    "issue_activity",
    "labels",
    "issue_labels",
    "projects",
    "project_teams",
    "milestones",
  ];

  /** A schema-22 database: alice (admin) and ben in acme, team EST with estimates on; EST-1 labeled Bug, sized, in project launch. */
  function writeV22(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file, { create: true });
    for (const sql of SCHEMA_V22) db.run(sql);
    db.run("PRAGMA user_version = 22");
    db.run(`INSERT INTO users (id, kind, email, created_at) VALUES (1, 'person', 'alice@example.com', '${t(0)}'), (2, 'person', NULL, '${t(0)}')`);
    db.run(`INSERT INTO workspaces (key, name, created_at, updated_at) VALUES ('acme', 'Acme', '${t(0)}', '${t(0)}')`);
    db.run(`INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES
      ('acme', 1, 'alice', 'Alice', 'admin', '${t(0)}'), ('acme', 2, 'ben', 'Ben', 'member', '${t(0)}')`);
    db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, next_number, estimate_scale) VALUES
      (5, 'acme', 'EST', 'Est', '${t(0)}', '${t(0)}', 2, 'fibonacci')`);
    db.run(`INSERT INTO workflow_statuses (team_id, key, name, category, color, position) VALUES
      (5, 'backlog', 'Backlog', 'backlog', '#a3a3a3', 1), (5, 'todo', 'Todo', 'unstarted', '#8f8f8f', 2),
      (5, 'in_progress', 'In Progress', 'started', '#e8a800', 3), (5, 'in_review', 'In Review', 'started', '#30a46c', 4),
      (5, 'done', 'Done', 'completed', '#5e6ad2', 5), (5, 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6),
      (5, 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7)`);
    db.run(`INSERT INTO projects (id, workspace, slug, name, creator_id, created_at, updated_at) VALUES (7, 'acme', 'launch', 'Launch', 1, '${t(0)}', '${t(0)}')`);
    db.run("INSERT INTO project_teams (project_id, team_id) VALUES (7, 5)");
    db.run(`INSERT INTO issues (id, team_id, number, title, status, priority, estimate, assignee_id, creator_id, project_id, created_at, updated_at) VALUES
      (101, 5, 1, 'Sized', 'todo', 2, 3, 1, 1, 7, '${t(1)}', '${t(11)}')`);
    db.run(`INSERT INTO labels (id, workspace, name, color, created_at) VALUES (1, 'acme', 'Bug', '#357fd4', '${t(0)}')`);
    db.run("INSERT INTO issue_labels (issue_id, label_id) VALUES (101, 1)");
    db.run(`INSERT INTO issue_activity (issue_id, actor_id, kind, from_value, to_value, created_at) VALUES
      (101, 1, 'created', NULL, NULL, '${t(1)}'), (101, 1, 'estimate', NULL, '3', '${t(11)}')`);
    db.close();
  }

  let v22: string;
  let columns: string[];
  let before: unknown[][];
  let server: TestServer;
  let alice: Caller;
  const snapshot = () => TABLES.map((table, n) => rows(v22, `SELECT ${columns[n]} FROM ${table} ORDER BY rowid`));
  beforeAll(async () => {
    v22 = join(dir, "v22", "docket.db");
    writeV22(v22);
    columns = TABLES.map((table) => (rows(v22, `PRAGMA table_info(${table})`) as { name: string }[]).map((c) => c.name).join(", "));
    before = snapshot();
    server = await startServer({ setup: false, env: { DATABASE_PATH: v22 } });
    await server.signIn("alice");
    alice = server.as("alice", "cookie", "acme");
  });
  afterAll(() => server.stop());

  test("no row changes; custom_views and view_favorites start empty", () => {
    expect(snapshot()).toEqual(before);
    expect(rows(v22, "SELECT * FROM custom_views")).toEqual([]);
    expect(rows(v22, "SELECT * FROM view_favorites")).toEqual([]);
    expect(rows(v22, "PRAGMA foreign_key_check")).toEqual([]);
    expect((rows(v22, "PRAGMA user_version")[0] as { user_version: number }).user_version).toBeGreaterThanOrEqual(23);
  });

  test("issues read as before; views save, star and delete on the migrated database", async () => {
    expect((await alice.api("GET", "/api/issues/EST-1")).body).toMatchObject({ labels: ["Bug"], estimate: 3, project: "launch", assignee: { username: "alice" } });
    expect((await alice.api("GET", "/api/views")).body).toEqual([]);
    const view = await alice.api("POST", "/api/views", { name: "Launch bugs", filter: { project: "launch", label: "Bug", assignee: "ben" }, display: { groupBy: "label" } });
    expect(view.status).toBe(201);
    expect(view.body).toMatchObject({ creator: { username: "alice" }, filter: { project: "launch" }, display: { groupBy: "label", orderBy: "priority", layout: "list" } });
    expect((await alice.api("PUT", `/api/views/${view.body.id}/favorite`)).body.favorite).toBe(true);
    expect(rows(v22, "SELECT user_id, view_id FROM view_favorites")).toEqual([{ user_id: 1, view_id: view.body.id }]);
    // The columns hold only what the API writes.
    const db = new Database(v22);
    try {
      expect(() => db.run(`UPDATE custom_views SET group_by = 'team' WHERE id = ${view.body.id}`)).toThrow();
      expect(() => db.run(`UPDATE custom_views SET order_by = 'due' WHERE id = ${view.body.id}`)).toThrow();
      expect(() => db.run(`UPDATE custom_views SET layout = 'table' WHERE id = ${view.body.id}`)).toThrow();
    } finally {
      db.close();
    }
    expect((await alice.api("DELETE", `/api/views/${view.body.id}`)).status).toBe(200);
    expect(rows(v22, "SELECT * FROM view_favorites")).toEqual([]); // its stars went with it
  });
});

// The SQLite connection, the schema, change events and the validation helpers the data modules share.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { xdgDataHome } from "./paths.ts";
import type { ServerEvent } from "../shared/types.ts";

/** An error with an HTTP status; REST returns it as `{ error }`, MCP as a tool error. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// --- Connection and schema ---

const path = process.env.DATABASE_PATH ?? join(xdgDataHome(), "docket", "docket.db");
mkdirSync(dirname(path), { recursive: true });
export const db = new Database(path, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");
db.run("PRAGMA busy_timeout = 5000");

// Append-only: each entry upgrades the schema by one PRAGMA user_version.
const MIGRATIONS = [
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
];

const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
MIGRATIONS.slice(user_version).forEach((sql, i) => {
  db.transaction(() => {
    db.run(sql);
    db.run(`PRAGMA user_version = ${user_version + i + 1}`);
  })();
});

// --- Change events ---

let listener: (event: ServerEvent) => void = () => {};

/** Called after every committed mutation (the server sends it over /ws to the workspace's members). */
export function onChange(fn: (event: ServerEvent) => void) {
  listener = fn;
}

export function changed(entity: ServerEvent["entity"], workspace: string, id: string) {
  listener({ type: "changed", entity, workspace, id });
}

// --- Validation ---

export const now = () => new Date().toISOString();

/**
 * updated_at doubles as a version token (baseUpdatedAt), so every change moves it strictly forward, even
 * within a millisecond. One rule, two forms that must agree: `bumpedAt(prev)` for a value computed in JS,
 * and `BUMPED_AT`, a SET clause for rows bumped in SQL (bind the current time to both `?`).
 */
export const bumpedAt = (prev: string, time = now()) =>
  time > prev ? time : new Date(Date.parse(prev) + 1).toISOString();
export const BUMPED_AT =
  "updated_at = CASE WHEN updated_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') ELSE ? END";

export const exists = (table: string, column: string, value: string) =>
  db.query(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(value) !== null;

/** The longest text a field takes, in characters (a huge comment would freeze every viewer's page). */
export const MAX_LENGTH: Record<string, number> = { title: 500, name: 200, body: 100_000, description: 100_000, content: 500_000 };

export function capLength(text: string, field: string): string {
  const max = MAX_LENGTH[field];
  if (max && text.length > max) throw new AppError(`${field} is too long: at most ${max.toLocaleString("en-US")} characters`);
  return text;
}

export function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError(`${field} is required`);
  return capLength(value.trim(), field);
}

export function optionalText(value: unknown, field: string): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new AppError(`${field} must be a string`);
  return capLength(value.trim(), field);
}

export function checkOneOf<T extends string | number>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new AppError(`Invalid ${field} "${value}". Use one of: ${allowed.join(", ")}`);
  return value as T;
}

/** "Q3 Roadmap: Café!" → "q3-roadmap-cafe"; "" when nothing Latin is left (e.g. an Arabic title). */
function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
}

/**
 * An explicit slug must be valid and free; a derived one is deduped: base, base-2, base-3…
 * or `${fallback}-1`, `${fallback}-2`… when the name has nothing Latin in it.
 */
export function pickSlug(
  explicit: unknown,
  name: string,
  taken: (slug: string) => boolean,
  { label, fallback }: { label: string; fallback: string },
): string {
  if (explicit !== undefined) {
    const slug = typeof explicit === "string" ? explicit.trim().toLowerCase() : "";
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      throw new AppError(`Invalid ${label} "${explicit}": use a-z, 0-9 and single dashes, e.g. "api-design"`);
    }
    if (taken(slug)) throw new AppError(`${label[0]!.toUpperCase()}${label.slice(1)} "${slug}" is already taken`, 409);
    return slug;
  }
  const base = slugify(name);
  for (let n = 1; ; n++) {
    const slug = base ? (n === 1 ? base : `${base}-${n}`) : `${fallback}-${n}`;
    if (!taken(slug)) return slug;
  }
}

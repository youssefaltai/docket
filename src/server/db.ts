import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { xdgDataHome } from "./paths.ts";
import {
  CLOSED_STATUSES,
  PRIORITIES,
  STATUSES,
  type Comment,
  type Document,
  type DocumentFilter,
  type DocumentInput,
  type DocumentPatch,
  type DocumentSummary,
  type DocumentVersion,
  type DocumentVersionSummary,
  type Issue,
  type IssueFilter,
  type IssueInput,
  type IssuePatch,
  type IssueSummary,
  type LabelCount,
  type Priority,
  type Project,
  type ProjectInput,
  type ProjectPatch,
  type ServerEvent,
  type Status,
  type Workspace,
  type WorkspaceInput,
  type WorkspacePatch,
} from "../shared/types.ts";

/** An error with an HTTP status; REST returns it as `{ error }`, MCP as a tool error. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// --- Connection and migrations ---

const path = process.env.DATABASE_PATH ?? join(xdgDataHome(), "docket", "docket.db");
mkdirSync(dirname(path), { recursive: true });
const db = new Database(path, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");
db.run("PRAGMA busy_timeout = 5000");

// Append-only: each entry upgrades the schema by one PRAGMA user_version.
const MIGRATIONS = [
  `
  CREATE TABLE projects (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY,
    project_key TEXT NOT NULL REFERENCES projects(key),
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    labels TEXT NOT NULL DEFAULT '[]',
    assignee TEXT,
    parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
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
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX comments_issue ON comments(issue_id);
  `,
  `
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    project_key TEXT NOT NULL REFERENCES projects(key),
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );
  CREATE INDEX documents_project ON documents(project_key, position);
  CREATE TABLE document_versions (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    author TEXT NOT NULL,
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
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX document_comments_document ON document_comments(document_id);
  `,
  // Workspaces group projects. Existing projects move into "default". SQLite can't add a
  // NOT NULL column with a foreign key, so the column is nullable and the app requires it.
  `
  CREATE TABLE workspaces (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO workspaces (key, name, created_at, updated_at)
    VALUES ('default', 'Default', strftime('%Y-%m-%dT%H:%M:%fZ'), strftime('%Y-%m-%dT%H:%M:%fZ'));
  ALTER TABLE projects ADD COLUMN workspace TEXT REFERENCES workspaces(key);
  UPDATE projects SET workspace = 'default';
  CREATE INDEX projects_workspace ON projects(workspace);
  `,
  // Issue numbers come from a per-project counter, so a deleted issue's number is never reused.
  `
  ALTER TABLE projects ADD COLUMN next_number INTEGER NOT NULL DEFAULT 1;
  UPDATE projects SET next_number = COALESCE((SELECT MAX(number) FROM issues WHERE project_key = projects.key), 0) + 1;
  `,
  // Comments can be edited; edited_at marks it.
  `
  ALTER TABLE comments ADD COLUMN edited_at TEXT;
  ALTER TABLE document_comments ADD COLUMN edited_at TEXT;
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

/** Called after every committed mutation (the server broadcasts it over /ws). */
export function onChange(fn: (event: ServerEvent) => void) {
  listener = fn;
}

function changed(entity: ServerEvent["entity"], id: string) {
  listener({ type: "changed", entity, id });
}

// --- Validation ---

const now = () => new Date().toISOString();

const exists = (table: string, column: string, value: string) =>
  db.query(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(value) !== null;

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError(`${field} is required`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new AppError(`${field} must be a string`);
  return value.trim();
}

function checkStatus(value: unknown): Status {
  if (!STATUSES.includes(value as Status)) {
    throw new AppError(`Invalid status "${value}". Use one of: ${STATUSES.join(", ")}`);
  }
  return value as Status;
}

function checkPriority(value: unknown): Priority {
  if (!PRIORITIES.includes(value as Priority)) {
    throw new AppError(`Invalid priority "${value}". Use 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)`);
  }
  return value as Priority;
}

function checkLabels(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((l) => typeof l === "string")) {
    throw new AppError("labels must be an array of strings");
  }
  return [...new Set(value.map((l) => l.trim()).filter(Boolean))];
}

function checkAssignee(value: unknown): string | null {
  if (value !== null && typeof value !== "string") throw new AppError("assignee must be a string or null");
  return value?.trim() || null;
}

/** "Q3 Roadmap: Café!" → "q3-roadmap-cafe"; "" when nothing Latin is left (e.g. an Arabic title). */
function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
}

/**
 * An explicit slug must be valid and free; a derived one is deduped: base, base-2, base-3…
 * or `${fallback}-1`, `${fallback}-2`… when the name has nothing Latin in it.
 */
function pickSlug(
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

// --- Comments ---

// Issue and doc comments live in parallel tables; each helper serves both.
const COMMENTS = {
  issue: { table: "comments", column: "issue_id" },
  document: { table: "document_comments", column: "document_id" },
} as const;

type CommentOwner = keyof typeof COMMENTS;

function listComments(owner: CommentOwner, ownerId: number): Comment[] {
  const { table, column } = COMMENTS[owner];
  return db
    .query<Comment, [number]>(
      `SELECT id, author, body, created_at AS createdAt, edited_at AS editedAt FROM ${table} WHERE ${column} = ? ORDER BY id`,
    )
    .all(ownerId);
}

function insertComment(owner: CommentOwner, ownerId: number, body: unknown, author: unknown, time: string) {
  const { table, column } = COMMENTS[owner];
  const text = requireText(body, "body");
  const name = requireText(author, "author");
  db.query(`INSERT INTO ${table} (${column}, author, body, created_at) VALUES (?, ?, ?, ?)`).run(ownerId, name, text, time);
}

/**
 * The id of a comment on this owner that `author` wrote (case-insensitive). Authors are
 * self-declared, so this guards against mistakes (an agent rewriting a person's note), not abuse.
 */
function ownComment(owner: CommentOwner, ownerId: number, commentId: unknown, author: unknown): number {
  const { table, column } = COMMENTS[owner];
  const id = Number(commentId);
  const row = Number.isInteger(id)
    ? db.query<{ author: string }, [number, number]>(`SELECT author FROM ${table} WHERE id = ? AND ${column} = ?`).get(id, ownerId)
    : null;
  if (!row) throw new AppError(`Comment ${commentId} not found`, 404);
  if (row.author.toLowerCase() !== requireText(author, "author").toLowerCase()) {
    throw new AppError(`Only ${row.author} can change this comment`, 403);
  }
  return id;
}

function updateComment(owner: CommentOwner, ownerId: number, commentId: unknown, body: unknown, author: unknown, time: string) {
  const id = ownComment(owner, ownerId, commentId, author);
  const text = requireText(body, "body");
  db.query(`UPDATE ${COMMENTS[owner].table} SET body = ?, edited_at = ? WHERE id = ?`).run(text, time, id);
}

function deleteComment(owner: CommentOwner, ownerId: number, commentId: unknown, author: unknown) {
  const id = ownComment(owner, ownerId, commentId, author);
  db.query(`DELETE FROM ${COMMENTS[owner].table} WHERE id = ?`).run(id);
}

// --- Workspaces ---

interface WorkspaceRow {
  key: string;
  name: string;
  project_count: number;
  created_at: string;
  updated_at: string;
}

const WORKSPACE_SELECT =
  "SELECT w.*, (SELECT COUNT(*) FROM projects WHERE workspace = w.key) AS project_count FROM workspaces w";

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    key: row.key,
    name: row.name,
    projectCount: row.project_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workspaceRow(key: unknown): WorkspaceRow {
  const row =
    typeof key === "string"
      ? db.query<WorkspaceRow, [string]>(`${WORKSPACE_SELECT} WHERE w.key = ?`).get(key.trim().toLowerCase())
      : null;
  if (!row) throw new AppError(`Workspace ${key} not found`, 404);
  return row;
}

export function listWorkspaces(): Workspace[] {
  return db
    .query<WorkspaceRow, []>(`${WORKSPACE_SELECT} ORDER BY w.name COLLATE NOCASE, w.key`)
    .all()
    .map(toWorkspace);
}

export function createWorkspace(input: WorkspaceInput): Workspace {
  const name = requireText(input.name, "name");
  const taken = (key: string) => exists("workspaces", "key", key);
  const key = pickSlug(input.key, name, taken, { label: "workspace key", fallback: "workspace" });
  const time = now();
  db.query("INSERT INTO workspaces (key, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(key, name, time, time);
  changed("workspace", key);
  return toWorkspace(workspaceRow(key));
}

export function updateWorkspace(key: string, patch: WorkspacePatch): Workspace {
  const row = workspaceRow(key);
  const name = patch.name === undefined ? row.name : requireText(patch.name, "name");
  db.query("UPDATE workspaces SET name = ?, updated_at = ? WHERE key = ?").run(name, now(), row.key);
  changed("workspace", row.key);
  return toWorkspace(workspaceRow(row.key));
}

// --- Projects ---

interface ProjectRow {
  key: string;
  workspace: string;
  name: string;
  description: string;
  counts: string; // JSON object: status → issue count, statuses without issues left out
  doc_count: number;
  created_at: string;
  updated_at: string;
}

const PROJECT_SELECT = `
  SELECT p.*,
    (SELECT json_group_object(status, n) FROM (
      SELECT status, COUNT(*) AS n FROM issues WHERE project_key = p.key GROUP BY status
    )) AS counts,
    (SELECT COUNT(*) FROM documents WHERE project_key = p.key) AS doc_count
  FROM projects p`;

function toProject(row: ProjectRow): Project {
  return {
    key: row.key,
    workspace: row.workspace,
    name: row.name,
    description: row.description,
    counts: { ...Object.fromEntries(STATUSES.map((s) => [s, 0])), ...JSON.parse(row.counts) },
    docCount: row.doc_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectRow(key: unknown): ProjectRow {
  const row =
    typeof key === "string"
      ? db.query<ProjectRow, [string]>(`${PROJECT_SELECT} WHERE p.key = ?`).get(key.trim().toUpperCase())
      : null;
  if (!row) throw new AppError(`Project ${key} not found`, 404);
  return row;
}

export function listProjects(filter: { workspace?: string } = {}): Project[] {
  const workspace = filter.workspace ? workspaceRow(filter.workspace).key : null;
  return db
    .query<ProjectRow, [string | null]>(`${PROJECT_SELECT} WHERE ?1 IS NULL OR p.workspace = ?1 ORDER BY p.key`)
    .all(workspace)
    .map(toProject);
}

export function createProject(input: ProjectInput): Project {
  const key = typeof input.key === "string" ? input.key.trim().toUpperCase() : "";
  if (!/^[A-Z]{2,5}$/.test(key)) throw new AppError("Project key must be 2–5 letters, e.g. BRD");
  const workspace = workspaceRow(requireText(input.workspace, "workspace")).key;
  const name = requireText(input.name, "name");
  const description = optionalText(input.description, "description");
  if (exists("projects", "key", key)) throw new AppError(`Project ${key} already exists`, 409);
  const time = now();
  db.query(
    "INSERT INTO projects (key, workspace, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(key, workspace, name, description, time, time);
  changed("project", key);
  return toProject(projectRow(key));
}

export function updateProject(key: string, patch: ProjectPatch): Project {
  const row = projectRow(key);
  const name = patch.name === undefined ? row.name : requireText(patch.name, "name");
  const description =
    patch.description === undefined ? row.description : optionalText(patch.description, "description");
  const workspace = patch.workspace === undefined ? row.workspace : workspaceRow(patch.workspace).key;
  db.query("UPDATE projects SET name = ?, description = ?, workspace = ?, updated_at = ? WHERE key = ?").run(
    name,
    description,
    workspace,
    now(),
    row.key,
  );
  changed("project", row.key);
  return toProject(projectRow(row.key));
}

// --- Issues ---

interface IssueRow {
  id: number;
  project_key: string;
  number: number;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  labels: string; // JSON array
  assignee: string | null;
  parent: string | null; // identifier
  blocked_by: string; // JSON array of identifiers
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const ident = (alias: string) => `${alias}.project_key || '-' || ${alias}.number`;

const ISSUE_SELECT = `
  SELECT i.*, ${ident("p")} AS parent,
    (SELECT json_group_array(ref) FROM (
      SELECT ${ident("b")} AS ref FROM issue_blocks x JOIN issues b ON b.id = x.blocker_id
      WHERE x.blocked_id = i.id ORDER BY b.project_key, b.number
    )) AS blocked_by
  FROM issues i LEFT JOIN issues p ON p.id = i.parent_id`;

// Status order, then priority 1→4 with 0 (none) last, then most recently updated.
const ISSUE_ORDER = `ORDER BY
  CASE i.status ${STATUSES.map((s, n) => `WHEN '${s}' THEN ${n}`).join(" ")} END,
  CASE i.priority WHEN 0 THEN 5 ELSE i.priority END,
  i.updated_at DESC, i.id DESC`;

function toSummary(row: IssueRow): IssueSummary {
  return {
    id: `${row.project_key}-${row.number}`,
    project: row.project_key,
    number: row.number,
    title: row.title,
    status: row.status,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    assignee: row.assignee,
    parent: row.parent,
    blockedBy: JSON.parse(row.blocked_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const findIssueId = (key: string, number: number) =>
  db.query<{ id: number }, [string, number]>("SELECT id FROM issues WHERE project_key = ? AND number = ?").get(key, number)
    ?.id;

/** Resolves an identifier like "brd-12" to the issue's row id. */
function issueId(identifier: unknown): number {
  const match = typeof identifier === "string" ? /^([a-z]{2,5})-(\d+)$/i.exec(identifier.trim()) : null;
  if (!match) throw new AppError(`Invalid issue identifier "${identifier}" (expected e.g. BRD-12)`);
  const key = match[1]!.toUpperCase();
  const number = Number(match[2]);
  const id = findIssueId(key, number);
  if (id === undefined) throw new AppError(`Issue ${key}-${number} not found`, 404);
  return id;
}

function blockerIds(identifiers: unknown, self?: number): number[] {
  if (!Array.isArray(identifiers)) throw new AppError("blockedBy must be an array of issue identifiers");
  const ids = [...new Set(identifiers.map(issueId))];
  if (self === undefined) return ids; // a new issue blocks nothing yet, so it can't close a cycle
  if (ids.includes(self)) throw new AppError("An issue can't block itself");
  if (ids.length === 0) return ids;
  // A blocker must not already depend on this issue, directly or through a chain of blocks.
  const cycle = db
    .query<{ ref: string }, [number]>(
      `WITH RECURSIVE downstream(id) AS (
         SELECT blocked_id FROM issue_blocks WHERE blocker_id = ?
         UNION SELECT x.blocked_id FROM issue_blocks x JOIN downstream d ON x.blocker_id = d.id
       )
       SELECT ${ident("i")} AS ref FROM issues i JOIN downstream d ON d.id = i.id
       WHERE i.id IN (${ids.join(", ")})`,
    )
    .get(self);
  if (cycle) throw new AppError(`${cycle.ref} is already blocked by this issue (directly or indirectly); that would be a cycle`);
  return ids;
}

function setBlockers(id: number, blockers: number[]) {
  db.query("DELETE FROM issue_blocks WHERE blocked_id = ?").run(id);
  for (const blocker of blockers) {
    db.query("INSERT INTO issue_blocks (blocker_id, blocked_id) VALUES (?, ?)").run(blocker, id);
  }
}

/** Validates the patch fields that map directly to issue columns. */
function issueColumns(patch: IssuePatch): Record<string, SQLQueryBindings> {
  const cols: Record<string, SQLQueryBindings> = {};
  if (patch.title !== undefined) cols.title = requireText(patch.title, "title");
  if (patch.description !== undefined) cols.description = optionalText(patch.description, "description");
  if (patch.status !== undefined) cols.status = checkStatus(patch.status);
  if (patch.priority !== undefined) cols.priority = checkPriority(patch.priority);
  if (patch.labels !== undefined) cols.labels = JSON.stringify(checkLabels(patch.labels));
  if (patch.assignee !== undefined) cols.assignee = checkAssignee(patch.assignee);
  if (patch.parent !== undefined) cols.parent_id = patch.parent === null ? null : issueId(patch.parent);
  return cols;
}

const isClosed = (status: Status) => CLOSED_STATUSES.includes(status);

/**
 * WHERE conditions shared by the issue and doc lists: workspace, project, and a substring
 * search over `searched` (the query's own %, _ and \ match literally).
 */
function listScope(alias: string, filter: { workspace?: string; project?: string; q?: string }, searched: string[]) {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (filter.workspace) {
    where.push(`${alias}.project_key IN (SELECT key FROM projects WHERE workspace = ?)`);
    params.push(workspaceRow(filter.workspace).key);
  }
  if (filter.project) {
    where.push(`${alias}.project_key = ?`);
    params.push(projectRow(filter.project).key);
  }
  if (filter.q) {
    where.push(`(${searched.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    params.push(...searched.map(() => `%${filter.q!.trim().replace(/[\\%_]/g, "\\$&")}%`));
  }
  return { where, params };
}

const whereClause = (where: string[]) => (where.length ? `WHERE ${where.join(" AND ")}` : "");

export function listIssues(filter: IssueFilter): IssueSummary[] {
  const { where, params } = listScope("i", filter, ["i.title", "i.description", ident("i")]);
  if (filter.status?.length) {
    where.push(`i.status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status.map(checkStatus));
  }
  if (filter.label) {
    where.push("EXISTS (SELECT 1 FROM json_each(i.labels) WHERE value = ? COLLATE NOCASE)");
    params.push(filter.label);
  }
  if (filter.assignee) {
    where.push("i.assignee = ? COLLATE NOCASE");
    params.push(filter.assignee);
  }
  if (filter.parent) {
    where.push("i.parent_id = ?");
    params.push(issueId(filter.parent));
  }
  return db
    .query<IssueRow, SQLQueryBindings[]>(`${ISSUE_SELECT} ${whereClause(where)} ${ISSUE_ORDER}`)
    .all(...params)
    .map(toSummary);
}

export function getIssue(identifier: string): Issue {
  const id = issueId(identifier);
  const row = db.query<IssueRow, [number]>(`${ISSUE_SELECT} WHERE i.id = ?`).get(id)!;
  const children = db
    .query<IssueRow, [number]>(`${ISSUE_SELECT} WHERE i.parent_id = ? ${ISSUE_ORDER}`)
    .all(id)
    .map(toSummary);
  const blocks = db
    .query<{ ref: string }, [number]>(
      `SELECT ${ident("b")} AS ref FROM issue_blocks x JOIN issues b ON b.id = x.blocked_id
       WHERE x.blocker_id = ? ORDER BY b.project_key, b.number`,
    )
    .all(id)
    .map((r) => r.ref);
  const comments = listComments("issue", id);
  const docs = db
    .query<DocumentRow, [number]>(
      `SELECT ${DOC_COLUMNS("d")} FROM document_refs r JOIN documents d ON d.id = r.document_id
       WHERE r.issue_id = ? ORDER BY d.project_key, d.position, d.id`,
    )
    .all(id)
    .map(toDocSummary);
  return { ...toSummary(row), description: row.description, children, blocks, comments, docs };
}

export function createIssue(input: IssueInput): Issue {
  const project = projectRow(input.project).key;
  const cols = {
    description: "",
    status: "todo",
    priority: 0,
    labels: "[]",
    assignee: null,
    parent_id: null,
    ...issueColumns(input),
    title: requireText(input.title, "title"),
  };
  const blockers = input.blockedBy === undefined ? [] : blockerIds(input.blockedBy);
  const time = now();
  const { identifier, docs } = db.transaction(() => {
    const { number } = db
      .query<{ number: number }, [string]>(
        "UPDATE projects SET next_number = next_number + 1 WHERE key = ? RETURNING next_number - 1 AS number",
      )
      .get(project)!;
    const row: Record<string, SQLQueryBindings> = {
      ...cols,
      project_key: project,
      number,
      created_at: time,
      updated_at: time,
      completed_at: isClosed(cols.status as Status) ? time : null,
    };
    const names = Object.keys(row);
    const { id } = db
      .query<{ id: number }, SQLQueryBindings[]>(
        `INSERT INTO issues (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) RETURNING id`,
      )
      .get(...Object.values(row))!;
    setBlockers(id, blockers);
    const identifier = `${project}-${number}`;
    // Docs that mentioned this identifier before the issue existed now link to it.
    const mention = new RegExp(`\\b${identifier}\\b`);
    const docs = db
      .query<{ id: number; slug: string; content: string }, [string]>(
        "SELECT id, slug, content FROM documents WHERE content LIKE ?",
      )
      .all(`%${identifier}%`)
      .filter((doc) => mention.test(doc.content));
    for (const doc of docs) saveRefs(doc.id, doc.content);
    return { identifier, docs };
  })();
  changed("issue", identifier);
  for (const doc of docs) changed("document", doc.slug);
  return getIssue(identifier);
}

export function updateIssue(identifier: string, patch: IssuePatch): Issue {
  const id = issueId(identifier);
  const cols = issueColumns(patch);
  const current = db
    .query<{ status: Status; parent_id: number | null }, [number]>("SELECT status, parent_id FROM issues WHERE id = ?")
    .get(id)!;
  // A new parent must not be the issue itself or one of its descendants.
  for (let p = cols.parent_id as number | null | undefined; p != null; ) {
    if (p === id) throw new AppError("An issue can't be its own parent or ancestor");
    p = db.query<{ parent_id: number | null }, [number]>("SELECT parent_id FROM issues WHERE id = ?").get(p)!.parent_id;
  }
  const blockers = patch.blockedBy === undefined ? undefined : blockerIds(patch.blockedBy, id);
  const time = now();
  if (cols.status !== undefined) {
    const closing = isClosed(cols.status as Status);
    if (closing !== isClosed(current.status)) cols.completed_at = closing ? time : null;
  }
  cols.updated_at = time;
  // The old and new parent and any blocker added or removed change too.
  const related = new Set<number>();
  if (cols.parent_id !== undefined && cols.parent_id !== current.parent_id) {
    if (current.parent_id !== null) related.add(current.parent_id);
    if (cols.parent_id !== null) related.add(cols.parent_id as number);
  }
  if (blockers) {
    const before = db
      .query<{ blocker_id: number }, [number]>("SELECT blocker_id FROM issue_blocks WHERE blocked_id = ?")
      .all(id)
      .map((b) => b.blocker_id);
    for (const b of before) if (!blockers.includes(b)) related.add(b);
    for (const b of blockers) if (!before.includes(b)) related.add(b);
  }
  const refs = db.transaction(() => {
    const assignments = Object.keys(cols).map((c) => `${c} = ?`);
    db.query(`UPDATE issues SET ${assignments.join(", ")} WHERE id = ?`).run(...Object.values(cols), id);
    if (blockers) setBlockers(id, blockers);
    const bump = db.query<{ ref: string }, [string, number]>(
      `UPDATE issues SET updated_at = ? WHERE id = ? RETURNING ${ident("issues")} AS ref`,
    );
    return [...related].map((r) => bump.get(time, r)!.ref);
  })();
  const issue = getIssue(identifier);
  changed("issue", issue.id);
  for (const ref of refs) changed("issue", ref);
  return issue;
}

export function deleteIssue(identifier: string) {
  const id = issueId(identifier);
  // Issues that lose their parent, a blocker link or a sub-issue, and docs that lose a ref, change too.
  const issues = db
    .query<{ id: number; ref: string }, [number, number, number, number]>(
      `SELECT i.id, ${ident("i")} AS ref FROM issues i
       WHERE i.parent_id = ? OR i.id = (SELECT parent_id FROM issues WHERE id = ?)
         OR i.id IN (SELECT blocked_id FROM issue_blocks WHERE blocker_id = ?)
         OR i.id IN (SELECT blocker_id FROM issue_blocks WHERE blocked_id = ?)`,
    )
    .all(id, id, id, id);
  const docs = db
    .query<{ slug: string }, [number]>(
      "SELECT d.slug FROM document_refs r JOIN documents d ON d.id = r.document_id WHERE r.issue_id = ?",
    )
    .all(id);
  const time = now();
  const ref = db.transaction(() => {
    for (const issue of issues) db.query("UPDATE issues SET updated_at = ? WHERE id = ?").run(time, issue.id);
    return db
      .query<{ ref: string }, [number]>(`DELETE FROM issues WHERE id = ? RETURNING ${ident("issues")} AS ref`)
      .get(id)!.ref;
  })();
  changed("issue", ref);
  for (const issue of issues) changed("issue", issue.ref);
  for (const doc of docs) changed("document", doc.slug);
}

/** Runs a change to an issue's comments, bumping the issue in the same transaction. */
function changeIssueComments(identifier: string, change: (id: number, time: string) => void): Issue {
  const id = issueId(identifier);
  const time = now();
  db.transaction(() => {
    change(id, time);
    db.query("UPDATE issues SET updated_at = ? WHERE id = ?").run(time, id);
  })();
  const issue = getIssue(identifier);
  changed("issue", issue.id);
  return issue;
}

export function addComment(identifier: string, body: unknown, author: unknown): Issue {
  return changeIssueComments(identifier, (id, time) => insertComment("issue", id, body, author, time));
}

export function updateIssueComment(identifier: string, commentId: unknown, body: unknown, author: unknown): Issue {
  return changeIssueComments(identifier, (id, time) => updateComment("issue", id, commentId, body, author, time));
}

export function deleteIssueComment(identifier: string, commentId: unknown, author: unknown): Issue {
  return changeIssueComments(identifier, (id) => deleteComment("issue", id, commentId, author));
}

/** Labels in use (optionally in one workspace), each with how many open issues carry it. */
export function listLabels(filter: { workspace?: string } = {}): LabelCount[] {
  const { where, params } = listScope("i", filter, []);
  return db
    .query<LabelCount, SQLQueryBindings[]>(
      `SELECT l.value AS label, SUM(i.status NOT IN (${CLOSED_STATUSES.map(() => "?").join(", ")})) AS open
       FROM issues i, json_each(i.labels) l ${whereClause(where)}
       GROUP BY l.value ORDER BY l.value COLLATE NOCASE`,
    )
    .all(...CLOSED_STATUSES, ...params);
}

// --- Documents ---

interface DocumentRow {
  id: number;
  slug: string;
  project_key: string;
  title: string;
  content: string; // not selected for lists
  position: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

const DOC_COLUMNS = (a: string) =>
  ["id", "slug", "project_key", "title", "position", "created_at", "updated_at", "updated_by"]
    .map((c) => `${a}.${c}`)
    .join(", ");

// Saves by the same author within this window of a version's first save update that version (autosave-friendly).
const VERSION_WINDOW_MS = 10 * 60 * 1000;

function toDocSummary(row: DocumentRow): DocumentSummary {
  return {
    slug: row.slug,
    project: row.project_key,
    title: row.title,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function documentRow(slug: unknown): DocumentRow {
  const row =
    typeof slug === "string"
      ? db.query<DocumentRow, [string]>("SELECT * FROM documents WHERE slug = ?").get(slug.trim().toLowerCase())
      : null;
  if (!row) throw new AppError(`Document ${slug} not found`, 404);
  return row;
}

function checkContent(value: unknown): string {
  if (typeof value !== "string") throw new AppError("content must be a string");
  return value;
}

function checkPosition(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new AppError("position must be a number");
  return value;
}

const nextPosition = (project: string) =>
  db
    .query<{ n: number }, [string]>("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM documents WHERE project_key = ?")
    .get(project)!.n;

/** Applies exact-text replacements in order; throws (applying nothing) unless each matches exactly once. */
function applyEdits(content: string, edits: unknown): string {
  if (!Array.isArray(edits)) throw new AppError("edits must be an array of { oldText, newText }");
  return edits.reduce<string>((text, edit, i) => {
    const { oldText, newText } = (edit ?? {}) as Record<string, unknown>;
    if (typeof oldText !== "string" || !oldText || typeof newText !== "string") {
      throw new AppError(`edits[${i}]: oldText (non-empty) and newText must be strings`);
    }
    // Overlapping matches count too: "aa" occurs twice in "aaa", which is ambiguous.
    let matches = 0;
    for (let at = text.indexOf(oldText); at !== -1; at = text.indexOf(oldText, at + 1)) matches++;
    if (matches === 0) {
      throw new AppError(`edits[${i}]: oldText not found (0 matches). Nothing was applied. Copy the text exactly from the current content.`);
    }
    if (matches > 1) {
      throw new AppError(`edits[${i}]: oldText matches ${matches} times. Nothing was applied. Include more surrounding text so it matches exactly once.`);
    }
    const at = text.indexOf(oldText);
    return text.slice(0, at) + newText + text.slice(at + oldText.length);
  }, content);
}

/**
 * Records a version, or updates the latest one if it's by the same author and started < 10 min ago.
 * The first version (creation) is never merged into, and a checkpoint always gets its own.
 */
function saveVersion(documentId: number, title: string, content: string, author: string, time: string, checkpoint = false) {
  const last = db
    .query<{ id: number; author: string; created_at: string; first: number }, [number]>(
      `SELECT id, author, created_at, id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id) AS first
       FROM document_versions v WHERE document_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(documentId);
  const merge =
    last && !checkpoint && !last.first && last.author === author &&
    Date.parse(time) - Date.parse(last.created_at) < VERSION_WINDOW_MS;
  if (merge) {
    // created_at stays put, so the window is anchored to the version's start and can't slide forever.
    db.query("UPDATE document_versions SET title = ?, content = ? WHERE id = ?").run(title, content, last.id);
  } else {
    db.query(
      "INSERT INTO document_versions (document_id, title, content, author, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(documentId, title, content, author, time);
  }
}

/** Rebuilds the issues a document mentions (identifiers that resolve to real issues, first-mention order). */
function saveRefs(documentId: number, content: string) {
  db.query("DELETE FROM document_refs WHERE document_id = ?").run(documentId);
  const ids = new Set<number>();
  for (const [, key, number] of content.matchAll(/\b([A-Z]{2,5})-(\d+)\b/g)) {
    const id = findIssueId(key!, Number(number));
    if (id !== undefined) ids.add(id);
  }
  [...ids].forEach((issueId, ord) => {
    db.query("INSERT INTO document_refs (document_id, issue_id, ord) VALUES (?, ?, ?)").run(documentId, issueId, ord);
  });
}

export function listDocuments(filter: DocumentFilter): DocumentSummary[] {
  const { where, params } = listScope("d", filter, ["d.title", "d.content"]);
  return db
    .query<DocumentRow, SQLQueryBindings[]>(
      `SELECT ${DOC_COLUMNS("d")} FROM documents d ${whereClause(where)} ORDER BY d.project_key, d.position, d.id`,
    )
    .all(...params)
    .map(toDocSummary);
}

export function getDocument(slug: string): Document {
  const row = documentRow(slug);
  const issues = db
    .query<IssueRow, [number]>(
      `${ISSUE_SELECT} JOIN document_refs r ON r.issue_id = i.id WHERE r.document_id = ? ORDER BY r.ord`,
    )
    .all(row.id)
    .map(toSummary);
  const comments = listComments("document", row.id);
  const { n: versionCount } = db
    .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ?")
    .get(row.id)!;
  return { ...toDocSummary(row), content: row.content, issues, comments, versionCount };
}

export function createDocument(input: DocumentInput): Document {
  const project = projectRow(input.project).key;
  const title = requireText(input.title, "title");
  const content = input.content === undefined ? "" : checkContent(input.content);
  const author = requireText(input.author, "author");
  const position = input.position === undefined ? undefined : checkPosition(input.position);
  const time = now();
  const slug = db.transaction(() => {
    const slug = pickSlug(input.slug, title, (s) => exists("documents", "slug", s), { label: "slug", fallback: "doc" });
    const { id } = db
      .query<{ id: number }, SQLQueryBindings[]>(
        `INSERT INTO documents (slug, project_key, title, content, position, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(slug, project, title, content, position ?? nextPosition(project), time, time, author)!;
    saveVersion(id, title, content, author, time);
    saveRefs(id, content);
    return slug;
  })();
  changed("document", slug);
  return getDocument(slug);
}

export function updateDocument(slug: string, patch: DocumentPatch): Document {
  const row = documentRow(slug);
  const author = requireText(patch.author, "author");
  if (patch.baseUpdatedAt !== undefined && patch.baseUpdatedAt !== row.updated_at) {
    throw new AppError("Document changed since you started editing", 409);
  }
  if (patch.content !== undefined && patch.edits !== undefined) {
    throw new AppError("Pass either content (full replacement) or edits, not both");
  }
  const cols: Partial<DocumentRow> = {};
  if (patch.title !== undefined) cols.title = requireText(patch.title, "title");
  if (patch.content !== undefined) cols.content = checkContent(patch.content);
  if (patch.edits !== undefined) cols.content = applyEdits(row.content, patch.edits);
  if (patch.project !== undefined) {
    cols.project_key = projectRow(patch.project).key;
    if (cols.project_key !== row.project_key && patch.position === undefined) {
      cols.position = nextPosition(cols.project_key);
    }
  }
  if (patch.position !== undefined) cols.position = checkPosition(patch.position);
  for (const [name, value] of Object.entries(cols)) {
    if (row[name as keyof DocumentRow] === value) delete cols[name as keyof DocumentRow];
  }
  if (Object.keys(cols).length === 0) return getDocument(row.slug);

  // updated_at is the version token for baseUpdatedAt, so it moves forward on every save, even within a millisecond.
  const time = new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString();
  const next = { ...row, ...cols, updated_at: time, updated_by: author };
  db.transaction(() => {
    const names = Object.keys(cols).concat("updated_at", "updated_by");
    db.query(`UPDATE documents SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE id = ?`).run(
      ...names.map((n) => next[n as keyof DocumentRow]),
      row.id,
    );
    if (cols.title !== undefined || cols.content !== undefined) {
      saveVersion(row.id, next.title, next.content, author, time, patch.checkpoint === true);
    }
    if (cols.content !== undefined) saveRefs(row.id, next.content);
  })();
  changed("document", row.slug);
  return getDocument(row.slug);
}

export function deleteDocument(slug: string) {
  const row = documentRow(slug);
  db.query("DELETE FROM documents WHERE id = ?").run(row.id);
  changed("document", row.slug);
}

/** Runs a change to a doc's comments. It leaves the doc's updated_at alone, so an open editor sees no conflict. */
function changeDocumentComments(slug: string, change: (id: number) => void): Document {
  const row = documentRow(slug);
  change(row.id);
  changed("document", row.slug);
  return getDocument(row.slug);
}

export function addDocumentComment(slug: string, body: unknown, author: unknown): Document {
  return changeDocumentComments(slug, (id) => insertComment("document", id, body, author, now()));
}

export function updateDocumentComment(slug: string, commentId: unknown, body: unknown, author: unknown): Document {
  return changeDocumentComments(slug, (id) => updateComment("document", id, commentId, body, author, now()));
}

export function deleteDocumentComment(slug: string, commentId: unknown, author: unknown): Document {
  return changeDocumentComments(slug, (id) => deleteComment("document", id, commentId, author));
}

export function listDocumentVersions(slug: string): DocumentVersionSummary[] {
  return db
    .query<DocumentVersionSummary, [number]>(
      `SELECT id, author, title, created_at AS createdAt FROM document_versions
       WHERE document_id = ? ORDER BY id DESC`,
    )
    .all(documentRow(slug).id);
}

export function getDocumentVersion(slug: string, id: unknown): DocumentVersion {
  const version = db
    .query<DocumentVersion, [number, number]>(
      `SELECT id, author, title, content, created_at AS createdAt FROM document_versions
       WHERE document_id = ? AND id = ?`,
    )
    .get(documentRow(slug).id, Number(id));
  if (!version) throw new AppError(`Version ${id} of ${slug} not found`, 404);
  return version;
}

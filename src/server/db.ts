import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  PRIORITIES,
  STATUSES,
  type Comment,
  type Document,
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
  type Priority,
  type Project,
  type ProjectInput,
  type ServerEvent,
  type Status,
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

export const CLOSED_STATUSES: Status[] = ["done", "canceled"];
export const OPEN_STATUSES = STATUSES.filter((s) => !CLOSED_STATUSES.includes(s));

// --- Connection and migrations ---

const path = process.env.DATABASE_PATH ?? "./data/docket.db";
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

// --- Projects ---

interface ProjectRow {
  key: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

function toProject(row: ProjectRow): Project {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  const rows = db
    .query<{ status: Status; n: number }, [string]>(
      "SELECT status, COUNT(*) AS n FROM issues WHERE project_key = ? GROUP BY status",
    )
    .all(row.key);
  for (const { status, n } of rows) counts[status] = n;
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    counts,
    docCount: db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM documents WHERE project_key = ?")
      .get(row.key)!.n,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectRow(key: unknown): ProjectRow {
  const row =
    typeof key === "string"
      ? db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE key = ?").get(key.trim().toUpperCase())
      : null;
  if (!row) throw new AppError(`Project ${key} not found`, 404);
  return row;
}

export function listProjects(): Project[] {
  return db.query<ProjectRow, []>("SELECT * FROM projects ORDER BY key").all().map(toProject);
}

export function createProject(input: ProjectInput): Project {
  const key = typeof input.key === "string" ? input.key.trim().toUpperCase() : "";
  if (!/^[A-Z]{2,5}$/.test(key)) throw new AppError("Project key must be 2–5 letters, e.g. BRD");
  const name = requireText(input.name, "name");
  const description = optionalText(input.description, "description");
  if (db.query("SELECT 1 FROM projects WHERE key = ?").get(key)) {
    throw new AppError(`Project ${key} already exists`, 409);
  }
  const time = now();
  db.query("INSERT INTO projects (key, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    key,
    name,
    description,
    time,
    time,
  );
  changed("project", key);
  return toProject(projectRow(key));
}

export function updateProject(key: string, patch: { name?: unknown; description?: unknown }): Project {
  const row = projectRow(key);
  const name = patch.name === undefined ? row.name : requireText(patch.name, "name");
  const description =
    patch.description === undefined ? row.description : optionalText(patch.description, "description");
  db.query("UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE key = ?").run(
    name,
    description,
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

/** Resolves an identifier like "brd-12" to the issue's row id. */
function issueId(identifier: unknown): number {
  const match = typeof identifier === "string" ? /^([a-z]{2,5})-(\d+)$/i.exec(identifier.trim()) : null;
  if (!match) throw new AppError(`Invalid issue identifier "${identifier}" (expected e.g. BRD-12)`);
  const key = match[1]!.toUpperCase();
  const number = Number(match[2]);
  const row = db
    .query<{ id: number }, [string, number]>("SELECT id FROM issues WHERE project_key = ? AND number = ?")
    .get(key, number);
  if (!row) throw new AppError(`Issue ${key}-${number} not found`, 404);
  return row.id;
}

function blockerIds(identifiers: unknown, self?: number): number[] {
  if (!Array.isArray(identifiers)) throw new AppError("blockedBy must be an array of issue identifiers");
  const ids = [...new Set(identifiers.map(issueId))];
  if (self !== undefined && ids.includes(self)) throw new AppError("An issue can't block itself");
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

export function listIssues(filter: IssueFilter): IssueSummary[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (filter.project) {
    where.push("i.project_key = ?");
    params.push(projectRow(filter.project).key);
  }
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
  if (filter.q) {
    where.push(`(i.title LIKE ? OR i.description LIKE ? OR ${ident("i")} LIKE ?)`);
    const like = `%${filter.q.trim()}%`;
    params.push(like, like, like);
  }
  const sql = `${ISSUE_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ${ISSUE_ORDER}`;
  return db
    .query<IssueRow, SQLQueryBindings[]>(sql)
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
  const comments = db
    .query<Comment, [number]>(
      "SELECT id, author, body, created_at AS createdAt FROM comments WHERE issue_id = ? ORDER BY id",
    )
    .all(id);
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
  const identifier = db.transaction(() => {
    const { number } = db
      .query<{ number: number }, [string]>(
        "SELECT COALESCE(MAX(number), 0) + 1 AS number FROM issues WHERE project_key = ?",
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
    return `${project}-${number}`;
  })();
  changed("issue", identifier);
  // Docs that mentioned this identifier before the issue existed now link to it.
  const mentions = db
    .query<{ id: number; slug: string; content: string }, [string]>(
      "SELECT id, slug, content FROM documents WHERE content LIKE ?",
    )
    .all(`%${identifier}%`);
  for (const doc of mentions) {
    saveRefs(doc.id, doc.content);
    changed("document", doc.slug);
  }
  return getIssue(identifier);
}

export function updateIssue(identifier: string, patch: IssuePatch): Issue {
  const id = issueId(identifier);
  const cols = issueColumns(patch);
  // A new parent must not be the issue itself or one of its descendants.
  for (let p = cols.parent_id as number | null | undefined; p != null; ) {
    if (p === id) throw new AppError("An issue can't be its own parent or ancestor");
    p = db.query<{ parent_id: number | null }, [number]>("SELECT parent_id FROM issues WHERE id = ?").get(p)!.parent_id;
  }
  const blockers = patch.blockedBy === undefined ? undefined : blockerIds(patch.blockedBy, id);
  const time = now();
  if (cols.status !== undefined) {
    const current = db.query<{ status: Status }, [number]>("SELECT status FROM issues WHERE id = ?").get(id)!;
    const closing = isClosed(cols.status as Status);
    if (closing !== isClosed(current.status)) cols.completed_at = closing ? time : null;
  }
  cols.updated_at = time;
  db.transaction(() => {
    const assignments = Object.keys(cols).map((c) => `${c} = ?`);
    db.query(`UPDATE issues SET ${assignments.join(", ")} WHERE id = ?`).run(...Object.values(cols), id);
    if (blockers) setBlockers(id, blockers);
  })();
  const issue = getIssue(identifier);
  changed("issue", issue.id);
  return issue;
}

export function deleteIssue(identifier: string) {
  const { ref } = db
    .query<{ ref: string }, [number]>("DELETE FROM issues WHERE id = ? RETURNING project_key || '-' || number AS ref")
    .get(issueId(identifier))!;
  changed("issue", ref);
}

export function addComment(identifier: string, body: unknown, author: unknown): Issue {
  const id = issueId(identifier);
  const text = requireText(body, "body");
  const name = requireText(author, "author");
  const time = now();
  db.transaction(() => {
    db.query("INSERT INTO comments (issue_id, author, body, created_at) VALUES (?, ?, ?, ?)").run(id, name, text, time);
    db.query("UPDATE issues SET updated_at = ? WHERE id = ?").run(time, id);
  })();
  const issue = getIssue(identifier);
  changed("issue", issue.id);
  return issue;
}

export function listLabels(): string[] {
  return db
    .query<{ value: string }, []>(
      "SELECT DISTINCT value FROM issues, json_each(issues.labels) ORDER BY value COLLATE NOCASE",
    )
    .all()
    .map((r) => r.value);
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

// Consecutive saves by the same author within this window update one version (autosave-friendly).
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

function slugTaken(slug: string): boolean {
  return db.query("SELECT 1 FROM documents WHERE slug = ?").get(slug) !== null;
}

/** An explicit slug must be free; a derived one is deduped: base, base-2, base-3… or doc-1, doc-2… */
function pickSlug(explicit: unknown, title: string): string {
  if (explicit !== undefined) {
    const slug = typeof explicit === "string" ? explicit.trim().toLowerCase() : "";
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      throw new AppError(`Invalid slug "${explicit}": use a-z, 0-9 and single dashes, e.g. "api-design"`);
    }
    if (slugTaken(slug)) throw new AppError(`Slug "${slug}" is already taken`, 409);
    return slug;
  }
  const base = slugify(title);
  for (let n = 1; ; n++) {
    const slug = base ? (n === 1 ? base : `${base}-${n}`) : `doc-${n}`;
    if (!slugTaken(slug)) return slug;
  }
}

/** Applies exact-text replacements in order; throws (applying nothing) unless each matches exactly once. */
function applyEdits(content: string, edits: unknown): string {
  if (!Array.isArray(edits)) throw new AppError("edits must be an array of { oldText, newText }");
  return edits.reduce<string>((text, edit, i) => {
    const { oldText, newText } = (edit ?? {}) as Record<string, unknown>;
    if (typeof oldText !== "string" || !oldText || typeof newText !== "string") {
      throw new AppError(`edits[${i}]: oldText (non-empty) and newText must be strings`);
    }
    const matches = text.split(oldText).length - 1;
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
 * Records a version, or updates the latest one if it's by the same author and recent.
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
    db.query("UPDATE document_versions SET title = ?, content = ?, created_at = ? WHERE id = ?").run(
      title,
      content,
      time,
      last.id,
    );
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
    const row = db
      .query<{ id: number }, [string, number]>("SELECT id FROM issues WHERE project_key = ? AND number = ?")
      .get(key!, Number(number));
    if (row) ids.add(row.id);
  }
  [...ids].forEach((issueId, ord) => {
    db.query("INSERT INTO document_refs (document_id, issue_id, ord) VALUES (?, ?, ?)").run(documentId, issueId, ord);
  });
}

export function listDocuments(filter: { project?: string; q?: string }): DocumentSummary[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (filter.project) {
    where.push("d.project_key = ?");
    params.push(projectRow(filter.project).key);
  }
  if (filter.q) {
    where.push("(d.title LIKE ? OR d.content LIKE ?)");
    const like = `%${filter.q.trim()}%`;
    params.push(like, like);
  }
  const sql = `SELECT ${DOC_COLUMNS("d")} FROM documents d ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY d.project_key, d.position, d.id`;
  return db
    .query<DocumentRow, SQLQueryBindings[]>(sql)
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
  const comments = db
    .query<Comment, [number]>(
      "SELECT id, author, body, created_at AS createdAt FROM document_comments WHERE document_id = ? ORDER BY id",
    )
    .all(row.id);
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
    const slug = pickSlug(input.slug, title);
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

  const time = now();
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

export function addDocumentComment(slug: string, body: unknown, author: unknown): Document {
  const row = documentRow(slug);
  const text = requireText(body, "body");
  const name = requireText(author, "author");
  db.query("INSERT INTO document_comments (document_id, author, body, created_at) VALUES (?, ?, ?, ?)").run(
    row.id,
    name,
    text,
    now(),
  );
  changed("document", row.slug);
  return getDocument(row.slug);
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

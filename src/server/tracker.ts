// Teams, issues, comments, labels and documents. Every function acts for an Actor and sees only the
// workspaces it's an active member of: anything elsewhere is 404, as if it didn't exist.
import type { SQLQueryBindings } from "bun:sqlite";
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
  type IssuePage,
  type IssuePatch,
  type IssueSummary,
  type LabelCount,
  type Priority,
  type Status,
  type Team,
  type TeamInput,
  type TeamPatch,
  type Trash,
  type UserKind,
  type UserRef,
} from "../shared/types.ts";
import { type Actor, activeMemberId, requireMember } from "./access.ts";
import {
  AppError,
  BUMPED_AT,
  bumpedAt,
  changed,
  checkOneOf,
  db,
  exists,
  now,
  capLength,
  optionalText,
  pickSlug,
  requireText,
} from "./db.ts";

const checkStatus = (value: unknown) => checkOneOf(value, STATUSES, "status");
const checkPriority = (value: unknown) => checkOneOf(value as Priority, PRIORITIES, "priority (0 none, 1 urgent, 2 high, 3 medium, 4 low)");

function checkLabels(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((l) => typeof l === "string")) {
    throw new AppError("labels must be an array of strings");
  }
  return [...new Set(value.map((l) => l.trim()).filter(Boolean))];
}

/**
 * The one workspace a filter asks for, else all of the actor's. A filter naming something unknown (or
 * outside your workspaces) is 400, not an empty list, so a typo can't pass for "nothing here".
 */
function scopeWorkspaces(a: Actor, workspace?: string): string[] {
  if (!workspace) return [...a.workspaces.keys()];
  const key = workspace.trim().toLowerCase();
  if (!a.workspaces.has(key)) throw new AppError(`Unknown workspace "${workspace}"`);
  return [key];
}
/** Placeholders for `IN (…)`; never empty, so the SQL stays valid. */
const inList = (values: unknown[]) => (values.length ? values.map(() => "?").join(", ") : "NULL");

/** A UserRef from joined columns `${p}_username`, `${p}_name`, `${p}_kind`, or null. */
function ref(row: Record<string, unknown>, p: string): UserRef | null {
  const username = row[`${p}_username`] as string | null;
  return username ? { username, name: row[`${p}_name`] as string, kind: row[`${p}_kind`] as UserKind } : null;
}
const userCols = (alias: string, p: string) => `${alias}.username AS ${p}_username, ${alias}.name AS ${p}_name, ${alias}.kind AS ${p}_kind`;

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
    .query<Record<string, unknown>, [number]>(
      `SELECT c.id, c.body, c.created_at, c.edited_at, ${userCols("u", "a")}
       FROM ${table} c JOIN users u ON u.id = c.author_id WHERE c.${column} = ? ORDER BY c.id`,
    )
    .all(ownerId)
    .map((r) => ({
      id: r.id as number,
      author: ref(r, "a")!,
      body: r.body as string,
      createdAt: r.created_at as string,
      editedAt: r.edited_at as string | null,
    }));
}

function insertComment(a: Actor, owner: CommentOwner, ownerId: number, body: unknown, time: string) {
  const { table, column } = COMMENTS[owner];
  db.query(`INSERT INTO ${table} (${column}, author_id, body, created_at) VALUES (?, ?, ?, ?)`).run(
    ownerId,
    a.id,
    requireText(body, "body"),
    time,
  );
}

/** The id of a comment on this owner that the actor wrote; others' comments are 403. */
function ownComment(a: Actor, owner: CommentOwner, ownerId: number, commentId: unknown): number {
  const { table, column } = COMMENTS[owner];
  const id = Number(commentId);
  const row = Number.isInteger(id)
    ? db
        .query<{ author_id: number; username: string }, [number, number]>(
          `SELECT c.author_id, u.username FROM ${table} c JOIN users u ON u.id = c.author_id WHERE c.id = ? AND c.${column} = ?`,
        )
        .get(id, ownerId)
    : null;
  if (!row) throw new AppError(`Comment ${commentId} not found`, 404);
  if (row.author_id !== a.id) throw new AppError(`Only @${row.username} can change this comment`, 403);
  return id;
}

function updateComment(a: Actor, owner: CommentOwner, ownerId: number, commentId: unknown, body: unknown, time: string) {
  const id = ownComment(a, owner, ownerId, commentId);
  db.query(`UPDATE ${COMMENTS[owner].table} SET body = ?, edited_at = ? WHERE id = ?`).run(requireText(body, "body"), time, id);
}

function deleteComment(a: Actor, owner: CommentOwner, ownerId: number, commentId: unknown) {
  const id = ownComment(a, owner, ownerId, commentId);
  db.query(`DELETE FROM ${COMMENTS[owner].table} WHERE id = ?`).run(id);
}

// --- Teams ---

interface TeamRow {
  key: string;
  workspace: string;
  name: string;
  description: string;
  counts: string; // JSON object: status → issue count, statuses without issues left out
  doc_count: number;
  created_at: string;
  updated_at: string;
}

const TEAM_SELECT = `
  SELECT t.*,
    (SELECT json_group_object(status, n) FROM (
      SELECT status, COUNT(*) AS n FROM issues WHERE team_key = t.key AND deleted_at IS NULL GROUP BY status
    )) AS counts,
    (SELECT COUNT(*) FROM documents WHERE team_key = t.key AND deleted_at IS NULL) AS doc_count
  FROM teams t`;

const toTeam = (row: TeamRow): Team => ({
  key: row.key,
  workspace: row.workspace,
  name: row.name,
  description: row.description,
  counts: { ...Object.fromEntries(STATUSES.map((s) => [s, 0])), ...JSON.parse(row.counts) },
  docCount: row.doc_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function teamRow(a: Actor, key: unknown): TeamRow {
  const row =
    typeof key === "string" ? db.query<TeamRow, [string]>(`${TEAM_SELECT} WHERE t.key = ?`).get(key.trim().toUpperCase()) : null;
  if (!row || !a.workspaces.has(row.workspace)) throw new AppError(`Team ${key} not found`, 404);
  return row;
}

export function listTeams(a: Actor, filter: { workspace?: string } = {}): Team[] {
  const workspaces = scopeWorkspaces(a, filter.workspace);
  return db
    .query<TeamRow, string[]>(`${TEAM_SELECT} WHERE t.workspace IN (${inList(workspaces)}) ORDER BY t.key`)
    .all(...workspaces)
    .map(toTeam);
}

export function createTeam(a: Actor, input: TeamInput): Team {
  const key = typeof input.key === "string" ? input.key.trim().toUpperCase() : "";
  if (!/^[A-Z]{2,5}$/.test(key)) throw new AppError("Team key must be 2–5 letters, e.g. BRD");
  const workspace = requireMember(a, requireText(input.workspace, "workspace"));
  const name = requireText(input.name, "name");
  const description = optionalText(input.description, "description");
  if (exists("teams", "key", key)) throw new AppError(`Team key ${key} is taken`, 409);
  const time = now();
  db.query("INSERT INTO teams (key, workspace, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    key,
    workspace,
    name,
    description,
    time,
    time,
  );
  changed("team", workspace, key);
  return toTeam(teamRow(a, key));
}

/** Renames or redescribes a team. Teams never change workspace: their issues, people and links belong to it. */
export function updateTeam(a: Actor, key: string, patch: TeamPatch & { workspace?: unknown }): Team {
  const row = teamRow(a, key);
  if (patch.workspace !== undefined && patch.workspace !== row.workspace) throw new AppError("Teams can't move between workspaces");
  const name = patch.name === undefined ? row.name : requireText(patch.name, "name");
  const description = patch.description === undefined ? row.description : optionalText(patch.description, "description");
  db.query("UPDATE teams SET name = ?, description = ?, updated_at = ? WHERE key = ?").run(name, description, now(), row.key);
  changed("team", row.workspace, row.key);
  return toTeam(teamRow(a, row.key));
}

// --- Issues ---

type IssueRow = Record<string, unknown> & {
  id: number;
  team_key: string;
  workspace: string;
  number: number;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  labels: string; // JSON array
  parent: string | null; // identifier
  blocked_by: string; // JSON array of identifiers
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
};

const ident = (alias: string) => `${alias}.team_key || '-' || ${alias}.number`;

const ISSUE_SELECT = `
  SELECT i.*, t.workspace, ${ident("p")} AS parent,
    ${userCols("ua", "assignee")}, ${userCols("ud", "delegate")}, ${userCols("uc", "creator")},
    (SELECT json_group_array(ref) FROM (
      SELECT ${ident("b")} AS ref FROM issue_blocks x JOIN issues b ON b.id = x.blocker_id
      WHERE x.blocked_id = i.id AND b.deleted_at IS NULL ORDER BY b.team_key, b.number
    )) AS blocked_by
  FROM issues i
  JOIN teams t ON t.key = i.team_key
  JOIN users uc ON uc.id = i.creator_id
  LEFT JOIN users ua ON ua.id = i.assignee_id
  LEFT JOIN users ud ON ud.id = i.delegate_id
  LEFT JOIN issues p ON p.id = i.parent_id`;

// Status order, then priority 1→4 with 0 (none) last, then most recently updated. The first two keys are
// also what a page cursor records (with updated_at and id), so pages resume exactly where they stopped.
const STATUS_RANK = `CASE i.status ${STATUSES.map((s, n) => `WHEN '${s}' THEN ${n}`).join(" ")} END`;
const PRIORITY_RANK = "CASE i.priority WHEN 0 THEN 5 ELSE i.priority END";
const ISSUE_ORDER = `ORDER BY ${STATUS_RANK}, ${PRIORITY_RANK}, i.updated_at DESC, i.id DESC`;
const LIVE = "i.deleted_at IS NULL";

const toSummary = (row: IssueRow): IssueSummary => ({
  id: `${row.team_key}-${row.number}`,
  team: row.team_key,
  number: row.number,
  title: row.title,
  status: row.status,
  priority: row.priority,
  labels: JSON.parse(row.labels),
  assignee: ref(row, "assignee"),
  delegate: ref(row, "delegate"),
  parent: row.parent,
  blockedBy: JSON.parse(row.blocked_by),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  deletedAt: row.deleted_at,
});

/**
 * Resolves an identifier like "brd-12" to the issue's row id and workspace; 404 outside the actor's.
 * Trashed issues resolve too (to read or restore them); `liveIssue` is for everything that changes one.
 */
function issueRef(a: Actor, identifier: unknown): { id: number; workspace: string; deleted_at: string | null; ref: string } {
  const match = typeof identifier === "string" ? /^([a-z]{2,5})-(\d+)$/i.exec(identifier.trim()) : null;
  if (!match) throw new AppError(`Invalid issue identifier "${identifier}" (expected e.g. BRD-12)`);
  const key = match[1]!.toUpperCase();
  const number = Number(match[2]);
  const row = db
    .query<{ id: number; workspace: string; deleted_at: string | null }, [string, number]>(
      "SELECT i.id, t.workspace, i.deleted_at FROM issues i JOIN teams t ON t.key = i.team_key WHERE i.team_key = ? AND i.number = ?",
    )
    .get(key, number);
  if (!row || !a.workspaces.has(row.workspace)) throw new AppError(`Issue ${key}-${number} not found`, 404);
  return { ...row, ref: `${key}-${number}` };
}

/** An issue that isn't in the trash: a trashed one can be read and restored, nothing else. */
function liveIssue(a: Actor, identifier: unknown) {
  const issue = issueRef(a, identifier);
  if (issue.deleted_at) throw new AppError(`${issue.ref} is in the trash; restore it first`, 409);
  return issue;
}

/** An issue in `workspace`: relations never cross workspaces, where their members couldn't see both ends. */
function relatedId(a: Actor, identifier: unknown, workspace: string, field: string): number {
  const other = issueRef(a, identifier);
  if (other.workspace !== workspace) throw new AppError(`${field}: ${identifier} is in another workspace`);
  if (other.deleted_at) throw new AppError(`${field}: ${other.ref} is in the trash`);
  return other.id;
}

function blockerIds(a: Actor, identifiers: unknown, workspace: string, self?: number): number[] {
  if (!Array.isArray(identifiers)) throw new AppError("blockedBy must be an array of issue identifiers");
  const ids = [...new Set(identifiers.map((i) => relatedId(a, i, workspace, "blockedBy")))];
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
  for (const blocker of blockers) db.query("INSERT INTO issue_blocks (blocker_id, blocked_id) VALUES (?, ?)").run(blocker, id);
}

/** Validates the patch fields that map directly to issue columns. */
function issueColumns(a: Actor, workspace: string, patch: IssuePatch): Record<string, SQLQueryBindings> {
  const cols: Record<string, SQLQueryBindings> = {};
  if (patch.title !== undefined) cols.title = requireText(patch.title, "title");
  if (patch.description !== undefined) cols.description = optionalText(patch.description, "description");
  if (patch.status !== undefined) cols.status = checkStatus(patch.status);
  if (patch.priority !== undefined) cols.priority = checkPriority(patch.priority);
  if (patch.labels !== undefined) cols.labels = JSON.stringify(checkLabels(patch.labels));
  for (const [field, kind] of [["assignee", "person"], ["delegate", "agent"]] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") throw new AppError(`${field} must be a username or null`);
    cols[`${field}_id`] = value?.trim() ? activeMemberId(a, workspace, value, kind, field) : null;
  }
  if (patch.parent !== undefined) cols.parent_id = patch.parent === null ? null : relatedId(a, patch.parent, workspace, "parent");
  return cols;
}

const isClosed = (status: Status) => CLOSED_STATUSES.includes(status);

/**
 * WHERE conditions shared by the issue and doc lists: the actor's workspaces (or one of them), a team,
 * and a substring search over `searched` (the query's own %, _ and \ match literally).
 */
function listScope(a: Actor, alias: string, filter: { workspace?: string; team?: string; q?: string }, searched: string[]) {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  const workspaces = scopeWorkspaces(a, filter.workspace);
  where.push(`${alias}.team_key IN (SELECT key FROM teams WHERE workspace IN (${inList(workspaces)}))`);
  params.push(...workspaces);
  where.push(`${alias}.deleted_at IS NULL`);
  if (filter.team) {
    const key = filter.team.trim().toUpperCase();
    const team = db.query<{ workspace: string }, [string]>("SELECT workspace FROM teams WHERE key = ?").get(key);
    if (!team || !workspaces.includes(team.workspace)) throw new AppError(`Unknown team "${filter.team}"`);
    where.push(`${alias}.team_key = ?`);
    params.push(key);
  }
  if (filter.q) {
    where.push(`(${searched.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    params.push(...searched.map(() => `%${filter.q!.trim().replace(/[\\%_]/g, "\\$&")}%`));
  }
  return { where, params };
}

/** `listScope` always adds the workspace condition, so there's always a WHERE. */
const whereClause = (where: string[]) => `WHERE ${where.join(" AND ")}`;

/**
 * A username filter ("me" is the actor) as a user id. It must name someone who is or was in one of the
 * workspaces searched; anyone else is 400 (a typo shouldn't look like "no issues").
 */
function userFilterId(a: Actor, value: string, workspaces: SQLQueryBindings[], field: string): number {
  const username = value.trim().toLowerCase();
  if (username === "me") return a.id;
  const row = db
    .query<{ id: number }, SQLQueryBindings[]>(
      `SELECT u.id FROM users u WHERE u.username = ?
       AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = u.id AND m.workspace IN (${inList(workspaces)}))`,
    )
    .get(username, ...workspaces);
  if (!row) throw new AppError(`Unknown ${field} "${value}"`);
  return row.id;
}

/** Page cursors: the last row's sort keys (status rank, priority rank, updated_at, id), opaque to clients. */
const cursorOf = (issue: IssueSummary, id: number) =>
  Buffer.from(JSON.stringify([STATUSES.indexOf(issue.status), issue.priority || 5, issue.updatedAt, id])).toString("base64url");

function parseCursor(cursor: string): [number, number, string, number] {
  try {
    const keys = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (Array.isArray(keys) && keys.length === 4 && typeof keys[2] === "string" && [0, 1, 3].every((i) => Number.isInteger(keys[i]))) {
      return keys as [number, number, string, number];
    }
  } catch {}
  throw new AppError("Invalid cursor: pass an endCursor from a previous page");
}

export function listIssues(a: Actor, filter: IssueFilter): IssueSummary[] {
  return queryIssues(a, filter).rows.map(toSummary);
}

/**
 * One page of issues, Linear-style: `first` (1–500) from after the `after` cursor, in list order. Keyset
 * paging: the cursor holds the last row's sort keys, so pages don't shift when earlier rows change.
 */
export function listIssuesPage(a: Actor, filter: IssueFilter, page: { first?: unknown; after?: unknown }): IssuePage {
  const first = page.first === undefined ? 50 : Number(page.first);
  if (!Number.isInteger(first) || first < 1 || first > 500) throw new AppError("first must be a whole number from 1 to 500");
  const after = page.after === undefined || page.after === "" ? undefined : parseCursor(String(page.after));
  const { rows } = queryIssues(a, filter, after, first + 1);
  const hasNextPage = rows.length > first;
  const issues = rows.slice(0, first);
  const last = issues.at(-1);
  return { issues: issues.map(toSummary), pageInfo: { hasNextPage, endCursor: last ? cursorOf(toSummary(last), last.id) : null } };
}

function queryIssues(a: Actor, filter: IssueFilter, after?: [number, number, string, number], limit?: number) {
  const { where, params } = listScope(a, "i", filter, ["i.title", "i.description", ident("i")]);
  if (filter.status?.length) {
    where.push(`i.status IN (${inList(filter.status)})`);
    params.push(...filter.status.map(checkStatus));
  }
  if (filter.label) {
    where.push("EXISTS (SELECT 1 FROM json_each(i.labels) WHERE value = ? COLLATE NOCASE)");
    params.push(filter.label);
  }
  const workspaces = scopeWorkspaces(a, filter.workspace);
  if (filter.assignee) {
    where.push("i.assignee_id = ?");
    params.push(userFilterId(a, filter.assignee, workspaces, "assignee"));
  }
  if (filter.delegate) {
    where.push("i.delegate_id = ?");
    params.push(userFilterId(a, filter.delegate, workspaces, "delegate"));
  }
  if (filter.parent) {
    let parent: number;
    try {
      parent = issueRef(a, filter.parent).id;
    } catch {
      throw new AppError(`Unknown parent issue "${filter.parent}"`);
    }
    where.push("i.parent_id = ?");
    params.push(parent);
  }
  if (after) {
    const [s, p, u, id] = after;
    where.push(`(${STATUS_RANK} > ? OR (${STATUS_RANK} = ? AND (${PRIORITY_RANK} > ? OR (${PRIORITY_RANK} = ? AND (i.updated_at < ? OR (i.updated_at = ? AND i.id < ?))))))`);
    params.push(s, s, p, p, u, u, id);
  }
  const rows = db
    .query<IssueRow, SQLQueryBindings[]>(`${ISSUE_SELECT} ${whereClause(where)} ${ISSUE_ORDER}${limit ? ` LIMIT ${limit}` : ""}`)
    .all(...params);
  return { rows };
}

export function getIssue(a: Actor, identifier: string): Issue {
  const { id } = issueRef(a, identifier);
  const row = db.query<IssueRow, [number]>(`${ISSUE_SELECT} WHERE i.id = ?`).get(id)!;
  const children = db.query<IssueRow, [number]>(`${ISSUE_SELECT} WHERE i.parent_id = ? AND ${LIVE} ${ISSUE_ORDER}`).all(id).map(toSummary);
  const blocks = db
    .query<{ ref: string }, [number]>(
      `SELECT ${ident("b")} AS ref FROM issue_blocks x JOIN issues b ON b.id = x.blocked_id
       WHERE x.blocker_id = ? AND b.deleted_at IS NULL ORDER BY b.team_key, b.number`,
    )
    .all(id)
    .map((r) => r.ref);
  const docs = db
    .query<DocumentRow, [number]>(
      `${DOC_SELECT} JOIN document_refs r ON r.document_id = d.id WHERE r.issue_id = ? AND d.deleted_at IS NULL ORDER BY d.team_key, d.position, d.id`,
    )
    .all(id)
    .map(toDocSummary);
  return {
    ...toSummary(row),
    description: row.description,
    creator: ref(row, "creator")!,
    children,
    blocks,
    comments: listComments("issue", id),
    docs,
  };
}

/** Bumps issues in SQL and returns their identifiers, for change events. */
function bumpIssues(ids: Iterable<number>, time: string): string[] {
  const bump = db.query<{ ref: string }, [string, string, number]>(`UPDATE issues SET ${BUMPED_AT} WHERE id = ? RETURNING ${ident("issues")} AS ref`);
  return [...ids].map((id) => bump.get(time, time, id)!.ref);
}

export function createIssue(a: Actor, input: IssueInput): Issue {
  const team = teamRow(a, input.team);
  const cols = {
    description: "",
    status: "backlog",
    priority: 0,
    labels: "[]",
    assignee_id: null,
    delegate_id: null,
    parent_id: null,
    ...issueColumns(a, team.workspace, input),
    title: requireText(input.title, "title"),
  };
  const blockers = input.blockedBy === undefined ? [] : blockerIds(a, input.blockedBy, team.workspace);
  const time = now();
  const { identifier, docs, refs } = db.transaction(() => {
    const { number } = db
      .query<{ number: number }, [string]>("UPDATE teams SET next_number = next_number + 1 WHERE key = ? RETURNING next_number - 1 AS number")
      .get(team.key)!;
    const row: Record<string, SQLQueryBindings> = {
      ...cols,
      team_key: team.key,
      number,
      creator_id: a.id,
      created_at: time,
      updated_at: time,
      completed_at: isClosed(cols.status as Status) ? time : null,
    };
    const names = Object.keys(row);
    const { id } = db
      .query<{ id: number }, SQLQueryBindings[]>(`INSERT INTO issues (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) RETURNING id`)
      .get(...Object.values(row))!;
    setBlockers(id, blockers);
    // Its parent and blockers change too (they gain a sub-issue or something they block), as on update and delete.
    const refs = bumpIssues(new Set([cols.parent_id as number | null, ...blockers].filter((r): r is number => r !== null)), time);
    const identifier = `${team.key}-${number}`;
    // Docs in the workspace that mentioned this identifier before the issue existed now link to it.
    const mention = new RegExp(`\\b${identifier}\\b`);
    const docs = db
      .query<{ id: number; slug: string; content: string }, [string, string]>(
        "SELECT d.id, d.slug, d.content FROM documents d JOIN teams t ON t.key = d.team_key WHERE t.workspace = ? AND d.content LIKE ?",
      )
      .all(team.workspace, `%${identifier}%`)
      .filter((doc) => mention.test(doc.content));
    for (const doc of docs) saveRefs(doc.id, doc.content, team.workspace);
    return { identifier, docs, refs };
  })();
  changed("issue", team.workspace, identifier);
  for (const r of refs) changed("issue", team.workspace, r);
  for (const doc of docs) changed("document", team.workspace, doc.slug);
  return getIssue(a, identifier);
}

export function updateIssue(a: Actor, identifier: string, patch: IssuePatch): Issue {
  const { id, workspace } = liveIssue(a, identifier);
  const cols = issueColumns(a, workspace, patch);
  const current = db.query<{ status: Status; parent_id: number | null }, [number]>("SELECT status, parent_id FROM issues WHERE id = ?").get(id)!;
  // A new parent must not be the issue itself or one of its descendants.
  for (let p = cols.parent_id as number | null | undefined; p != null; ) {
    if (p === id) throw new AppError("An issue can't be its own parent or ancestor");
    p = db.query<{ parent_id: number | null }, [number]>("SELECT parent_id FROM issues WHERE id = ?").get(p)!.parent_id;
  }
  const blockers = patch.blockedBy === undefined ? undefined : blockerIds(a, patch.blockedBy, workspace, id);
  const time = now();
  if (cols.status !== undefined) {
    const closing = isClosed(cols.status as Status);
    if (closing !== isClosed(current.status)) cols.completed_at = closing ? time : null;
  }
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
  // IMMEDIATE holds the write lock from the version check to the write, so nothing lands in between.
  const refs = db.transaction(() => {
    if (patch.baseUpdatedAt !== undefined) {
      const { updated_at } = db.query<{ updated_at: string }, [number]>("SELECT updated_at FROM issues WHERE id = ?").get(id)!;
      if (patch.baseUpdatedAt !== updated_at) throw new AppError("Issue changed since you read it", 409);
    }
    const assignments = [...Object.keys(cols).map((c) => `${c} = ?`), BUMPED_AT];
    db.query(`UPDATE issues SET ${assignments.join(", ")} WHERE id = ?`).run(...Object.values(cols), time, time, id);
    if (blockers) setBlockers(id, blockers);
    return bumpIssues(related, time);
  }).immediate();
  const issue = getIssue(a, identifier);
  changed("issue", workspace, issue.id);
  for (const r of refs) changed("issue", workspace, r);
  return issue;
}

/** Issues that gain or lose a relation when `id` enters or leaves the trash: its parent, sub-issues and blockers. */
function relatives(id: number): number[] {
  return db
    .query<{ id: number }, [number, number, number, number]>(
      `SELECT i.id FROM issues i
       WHERE i.parent_id = ? OR i.id = (SELECT parent_id FROM issues WHERE id = ?)
         OR i.id IN (SELECT blocked_id FROM issue_blocks WHERE blocker_id = ?)
         OR i.id IN (SELECT blocker_id FROM issue_blocks WHERE blocked_id = ?)`,
    )
    .all(id, id, id, id)
    .map((r) => r.id);
}

/**
 * Moves an issue to the trash or back (Linear's delete): it leaves lists, search, relations and doc refs,
 * but keeps its links, so restoring puts everything back. Sub-issues stay where they are, pointing at it.
 */
function trashIssue(a: Actor, identifier: string, trash: boolean): Issue {
  const issue = issueRef(a, identifier);
  if (!!issue.deleted_at === trash) throw new AppError(trash ? `${issue.ref} is already in the trash` : `${issue.ref} isn't in the trash`, 409);
  purgeTrash();
  const docs = db
    .query<{ slug: string }, [number]>("SELECT d.slug FROM document_refs r JOIN documents d ON d.id = r.document_id WHERE r.issue_id = ?")
    .all(issue.id);
  const time = now();
  const refs = db.transaction(() => {
    db.query(`UPDATE issues SET deleted_at = ?, ${BUMPED_AT} WHERE id = ?`).run(trash ? time : null, time, time, issue.id);
    return bumpIssues(relatives(issue.id), time);
  })();
  changed("issue", issue.workspace, issue.ref);
  for (const r of refs) changed("issue", issue.workspace, r);
  for (const doc of docs) changed("document", issue.workspace, doc.slug);
  return getIssue(a, identifier);
}

export const deleteIssue = (a: Actor, identifier: string) => trashIssue(a, identifier, true);
export const restoreIssue = (a: Actor, identifier: string) => trashIssue(a, identifier, false);

const TRASH_DAYS = 30;

/** Deletes for good whatever has been in the trash for 30 days (cascading to comments, versions, refs). */
export function purgeTrash() {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.transaction(() => {
    db.query("DELETE FROM issues WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff);
    db.query("DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff);
  })();
}

/** A team's trash, newest first. */
export function listTrash(a: Actor, team: string): Trash {
  const key = teamRow(a, team).key;
  purgeTrash();
  const issues = db
    .query<IssueRow, [string]>(`${ISSUE_SELECT} WHERE i.team_key = ? AND i.deleted_at IS NOT NULL ORDER BY i.deleted_at DESC, i.id DESC`)
    .all(key)
    .map(toSummary);
  const documents = db
    .query<DocumentRow, [string]>(`${DOC_SELECT} WHERE d.team_key = ? AND d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC, d.id DESC`)
    .all(key)
    .map(toDocSummary);
  return { issues, documents };
}

/**
 * Takes an open issue: a person as its assignee, an agent as its delegate. An unstarted one (backlog,
 * todo) moves to in_progress; one already started (in_progress, in_review) keeps its status, as in
 * Linear. Refused (409, naming them) if it's closed or another active member holds that slot. IMMEDIATE
 * takes the write lock before the read, so of two claims racing for a free issue exactly one wins.
 * Claiming your own started issue is a no-op.
 */
export function claimIssue(a: Actor, identifier: string): Issue {
  const { id, workspace } = liveIssue(a, identifier);
  const slot = a.kind === "person" ? "assignee_id" : "delegate_id";
  const time = now();
  const claimed = db.transaction(() => {
    const row = db
      .query<{ status: Status; holder: number | null; username: string | null; active: number; ref: string }, [string, number]>(
        `SELECT i.status, i.${slot} AS holder, u.username, ${ident("i")} AS ref,
           EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = i.${slot} AND m.workspace = ? AND m.suspended_at IS NULL) AS active
         FROM issues i LEFT JOIN users u ON u.id = i.${slot} WHERE i.id = ?`,
      )
      .get(workspace, id)!;
    if (isClosed(row.status)) throw new AppError(`${row.ref} is ${row.status}`, 409);
    if (row.holder !== null && row.holder !== a.id && row.active) {
      throw new AppError(`${row.ref} is claimed by ${row.username}`, 409);
    }
    const started = row.status === "in_progress" || row.status === "in_review";
    if (row.holder === a.id && started) return false;
    db.query(`UPDATE issues SET ${slot} = ?, status = ?, ${BUMPED_AT} WHERE id = ?`).run(a.id, started ? row.status : "in_progress", time, time, id);
    return true;
  }).immediate();
  const issue = getIssue(a, identifier);
  if (claimed) changed("issue", workspace, issue.id);
  return issue;
}

/** Runs a change to an issue's comments, bumping the issue in the same transaction. */
function changeIssueComments(a: Actor, identifier: string, change: (id: number, time: string) => void): Issue {
  const { id, workspace } = liveIssue(a, identifier);
  const time = now();
  db.transaction(() => {
    change(id, time);
    db.query(`UPDATE issues SET ${BUMPED_AT} WHERE id = ?`).run(time, time, id);
  })();
  const issue = getIssue(a, identifier);
  changed("issue", workspace, issue.id);
  return issue;
}

export const addComment = (a: Actor, identifier: string, body: unknown) =>
  changeIssueComments(a, identifier, (id, time) => insertComment(a, "issue", id, body, time));

export const updateIssueComment = (a: Actor, identifier: string, commentId: unknown, body: unknown) =>
  changeIssueComments(a, identifier, (id, time) => updateComment(a, "issue", id, commentId, body, time));

export const deleteIssueComment = (a: Actor, identifier: string, commentId: unknown) =>
  changeIssueComments(a, identifier, (id) => deleteComment(a, "issue", id, commentId));

/** Labels in use in the actor's workspaces (or one), each with how many open issues carry it. */
export function listLabels(a: Actor, filter: { workspace?: string } = {}): LabelCount[] {
  const { where, params } = listScope(a, "i", filter, []);
  return db
    .query<LabelCount, SQLQueryBindings[]>(
      `SELECT l.value AS label, SUM(i.status NOT IN (${inList(CLOSED_STATUSES)})) AS open
       FROM issues i, json_each(i.labels) l ${whereClause(where)}
       GROUP BY l.value ORDER BY l.value COLLATE NOCASE`,
    )
    .all(...CLOSED_STATUSES, ...params);
}

// --- Documents ---

type DocumentRow = Record<string, unknown> & {
  id: number;
  slug: string;
  team_key: string;
  workspace: string;
  title: string;
  content: string;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

const DOC_COLUMNS = `d.id, d.slug, d.team_key, t.workspace, d.title, d.position, d.created_at, d.updated_at, d.deleted_at, ${userCols("u", "by")}`;
const DOC_FROM = "FROM documents d JOIN teams t ON t.key = d.team_key JOIN users u ON u.id = d.updated_by_id";
const DOC_SELECT = `SELECT ${DOC_COLUMNS} ${DOC_FROM}`; // lists leave out the content

// Saves by the same author within this window of a version's first save update that version (autosave-friendly).
const VERSION_WINDOW_MS = 10 * 60 * 1000;

const toDocSummary = (row: DocumentRow): DocumentSummary => ({
  slug: row.slug,
  team: row.team_key,
  title: row.title,
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  updatedBy: ref(row, "by")!,
  deletedAt: row.deleted_at,
});

/** A doc that isn't in the trash: a trashed one can be read and restored, nothing else. */
function liveDocument(a: Actor, slug: unknown): DocumentRow {
  const row = documentRow(a, slug);
  if (row.deleted_at) throw new AppError(`Document ${row.slug} is in the trash; restore it first`, 409);
  return row;
}

function documentRow(a: Actor, slug: unknown): DocumentRow {
  const row =
    typeof slug === "string"
      ? db
          .query<DocumentRow, [string]>(`SELECT d.content, ${DOC_COLUMNS} ${DOC_FROM} WHERE d.slug = ?`)
          .get(slug.trim().toLowerCase())
      : null;
  if (!row || !a.workspaces.has(row.workspace)) throw new AppError(`Document ${slug} not found`, 404);
  return row;
}

function checkContent(value: unknown): string {
  if (typeof value !== "string") throw new AppError("content must be a string");
  return capLength(value, "content");
}

function checkPosition(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new AppError("position must be a number");
  return value;
}

const nextPosition = (team: string) =>
  db.query<{ n: number }, [string]>("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM documents WHERE team_key = ?").get(team)!.n;

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
function saveVersion(documentId: number, title: string, content: string, authorId: number, time: string, checkpoint = false) {
  const last = db
    .query<{ id: number; author_id: number; created_at: string; first: number }, [number]>(
      `SELECT id, author_id, created_at, id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id) AS first
       FROM document_versions v WHERE document_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(documentId);
  const merge =
    last && !checkpoint && !last.first && last.author_id === authorId && Date.parse(time) - Date.parse(last.created_at) < VERSION_WINDOW_MS;
  if (merge) {
    // created_at stays put, so the window is anchored to the version's start and can't slide forever.
    db.query("UPDATE document_versions SET title = ?, content = ? WHERE id = ?").run(title, content, last.id);
  } else {
    db.query("INSERT INTO document_versions (document_id, title, content, author_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
      documentId,
      title,
      content,
      authorId,
      time,
    );
  }
}

/** Rebuilds the issues a document mentions: identifiers of real issues in its workspace, first-mention order. */
function saveRefs(documentId: number, content: string, workspace: string) {
  db.query("DELETE FROM document_refs WHERE document_id = ?").run(documentId);
  const find = db.query<{ id: number }, [string, number, string]>(
    "SELECT i.id FROM issues i JOIN teams t ON t.key = i.team_key WHERE i.team_key = ? AND i.number = ? AND t.workspace = ?",
  );
  const ids = new Set<number>();
  for (const [, key, number] of content.matchAll(/\b([A-Z]{2,5})-(\d+)\b/g)) {
    const row = find.get(key!, Number(number), workspace);
    if (row) ids.add(row.id);
  }
  [...ids].forEach((issueId, ord) => {
    db.query("INSERT INTO document_refs (document_id, issue_id, ord) VALUES (?, ?, ?)").run(documentId, issueId, ord);
  });
}

export function listDocuments(a: Actor, filter: DocumentFilter): DocumentSummary[] {
  const { where, params } = listScope(a, "d", filter, ["d.title", "d.content"]);
  return db
    .query<DocumentRow, SQLQueryBindings[]>(`${DOC_SELECT} ${whereClause(where)} ORDER BY d.team_key, d.position, d.id`)
    .all(...params)
    .map(toDocSummary);
}

export function getDocument(a: Actor, slug: string): Document {
  const row = documentRow(a, slug);
  const issues = db
    .query<IssueRow, [number]>(`${ISSUE_SELECT} JOIN document_refs r ON r.issue_id = i.id WHERE r.document_id = ? AND ${LIVE} ORDER BY r.ord`)
    .all(row.id)
    .map(toSummary);
  const { n: versionCount } = db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ?").get(row.id)!;
  return { ...toDocSummary(row), content: row.content, issues, comments: listComments("document", row.id), versionCount };
}

export function createDocument(a: Actor, input: DocumentInput): Document {
  const team = teamRow(a, input.team);
  const title = requireText(input.title, "title");
  const content = input.content === undefined ? "" : checkContent(input.content);
  const position = input.position === undefined ? undefined : checkPosition(input.position);
  const time = now();
  const slug = db.transaction(() => {
    const slug = pickSlug(input.slug, title, (s) => exists("documents", "slug", s), { label: "slug", fallback: "doc" });
    const { id } = db
      .query<{ id: number }, SQLQueryBindings[]>(
        `INSERT INTO documents (slug, team_key, title, content, position, created_at, updated_at, updated_by_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(slug, team.key, title, content, position ?? nextPosition(team.key), time, time, a.id)!;
    saveVersion(id, title, content, a.id, time);
    saveRefs(id, content, team.workspace);
    return slug;
  })();
  changed("document", team.workspace, slug);
  return getDocument(a, slug);
}

export function updateDocument(a: Actor, slug: string, patch: DocumentPatch): Document {
  const row = liveDocument(a, slug);
  if (patch.baseUpdatedAt !== undefined && patch.baseUpdatedAt !== row.updated_at) {
    throw new AppError("Document changed since you started editing", 409);
  }
  if (patch.content !== undefined && patch.edits !== undefined) {
    throw new AppError("Pass either content (full replacement) or edits, not both");
  }
  const cols: Record<string, SQLQueryBindings> = {};
  if (patch.title !== undefined) cols.title = requireText(patch.title, "title");
  if (patch.content !== undefined) cols.content = checkContent(patch.content);
  if (patch.edits !== undefined) cols.content = capLength(applyEdits(row.content, patch.edits), "content");
  if (patch.team !== undefined) {
    const team = teamRow(a, patch.team);
    if (team.workspace !== row.workspace) throw new AppError("A doc can only move to a team in the same workspace");
    cols.team_key = team.key;
    if (team.key !== row.team_key && patch.position === undefined) cols.position = nextPosition(team.key);
  }
  if (patch.position !== undefined) cols.position = checkPosition(patch.position);
  for (const [name, value] of Object.entries(cols)) if (row[name] === value) delete cols[name];
  if (Object.keys(cols).length === 0) return getDocument(a, row.slug);

  const time = bumpedAt(row.updated_at);
  const title = (cols.title as string | undefined) ?? row.title;
  const content = (cols.content as string | undefined) ?? row.content;
  db.transaction(() => {
    const next: Record<string, SQLQueryBindings> = { ...cols, updated_at: time, updated_by_id: a.id };
    db.query(`UPDATE documents SET ${Object.keys(next).map((n) => `${n} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(next), row.id);
    if (cols.title !== undefined || cols.content !== undefined) saveVersion(row.id, title, content, a.id, time, patch.checkpoint === true);
    if (cols.content !== undefined) saveRefs(row.id, content, row.workspace);
  })();
  changed("document", row.workspace, row.slug);
  return getDocument(a, row.slug);
}

/** Moves a doc to the trash or back; its versions, comments and refs stay until it's purged. */
function trashDocument(a: Actor, slug: string, trash: boolean): Document {
  const row = documentRow(a, slug);
  if (!!row.deleted_at === trash) throw new AppError(trash ? `Document ${row.slug} is already in the trash` : `Document ${row.slug} isn't in the trash`, 409);
  purgeTrash();
  db.query("UPDATE documents SET deleted_at = ? WHERE id = ?").run(trash ? now() : null, row.id);
  changed("document", row.workspace, row.slug);
  return getDocument(a, row.slug);
}

export const deleteDocument = (a: Actor, slug: string) => trashDocument(a, slug, true);
export const restoreDocument = (a: Actor, slug: string) => trashDocument(a, slug, false);

/** Runs a change to a doc's comments. It leaves the doc's updated_at alone, so an open editor sees no conflict. */
function changeDocumentComments(a: Actor, slug: string, change: (id: number) => void): Document {
  const row = liveDocument(a, slug);
  change(row.id);
  changed("document", row.workspace, row.slug);
  return getDocument(a, row.slug);
}

export const addDocumentComment = (a: Actor, slug: string, body: unknown) =>
  changeDocumentComments(a, slug, (id) => insertComment(a, "document", id, body, now()));

export const updateDocumentComment = (a: Actor, slug: string, commentId: unknown, body: unknown) =>
  changeDocumentComments(a, slug, (id) => updateComment(a, "document", id, commentId, body, now()));

export const deleteDocumentComment = (a: Actor, slug: string, commentId: unknown) =>
  changeDocumentComments(a, slug, (id) => deleteComment(a, "document", id, commentId));

const VERSION_FROM = "FROM document_versions v JOIN users u ON u.id = v.author_id";

export function listDocumentVersions(a: Actor, slug: string): DocumentVersionSummary[] {
  return db
    .query<Record<string, unknown>, [number]>(
      `SELECT v.id, v.title, v.created_at, ${userCols("u", "a")} ${VERSION_FROM} WHERE v.document_id = ? ORDER BY v.id DESC`,
    )
    .all(documentRow(a, slug).id)
    .map((r) => ({ id: r.id as number, author: ref(r, "a")!, title: r.title as string, createdAt: r.created_at as string }));
}

export function getDocumentVersion(a: Actor, slug: string, id: unknown): DocumentVersion {
  const r = db
    .query<Record<string, unknown>, [number, number]>(
      `SELECT v.id, v.title, v.content, v.created_at, ${userCols("u", "a")} ${VERSION_FROM} WHERE v.document_id = ? AND v.id = ?`,
    )
    .get(documentRow(a, slug).id, Number(id));
  if (!r) throw new AppError(`Version ${id} of ${slug} not found`, 404);
  return { id: r.id as number, author: ref(r, "a")!, title: r.title as string, content: r.content as string, createdAt: r.created_at as string };
}

// Anything that expired while the server was down goes now; later deletes and trash views purge as they go.
purgeTrash();

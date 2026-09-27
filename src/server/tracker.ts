// Teams, issues, comments, labels and documents. Every function acts for an Actor in the request's one
// workspace (requestWorkspace): team keys, identifiers and slugs resolve there, and anything elsewhere is
// 404, as if it didn't exist.
import type { SQLQueryBindings } from "bun:sqlite";
import {
  CLOSED_STATUSES,
  DUE_FILTERS,
  ISSUE_SORTS,
  PRIORITIES,
  STATUSES,
  type Activity,
  type ActivityKind,
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
  type WebhookAction,
} from "../shared/types.ts";
import { type Actor, activeMemberId, requestWorkspace, requirePerson } from "./access.ts";
import {
  AppError,
  BUMPED_AT,
  bumpedAt,
  capLength,
  changed,
  checkOneOf,
  db,
  mentionedIn,
  now,
  optionalText,
  pickSlug,
  requireText,
} from "./db.ts";
import * as inbox from "./inbox.ts";
import { enqueue } from "./webhooks.ts";

const checkStatus = (value: unknown) => checkOneOf(value, STATUSES, "status");
const checkPriority = (value: unknown) => checkOneOf(value as Priority, PRIORITIES, "priority (0 none, 1 urgent, 2 high, 3 medium, 4 low)");

/** A calendar date, "YYYY-MM-DD", that exists (no 2026-02-30). */
function checkDueOn(value: unknown): string {
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time) || !new Date(time).toISOString().startsWith(date)) throw new AppError("dueOn must be a date like 2026-09-30");
  return date;
}

function checkLabels(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((l) => typeof l === "string")) {
    throw new AppError("labels must be an array of strings");
  }
  return [...new Set(value.map((l) => l.trim()).filter(Boolean))];
}

/** Placeholders for `IN (…)`; never empty, so the SQL stays valid. */
const inList = (values: unknown[]) => (values.length ? values.map(() => "?").join(", ") : "NULL");

/** A UserRef from joined columns `${p}_username`, `${p}_name`, `${p}_kind`, or null. */
function ref(row: Record<string, unknown>, p: string): UserRef | null {
  const username = row[`${p}_username`] as string | null;
  return username ? { username, name: row[`${p}_name`] as string, kind: row[`${p}_kind`] as UserKind } : null;
}
/**
 * Joins the user `id` (a column) as `alias`: their account, and their membership in `workspace` (an SQL
 * expression, e.g. the row's team's), which holds how they're known there. Read it with `userCols`.
 */
const userJoin = (alias: string, id: string, workspace: string) =>
  `LEFT JOIN users ${alias} ON ${alias}.id = ${id}
   LEFT JOIN workspace_members ${alias}_m ON ${alias}_m.user_id = ${id} AND ${alias}_m.workspace = ${workspace}`;
const userCols = (alias: string, p: string) =>
  `${alias}_m.username AS ${p}_username, ${alias}_m.name AS ${p}_name, ${alias}.kind AS ${p}_kind`;

// --- Mentions ---

/**
 * Rebuilds who a text mentions: active members of its workspace named as @username (see `mentionedIn`). Call it
 * in the transaction that saves the text. `source` names the text ('issue:<id>' for a description, 'comment:<id>',
 * 'document:<id>', 'document_comment:<id>'); `owner` is the issue or doc it's in or on. Mentions the text still has
 * stay as they were; new ones are recorded by the actor at `time` (never the actor themselves), subscribed to the
 * owner, notified (with `commentId` when the text is a comment) and returned. `typing`: see `mentionedIn`.
 */
function saveMentions(
  a: Actor,
  workspace: string,
  source: string,
  owner: inbox.Target,
  text: string,
  time: string,
  { typing = false, commentId }: { typing?: boolean; commentId?: number } = {},
): number[] {
  const ids = mentionedIn(workspace, text, typing);
  const had = db.query<{ user_id: number }, [string]>("SELECT user_id FROM mentions WHERE source = ?").all(source).map((r) => r.user_id);
  for (const id of had) if (!ids.has(id)) db.query("DELETE FROM mentions WHERE source = ? AND user_id = ?").run(source, id);
  const fresh = [...ids].filter((id) => !had.includes(id) && id !== a.id);
  const insert = db.query("INSERT INTO mentions (source, user_id, issue_id, document_id, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const [issueId, documentId] = "issueId" in owner ? [owner.issueId, null] : [null, owner.documentId];
  for (const id of fresh) insert.run(source, id, issueId, documentId, a.id, time);
  inbox.mentioned(fresh, { actorId: a.id, workspace, target: owner, commentId }, time);
  return fresh;
}

// --- Comments ---

// Issue and doc comments live in parallel tables; each helper serves both. `source`: how mentions name a comment.
const COMMENTS = {
  issue: { table: "comments", column: "issue_id", source: "comment" },
  document: { table: "document_comments", column: "document_id", source: "document_comment" },
} as const;

type CommentOwner = keyof typeof COMMENTS;

const commentSelect = (owner: CommentOwner) =>
  `SELECT c.id, c.body, c.created_at, c.edited_at, ${userCols("u", "a")} FROM ${COMMENTS[owner].table} c ${userJoin("u", "c.author_id", "?")}`;

const toComment = (r: Record<string, unknown>): Comment => ({
  id: r.id as number,
  author: ref(r, "a")!,
  body: r.body as string,
  createdAt: r.created_at as string,
  editedAt: r.edited_at as string | null,
});

/** An issue's or doc's comments; authors as they're known in `workspace`, the owner's. */
function listComments(owner: CommentOwner, ownerId: number, workspace: string): Comment[] {
  return db
    .query<Record<string, unknown>, [string, number]>(`${commentSelect(owner)} WHERE c.${COMMENTS[owner].column} = ? ORDER BY c.id`)
    .all(workspace, ownerId)
    .map(toComment);
}

/** An issue's identifier or a doc's slug, by row id. */
const ownerRef = (owner: CommentOwner, id: number) =>
  db
    .query<{ ref: string }, [number]>(
      owner === "issue" ? `SELECT ${ident("t", "i")} AS ref FROM issues i JOIN teams t ON t.id = i.team_id WHERE i.id = ?` : "SELECT slug AS ref FROM documents WHERE id = ?",
    )
    .get(id)!.ref;

/** Queues a comment's webhook event (see webhooks.ts); call it while the comment is still there. */
function commentEvent(
  a: Actor,
  owner: CommentOwner,
  ownerId: number,
  workspace: string,
  id: number,
  action: WebhookAction,
  time: string,
  updatedFrom?: Record<string, unknown>,
) {
  const on = ownerRef(owner, ownerId);
  const comment = toComment(db.query<Record<string, unknown>, [string, number]>(`${commentSelect(owner)} WHERE c.id = ?`).get(workspace, id)!);
  const data = { ...comment, issue: owner === "issue" ? on : null, document: owner === "document" ? on : null };
  enqueue({ workspace, type: "Comment", action, entity: String(id), actorId: a.id, time, data: () => data, updatedFrom });
}

const targetOf = (owner: CommentOwner, ownerId: number): inbox.Target => (owner === "issue" ? { issueId: ownerId } : { documentId: ownerId });

/** Rebuilds a comment's mentions (see saveMentions). */
const commentMentions = (a: Actor, owner: CommentOwner, ownerId: number, workspace: string, id: number, body: string, time: string) =>
  saveMentions(a, workspace, `${COMMENTS[owner].source}:${id}`, targetOf(owner, ownerId), body, time, { commentId: id });

/** Adds a comment: its author follows the issue or doc, and its other subscribers hear of it (unless it mentions them). */
function insertComment(a: Actor, owner: CommentOwner, ownerId: number, workspace: string, body: unknown, time: string): number {
  const { table, column } = COMMENTS[owner];
  const text = requireText(body, "body");
  const id = Number(db.query(`INSERT INTO ${table} (${column}, author_id, body, created_at) VALUES (?, ?, ?, ?)`).run(ownerId, a.id, text, time).lastInsertRowid);
  commentEvent(a, owner, ownerId, workspace, id, "create", time); // before the notifications it causes
  const mentioned = commentMentions(a, owner, ownerId, workspace, id, text, time);
  const target = targetOf(owner, ownerId);
  inbox.subscribe(a.id, target, time);
  const others = inbox.subscribers(target).filter((u) => !mentioned.includes(u));
  inbox.notify(others, { kind: "commented", actorId: a.id, workspace, target, commentId: id }, time);
  return id;
}

/** The id of a comment on this owner (in `workspace`) that the actor wrote; others' comments are 403. */
function ownComment(a: Actor, owner: CommentOwner, ownerId: number, workspace: string, commentId: unknown): number {
  const { table, column } = COMMENTS[owner];
  const id = Number(commentId);
  const row = Number.isInteger(id)
    ? db
        .query<{ author_id: number; username: string | null }, [string, number, number]>(
          `SELECT c.author_id, m.username FROM ${table} c
           LEFT JOIN workspace_members m ON m.user_id = c.author_id AND m.workspace = ? WHERE c.id = ? AND c.${column} = ?`,
        )
        .get(workspace, id, ownerId)
    : null;
  if (!row) throw new AppError(`Comment ${commentId} not found`, 404);
  if (row.author_id !== a.id) throw new AppError(`Only @${row.username} can change this comment`, 403);
  return id;
}

function updateComment(a: Actor, owner: CommentOwner, ownerId: number, workspace: string, commentId: unknown, body: unknown, time: string) {
  const id = ownComment(a, owner, ownerId, workspace, commentId);
  const text = requireText(body, "body");
  const { table } = COMMENTS[owner];
  const before = db.query<{ body: string; edited_at: string | null }, [number]>(`SELECT body, edited_at FROM ${table} WHERE id = ?`).get(id)!;
  db.query(`UPDATE ${table} SET body = ?, edited_at = ? WHERE id = ?`).run(text, time, id);
  commentMentions(a, owner, ownerId, workspace, id, text, time);
  if (text !== before.body) commentEvent(a, owner, ownerId, workspace, id, "update", time, { body: before.body, editedAt: before.edited_at });
}

function deleteComment(a: Actor, owner: CommentOwner, ownerId: number, workspace: string, commentId: unknown, time: string) {
  const id = ownComment(a, owner, ownerId, workspace, commentId);
  commentEvent(a, owner, ownerId, workspace, id, "remove", time);
  db.query(`DELETE FROM ${COMMENTS[owner].table} WHERE id = ?`).run(id);
  db.query("DELETE FROM mentions WHERE source = ?").run(`${COMMENTS[owner].source}:${id}`);
  inbox.commentDeleted(targetOf(owner, ownerId), id);
}

// --- Teams ---

interface TeamRow {
  id: number; // internal: issues and docs point to it; the API names teams by key
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
      SELECT status, COUNT(*) AS n FROM issues WHERE team_id = t.id AND deleted_at IS NULL GROUP BY status
    )) AS counts,
    (SELECT COUNT(*) FROM documents WHERE team_id = t.id AND deleted_at IS NULL) AS doc_count
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

/** A team of the request's workspace, by key. */
function teamRow(a: Actor, key: unknown): TeamRow {
  const workspace = requestWorkspace(a);
  const row =
    typeof key === "string"
      ? db.query<TeamRow, [string, string]>(`${TEAM_SELECT} WHERE t.workspace = ? AND t.key = ?`).get(workspace, key.trim().toUpperCase())
      : null;
  if (!row) throw new AppError(`Team ${key} not found`, 404);
  return row;
}

export function listTeams(a: Actor): Team[] {
  return db.query<TeamRow, [string]>(`${TEAM_SELECT} WHERE t.workspace = ? ORDER BY t.key`).all(requestWorkspace(a)).map(toTeam);
}

const NO_AGENT_TEAMS = "Agents can't create or change teams; ask a person";

export function createTeam(a: Actor, input: TeamInput): Team {
  requirePerson(a, NO_AGENT_TEAMS);
  const key = typeof input.key === "string" ? input.key.trim().toUpperCase() : "";
  if (!/^[A-Z]{2,5}$/.test(key)) throw new AppError("Team key must be 2–5 letters, e.g. BRD");
  const workspace = requestWorkspace(a);
  // Old scripts still send it: fine, as long as it's where the request acts.
  if (input.workspace !== undefined && String(input.workspace).trim().toLowerCase() !== workspace) {
    throw new AppError("Teams are created in the workspace you're in");
  }
  const name = requireText(input.name, "name");
  const description = optionalText(input.description, "description");
  if (db.query("SELECT 1 FROM teams WHERE workspace = ? AND key = ?").get(workspace, key)) {
    throw new AppError(`Team key ${key} is taken in this workspace`, 409);
  }
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
  requirePerson(a, NO_AGENT_TEAMS);
  const row = teamRow(a, key);
  if (patch.workspace !== undefined && patch.workspace !== row.workspace) throw new AppError("Teams can't move between workspaces");
  const name = patch.name === undefined ? row.name : requireText(patch.name, "name");
  const description = patch.description === undefined ? row.description : optionalText(patch.description, "description");
  db.query("UPDATE teams SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(name, description, now(), row.id);
  changed("team", row.workspace, row.key);
  return toTeam(teamRow(a, row.key));
}

// --- Issues ---

type IssueRow = Record<string, unknown> & {
  id: number;
  team_id: number;
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
  related_to: string; // JSON array of identifiers
  duplicate_of: string | null; // identifier
  due_on: string | null; // "YYYY-MM-DD"
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
};

/** An issue's identifier in SQL, from its team's alias and its own: BRD-12. */
const ident = (team: string, issue: string) => `${team}.key || '-' || ${issue}.number`;

const ISSUE_SELECT = `
  SELECT i.*, t.key AS team_key, t.workspace, ${ident("pt", "p")} AS parent,
    ${userCols("ua", "assignee")}, ${userCols("ud", "delegate")}, ${userCols("uc", "creator")},
    (SELECT json_group_array(ref) FROM (
      SELECT ${ident("bt", "b")} AS ref FROM issue_blocks x JOIN issues b ON b.id = x.blocker_id JOIN teams bt ON bt.id = b.team_id
      WHERE x.blocked_id = i.id AND b.deleted_at IS NULL ORDER BY bt.key, b.number
    )) AS blocked_by,
    (SELECT json_group_array(ref) FROM (
      SELECT ${ident("rt", "r")} AS ref FROM issue_relations x
      JOIN issues r ON r.id = CASE WHEN x.from_id = i.id THEN x.to_id ELSE x.from_id END JOIN teams rt ON rt.id = r.team_id
      WHERE x.kind = 'related' AND (x.from_id = i.id OR x.to_id = i.id) AND r.deleted_at IS NULL ORDER BY rt.key, r.number
    )) AS related_to,
    (SELECT ${ident("dt", "d")} FROM issue_relations x JOIN issues d ON d.id = x.to_id JOIN teams dt ON dt.id = d.team_id
      WHERE x.kind = 'duplicate' AND x.from_id = i.id AND d.deleted_at IS NULL) AS duplicate_of
  FROM issues i
  JOIN teams t ON t.id = i.team_id
  ${userJoin("uc", "i.creator_id", "t.workspace")}
  ${userJoin("ua", "i.assignee_id", "t.workspace")}
  ${userJoin("ud", "i.delegate_id", "t.workspace")}
  LEFT JOIN issues p ON p.id = i.parent_id
  LEFT JOIN teams pt ON pt.id = p.team_id`;

// Status order, then priority 1→4 with 0 (none) last, then most recently updated. The first two keys are
// also what a page cursor records (with updated_at and id), so pages resume exactly where they stopped.
const STATUS_RANK = `CASE i.status ${STATUSES.map((s, n) => `WHEN '${s}' THEN ${n}`).join(" ")} END`;
const PRIORITY_RANK = "CASE i.priority WHEN 0 THEN 5 ELSE i.priority END";
const DEFAULT_ORDER = `${STATUS_RANK}, ${PRIORITY_RANK}, i.updated_at DESC, i.id DESC`;
const ISSUE_ORDER = `ORDER BY ${DEFAULT_ORDER}`;
// sort=due: earliest due date first, issues without one last, then the default order.
const DUE_ORDER = `ORDER BY i.due_on IS NULL, i.due_on, ${DEFAULT_ORDER}`;
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
  relatedTo: JSON.parse(row.related_to),
  duplicateOf: row.duplicate_of,
  dueOn: row.due_on,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  deletedAt: row.deleted_at,
});

/**
 * Resolves an identifier like "brd-12" in the request's workspace to the issue's row id; 404 if it isn't there.
 * Trashed issues resolve too (to read or restore them); `liveIssue` is for everything that changes one.
 */
function issueRef(a: Actor, identifier: unknown): { id: number; workspace: string; deleted_at: string | null; ref: string } {
  const match = typeof identifier === "string" ? /^([a-z]{2,5})-(\d+)$/i.exec(identifier.trim()) : null;
  if (!match) throw new AppError(`Invalid issue identifier "${identifier}" (expected e.g. BRD-12)`);
  const key = match[1]!.toUpperCase();
  const number = Number(match[2]);
  const row = db
    .query<{ id: number; workspace: string; deleted_at: string | null }, [string, string, number]>(
      "SELECT i.id, t.workspace, i.deleted_at FROM issues i JOIN teams t ON t.id = i.team_id WHERE t.workspace = ? AND t.key = ? AND i.number = ?",
    )
    .get(requestWorkspace(a), key, number);
  if (!row) throw new AppError(`Issue ${key}-${number} not found`, 404);
  return { ...row, ref: `${key}-${number}` };
}

/** An issue that isn't in the trash: a trashed one can be read and restored, nothing else. */
function liveIssue(a: Actor, identifier: unknown) {
  const issue = issueRef(a, identifier);
  if (issue.deleted_at) throw new AppError(`${issue.ref} is in the trash; restore it first`, 409);
  return issue;
}

/** A live issue to relate to. It resolves in the request's workspace, so relations never cross workspaces. */
function relatedId(a: Actor, identifier: unknown, field: string): number {
  const other = issueRef(a, identifier);
  if (other.deleted_at) throw new AppError(`${field}: ${other.ref} is in the trash`);
  return other.id;
}

function blockerIds(a: Actor, identifiers: unknown, self?: number): number[] {
  if (!Array.isArray(identifiers)) throw new AppError("blockedBy must be an array of issue identifiers");
  const ids = [...new Set(identifiers.map((i) => relatedId(a, i, "blockedBy")))];
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
       SELECT ${ident("t", "i")} AS ref FROM issues i JOIN teams t ON t.id = i.team_id JOIN downstream d ON d.id = i.id
       WHERE i.id IN (${ids.join(", ")})`,
    )
    .get(self);
  if (cycle) throw new AppError(`${cycle.ref} is already blocked by this issue (directly or indirectly); that would be a cycle`);
  return ids;
}

/** Replaces an issue's blockers. Links to trashed blockers are hidden, not edited, so they stay for their restore. */
function setBlockers(id: number, blockers: number[]) {
  db.query("DELETE FROM issue_blocks WHERE blocked_id = ? AND blocker_id IN (SELECT id FROM issues WHERE deleted_at IS NULL)").run(id);
  for (const blocker of blockers) db.query("INSERT OR IGNORE INTO issue_blocks (blocker_id, blocked_id) VALUES (?, ?)").run(blocker, id);
}

/** Issues to relate to: live, in the request's workspace, never the issue itself. */
function relatedIds(a: Actor, identifiers: unknown, self?: number): number[] {
  if (!Array.isArray(identifiers)) throw new AppError("relatedTo must be an array of issue identifiers");
  const ids = [...new Set(identifiers.map((i) => relatedId(a, i, "relatedTo")))];
  if (self !== undefined && ids.includes(self)) throw new AppError("An issue can't be related to itself");
  return ids;
}

const duplicateOfId = (id: number) =>
  db.query<{ to_id: number }, [number]>("SELECT to_id FROM issue_relations WHERE kind = 'duplicate' AND from_id = ?").get(id)?.to_id ?? null;

/** The issue a duplicate points to (null clears it): never itself, directly or through a chain of duplicates. */
function duplicateId(a: Actor, identifier: unknown, self?: number): number | null {
  if (identifier === null) return null;
  const id = relatedId(a, identifier, "duplicateOf");
  if (id === self) throw new AppError("An issue can't be a duplicate of itself");
  for (let d = duplicateOfId(id); self !== undefined && d !== null; d = duplicateOfId(d)) {
    if (d === self) throw new AppError(`${String(identifier).trim().toUpperCase()} is already a duplicate of this issue (directly or indirectly); that would be a cycle`);
  }
  return id;
}

/** An issue's live related issues, either direction. */
const relatedOf = (id: number) =>
  db
    .query<{ id: number }, [number]>(
      `SELECT r.id FROM issue_relations x JOIN issues r ON r.id = CASE WHEN x.from_id = ?1 THEN x.to_id ELSE x.from_id END
       WHERE x.kind = 'related' AND (x.from_id = ?1 OR x.to_id = ?1) AND r.deleted_at IS NULL`,
    )
    .all(id)
    .map((r) => r.id);

/**
 * Replaces an issue's related issues, on both sides: a pair is one row, (lower id, higher id). Links to trashed
 * issues are hidden, not edited, as with blockers. Returns the issues that gained or lost the relation.
 */
function setRelated(id: number, related: number[], time: string): number[] {
  const was = relatedOf(id);
  const pair = (other: number) => [Math.min(id, other), Math.max(id, other)] as const;
  for (const other of was) {
    if (!related.includes(other)) db.query("DELETE FROM issue_relations WHERE from_id = ? AND to_id = ? AND kind = 'related'").run(...pair(other));
  }
  for (const other of related) {
    if (!was.includes(other)) db.query("INSERT OR IGNORE INTO issue_relations (from_id, to_id, kind, created_at) VALUES (?, ?, 'related', ?)").run(...pair(other), time);
  }
  return [...was, ...related].filter((other) => was.includes(other) !== related.includes(other));
}

/** Points a duplicate at its canonical issue, or clears it. Returns the canonical issues before and after, if it changed. */
function setDuplicate(id: number, canonical: number | null, time: string): number[] {
  const was = duplicateOfId(id);
  if (was === canonical) return [];
  db.query("DELETE FROM issue_relations WHERE kind = 'duplicate' AND from_id = ?").run(id);
  if (canonical !== null) db.query("INSERT INTO issue_relations (from_id, to_id, kind, created_at) VALUES (?, ?, 'duplicate', ?)").run(id, canonical, time);
  return [was, canonical].filter((c) => c !== null);
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
  if (patch.parent !== undefined) cols.parent_id = patch.parent === null ? null : relatedId(a, patch.parent, "parent");
  if (patch.dueOn !== undefined) cols.due_on = patch.dueOn === null ? null : checkDueOn(patch.dueOn);
  return cols;
}

const isClosed = (status: Status) => CLOSED_STATUSES.includes(status);

/**
 * WHERE conditions shared by the issue and doc lists (both join their team as `t`): the request's workspace,
 * a team, and a substring search over `searched` (the query's own %, _ and \ match literally).
 */
function listScope(a: Actor, alias: string, filter: { team?: string; q?: string }, searched: string[]) {
  const workspace = requestWorkspace(a);
  const where = ["t.workspace = ?", `${alias}.deleted_at IS NULL`];
  const params: SQLQueryBindings[] = [workspace];
  if (filter.team) {
    const team = db
      .query<{ id: number }, [string, string]>("SELECT id FROM teams WHERE workspace = ? AND key = ?")
      .get(workspace, filter.team.trim().toUpperCase());
    if (!team) throw new AppError(`Unknown team "${filter.team}"`);
    where.push(`${alias}.team_id = ?`);
    params.push(team.id);
  }
  if (filter.q) {
    where.push(`(${searched.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    params.push(...searched.map(() => `%${filter.q!.trim().replace(/[\\%_]/g, "\\$&")}%`));
  }
  return { where, params, workspace };
}

/** `listScope` always adds the workspace condition, so there's always a WHERE. */
const whereClause = (where: string[]) => `WHERE ${where.join(" AND ")}`;

/**
 * A username filter on `column` ("me" is the actor): whoever holds that username in the workspace. It must
 * name someone who is or was there; anyone else is 400 (a typo shouldn't look like "no issues").
 */
function userFilter(a: Actor, value: string, workspace: string, field: string, column: string): [string, SQLQueryBindings] {
  const username = value.trim().toLowerCase();
  if (username === "me") return [`${column} = ?`, a.id];
  const known = db.query("SELECT 1 FROM workspace_members WHERE username = ? AND workspace = ?").get(username, workspace);
  if (!known) throw new AppError(`Unknown ${field} "${value}"`);
  return [`EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = ${column} AND m.workspace = t.workspace AND m.username = ?)`, username];
}

/**
 * Page cursors: the last row's sort keys (status rank, priority rank, updated_at, id, due_on), opaque to clients.
 * They carry every order's keys, so a cursor resumes in either order.
 */
type Cursor = [number, number, string, number, string | null];
const cursorOf = (issue: IssueSummary, id: number) =>
  Buffer.from(JSON.stringify([STATUSES.indexOf(issue.status), issue.priority || 5, issue.updatedAt, id, issue.dueOn])).toString("base64url");

function parseCursor(cursor: string): Cursor {
  try {
    const keys = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      Array.isArray(keys) &&
      keys.length === 5 &&
      typeof keys[2] === "string" &&
      [0, 1, 3].every((i) => Number.isInteger(keys[i])) &&
      (keys[4] === null || typeof keys[4] === "string")
    ) {
      return keys as Cursor;
    }
  } catch {}
  throw new AppError("Invalid cursor: pass an endCursor from a previous page");
}

export function listIssues(a: Actor, filter: IssueFilter): IssueSummary[] {
  return queryIssues(a, filter).map(toSummary);
}

/**
 * One page of issues, Linear-style: `first` (1–500) from after the `after` cursor, in list order. Keyset
 * paging: the cursor holds the last row's sort keys, so pages don't shift when earlier rows change.
 */
export function listIssuesPage(a: Actor, filter: IssueFilter, page: { first?: unknown; after?: unknown }): IssuePage {
  const first = page.first === undefined ? 50 : Number(page.first);
  if (!Number.isInteger(first) || first < 1 || first > 500) throw new AppError("first must be a whole number from 1 to 500");
  const after = page.after === undefined || page.after === "" ? undefined : parseCursor(String(page.after));
  const rows = queryIssues(a, filter, after, first + 1);
  const hasNextPage = rows.length > first;
  const issues = rows.slice(0, first);
  const last = issues.at(-1);
  return { issues: issues.map(toSummary), pageInfo: { hasNextPage, endCursor: last ? cursorOf(toSummary(last), last.id) : null } };
}

// Linear's due-date filters, by the server's date (SQLite's date('now'), UTC). Finished work is never overdue.
const DUE_WHERE: Record<(typeof DUE_FILTERS)[number], string> = {
  overdue: `i.due_on < date('now') AND i.status NOT IN (${CLOSED_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  soon: "i.due_on BETWEEN date('now') AND date('now', '+7 days')",
  today: "i.due_on = date('now')",
  any: "i.due_on IS NOT NULL",
  none: "i.due_on IS NULL",
};

function queryIssues(a: Actor, filter: IssueFilter, after?: Cursor, limit?: number): IssueRow[] {
  const { where, params, workspace } = listScope(a, "i", filter, ["i.title", "i.description", ident("t", "i")]);
  if (filter.status?.length) {
    where.push(`i.status IN (${inList(filter.status)})`);
    params.push(...filter.status.map(checkStatus));
  }
  if (filter.label) {
    where.push("EXISTS (SELECT 1 FROM json_each(i.labels) WHERE value = ? COLLATE NOCASE)");
    params.push(filter.label);
  }
  for (const field of ["assignee", "delegate", "creator"] as const) {
    if (!filter[field]) continue;
    const [condition, param] = userFilter(a, filter[field], workspace, field, `i.${field}_id`);
    where.push(condition);
    params.push(param);
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
  if (filter.subscribed) {
    where.push("EXISTS (SELECT 1 FROM subscriptions s WHERE s.issue_id = i.id AND s.user_id = ?)");
    params.push(a.id);
  }
  if (filter.due) where.push(DUE_WHERE[checkOneOf(filter.due, DUE_FILTERS, "due")]);
  const byDue = checkOneOf(filter.sort ?? "default", ISSUE_SORTS, "sort") === "due";
  if (after) {
    const [s, p, u, id, due] = after;
    let rest = `(${STATUS_RANK} > ? OR (${STATUS_RANK} = ? AND (${PRIORITY_RANK} > ? OR (${PRIORITY_RANK} = ? AND (i.updated_at < ? OR (i.updated_at = ? AND i.id < ?))))))`;
    const restParams: SQLQueryBindings[] = [s, s, p, p, u, u, id];
    if (byDue && due === null) rest = `(i.due_on IS NULL AND ${rest})`; // past the dated rows: only undated ones follow
    else if (byDue) {
      rest = `(i.due_on IS NULL OR i.due_on > ? OR (i.due_on = ? AND ${rest}))`;
      restParams.unshift(due, due);
    }
    where.push(rest);
    params.push(...restParams);
  }
  return db
    .query<IssueRow, SQLQueryBindings[]>(`${ISSUE_SELECT} ${whereClause(where)} ${byDue ? DUE_ORDER : ISSUE_ORDER}${limit ? ` LIMIT ${limit}` : ""}`)
    .all(...params);
}

// --- Activity ---

type Change = { kind: ActivityKind; from?: unknown; to?: unknown };

// Kinds whose values aren't stored: `created` and the trash have none, and descriptions aren't diffed.
const NO_VALUES: ActivityKind[] = ["created", "description", "trashed", "restored"];

// Moving into these tells an issue's subscribers: work handed back for review, finished or dropped.
const ANNOUNCED: Status[] = ["in_review", "done", "canceled"];

/**
 * Records a mutation's changes, one row each, at its `time`. Call it once per mutation, as the last statement
 * of its transaction, so whatever runs here later sees the final state and rolls back with the change.
 * Values as they are in memory (users by id, parent and blockers by identifier), stored as JSON.
 * Then the inbox: creating or claiming subscribes the actor; a new assignee or delegate is subscribed and told;
 * a move into in_review, done or canceled tells the subscribers. The webhook event goes first (`was`: see issueEvent).
 */
function logActivity(a: Actor, issueId: number, workspace: string, changes: Change[], time: string, was: Record<string, unknown> = {}) {
  const insert = db.query("INSERT INTO issue_activity (issue_id, actor_id, kind, from_value, to_value, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const json = (kind: ActivityKind, value: unknown) => (NO_VALUES.includes(kind) || value == null ? null : JSON.stringify(value));
  for (const { kind, from, to } of changes) insert.run(issueId, a.id, kind, json(kind, from), json(kind, to), time);
  if (changes.length) issueEvent(a, issueId, workspace, changes, time, was);
  const target = { issueId };
  const event = { actorId: a.id, workspace, target };
  for (const { kind, to } of changes) {
    if (kind === "created" || kind === "claimed") inbox.subscribe(a.id, target, time);
    else if ((kind === "assignee" || kind === "delegate") && typeof to === "number") {
      inbox.subscribe(to, target, time);
      inbox.notify([to], { ...event, kind: kind === "assignee" ? "assigned" : "delegated" }, time);
    } else if (kind === "status" && ANNOUNCED.includes(to as Status)) {
      inbox.notify(inbox.subscribers(target), { ...event, kind: "status", status: to as Status }, time);
    }
  }
}

/** How someone is known in `workspace`, by id. */
const userRef = (id: number, workspace: string) =>
  ref(db.query<Record<string, unknown>, [number, string]>(`SELECT ${userCols("u", "u")} FROM (SELECT ? AS id) x ${userJoin("u", "x.id", "?")}`).get(id, workspace)!, "u");

/**
 * Queues a mutation's one Issue webhook event: created is `create`, trashed `remove`, anything else `update`, with
 * `updatedFrom` the changed fields' values before (plus `was`: a claim's previous assignee or delegate).
 */
function issueEvent(a: Actor, issueId: number, workspace: string, changes: Change[], time: string, was: Record<string, unknown>) {
  const kinds = changes.map((c) => c.kind);
  const action = kinds.includes("created") ? "create" : kinds.includes("trashed") ? "remove" : "update";
  let updatedFrom: Record<string, unknown> | undefined;
  if (action === "update") {
    updatedFrom = { ...was };
    for (const { kind, from, to } of changes) {
      if (kind === "claimed") {
        if (from !== to) updatedFrom.status = from;
      } else if (kind === "restored") updatedFrom.deletedAt = from;
      else if (kind === "assignee" || kind === "delegate") updatedFrom[kind] = from == null ? null : userRef(from as number, workspace);
      else updatedFrom[kind] = from;
    }
  }
  const data = () => {
    const row = db.query<IssueRow, [number]>(`${ISSUE_SELECT} WHERE i.id = ?`).get(issueId)!;
    return { ...toSummary(row), description: row.description, creator: ref(row, "creator")! };
  };
  enqueue({ workspace, type: "Issue", action, entity: ownerRef("issue", issueId), actorId: a.id, time, data, updatedFrom });
}

// The fields of an issue's history, from an ISSUE_SELECT row, in the order a mutation lists them.
const TRACKED: [ActivityKind, (row: IssueRow) => unknown][] = [
  ["title", (r) => r.title],
  ["description", (r) => r.description],
  ["status", (r) => r.status],
  ["priority", (r) => r.priority],
  ["assignee", (r) => r.assignee_id],
  ["delegate", (r) => r.delegate_id],
  ["labels", (r) => JSON.parse(r.labels)],
  ["parent", (r) => r.parent],
  ["blockedBy", (r) => JSON.parse(r.blocked_by)],
  ["relatedTo", (r) => JSON.parse(r.related_to)],
  ["duplicateOf", (r) => r.duplicate_of],
  ["dueOn", (r) => r.due_on],
];

/** What really changed between two reads of an issue; lists (labels, blockers, related) compare as sets. */
function changes(before: IssueRow, after: IssueRow): Change[] {
  const key = (v: unknown) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v);
  return TRACKED.map(([kind, get]) => ({ kind, from: get(before), to: get(after) })).filter((c) => key(c.from) !== key(c.to));
}

/** An issue's history, oldest first; people by how they're known in `workspace` now, so renames show. */
function listActivity(issueId: number, workspace: string): Activity[] {
  const rows = db
    .query<Record<string, unknown>, [string, number]>(
      `SELECT x.id, x.kind, x.from_value, x.to_value, x.created_at, ${userCols("u", "a")}
       FROM issue_activity x ${userJoin("u", "x.actor_id", "?")} WHERE x.issue_id = ? ORDER BY x.id`,
    )
    .all(workspace, issueId)
    .map((r) => ({ r, from: JSON.parse((r.from_value as string | null) ?? "null"), to: JSON.parse((r.to_value as string | null) ?? "null") }));
  // Assignees and delegates are stored by id: one query for everyone they name.
  const people = (r: Record<string, unknown>) => r.kind === "assignee" || r.kind === "delegate";
  const ids = [...new Set(rows.filter(({ r }) => people(r)).flatMap(({ from, to }) => [from, to]).filter((id) => id !== null))];
  const users = new Map(
    db
      .query<Record<string, unknown>, [string, string]>(`SELECT ids.value AS id, ${userCols("u", "u")} FROM json_each(?) ids ${userJoin("u", "ids.value", "?")}`)
      .all(JSON.stringify(ids), workspace)
      .map((u) => [u.id as number, ref(u, "u")]),
  );
  return rows.map(({ r, from, to }) => ({
    id: r.id as number,
    kind: r.kind as ActivityKind,
    actor: ref(r, "a")!,
    from: people(r) && from !== null ? (users.get(from) ?? null) : from,
    to: people(r) && to !== null ? (users.get(to) ?? null) : to,
    createdAt: r.created_at as string,
  }));
}

export function getIssue(a: Actor, identifier: string): Issue {
  const { id } = issueRef(a, identifier);
  const row = db.query<IssueRow, [number]>(`${ISSUE_SELECT} WHERE i.id = ?`).get(id)!;
  const children = db.query<IssueRow, [number]>(`${ISSUE_SELECT} WHERE i.parent_id = ? AND ${LIVE} ${ISSUE_ORDER}`).all(id).map(toSummary);
  const duplicates = db
    .query<{ ref: string }, [number]>(
      `SELECT ${ident("dt", "d")} AS ref FROM issue_relations x JOIN issues d ON d.id = x.from_id JOIN teams dt ON dt.id = d.team_id
       WHERE x.kind = 'duplicate' AND x.to_id = ? AND d.deleted_at IS NULL ORDER BY dt.key, d.number`,
    )
    .all(id)
    .map((r) => r.ref);
  const blocks = db
    .query<{ ref: string }, [number]>(
      `SELECT ${ident("bt", "b")} AS ref FROM issue_blocks x JOIN issues b ON b.id = x.blocked_id JOIN teams bt ON bt.id = b.team_id
       WHERE x.blocker_id = ? AND b.deleted_at IS NULL ORDER BY bt.key, b.number`,
    )
    .all(id)
    .map((r) => r.ref);
  const docs = db
    .query<DocumentRow, [number]>(
      `${DOC_SELECT} JOIN document_refs r ON r.document_id = d.id WHERE r.issue_id = ? AND d.deleted_at IS NULL ORDER BY t.key, d.position, d.id`,
    )
    .all(id)
    .map(toDocSummary);
  return {
    ...toSummary(row),
    description: row.description,
    creator: ref(row, "creator")!,
    children,
    blocks,
    duplicates,
    comments: listComments("issue", id, row.workspace),
    activity: listActivity(id, row.workspace),
    docs,
    subscribed: inbox.isSubscribed(a.id, { issueId: id }),
  };
}

/** Bumps issues in SQL and returns their identifiers, for change events. */
function bumpIssues(ids: Iterable<number>, time: string): string[] {
  const bump = db.query<{ ref: string }, [string, string, number]>(
    `UPDATE issues SET ${BUMPED_AT} WHERE id = ? RETURNING (SELECT key FROM teams WHERE id = issues.team_id) || '-' || number AS ref`,
  );
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
    due_on: null,
    ...issueColumns(a, team.workspace, input),
    title: requireText(input.title, "title"),
  };
  const blockers = input.blockedBy === undefined ? [] : blockerIds(a, input.blockedBy);
  const related = input.relatedTo === undefined ? [] : relatedIds(a, input.relatedTo);
  const duplicate = input.duplicateOf === undefined ? null : duplicateId(a, input.duplicateOf);
  if (duplicate !== null) cols.status = "canceled"; // a duplicate is closed, as in Linear
  const time = now();
  const { identifier, docs, refs } = db.transaction(() => {
    const { number } = db
      .query<{ number: number }, [number]>("UPDATE teams SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS number")
      .get(team.id)!;
    const row: Record<string, SQLQueryBindings> = {
      ...cols,
      team_id: team.id,
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
    setRelated(id, related, time);
    setDuplicate(id, duplicate, time);
    // Its parent, blockers, related and canonical issues change too (they gain a sub-issue, something they block, a relation).
    const refs = bumpIssues(new Set([cols.parent_id as number | null, ...blockers, ...related, duplicate].filter((r): r is number => r !== null)), time);
    const identifier = `${team.key}-${number}`;
    // Docs in the workspace that mentioned this identifier before the issue existed now link to it.
    const mention = new RegExp(`\\b${identifier}\\b`);
    const docs = db
      .query<{ id: number; slug: string; content: string }, [string, string]>(
        "SELECT id, slug, content FROM documents WHERE workspace = ? AND content LIKE ?",
      )
      .all(team.workspace, `%${identifier}%`)
      .filter((doc) => mention.test(doc.content));
    for (const doc of docs) saveRefs(doc.id, doc.content, team.workspace);
    saveMentions(a, team.workspace, `issue:${id}`, { issueId: id }, cols.description as string, time);
    const people = (["assignee", "delegate"] as const).filter((f) => cols[`${f}_id`] !== null);
    logActivity(a, id, team.workspace, [{ kind: "created" }, ...people.map((kind) => ({ kind, from: null, to: cols[`${kind}_id`] }))], time);
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
  // A new parent must not be the issue itself or one of its descendants.
  for (let p = cols.parent_id as number | null | undefined; p != null; ) {
    if (p === id) throw new AppError("An issue can't be its own parent or ancestor");
    p = db.query<{ parent_id: number | null }, [number]>("SELECT parent_id FROM issues WHERE id = ?").get(p)!.parent_id;
  }
  const blockers = patch.blockedBy === undefined ? undefined : blockerIds(a, patch.blockedBy, id);
  const relatedTo = patch.relatedTo === undefined ? undefined : relatedIds(a, patch.relatedTo, id);
  const duplicate = patch.duplicateOf === undefined ? undefined : duplicateId(a, patch.duplicateOf, id);
  if (duplicate != null) cols.status = "canceled"; // marking a duplicate closes it; clearing leaves the status alone
  const time = now();
  const read = db.query<IssueRow, [number]>(`${ISSUE_SELECT} WHERE i.id = ?`);
  // IMMEDIATE holds the write lock from the read (the version check, the history's "before") to the write.
  const refs = db.transaction(() => {
    const before = read.get(id)!;
    if (patch.baseUpdatedAt !== undefined && patch.baseUpdatedAt !== before.updated_at) {
      throw new AppError("Issue changed since you read it", 409);
    }
    if (cols.status !== undefined) {
      const closing = isClosed(cols.status as Status);
      if (closing !== isClosed(before.status)) cols.completed_at = closing ? time : null;
    }
    // The old and new parent, and any blocker, related or canonical issue added or removed, change too.
    const related = new Set<number>();
    const parentBefore = before.parent_id as number | null;
    if (cols.parent_id !== undefined && cols.parent_id !== parentBefore) {
      if (parentBefore !== null) related.add(parentBefore);
      if (cols.parent_id !== null) related.add(cols.parent_id as number);
    }
    if (blockers) {
      const was = db
        .query<{ blocker_id: number }, [number]>("SELECT blocker_id FROM issue_blocks WHERE blocked_id = ?")
        .all(id)
        .map((b) => b.blocker_id);
      for (const b of was) if (!blockers.includes(b)) related.add(b);
      for (const b of blockers) if (!was.includes(b)) related.add(b);
    }
    const assignments = [...Object.keys(cols).map((c) => `${c} = ?`), BUMPED_AT];
    db.query(`UPDATE issues SET ${assignments.join(", ")} WHERE id = ?`).run(...Object.values(cols), time, time, id);
    if (blockers) setBlockers(id, blockers);
    if (relatedTo) for (const r of setRelated(id, relatedTo, time)) related.add(r);
    if (duplicate !== undefined) for (const r of setDuplicate(id, duplicate, time)) related.add(r);
    const refs = bumpIssues(related, time);
    if (cols.description !== undefined) saveMentions(a, workspace, `issue:${id}`, { issueId: id }, cols.description as string, time);
    logActivity(a, id, workspace, changes(before, read.get(id)!), time);
    return refs;
  }).immediate();
  const issue = getIssue(a, identifier);
  changed("issue", workspace, issue.id);
  for (const r of refs) changed("issue", workspace, r);
  return issue;
}

/** Issues that gain or lose a relation when `id` enters or leaves the trash: its parent, sub-issues, blockers, related and duplicates. */
function relatives(id: number): number[] {
  return db
    .query<{ id: number }, [number]>(
      `SELECT i.id FROM issues i
       WHERE i.parent_id = ?1 OR i.id = (SELECT parent_id FROM issues WHERE id = ?1)
         OR i.id IN (SELECT blocked_id FROM issue_blocks WHERE blocker_id = ?1)
         OR i.id IN (SELECT blocker_id FROM issue_blocks WHERE blocked_id = ?1)
         OR i.id IN (SELECT to_id FROM issue_relations WHERE from_id = ?1)
         OR i.id IN (SELECT from_id FROM issue_relations WHERE to_id = ?1)`,
    )
    .all(id)
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
    const refs = bumpIssues(relatives(issue.id), time);
    logActivity(a, issue.id, issue.workspace, [trash ? { kind: "trashed" } : { kind: "restored", from: issue.deleted_at }], time);
    return refs;
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
function purgeTrash() {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // Live sub-issues lose their parent when it's purged: bump and publish them, as any parent change does.
  const orphans = db.transaction(() => {
    const orphans = db
      .query<{ id: number; workspace: string }, [string]>(
        `SELECT c.id, t.workspace FROM issues c JOIN teams t ON t.id = c.team_id
         WHERE c.deleted_at IS NULL AND c.parent_id IN (SELECT id FROM issues WHERE deleted_at IS NOT NULL AND deleted_at < ?)`,
      )
      .all(cutoff);
    db.query("DELETE FROM issues WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff);
    db.query("DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff);
    const refs = bumpIssues(orphans.map((o) => o.id), now());
    return orphans.map((o, i) => ({ workspace: o.workspace, ref: refs[i]! }));
  })();
  for (const { workspace, ref } of orphans) changed("issue", workspace, ref);
}

/** A team's trash, newest first. */
export function listTrash(a: Actor, team: string): Trash {
  const { id } = teamRow(a, team);
  purgeTrash();
  const issues = db
    .query<IssueRow, [number]>(`${ISSUE_SELECT} WHERE i.team_id = ? AND i.deleted_at IS NOT NULL ORDER BY i.deleted_at DESC, i.id DESC`)
    .all(id)
    .map(toSummary);
  const documents = db
    .query<DocumentRow, [number]>(`${DOC_SELECT} WHERE d.team_id = ? AND d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC, d.id DESC`)
    .all(id)
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
        `SELECT i.status, i.${slot} AS holder, m.username, ${ident("t", "i")} AS ref, (m.user_id IS NOT NULL AND m.suspended_at IS NULL) AS active
         FROM issues i JOIN teams t ON t.id = i.team_id
         LEFT JOIN workspace_members m ON m.user_id = i.${slot} AND m.workspace = ? WHERE i.id = ?`,
      )
      .get(workspace, id)!;
    if (isClosed(row.status)) throw new AppError(`${row.ref} is ${row.status}`, 409);
    if (row.holder !== null && row.holder !== a.id && row.active) {
      throw new AppError(`${row.ref} is claimed by ${row.username}`, 409);
    }
    const started = row.status === "in_progress" || row.status === "in_review";
    if (row.holder === a.id && started) return false;
    const status = started ? row.status : "in_progress";
    db.query(`UPDATE issues SET ${slot} = ?, status = ?, ${BUMPED_AT} WHERE id = ?`).run(a.id, status, time, time, id);
    const was = row.holder === a.id ? {} : { [slot === "assignee_id" ? "assignee" : "delegate"]: row.holder === null ? null : userRef(row.holder, workspace) };
    logActivity(a, id, workspace, [{ kind: "claimed", from: row.status, to: status }], time, was);
    return true;
  }).immediate();
  const issue = getIssue(a, identifier);
  if (claimed) changed("issue", workspace, issue.id);
  return issue;
}

/** Runs a change to an issue's comments, bumping the issue in the same transaction. */
function changeIssueComments(a: Actor, identifier: string, change: (id: number, time: string, workspace: string) => void): Issue {
  const { id, workspace } = liveIssue(a, identifier);
  const time = now();
  db.transaction(() => {
    change(id, time, workspace);
    db.query(`UPDATE issues SET ${BUMPED_AT} WHERE id = ?`).run(time, time, id);
  })();
  const issue = getIssue(a, identifier);
  changed("issue", workspace, issue.id);
  return issue;
}

export const addComment = (a: Actor, identifier: string, body: unknown) =>
  changeIssueComments(a, identifier, (id, time, workspace) => insertComment(a, "issue", id, workspace, body, time));

export const updateIssueComment = (a: Actor, identifier: string, commentId: unknown, body: unknown) =>
  changeIssueComments(a, identifier, (id, time, workspace) => updateComment(a, "issue", id, workspace, commentId, body, time));

export const deleteIssueComment = (a: Actor, identifier: string, commentId: unknown) =>
  changeIssueComments(a, identifier, (id, time, workspace) => deleteComment(a, "issue", id, workspace, commentId, time));

/** Follows or unfollows an issue; it sticks until you create, claim, comment on or are assigned, delegated or mentioned in it. */
export function subscribeIssue(a: Actor, identifier: string, on: boolean): Issue {
  const issue = liveIssue(a, identifier);
  if (on) inbox.subscribe(a.id, { issueId: issue.id }, now());
  else inbox.unsubscribe(a.id, { issueId: issue.id });
  changed("issue", issue.workspace, issue.ref, a.id);
  return getIssue(a, identifier);
}

/** Labels in use in the request's workspace, each with how many open issues carry it. */
export function listLabels(a: Actor): LabelCount[] {
  const { where, params } = listScope(a, "i", {}, []);
  return db
    .query<LabelCount, SQLQueryBindings[]>(
      `SELECT l.value AS label, SUM(i.status NOT IN (${inList(CLOSED_STATUSES)})) AS open
       FROM issues i JOIN teams t ON t.id = i.team_id, json_each(i.labels) l ${whereClause(where)}
       GROUP BY l.value ORDER BY l.value COLLATE NOCASE`,
    )
    .all(...CLOSED_STATUSES, ...params);
}

// --- Documents ---

type DocumentRow = Record<string, unknown> & {
  id: number;
  slug: string;
  team_id: number;
  team_key: string;
  workspace: string;
  title: string;
  content: string;
  position: number;
  created_at: string;
  updated_at: string;
  updated_by_id: number;
  deleted_at: string | null;
};

const DOC_COLUMNS = `d.id, d.slug, d.team_id, t.key AS team_key, d.workspace, d.title, d.position, d.created_at, d.updated_at, d.updated_by_id, d.deleted_at, ${userCols("u", "by")}`;
const DOC_FROM = `FROM documents d JOIN teams t ON t.id = d.team_id ${userJoin("u", "d.updated_by_id", "d.workspace")}`;
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

/** Queues a doc's webhook event (see webhooks.ts): its summary, never its content. */
function documentEvent(a: Actor, doc: { id: number; slug: string; workspace: string }, action: WebhookAction, time: string, updatedFrom?: Record<string, unknown>) {
  const data = () => toDocSummary(db.query<DocumentRow, [number]>(`${DOC_SELECT} WHERE d.id = ?`).get(doc.id)!);
  enqueue({ workspace: doc.workspace, type: "Document", action, entity: doc.slug, actorId: a.id, time, data, updatedFrom });
}

/** A doc of the request's workspace, by slug. */
function documentRow(a: Actor, slug: unknown): DocumentRow {
  const workspace = requestWorkspace(a);
  const row =
    typeof slug === "string"
      ? db
          .query<DocumentRow, [string, string]>(`SELECT d.content, ${DOC_COLUMNS} ${DOC_FROM} WHERE d.workspace = ? AND d.slug = ?`)
          .get(workspace, slug.trim().toLowerCase())
      : null;
  if (!row) throw new AppError(`Document ${slug} not found`, 404);
  return row;
}

/** A doc that isn't in the trash: a trashed one can be read and restored, nothing else. */
function liveDocument(a: Actor, slug: unknown): DocumentRow {
  const row = documentRow(a, slug);
  if (row.deleted_at) throw new AppError(`Document ${row.slug} is in the trash; restore it first`, 409);
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

const nextPosition = (teamId: number) =>
  db.query<{ n: number }, [number]>("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM documents WHERE team_id = ?").get(teamId)!.n;

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
  const find = db.query<{ id: number }, [string, string, number]>(
    "SELECT i.id FROM issues i JOIN teams t ON t.id = i.team_id WHERE t.workspace = ? AND t.key = ? AND i.number = ?",
  );
  const ids = new Set<number>();
  for (const [, key, number] of content.matchAll(/\b([A-Z]{2,5})-(\d+)\b/g)) {
    const row = find.get(workspace, key!, Number(number));
    if (row) ids.add(row.id);
  }
  [...ids].forEach((issueId, ord) => {
    db.query("INSERT INTO document_refs (document_id, issue_id, ord) VALUES (?, ?, ?)").run(documentId, issueId, ord);
  });
}

export function listDocuments(a: Actor, filter: DocumentFilter): DocumentSummary[] {
  const { where, params } = listScope(a, "d", filter, ["d.title", "d.content"]);
  return db
    .query<DocumentRow, SQLQueryBindings[]>(`${DOC_SELECT} ${whereClause(where)} ORDER BY t.key, d.position, d.id`)
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
  const comments = listComments("document", row.id, row.workspace);
  return { ...toDocSummary(row), content: row.content, issues, comments, versionCount, subscribed: inbox.isSubscribed(a.id, { documentId: row.id }) };
}

export function createDocument(a: Actor, input: DocumentInput): Document {
  const team = teamRow(a, input.team);
  const title = requireText(input.title, "title");
  const content = input.content === undefined ? "" : checkContent(input.content);
  const position = input.position === undefined ? undefined : checkPosition(input.position);
  const time = now();
  const slug = db.transaction(() => {
    const taken = (s: string) => db.query("SELECT 1 FROM documents WHERE workspace = ? AND slug = ?").get(team.workspace, s) !== null;
    const slug = pickSlug(input.slug, title, taken, { label: "slug", fallback: "doc" });
    const { id } = db
      .query<{ id: number }, SQLQueryBindings[]>(
        `INSERT INTO documents (workspace, team_id, slug, title, content, position, created_at, updated_at, updated_by_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(team.workspace, team.id, slug, title, content, position ?? nextPosition(team.id), time, time, a.id)!;
    saveVersion(id, title, content, a.id, time);
    saveRefs(id, content, team.workspace);
    inbox.subscribe(a.id, { documentId: id }, time);
    saveMentions(a, team.workspace, `document:${id}`, { documentId: id }, content, time, { typing: true });
    documentEvent(a, { id, slug, workspace: team.workspace }, "create", time);
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
    const team = teamRow(a, patch.team); // in the doc's workspace: docs never move between workspaces
    cols.team_id = team.id;
    if (team.id !== row.team_id && patch.position === undefined) cols.position = nextPosition(team.id);
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
    if (cols.content !== undefined) {
      saveRefs(row.id, content, row.workspace);
      saveMentions(a, row.workspace, `document:${row.id}`, { documentId: row.id }, content, time, { typing: true });
    }
    // Content isn't in the payload (it can be large): a content change shows as updatedAt alone.
    const was: Record<string, unknown> = { updatedAt: row.updated_at };
    if (cols.title !== undefined) was.title = row.title;
    if (cols.team_id !== undefined) was.team = row.team_key;
    if (cols.position !== undefined) was.position = row.position;
    if (row.updated_by_id !== a.id) was.updatedBy = ref(row, "by");
    documentEvent(a, row, "update", time, was);
  })();
  changed("document", row.workspace, row.slug);
  return getDocument(a, row.slug);
}

/** Moves a doc to the trash or back; its versions, comments and refs stay until it's purged. */
function trashDocument(a: Actor, slug: string, trash: boolean): Document {
  const row = documentRow(a, slug);
  if (!!row.deleted_at === trash) throw new AppError(trash ? `Document ${row.slug} is already in the trash` : `Document ${row.slug} isn't in the trash`, 409);
  purgeTrash();
  const time = now();
  db.transaction(() => {
    db.query("UPDATE documents SET deleted_at = ? WHERE id = ?").run(trash ? time : null, row.id);
    documentEvent(a, row, trash ? "remove" : "update", time, trash ? undefined : { deletedAt: row.deleted_at });
  })();
  changed("document", row.workspace, row.slug);
  return getDocument(a, row.slug);
}

export const deleteDocument = (a: Actor, slug: string) => trashDocument(a, slug, true);
export const restoreDocument = (a: Actor, slug: string) => trashDocument(a, slug, false);

/** Runs a change to a doc's comments in one transaction. It leaves the doc's updated_at alone, so an open editor sees no conflict. */
function changeDocumentComments(a: Actor, slug: string, change: (id: number, time: string, workspace: string) => void): Document {
  const row = liveDocument(a, slug);
  const time = now();
  db.transaction(() => change(row.id, time, row.workspace))();
  changed("document", row.workspace, row.slug);
  return getDocument(a, row.slug);
}

export const addDocumentComment = (a: Actor, slug: string, body: unknown) =>
  changeDocumentComments(a, slug, (id, time, workspace) => insertComment(a, "document", id, workspace, body, time));

export const updateDocumentComment = (a: Actor, slug: string, commentId: unknown, body: unknown) =>
  changeDocumentComments(a, slug, (id, time, workspace) => updateComment(a, "document", id, workspace, commentId, body, time));

export const deleteDocumentComment = (a: Actor, slug: string, commentId: unknown) =>
  changeDocumentComments(a, slug, (id, time, workspace) => deleteComment(a, "document", id, workspace, commentId, time));

/** Follows or unfollows a doc (see subscribeIssue). */
export function subscribeDocument(a: Actor, slug: string, on: boolean): Document {
  const row = liveDocument(a, slug);
  if (on) inbox.subscribe(a.id, { documentId: row.id }, now());
  else inbox.unsubscribe(a.id, { documentId: row.id });
  changed("document", row.workspace, row.slug, a.id);
  return getDocument(a, row.slug);
}

const VERSION_FROM = `FROM document_versions v JOIN documents d ON d.id = v.document_id ${userJoin("u", "v.author_id", "d.workspace")}`;

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

// --- Links made before URLs carried the workspace ---

/**
 * Which of your workspaces an issue, doc or team (exactly one) is in, ignoring the request's. When several
 * match, the oldest team or doc wins: keys and slugs were unique across workspaces before, so old links meant it.
 */
export function locate(a: Actor, query: { issue?: string; doc?: string; team?: string }): { workspace: string } {
  const given = Object.entries(query).filter(([, value]) => value !== undefined);
  if (given.length !== 1) throw new AppError("Pass exactly one of issue, doc or team");
  const [kind, value] = given[0]! as [string, string];
  const mine = [...a.workspaces.keys()];
  const within = `IN (${inList(mine)})`;
  const issue = /^([a-z]{2,5})-(\d+)$/i.exec(value.trim());
  const row =
    kind === "doc"
      ? db
          .query<{ workspace: string }, SQLQueryBindings[]>(`SELECT workspace FROM documents WHERE slug = ? AND workspace ${within} ORDER BY created_at, id`)
          .get(value.trim().toLowerCase(), ...mine)
      : kind === "team"
        ? db
            .query<{ workspace: string }, SQLQueryBindings[]>(`SELECT workspace FROM teams WHERE key = ? AND workspace ${within} ORDER BY created_at, id`)
            .get(value.trim().toUpperCase(), ...mine)
        : issue
          ? db
              .query<{ workspace: string }, SQLQueryBindings[]>(
                `SELECT t.workspace FROM issues i JOIN teams t ON t.id = i.team_id
                 WHERE t.key = ? AND i.number = ? AND t.workspace ${within} ORDER BY t.created_at, t.id`,
              )
              .get(issue[1]!.toUpperCase(), Number(issue[2]), ...mine)
          : null;
  if (!row) throw new AppError("Not found", 404);
  return row;
}

// Anything that expired while the server was down goes now; later deletes and trash views purge as they go.
purgeTrash();

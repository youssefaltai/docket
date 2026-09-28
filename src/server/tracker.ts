// Teams, issues, comments, labels and documents. Every function acts for an Actor in the request's one
// workspace (requestWorkspace): team keys, identifiers and slugs resolve there, and anything elsewhere is
// 404, as if it didn't exist.
import type { SQLQueryBindings } from "bun:sqlite";
import {
  CATEGORY_COLORS,
  CLOSED_CATEGORIES,
  DEFAULT_WORKFLOW,
  DUE_FILTERS,
  DUPLICATE_STATUS,
  ISSUE_SORTS,
  PRIORITIES,
  STATUS_CATEGORIES,
  type Activity,
  type ActivityKind,
  type BulkIssueResult,
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
  LABEL_COLORS,
  type Label,
  type LabelInput,
  type LabelPatch,
  type Priority,
  type Reaction,
  type StatusCategory,
  type Team,
  type TeamInput,
  type TeamPatch,
  type Trash,
  type UserKind,
  type UserRef,
  type WebhookAction,
  type WorkflowStatus,
  type WorkflowStatusInput,
  type WorkflowStatusPatch,
} from "../shared/types.ts";
import { type Actor, activeMemberId, requestWorkspace, requirePerson, systemUserId } from "./access.ts";
import {
  AppError,
  BUMPED_AT,
  bumpedAt,
  capLength,
  changed,
  checkOneOf,
  db,
  knownAs,
  mentionedIn,
  now,
  optionalText,
  pickSlug,
  requireText,
} from "./db.ts";
import * as inbox from "./inbox.ts";
import { enqueue } from "./webhooks.ts";

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

/** A label's path in SQL, from its alias and its group's (LEFT JOINed): "Type/Bug" in a group, else the name. */
const LABEL_PATH = "CASE WHEN g.id IS NULL THEN l.name ELSE g.name || '/' || l.name END";

/** Placeholders for `IN (…)`; never empty, so the SQL stays valid. */
const inList = (values: unknown[]) => (values.length ? values.map(() => "?").join(", ") : "NULL");

/** A UserRef from joined columns `${p}_username`, `${p}_name`, `${p}_kind`, or null. */
function ref(row: Record<string, unknown>, p: string): UserRef | null {
  const username = row[`${p}_username`] as string | null;
  return username ? { username, name: row[`${p}_name`] as string, kind: row[`${p}_kind`] as UserKind } : null;
}
/**
 * Joins the user `id` (a column) as `alias`: their account, and their membership in `workspace` (an SQL
 * expression, e.g. the row's team's), which holds how they're known there (Docket's own account: as itself).
 * Read it with `userCols`.
 */
const userJoin = (alias: string, id: string, workspace: string) =>
  `LEFT JOIN users ${alias} ON ${alias}.id = ${id}
   LEFT JOIN workspace_members ${alias}_m ON ${alias}_m.user_id = ${id} AND ${alias}_m.workspace = ${workspace}`;
const userCols = (alias: string, p: string) =>
  `${knownAs(`${alias}_m`, alias, "username")} AS ${p}_username, ${knownAs(`${alias}_m`, alias, "name")} AS ${p}_name, ${alias}.kind AS ${p}_kind`;

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

// --- Reactions ---

const MAX_REACTIONS = 20; // distinct emoji per target

/** A keycap: a digit, # or *, an optional variation selector, then the combining enclosing keycap mark. */
const KEYCAP = /^[#*0-9]️?⃣$/;

/**
 * One emoji: after trimming, exactly one grapheme with a pictographic or regional-indicator code point (or a
 * keycap), at most 32 UTF-16 units. Stored as sent, normalized to NFC.
 */
function checkEmoji(value: unknown): string {
  const emoji = (typeof value === "string" ? value : "").trim().normalize("NFC");
  const graphemes = [...new Intl.Segmenter().segment(emoji)];
  const shaped = emoji.length > 0 && emoji.length <= 32 && graphemes.length === 1;
  if (!shaped || !(/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(emoji) || KEYCAP.test(emoji))) {
    throw new AppError("emoji must be a single emoji, e.g. 👍");
  }
  return emoji;
}

/** Every target's reactions, one query: emoji ordered by first reaction, users within an emoji by when they reacted. */
function listReactions(workspace: string, targets: string[]): Map<string, Reaction[]> {
  const byTarget = new Map<string, Reaction[]>();
  if (!targets.length) return byTarget;
  const rows = db
    .query<Record<string, unknown>, [string, ...string[]]>(
      `SELECT r.target, r.emoji, ${userCols("u", "user")} FROM reactions r ${userJoin("u", "r.user_id", "?1")}
       WHERE r.target IN (${inList(targets)}) ORDER BY r.created_at`,
    )
    .all(workspace, ...targets);
  for (const row of rows) {
    const target = row.target as string;
    const list = byTarget.get(target) ?? byTarget.set(target, []).get(target)!;
    const group = list.find((g) => g.emoji === row.emoji);
    if (group) group.users.push(ref(row, "user")!);
    else list.push({ emoji: row.emoji as string, users: [ref(row, "user")!] });
  }
  return byTarget;
}

/**
 * Adds or removes the actor's own reaction on `target` ('issue:<id>', 'comment:<id>', 'document_comment:<id>');
 * idempotent both ways. At most 20 distinct emoji per target (409 beyond, only when adding a new one).
 */
function setReaction(a: Actor, target: string, owner: { issueId?: number; documentId?: number }, emoji: unknown, on: boolean, time: string) {
  const e = checkEmoji(emoji);
  if (!on) {
    db.query("DELETE FROM reactions WHERE target = ? AND user_id = ? AND emoji = ?").run(target, a.id, e);
    return;
  }
  if (!db.query("SELECT 1 FROM reactions WHERE target = ? AND emoji = ?").get(target, e)) {
    const { n } = db.query<{ n: number }, [string]>("SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE target = ?").get(target)!;
    if (n >= MAX_REACTIONS) throw new AppError(`At most ${MAX_REACTIONS} different reactions on one thing`, 409);
  }
  db.query("INSERT OR IGNORE INTO reactions (target, user_id, emoji, issue_id, document_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    target,
    a.id,
    e,
    owner.issueId ?? null,
    owner.documentId ?? null,
    time,
  );
}

// --- Comments ---

// Issue and doc comments live in parallel tables; each helper serves both. `source`: how mentions name a comment.
const COMMENTS = {
  issue: { table: "comments", column: "issue_id", source: "comment" },
  document: { table: "document_comments", column: "document_id", source: "document_comment" },
} as const;

type CommentOwner = keyof typeof COMMENTS;

/** Comments with their author and resolver as known in workspace `?1`; add a WHERE on `?2`. */
const commentSelect = (owner: CommentOwner) =>
  `SELECT c.id, c.body, c.created_at, c.edited_at, c.parent_id, c.resolved_at, ${userCols("u", "a")}, ${userCols("r", "r")}
   FROM ${COMMENTS[owner].table} c ${userJoin("u", "c.author_id", "?1")} ${userJoin("r", "c.resolved_by_id", "?1")}`;

const toComment = (r: Record<string, unknown>, reactions: Reaction[] = []): Comment => ({
  id: r.id as number,
  author: ref(r, "a")!,
  body: r.body as string,
  createdAt: r.created_at as string,
  editedAt: r.edited_at as string | null,
  parent: r.parent_id as number | null,
  resolvedAt: r.resolved_at as string | null,
  resolvedBy: ref(r, "r"),
  reactions,
});

/** An issue's or doc's comments, one flat list by id (replies name their root); people as they're known in `workspace`, the owner's. */
function listComments(owner: CommentOwner, ownerId: number, workspace: string): Comment[] {
  const rows = db
    .query<Record<string, unknown>, [string, number]>(`${commentSelect(owner)} WHERE c.${COMMENTS[owner].column} = ?2 ORDER BY c.id`)
    .all(workspace, ownerId);
  const reactions = listReactions(
    workspace,
    rows.map((r) => `${COMMENTS[owner].source}:${r.id}`),
  );
  return rows.map((r) => toComment(r, reactions.get(`${COMMENTS[owner].source}:${r.id}`) ?? []));
}

/** A comment on this owner, by id (404 otherwise, as for any id elsewhere): its author and thread. */
function commentRow(owner: CommentOwner, ownerId: number, workspace: string, commentId: unknown) {
  const { table, column } = COMMENTS[owner];
  const id = Number(commentId);
  const row = Number.isInteger(id)
    ? db
        .query<{ id: number; author_id: number; username: string | null; parent_id: number | null; resolved_at: string | null }, [string, number, number]>(
          `SELECT c.id, c.author_id, m.username, c.parent_id, c.resolved_at FROM ${table} c
           LEFT JOIN workspace_members m ON m.user_id = c.author_id AND m.workspace = ? WHERE c.id = ? AND c.${column} = ?`,
        )
        .get(workspace, id, ownerId)
    : null;
  if (!row) throw new AppError(`Comment ${commentId} not found`, 404);
  return row;
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
  const row = db.query<Record<string, unknown>, [string, number]>(`${commentSelect(owner)} WHERE c.id = ?2`).get(workspace, id)!;
  const source = `${COMMENTS[owner].source}:${id}`;
  const comment = toComment(row, listReactions(workspace, [source]).get(source) ?? []);
  const data = { ...comment, issue: owner === "issue" ? on : null, document: owner === "document" ? on : null };
  enqueue({ workspace, type: "Comment", action, entity: String(id), actorId: a.id, time, data: () => data, updatedFrom });
}

const targetOf = (owner: CommentOwner, ownerId: number): inbox.Target => (owner === "issue" ? { issueId: ownerId } : { documentId: ownerId });

/** Rebuilds a comment's mentions (see saveMentions). */
const commentMentions = (a: Actor, owner: CommentOwner, ownerId: number, workspace: string, id: number, body: string, time: string) =>
  saveMentions(a, workspace, `${COMMENTS[owner].source}:${id}`, targetOf(owner, ownerId), body, time, { commentId: id });

/**
 * Adds a comment, or with `parent` a reply in that comment's thread (a reply to a reply joins its root's thread),
 * which reopens the thread if it was resolved. Its author follows the issue or doc, and its other subscribers
 * hear of it (unless it mentions them).
 */
function insertComment(a: Actor, owner: CommentOwner, ownerId: number, workspace: string, body: unknown, time: string, parent?: unknown): number {
  const { table, column } = COMMENTS[owner];
  const text = requireText(body, "body");
  let root: number | null = null;
  if (parent != null) {
    const p = commentRow(owner, ownerId, workspace, parent);
    root = p.parent_id ?? p.id;
    const was = db.query<{ resolved_at: string | null }, [number]>(`SELECT resolved_at FROM ${table} WHERE id = ?`).get(root)!.resolved_at;
    if (was) {
      db.query(`UPDATE ${table} SET resolved_at = NULL, resolved_by_id = NULL WHERE id = ?`).run(root);
      commentEvent(a, owner, ownerId, workspace, root, "update", time, { resolvedAt: was });
    }
  }
  const id = Number(
    db.query(`INSERT INTO ${table} (${column}, author_id, body, created_at, parent_id) VALUES (?, ?, ?, ?, ?)`).run(ownerId, a.id, text, time, root).lastInsertRowid,
  );
  commentEvent(a, owner, ownerId, workspace, id, "create", time); // before the notifications it causes
  const mentioned = commentMentions(a, owner, ownerId, workspace, id, text, time);
  const target = targetOf(owner, ownerId);
  inbox.subscribe(a.id, target, time);
  const others = inbox.subscribers(target).filter((u) => !mentioned.includes(u));
  inbox.notify(others, { kind: "commented", actorId: a.id, workspace, target, commentId: id }, time);
  return id;
}

/** The id of a comment on this owner (in `workspace`) that the actor wrote; others' comments are 403. */
function ownComment(a: Actor, owner: CommentOwner, ownerId: number, workspace: string, commentId: unknown) {
  const row = commentRow(owner, ownerId, workspace, commentId);
  if (row.author_id !== a.id) throw new AppError(`Only @${row.username} can change this comment`, 403);
  return row;
}

/** Resolves a thread, or reopens it: anyone who can comment can, from its first comment. Idempotent. */
function resolveThread(a: Actor, owner: CommentOwner, ownerId: number, workspace: string, commentId: unknown, resolved: boolean, time: string) {
  const row = commentRow(owner, ownerId, workspace, commentId);
  if (row.parent_id !== null) throw new AppError("Resolve a thread from its first comment");
  if (!!row.resolved_at === resolved) return;
  db.query(`UPDATE ${COMMENTS[owner].table} SET resolved_at = ?, resolved_by_id = ? WHERE id = ?`).run(resolved ? time : null, resolved ? a.id : null, row.id);
  commentEvent(a, owner, ownerId, workspace, row.id, "update", time, { resolvedAt: row.resolved_at });
}

function updateComment(a: Actor, owner: CommentOwner, ownerId: number, workspace: string, commentId: unknown, body: unknown, time: string) {
  const { id } = ownComment(a, owner, ownerId, workspace, commentId);
  const text = requireText(body, "body");
  const { table } = COMMENTS[owner];
  const before = db.query<{ body: string; edited_at: string | null }, [number]>(`SELECT body, edited_at FROM ${table} WHERE id = ?`).get(id)!;
  db.query(`UPDATE ${table} SET body = ?, edited_at = ? WHERE id = ?`).run(text, time, id);
  commentMentions(a, owner, ownerId, workspace, id, text, time);
  if (text !== before.body) commentEvent(a, owner, ownerId, workspace, id, "update", time, { body: before.body, editedAt: before.edited_at });
}

function deleteComment(a: Actor, owner: CommentOwner, ownerId: number, workspace: string, commentId: unknown, time: string) {
  const { id } = ownComment(a, owner, ownerId, workspace, commentId);
  const { table } = COMMENTS[owner];
  // Nobody's replies go with it.
  if (db.query(`SELECT 1 FROM ${table} WHERE parent_id = ?`).get(id)) throw new AppError("This comment has replies; edit it instead", 409);
  commentEvent(a, owner, ownerId, workspace, id, "remove", time);
  db.query(`DELETE FROM ${table} WHERE id = ?`).run(id);
  db.query("DELETE FROM mentions WHERE source = ?").run(`${COMMENTS[owner].source}:${id}`);
  db.query("DELETE FROM reactions WHERE target = ?").run(`${COMMENTS[owner].source}:${id}`);
  inbox.commentDeleted(targetOf(owner, ownerId), id);
}

// --- Teams ---

interface TeamRow {
  id: number; // internal: issues and docs point to it; the API names teams by key
  key: string;
  workspace: string;
  name: string;
  description: string;
  default_status: string;
  auto_close_parent: number; // 0 or 1
  auto_close_children: number;
  auto_archive_days: number | null; // null: never; else days after completed_at
  statuses: string; // JSON array of WorkflowStatus, in workflow order
  counts: string; // JSON object: status → issue count, statuses without issues left out
  doc_count: number;
  created_at: string;
  updated_at: string;
}

/** Category order in SQL (STATUS_CATEGORIES) for a category column; anything else last. */
const categoryRank = (column: string) =>
  `CASE ${column} ${STATUS_CATEGORIES.map((c, n) => `WHEN '${c}' THEN ${n}`).join(" ")} ELSE ${STATUS_CATEGORIES.length} END`;
const WORKFLOW_ORDER = `ORDER BY ${categoryRank("category")}, position, id`;

const TEAM_SELECT = `
  SELECT t.*,
    (SELECT json_group_array(json_object('key', key, 'name', name, 'category', category, 'color', color, 'position', position)) FROM (
      SELECT * FROM workflow_statuses WHERE team_id = t.id ${WORKFLOW_ORDER}
    )) AS statuses,
    (SELECT json_group_object(status, n) FROM (
      SELECT status, COUNT(*) AS n FROM issues WHERE team_id = t.id AND deleted_at IS NULL GROUP BY status
    )) AS counts,
    (SELECT COUNT(*) FROM documents WHERE team_id = t.id AND deleted_at IS NULL) AS doc_count
  FROM teams t`;

function toTeam(row: TeamRow): Team {
  const statuses: WorkflowStatus[] = JSON.parse(row.statuses);
  return {
    key: row.key,
    workspace: row.workspace,
    name: row.name,
    description: row.description,
    statuses,
    defaultStatus: row.default_status,
    autoCloseParent: row.auto_close_parent === 1,
    autoCloseChildren: row.auto_close_children === 1,
    autoArchiveDays: row.auto_archive_days,
    counts: { ...Object.fromEntries(statuses.map((s) => [s.key, 0])), ...JSON.parse(row.counts) },
    docCount: row.doc_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
  const autoCloseParent = checkFlag(input.autoCloseParent ?? false, "autoCloseParent");
  const autoCloseChildren = checkFlag(input.autoCloseChildren ?? false, "autoCloseChildren");
  const autoArchiveDays = input.autoArchiveDays === undefined ? null : checkAutoArchiveDays(input.autoArchiveDays);
  if (db.query("SELECT 1 FROM teams WHERE workspace = ? AND key = ?").get(workspace, key)) {
    throw new AppError(`Team key ${key} is taken in this workspace`, 409);
  }
  const time = now();
  db.transaction(() => {
    const { id } = db
      .query<{ id: number }, SQLQueryBindings[]>(
        "INSERT INTO teams (key, workspace, name, description, auto_close_parent, auto_close_children, auto_archive_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(key, workspace, name, description, autoCloseParent, autoCloseChildren, autoArchiveDays, time, time)!;
    const insert = db.query("INSERT INTO workflow_statuses (team_id, key, name, category, color, position) VALUES (?, ?, ?, ?, ?, ?)");
    for (const s of DEFAULT_WORKFLOW) insert.run(id, s.key, s.name, s.category, s.color, s.position);
  })();
  changed("team", workspace, key);
  return toTeam(teamRow(a, key));
}

/** A team setting's switch, stored as 0 or 1. */
function checkFlag(value: unknown, field: string): number {
  if (typeof value !== "boolean") throw new AppError(`${field} must be true or false`);
  return value ? 1 : 0;
}

/** How long after completedAt a team auto-archives an issue: null (never), else a positive whole number of days. */
function checkAutoArchiveDays(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new AppError("autoArchiveDays must be a positive whole number of days, or null for never");
  }
  return value;
}

/**
 * Renames or redescribes a team, sets where its new issues start (a backlog or unstarted status), or switches
 * auto-close. Teams never change workspace: their issues, people and links belong to it.
 */
export function updateTeam(a: Actor, key: string, patch: TeamPatch & { workspace?: unknown }): Team {
  requirePerson(a, NO_AGENT_TEAMS);
  const row = teamRow(a, key);
  if (patch.workspace !== undefined && patch.workspace !== row.workspace) throw new AppError("Teams can't move between workspaces");
  const name = patch.name === undefined ? row.name : requireText(patch.name, "name");
  const description = patch.description === undefined ? row.description : optionalText(patch.description, "description");
  let defaultStatus = row.default_status;
  if (patch.defaultStatus !== undefined) {
    const status = statusOf(row, patch.defaultStatus);
    if (status.category !== "backlog" && status.category !== "unstarted") throw new AppError("The default status must be in Backlog or Unstarted");
    defaultStatus = status.key;
  }
  const autoCloseParent = patch.autoCloseParent === undefined ? row.auto_close_parent : checkFlag(patch.autoCloseParent, "autoCloseParent");
  const autoCloseChildren = patch.autoCloseChildren === undefined ? row.auto_close_children : checkFlag(patch.autoCloseChildren, "autoCloseChildren");
  const autoArchiveDays = patch.autoArchiveDays === undefined ? row.auto_archive_days : checkAutoArchiveDays(patch.autoArchiveDays);
  db.query(
    "UPDATE teams SET name = ?, description = ?, default_status = ?, auto_close_parent = ?, auto_close_children = ?, auto_archive_days = ?, updated_at = ? WHERE id = ?",
  ).run(name, description, defaultStatus, autoCloseParent, autoCloseChildren, autoArchiveDays, now(), row.id);
  changed("team", row.workspace, row.key);
  return toTeam(teamRow(a, row.key));
}

// --- Workflows: each team's statuses (Linear's), in fixed categories; issues hold a status's key ---

type StatusRow = WorkflowStatus & { id: number };
type TeamRef = { id: number; key: string };

const teamStatuses = (teamId: number) =>
  db.query<StatusRow, [number]>(`SELECT id, key, name, category, color, position FROM workflow_statuses WHERE team_id = ? ${WORKFLOW_ORDER}`).all(teamId);

const isClosed = (category: StatusCategory | null) => !!category && CLOSED_CATEGORIES.includes(category);

/** A status of the team, by key, else by name, case-insensitively; anything else is 400 naming the team's keys. */
function statusOf(team: TeamRef, value: unknown): StatusRow {
  const statuses = teamStatuses(team.id);
  const given = typeof value === "string" ? value.trim().toLowerCase() : "";
  const found = statuses.find((s) => s.key === given) ?? statuses.find((s) => s.name.toLowerCase() === given);
  if (!found) throw new AppError(`Invalid status "${value}" for ${team.key}. Use one of: ${statuses.map((s) => s.key).join(", ")}`);
  return found;
}

/** Where a team's work goes when it's a duplicate: its Duplicate status, else its first canceled one. */
const duplicateStatus = (teamId: number) =>
  db
    .query<{ key: string }, [number, string]>(
      "SELECT key FROM workflow_statuses WHERE team_id = ? AND category = 'canceled' ORDER BY key = ? DESC, position, id LIMIT 1",
    )
    .get(teamId, DUPLICATE_STATUS)!.key;

const CATEGORY_NAMES: Record<StatusCategory, string> = {
  triage: "Triage",
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  completed: "Completed",
  canceled: "Canceled",
};

/** A workflow change: people only (like the rest of team settings), in the request's workspace (else 404). */
function workflowTeam(a: Actor, key: unknown): TeamRow {
  requirePerson(a, "Only people can change a workflow");
  return teamRow(a, key);
}

function workflowStatus(team: TeamRow, key: unknown): StatusRow {
  const given = typeof key === "string" ? key.trim().toLowerCase() : "";
  const status = teamStatuses(team.id).find((s) => s.key === given);
  if (!status) throw new AppError(`Status ${key} not found in ${team.key}`, 404);
  return status;
}

/** A status name, unique in the team case-insensitively (409). */
function statusName(team: TeamRow, value: unknown, self?: number): string {
  const name = requireText(value, "name");
  const clash = teamStatuses(team.id).find((s) => s.id !== self && s.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new AppError(`${team.key} already has a status named ${clash.name}`, 409);
  return name;
}

function checkColor(value: unknown): string {
  const color = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new AppError(`Invalid color "${value}": use #rrggbb, e.g. #5e6ad2`);
  return color;
}

/**
 * Adds a status to a team's workflow, last in its category unless `position` says otherwise. Its key is derived
 * from the name ("In QA" → in_qa) unless given, and never changes. A team has at most one triage status: adding
 * it turns Triage on.
 */
export function createStatus(a: Actor, teamKey: string, input: WorkflowStatusInput): Team {
  const team = workflowTeam(a, teamKey);
  const category = checkOneOf(input.category, STATUS_CATEGORIES, "category");
  const statuses = teamStatuses(team.id);
  const triage = category === "triage";
  if (triage && statuses.some((s) => s.category === "triage")) throw new AppError(`${team.key} already has Triage`, 409);
  const name = statusName(team, input.name ?? (triage ? "Triage" : undefined));
  const color = input.color === undefined ? CATEGORY_COLORS[category] : checkColor(input.color);
  const position =
    input.position === undefined ? Math.max(0, ...statuses.filter((s) => s.category === category).map((s) => s.position)) + 1 : checkPosition(input.position);
  const taken = (key: string) => statuses.some((s) => s.key === key);
  let key: string;
  if (input.key !== undefined || triage) {
    key = input.key === undefined ? "triage" : typeof input.key === "string" ? input.key.trim().toLowerCase() : "";
    if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(key)) throw new AppError(`Invalid key "${input.key}": use a-z, 0-9 and single underscores, e.g. "in_qa"`);
    if (taken(key)) throw new AppError(`${team.key} already has a status with the key ${key}`, 409);
  } else {
    key = pickSlug(undefined, name, (slug) => taken(slug.replace(/-/g, "_")), { label: "key", fallback: "status" }).replace(/-/g, "_");
  }
  db.query("INSERT INTO workflow_statuses (team_id, key, name, category, color, position) VALUES (?, ?, ?, ?, ?, ?)").run(
    team.id,
    key,
    name,
    category,
    color,
    position,
  );
  changed("team", team.workspace, team.key);
  return toTeam(teamRow(a, team.key));
}

/** Renames, recolors or moves a status within its category. Its key and category never change; Duplicate never does. */
export function updateStatus(a: Actor, teamKey: string, key: string, patch: WorkflowStatusPatch): Team {
  const team = workflowTeam(a, teamKey);
  const status = workflowStatus(team, key);
  if (status.key === DUPLICATE_STATUS) throw new AppError("Duplicate is a system status: it can't be changed");
  const name = patch.name === undefined ? status.name : statusName(team, patch.name, status.id);
  const color = patch.color === undefined ? status.color : checkColor(patch.color);
  const position = patch.position === undefined ? status.position : checkPosition(patch.position);
  db.query("UPDATE workflow_statuses SET name = ?, color = ?, position = ? WHERE id = ?").run(name, color, position, status.id);
  changed("team", team.workspace, team.key);
  return toTeam(teamRow(a, team.key));
}

/**
 * Deletes a status. Never Duplicate, the default status, or the last one of a category (triage aside: deleting
 * it turns Triage off). Issues in it, trashed ones too, need `moveTo`, another status of the team: they move in
 * one transaction, each as its own status change would (history, completedAt by category, notifications, webhooks).
 */
export function deleteStatus(a: Actor, teamKey: string, key: string, moveTo?: string): Team {
  const team = workflowTeam(a, teamKey);
  const status = workflowStatus(team, key);
  if (status.key === DUPLICATE_STATUS) throw new AppError("Duplicate is a system status: it can't be deleted");
  if (status.key === team.default_status) throw new AppError(`${status.name} is the default status: make another status the default first`, 409);
  const statuses = teamStatuses(team.id);
  const others = statuses.filter((s) => s.id !== status.id);
  if (status.category !== "triage" && !others.some((s) => s.category === status.category && s.key !== DUPLICATE_STATUS)) {
    throw new AppError(`${status.name} is the last ${CATEGORY_NAMES[status.category]} status: add another first`, 409);
  }
  const target = moveTo === undefined ? undefined : others.find((s) => s.key === String(moveTo).trim().toLowerCase());
  if (moveTo !== undefined && !target) throw new AppError(`moveTo: "${moveTo}" isn't another status of ${team.key}`);
  const time = now();
  const refs = db.transaction(() => {
    const issues = db.query<{ id: number }, [number, string]>("SELECT id FROM issues WHERE team_id = ? AND status = ? ORDER BY id").all(team.id, status.key);
    if (issues.length && !target) {
      throw new AppError(`${issues.length} ${issues.length === 1 ? "issue is" : "issues are"} ${status.name}: pass moveTo`, 409);
    }
    // completedAt changes only when the category crosses into or out of completed/canceled.
    const closing = isClosed(target?.category ?? null);
    const keep = closing === isClosed(status.category) ? 1 : 0;
    const move = db.query(`UPDATE issues SET status = ?, completed_at = CASE WHEN ? THEN completed_at ELSE ? END, ${BUMPED_AT} WHERE id = ?`);
    for (const { id } of issues) {
      move.run(target!.key, keep, closing ? time : null, time, time, id);
      logActivity(a, id, team.workspace, [{ kind: "status", from: status.key, to: target!.key }], time);
    }
    db.query("DELETE FROM workflow_statuses WHERE id = ?").run(status.id);
    return issues.map(({ id }) => ownerRef("issue", id));
  }).immediate();
  changed("team", team.workspace, team.key);
  for (const ref of refs) changed("issue", team.workspace, ref);
  return toTeam(teamRow(a, team.key));
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
  status: string; // a key of its team's workflow
  status_category: StatusCategory;
  status_position: number;
  priority: Priority;
  label_paths: string; // JSON array of its labels' paths (issues.labels is legacy: migration 17 moved it to issue_labels)
  parent: string | null; // identifier
  blocked_by: string; // JSON array of identifiers
  related_to: string; // JSON array of identifiers
  duplicate_of: string | null; // identifier
  previous_identifiers: string; // JSON array of identifiers it had before it moved team
  due_on: string | null; // "YYYY-MM-DD"
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
  archived_at: string | null;
};

/** An issue's identifier in SQL, from its team's alias and its own: BRD-12. */
const ident = (team: string, issue: string) => `${team}.key || '-' || ${issue}.number`;

const ISSUE_SELECT = `
  SELECT i.*, t.key AS team_key, t.workspace, ws.category AS status_category, ws.position AS status_position, ${ident("pt", "p")} AS parent,
    ${userCols("ua", "assignee")}, ${userCols("ud", "delegate")}, ${userCols("uc", "creator")},
    (SELECT json_group_array(path) FROM (
      SELECT ${LABEL_PATH} AS path FROM issue_labels x JOIN labels l ON l.id = x.label_id LEFT JOIN labels g ON g.id = l.parent_id
      WHERE x.issue_id = i.id ORDER BY path COLLATE NOCASE
    )) AS label_paths,
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
      WHERE x.kind = 'duplicate' AND x.from_id = i.id AND d.deleted_at IS NULL) AS duplicate_of,
    (SELECT json_group_array(ref) FROM (
      SELECT ${ident("at", "a")} AS ref FROM issue_aliases a JOIN teams at ON at.id = a.team_id WHERE a.issue_id = i.id ORDER BY a.created_at, at.key, a.number
    )) AS previous_identifiers
  FROM issues i
  JOIN teams t ON t.id = i.team_id
  LEFT JOIN workflow_statuses ws ON ws.team_id = i.team_id AND ws.key = i.status
  ${userJoin("uc", "i.creator_id", "t.workspace")}
  ${userJoin("ua", "i.assignee_id", "t.workspace")}
  ${userJoin("ud", "i.delegate_id", "t.workspace")}
  LEFT JOIN issues p ON p.id = i.parent_id
  LEFT JOIN teams pt ON pt.id = p.team_id`;

// Status category order, then the team's order within it, then priority 1→4 with 0 (none) last, then most
// recently updated. The first three keys are also what a page cursor records (with updated_at and id), so pages
// resume exactly where they stopped.
const STATUS_RANK = categoryRank("ws.category");
const STATUS_POSITION = "COALESCE(ws.position, 0)";
const PRIORITY_RANK = "CASE i.priority WHEN 0 THEN 5 ELSE i.priority END";
const DEFAULT_ORDER = `${STATUS_RANK}, ${STATUS_POSITION}, ${PRIORITY_RANK}, i.updated_at DESC, i.id DESC`;
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
  statusCategory: row.status_category,
  priority: row.priority,
  labels: JSON.parse(row.label_paths),
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
  previousIdentifiers: JSON.parse(row.previous_identifiers),
  archivedAt: row.archived_at,
});

/**
 * An issue's row id by identifier parts in `workspace`: its current identifier, else one it had before it moved team
 * (numbers are never reused, so the two never clash).
 */
function findIssue(workspace: string, key: string, number: number): number | null {
  return (
    db
      .query<{ id: number }, [string, string, number]>(
        `SELECT i.id FROM issues i JOIN teams t ON t.id = i.team_id WHERE t.workspace = ?1 AND t.key = ?2 AND i.number = ?3
         UNION ALL SELECT a.issue_id FROM issue_aliases a JOIN teams t ON t.id = a.team_id WHERE t.workspace = ?1 AND t.key = ?2 AND a.number = ?3`,
      )
      .get(workspace, key, number)?.id ?? null
  );
}

/**
 * Resolves an identifier like "brd-12" in the request's workspace to the issue's row id; 404 if it isn't there. An
 * identifier it had before it moved team resolves too; `ref` is always its current one. Trashed and archived issues
 * resolve too (to read, restore or unarchive them); `liveIssue` is for everything that changes one.
 */
function issueRef(
  a: Actor,
  identifier: unknown,
): { id: number; workspace: string; deleted_at: string | null; archived_at: string | null; ref: string; team: TeamRef } {
  const match = typeof identifier === "string" ? /^([a-z]{2,5})-(\d+)$/i.exec(identifier.trim()) : null;
  if (!match) throw new AppError(`Invalid issue identifier "${identifier}" (expected e.g. BRD-12)`);
  const key = match[1]!.toUpperCase();
  const number = Number(match[2]);
  const id = findIssue(requestWorkspace(a), key, number);
  if (id === null) throw new AppError(`Issue ${key}-${number} not found`, 404);
  const row = db
    .query<{ workspace: string; deleted_at: string | null; archived_at: string | null; team_id: number; key: string; number: number }, [number]>(
      "SELECT t.workspace, i.deleted_at, i.archived_at, i.team_id, t.key, i.number FROM issues i JOIN teams t ON t.id = i.team_id WHERE i.id = ?",
    )
    .get(id)!;
  return {
    id,
    workspace: row.workspace,
    deleted_at: row.deleted_at,
    archived_at: row.archived_at,
    ref: `${row.key}-${row.number}`,
    team: { id: row.team_id, key: row.key },
  };
}

/** An issue that isn't in the trash or archived: either one is read-only, nothing else. */
function liveIssue(a: Actor, identifier: unknown) {
  const issue = issueRef(a, identifier);
  if (issue.deleted_at) throw new AppError(`${issue.ref} is in the trash; restore it first`, 409);
  if (issue.archived_at) throw new AppError(`${issue.ref} is archived; unarchive it first`, 409);
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

/** Validates the patch fields that map directly to issue columns; a status must be one of the team's (by key or name). */
function issueColumns(a: Actor, workspace: string, team: TeamRef, patch: IssuePatch): Record<string, SQLQueryBindings> {
  const cols: Record<string, SQLQueryBindings> = {};
  if (patch.title !== undefined) cols.title = requireText(patch.title, "title");
  if (patch.description !== undefined) cols.description = optionalText(patch.description, "description");
  if (patch.status !== undefined) cols.status = statusOf(team, patch.status).key;
  if (patch.priority !== undefined) cols.priority = checkPriority(patch.priority);
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

/**
 * WHERE conditions shared by the issue and doc lists (both join their team as `t`): the request's workspace,
 * a team, and a substring search over `searched` (the query's own %, _ and \ match literally). Issues (alias
 * "i") also leave out archived ones by default, unless `archived` is passed or `q` is set (still searchable).
 */
function listScope(a: Actor, alias: string, filter: { team?: string; q?: string; archived?: boolean }, searched: string[]) {
  const workspace = requestWorkspace(a);
  const where = ["t.workspace = ?", `${alias}.deleted_at IS NULL`];
  if (alias === "i" && !filter.q && !filter.archived) where.push("i.archived_at IS NULL");
  const params: SQLQueryBindings[] = [workspace];
  let teamId: number | null = null;
  if (filter.team) {
    const team = db
      .query<{ id: number }, [string, string]>("SELECT id FROM teams WHERE workspace = ? AND key = ?")
      .get(workspace, filter.team.trim().toUpperCase());
    if (!team) throw new AppError(`Unknown team "${filter.team}"`);
    where.push(`${alias}.team_id = ?`);
    params.push(team.id);
    teamId = team.id;
  }
  if (filter.q) {
    where.push(`(${searched.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    params.push(...searched.map(() => `%${filter.q!.trim().replace(/[\\%_]/g, "\\$&")}%`));
  }
  return { where, params, workspace, teamId };
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
 * Page cursors: the last row's sort keys (category rank, status position, priority rank, updated_at, id, due_on),
 * opaque to clients. They carry every order's keys, so a cursor resumes in either order.
 */
type Cursor = [number, number, number, string, number, string | null];
const cursorOf = (row: IssueRow) => {
  const rank = STATUS_CATEGORIES.indexOf(row.status_category);
  const keys = [rank < 0 ? STATUS_CATEGORIES.length : rank, row.status_position ?? 0, row.priority || 5, row.updated_at, row.id, row.due_on];
  return Buffer.from(JSON.stringify(keys)).toString("base64url");
};

function parseCursor(cursor: string): Cursor {
  try {
    const keys = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      Array.isArray(keys) &&
      keys.length === 6 &&
      typeof keys[1] === "number" &&
      Number.isFinite(keys[1]) &&
      typeof keys[3] === "string" &&
      [0, 2, 4].every((i) => Number.isInteger(keys[i])) &&
      (keys[5] === null || typeof keys[5] === "string")
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
  return { issues: issues.map(toSummary), pageInfo: { hasNextPage, endCursor: last ? cursorOf(last) : null } };
}

// Linear's due-date filters, by the server's date (SQLite's date('now'), UTC). Finished work (completed or canceled) is never overdue.
const DUE_WHERE: Record<(typeof DUE_FILTERS)[number], string> = {
  overdue: `i.due_on < date('now') AND ws.category NOT IN (${CLOSED_CATEGORIES.map((c) => `'${c}'`).join(", ")})`,
  soon: "i.due_on BETWEEN date('now') AND date('now', '+7 days')",
  today: "i.due_on = date('now')",
  any: "i.due_on IS NOT NULL",
  none: "i.due_on IS NULL",
};

function queryIssues(a: Actor, filter: IssueFilter, after?: Cursor, limit?: number): IssueRow[] {
  const { where, params, workspace, teamId } = listScope(a, "i", filter, ["i.title", "i.description", ident("t", "i")]);
  if (filter.status?.length) {
    // Each key must be a status of some team in scope: a typo shouldn't look like "no issues".
    const known = db
      .query<{ key: string }, SQLQueryBindings[]>(
        `SELECT DISTINCT w.key FROM workflow_statuses w JOIN teams t ON t.id = w.team_id WHERE t.workspace = ?${teamId === null ? "" : " AND t.id = ?"}`,
      )
      .all(workspace, ...(teamId === null ? [] : [teamId]))
      .map((r) => r.key);
    const keys = filter.status.map((s) => String(s).trim().toLowerCase());
    const unknown = filter.status.find((_, n) => !known.includes(keys[n]!));
    if (unknown !== undefined) throw new AppError(`Unknown status "${unknown}"`);
    where.push(`i.status IN (${inList(keys)})`);
    params.push(...keys);
  }
  if (filter.category?.length) {
    where.push(`ws.category IN (${inList(filter.category)})`);
    params.push(...filter.category.map((c) => checkOneOf(c, STATUS_CATEGORIES, "category")));
  }
  if (filter.label) {
    // A label's name or path, or a group's name (any of its labels).
    where.push(
      `EXISTS (SELECT 1 FROM issue_labels x JOIN labels l ON l.id = x.label_id LEFT JOIN labels g ON g.id = l.parent_id
       WHERE x.issue_id = i.id AND (l.name = ? COLLATE NOCASE OR g.name = ? COLLATE NOCASE OR ${LABEL_PATH} = ? COLLATE NOCASE))`,
    );
    params.push(filter.label, filter.label, filter.label);
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
    const [s, o, p, u, id, due] = after;
    const byPriority = `(${PRIORITY_RANK} > ? OR (${PRIORITY_RANK} = ? AND (i.updated_at < ? OR (i.updated_at = ? AND i.id < ?))))`;
    let rest = `(${STATUS_RANK} > ? OR (${STATUS_RANK} = ? AND (${STATUS_POSITION} > ? OR (${STATUS_POSITION} = ? AND ${byPriority}))))`;
    const restParams: SQLQueryBindings[] = [s, s, o, o, p, p, u, u, id];
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

// Kinds whose values aren't stored: `created`, the trash and archiving have none, and descriptions aren't diffed.
const NO_VALUES: ActivityKind[] = ["created", "description", "trashed", "restored", "archived", "unarchived"];

/**
 * Whether moving an issue into this status tells its subscribers: work finished or dropped (the completed and
 * canceled categories, Duplicate included), or handed over for review (the key in_review, where the team has it).
 */
function announced(issueId: number, status: string): boolean {
  if (status === "in_review") return true;
  const row = db
    .query<{ category: StatusCategory }, [string, number]>(
      "SELECT w.category FROM issues i JOIN workflow_statuses w ON w.team_id = i.team_id AND w.key = ? WHERE i.id = ?",
    )
    .get(status, issueId);
  return isClosed(row?.category ?? null);
}

/**
 * Records a mutation's changes, one row each, at its `time`. Call it once per mutation, as the last statement
 * of its transaction, so whatever runs here later sees the final state and rolls back with the change.
 * Values as they are in memory (users by id, parent and blockers by identifier), stored as JSON.
 * Then the inbox: creating or claiming subscribes the actor; a new assignee or delegate is subscribed and told;
 * a move into in_review or a completed or canceled status tells the subscribers. The webhook event goes first (`was`: see issueEvent).
 * `a` is the actor, or for Docket's own changes its account with `onBehalfOf`, whose change set them off.
 */
function logActivity(
  a: { id: number; onBehalfOf?: number },
  issueId: number,
  workspace: string,
  changes: Change[],
  time: string,
  was: Record<string, unknown> = {},
) {
  const insert = db.query(
    "INSERT INTO issue_activity (issue_id, actor_id, on_behalf_of_id, kind, from_value, to_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const json = (kind: ActivityKind, value: unknown) => (NO_VALUES.includes(kind) || value == null ? null : JSON.stringify(value));
  for (const { kind, from, to } of changes) insert.run(issueId, a.id, a.onBehalfOf ?? null, kind, json(kind, from), json(kind, to), time);
  if (changes.length) issueEvent(a, issueId, workspace, changes, time, was);
  const target = { issueId };
  const event = { actorId: a.id, workspace, target };
  for (const { kind, to } of changes) {
    if (kind === "created" || kind === "claimed") inbox.subscribe(a.id, target, time);
    else if ((kind === "assignee" || kind === "delegate") && typeof to === "number") {
      inbox.subscribe(to, target, time);
      inbox.notify([to], { ...event, kind: kind === "assignee" ? "assigned" : "delegated" }, time);
    } else if (kind === "status" && announced(issueId, to as string)) {
      inbox.notify(inbox.subscribers(target), { ...event, kind: "status", status: to as string }, time);
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
function issueEvent(a: { id: number }, issueId: number, workspace: string, changes: Change[], time: string, was: Record<string, unknown>) {
  const kinds = changes.map((c) => c.kind);
  const action = kinds.includes("created") ? "create" : kinds.includes("trashed") ? "remove" : "update";
  let updatedFrom: Record<string, unknown> | undefined;
  if (action === "update") {
    updatedFrom = { ...was };
    for (const { kind, from, to } of changes) {
      if (kind === "claimed") {
        if (from !== to) updatedFrom.status = from;
      } else if (kind === "restored") updatedFrom.deletedAt = from;
      else if (kind === "team") {
        const at = (from as string).lastIndexOf("-"); // a move: the identifier, team and number it had
        Object.assign(updatedFrom, { id: from, team: (from as string).slice(0, at), number: Number((from as string).slice(at + 1)) });
      } else if (kind === "archived" || kind === "unarchived") updatedFrom.archivedAt = from ?? null;
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
  ["team", (r) => `${r.team_key}-${r.number}`], // its identifier: a move changes both
  ["title", (r) => r.title],
  ["description", (r) => r.description],
  ["status", (r) => r.status],
  ["priority", (r) => r.priority],
  ["assignee", (r) => r.assignee_id],
  ["delegate", (r) => r.delegate_id],
  ["labels", (r) => JSON.parse(r.label_paths)],
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
      `SELECT x.id, x.kind, x.from_value, x.to_value, x.created_at, ${userCols("u", "a")}, ${userCols("o", "o")}
       FROM issue_activity x ${userJoin("u", "x.actor_id", "?1")} ${userJoin("o", "x.on_behalf_of_id", "?1")} WHERE x.issue_id = ?2 ORDER BY x.id`,
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
    onBehalfOf: ref(r, "o"),
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
    reactions: listReactions(row.workspace, [`issue:${id}`]).get(`issue:${id}`) ?? [],
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
    status: team.default_status,
    priority: 0,
    assignee_id: null,
    delegate_id: null,
    parent_id: null,
    due_on: null,
    ...issueColumns(a, team.workspace, team, input),
    title: requireText(input.title, "title"),
  };
  const blockers = input.blockedBy === undefined ? [] : blockerIds(a, input.blockedBy);
  const related = input.relatedTo === undefined ? [] : relatedIds(a, input.relatedTo);
  const duplicate = input.duplicateOf === undefined ? null : duplicateId(a, input.duplicateOf);
  const labels = input.labels === undefined ? [] : checkLabels(input.labels);
  if (duplicate !== null) cols.status = duplicateStatus(team.id); // a duplicate is closed, as in Linear
  const closed = isClosed(statusOf(team, cols.status).category);
  const time = now();
  const { identifier, docs, refs, created } = db.transaction(() => {
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
      completed_at: closed ? time : null,
    };
    const names = Object.keys(row);
    const { id } = db
      .query<{ id: number }, SQLQueryBindings[]>(`INSERT INTO issues (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) RETURNING id`)
      .get(...Object.values(row))!;
    const created = setIssueLabels(id, team.workspace, team, labels, time);
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
    return { identifier, docs, refs, created };
  })();
  for (const id of created) changed("label", team.workspace, String(id));
  changed("issue", team.workspace, identifier);
  for (const r of refs) changed("issue", team.workspace, r);
  for (const doc of docs) changed("document", team.workspace, doc.slug);
  return getIssue(a, identifier);
}

/** The team an issue moves to: one of its workspace's (a key resolves only there, so another workspace's team is unknown here). */
function moveTarget(a: Actor, key: unknown): TeamRow {
  try {
    return teamRow(a, key);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) throw new AppError(`Unknown team "${key}": an issue moves only to a team of its workspace`);
    throw e;
  }
}

/** Where a moved issue's status lands: the same key in its new team, else that team's first status of its category (not Duplicate), else the team's default. */
function carriedStatus(team: TeamRow, status: string, category: StatusCategory): string {
  const statuses = teamStatuses(team.id);
  const same = statuses.find((s) => s.key === status) ?? statuses.find((s) => s.category === category && s.key !== DUPLICATE_STATUS);
  return same?.key ?? team.default_status;
}

/**
 * Changes an issue. With `team`, it moves to another team of its workspace (Linear's move): it takes that team's next
 * number, its old identifier keeps resolving (issue_aliases), its status carries over (see carriedStatus) unless one is
 * given, and it loses the old team's own labels unless `labels` is given. Relations, comments, subscribers, mentions and
 * doc refs point to its row id, so they come along.
 */
export function updateIssue(a: Actor, identifier: string, patch: IssuePatch): Issue {
  const { id, workspace, team: from, ref } = liveIssue(a, identifier);
  const team = patch.team === undefined ? from : moveTarget(a, patch.team);
  const moving = team.id !== from.id;
  const cols = issueColumns(a, workspace, team, patch);
  // A new parent must not be the issue itself or one of its descendants.
  for (let p = cols.parent_id as number | null | undefined; p != null; ) {
    if (p === id) throw new AppError("An issue can't be its own parent or ancestor");
    p = db.query<{ parent_id: number | null }, [number]>("SELECT parent_id FROM issues WHERE id = ?").get(p)!.parent_id;
  }
  const blockers = patch.blockedBy === undefined ? undefined : blockerIds(a, patch.blockedBy, id);
  const relatedTo = patch.relatedTo === undefined ? undefined : relatedIds(a, patch.relatedTo, id);
  const duplicate = patch.duplicateOf === undefined ? undefined : duplicateId(a, patch.duplicateOf, id);
  const labels = patch.labels === undefined ? undefined : checkLabels(patch.labels);
  if (duplicate != null) cols.status = duplicateStatus(team.id); // marking a duplicate closes it; clearing leaves the status alone
  const time = now();
  const read = db.query<IssueRow, [number]>(`${ISSUE_SELECT} WHERE i.id = ?`);
  // IMMEDIATE holds the write lock from the read (the version check, the history's "before") to the write.
  const { refs, created } = db.transaction(() => {
    const before = read.get(id)!;
    if (patch.baseUpdatedAt !== undefined && patch.baseUpdatedAt !== before.updated_at) {
      throw new AppError("Issue changed since you read it", 409);
    }
    if (moving) {
      db.query("INSERT INTO issue_aliases (team_id, number, issue_id, created_at) VALUES (?, ?, ?, ?)").run(from.id, before.number, id, time);
      cols.team_id = team.id;
      cols.number = db
        .query<{ number: number }, [number]>("UPDATE teams SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS number")
        .get(team.id)!.number;
      cols.status ??= carriedStatus(team as TeamRow, before.status, before.status_category);
      if (!labels) db.query("DELETE FROM issue_labels WHERE issue_id = ? AND label_id IN (SELECT id FROM labels WHERE team_id = ?)").run(id, from.id);
    }
    const closing = cols.status === undefined ? undefined : isClosed(statusOf(team, cols.status).category);
    // completedAt follows the category, not the key: it changes only when entering or leaving completed/canceled.
    if (closing !== undefined && closing !== isClosed(before.status_category)) cols.completed_at = closing ? time : null;
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
    const created = labels ? setIssueLabels(id, workspace, team, labels, time) : [];
    if (blockers) setBlockers(id, blockers);
    if (relatedTo) for (const r of setRelated(id, relatedTo, time)) related.add(r);
    if (duplicate !== undefined) for (const r of setDuplicate(id, duplicate, time)) related.add(r);
    const refs = bumpIssues(related, time);
    if (cols.description !== undefined) saveMentions(a, workspace, `issue:${id}`, { issueId: id }, cols.description as string, time);
    logActivity(a, id, workspace, changes(before, read.get(id)!), time);
    const closed = closing === true && !isClosed(before.status_category) ? autoClose(a.id, id, workspace, time) : [];
    return { refs: [...refs, ...closed.map((c) => ownerRef("issue", c))], created };
  }).immediate();
  // The team may now have old closed issues past their auto-archive window (see Auto-archive).
  if (cols.completed_at) autoArchive();
  const issue = getIssue(a, identifier);
  for (const label of created) changed("label", workspace, String(label));
  if (moving) changed("issue", workspace, ref); // lists showing it under its old identifier
  changed("issue", workspace, issue.id);
  for (const r of new Set(refs)) changed("issue", workspace, r);
  return issue;
}

// --- Auto-close (Linear's per-team settings) ---

type IssueNode = { id: number; status: string; category: StatusCategory; team_id: number; parent_id: number | null; deleted_at: string | null };
const NODE_SELECT = `SELECT i.id, i.status, ws.category, i.team_id, i.parent_id, i.deleted_at FROM issues i
  JOIN workflow_statuses ws ON ws.team_id = i.team_id AND ws.key = i.status`;
const CLOSED_SQL = `(${CLOSED_CATEGORIES.map((c) => `'${c}'`).join(", ")})`;
const teamFlag = (teamId: number, flag: "auto_close_parent" | "auto_close_children") =>
  db.query<{ on: number }, [number]>(`SELECT ${flag} AS "on" FROM teams WHERE id = ?`).get(teamId)!.on === 1;

/**
 * What closing issue `id` sets off, in the same transaction, each change made by Docket on behalf of `by`: when its
 * team auto-closes sub-issues, its live open sub-issues close to the same status (their own team's: the same key, else
 * the first of that category that isn't Duplicate); when its parent's team auto-closes parents and every live sub-issue
 * of the parent is now completed or canceled, the parent closes to its team's first completed status. Each close sets
 * off the same, so it cascades down the tree and up the chain (both acyclic). Reopening sets off nothing. Returns the
 * ids it closed.
 */
function autoClose(by: number, id: number, workspace: string, time: string): number[] {
  const node = db.query<IssueNode, [number]>(`${NODE_SELECT} WHERE i.id = ?`);
  const closed: number[] = [];
  const close = (issue: IssueNode, status: string) => {
    db.query(`UPDATE issues SET status = ?, completed_at = ?, ${BUMPED_AT} WHERE id = ?`).run(status, time, time, time, issue.id);
    logActivity({ id: systemUserId(), onBehalfOf: by }, issue.id, workspace, [{ kind: "status", from: issue.status, to: status }], time);
    closed.push(issue.id);
    cascade(issue.id);
  };
  const cascade = (from: number) => {
    const issue = node.get(from)!;
    if (teamFlag(issue.team_id, "auto_close_children")) {
      const open = db.query<IssueNode, [number]>(`${NODE_SELECT} WHERE i.parent_id = ? AND i.deleted_at IS NULL AND ws.category NOT IN ${CLOSED_SQL} ORDER BY i.id`);
      for (const child of open.all(from)) {
        const statuses = teamStatuses(child.team_id).filter((s) => s.category === issue.category && s.key !== DUPLICATE_STATUS);
        close(child, (statuses.find((s) => s.key === issue.status) ?? statuses[0]!).key);
      }
    }
    const parent = issue.parent_id === null ? null : node.get(issue.parent_id)!;
    if (!parent || parent.deleted_at || isClosed(parent.category) || !teamFlag(parent.team_id, "auto_close_parent")) return;
    const stillOpen = db.query(`${NODE_SELECT} WHERE i.parent_id = ? AND i.deleted_at IS NULL AND ws.category NOT IN ${CLOSED_SQL} LIMIT 1`).get(parent.id);
    if (!stillOpen) close(parent, teamStatuses(parent.team_id).find((s) => s.category === "completed")!.key);
  };
  cascade(id);
  return closed;
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

/**
 * Archives an issue or brings it back (Linear's auto-archive, done by hand or by `autoArchive`): a single flag,
 * `archived_at`, that only changes default-view visibility (see `listScope`) — unlike the trash, it touches no
 * label, count, relation, comment or doc ref, and never expires anything. Works on a live issue only (trashed:
 * 409, restore it first); an archived one is otherwise read-only, like a trashed one (`liveIssue`).
 */
function setArchived(a: Actor, identifier: string, archive: boolean): Issue {
  const issue = issueRef(a, identifier);
  if (issue.deleted_at) throw new AppError(`${issue.ref} is in the trash; restore it first`, 409);
  if (!!issue.archived_at === archive) throw new AppError(archive ? `${issue.ref} is already archived` : `${issue.ref} isn't archived`, 409);
  const time = now();
  db.transaction(() => {
    db.query(`UPDATE issues SET archived_at = ?, ${BUMPED_AT} WHERE id = ?`).run(archive ? time : null, time, time, issue.id);
    logActivity(a, issue.id, issue.workspace, [archive ? { kind: "archived" } : { kind: "unarchived", from: issue.archived_at }], time);
  })();
  changed("issue", issue.workspace, issue.ref);
  return getIssue(a, identifier);
}

export const archiveIssue = (a: Actor, identifier: string) => setArchived(a, identifier, true);
export const unarchiveIssue = (a: Actor, identifier: string) => setArchived(a, identifier, false);

/**
 * Sweeps every team with `autoArchiveDays` set: archives its live, unarchived issues whose `completedAt` is
 * older than that many days, attributed to @docket with no `onBehalfOf` (a time-based sweep, not set off by
 * anyone's own change). Run at startup and after any `updateIssue` call that closes an issue, so a team's
 * backlog of already-old closed issues is swept the next time something in it changes.
 */
function autoArchive() {
  const time = now();
  const due = db
    .query<{ id: number; workspace: string; ref: string }, []>(
      `SELECT i.id, t.workspace, ${ident("t", "i")} AS ref FROM issues i JOIN teams t ON t.id = i.team_id
       WHERE t.auto_archive_days IS NOT NULL AND i.deleted_at IS NULL AND i.archived_at IS NULL
         AND i.completed_at IS NOT NULL AND i.completed_at < datetime('now', '-' || t.auto_archive_days || ' days')`,
    )
    .all();
  if (!due.length) return;
  const by = systemUserId();
  db.transaction(() => {
    for (const issue of due) {
      db.query(`UPDATE issues SET archived_at = ?, ${BUMPED_AT} WHERE id = ?`).run(time, time, time, issue.id);
      logActivity({ id: by }, issue.id, issue.workspace, [{ kind: "archived" }], time);
    }
  })();
  for (const issue of due) changed("issue", issue.workspace, issue.ref);
}

const MAX_BULK = 100;
const BULK_FIELDS = ["status", "priority", "assignee", "delegate", "labels", "addLabels", "removeLabels"];

/**
 * One change for many issues (the list's multi-select). Each goes through `updateIssue`/`deleteIssue` on its
 * own, with its own transaction, history, notifications, webhooks and change event, exactly like N single
 * edits; one that fails (not found, in the trash, an unknown assignee) reports its error and the rest apply.
 */
export function bulkUpdateIssues(a: Actor, ids: unknown, patch: unknown): BulkIssueResult[] {
  if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === "string")) {
    throw new AppError("ids must be a non-empty array of issue identifiers");
  }
  if (ids.length > MAX_BULK) throw new AppError(`Select at most ${MAX_BULK} issues`);
  if (typeof patch !== "object" || patch === null || Array.isArray(patch) || !Object.keys(patch).length) {
    throw new AppError("patch must be an object with something to change");
  }
  const remove = "delete" in patch;
  if (remove && (patch.delete !== true || Object.keys(patch).length > 1)) throw new AppError("patch.delete must be true, on its own");
  for (const field of Object.keys(patch)) {
    if (!remove && !BULK_FIELDS.includes(field)) throw new AppError(`Unknown field "${field}" for a bulk edit: use ${BULK_FIELDS.join(", ")} or delete`);
  }
  const { addLabels, removeLabels, ...edit } = patch as IssuePatch & { addLabels?: unknown; removeLabels?: unknown };
  const add = addLabels === undefined ? [] : checkLabels(addLabels);
  const drop = removeLabels === undefined ? [] : checkLabels(removeLabels);
  type Own = { path: string; name: string; group: string | null };
  const labelsOf = db.query<Own, [number]>(
    `SELECT ${LABEL_PATH} AS path, l.name, g.name AS "group" FROM issue_labels x JOIN labels l ON l.id = x.label_id LEFT JOIN labels g ON g.id = l.parent_id
     WHERE x.issue_id = ?`,
  );
  const same = (x: string, y: string) => fold(x) === fold(y);
  // Adding Group/Label swaps out the issue's label of that group, as the picker does.
  const swapped = add.filter((l) => l.includes("/")).map((l) => l.slice(0, l.indexOf("/")).trim());
  // This issue's labels after the edit: `labels` (or its own), minus `removeLabels` (a path, or a grouped label's
  // name), plus `addLabels`.
  const labels = (id: string): string[] => {
    const own: Own[] = edit.labels !== undefined ? checkLabels(edit.labels).map((path) => ({ path, name: path, group: null })) : labelsOf.all(issueRef(a, id).id);
    const dropped = (l: Own) =>
      drop.some((d) => same(d, l.path) || (l.group !== null && same(d, l.name))) || (l.group !== null && swapped.some((g) => same(g, l.group!)));
    return [...own.filter((l) => !dropped(l)).map((l) => l.path), ...add.filter((l) => !drop.some((d) => same(d, l)))];
  };
  const relabel = addLabels !== undefined || removeLabels !== undefined;
  return [...new Set(ids as string[])].map((id): BulkIssueResult => {
    try {
      if (remove) return { id, issue: deleteIssue(a, id) };
      return { id, issue: updateIssue(a, id, relabel ? { ...edit, labels: labels(id) } : edit) };
    } catch (e) {
      if (e instanceof AppError) return { id, error: e.message, status: e.status };
      console.error(e);
      return { id, error: "Internal server error", status: 500 };
    }
  });
}

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
 * Takes an open issue: a person as its assignee, an agent as its delegate. One not started yet (the triage,
 * backlog and unstarted categories) moves to the team's first started status (in_progress by default); one
 * already started keeps its status, as in Linear. Refused (409, naming them) if it's completed or canceled or
 * another active member holds that slot. IMMEDIATE takes the write lock before the read, so of two claims racing
 * for a free issue exactly one wins. Claiming your own started issue is a no-op.
 */
export function claimIssue(a: Actor, identifier: string): Issue {
  const { id, workspace, team } = liveIssue(a, identifier);
  const slot = a.kind === "person" ? "assignee_id" : "delegate_id";
  const time = now();
  const claimed = db.transaction(() => {
    const row = db
      .query<{ status: string; category: StatusCategory; holder: number | null; username: string | null; active: number; ref: string }, [string, number]>(
        `SELECT i.status, ws.category, i.${slot} AS holder, m.username, ${ident("t", "i")} AS ref, (m.user_id IS NOT NULL AND m.suspended_at IS NULL) AS active
         FROM issues i JOIN teams t ON t.id = i.team_id
         LEFT JOIN workflow_statuses ws ON ws.team_id = i.team_id AND ws.key = i.status
         LEFT JOIN workspace_members m ON m.user_id = i.${slot} AND m.workspace = ? WHERE i.id = ?`,
      )
      .get(workspace, id)!;
    if (isClosed(row.category)) throw new AppError(`${row.ref} is ${row.status}`, 409);
    if (row.holder !== null && row.holder !== a.id && row.active) {
      throw new AppError(`${row.ref} is claimed by ${row.username}`, 409);
    }
    const started = row.category === "started";
    if (row.holder === a.id && started) return false;
    const status = started ? row.status : teamStatuses(team.id).find((s) => s.category === "started")!.key;
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

export const addComment = (a: Actor, identifier: string, body: unknown, parent?: unknown) =>
  changeIssueComments(a, identifier, (id, time, workspace) => insertComment(a, "issue", id, workspace, body, time, parent));

export const updateIssueComment = (a: Actor, identifier: string, commentId: unknown, body: unknown) =>
  changeIssueComments(a, identifier, (id, time, workspace) => updateComment(a, "issue", id, workspace, commentId, body, time));

export const deleteIssueComment = (a: Actor, identifier: string, commentId: unknown) =>
  changeIssueComments(a, identifier, (id, time, workspace) => deleteComment(a, "issue", id, workspace, commentId, time));

export const resolveIssueThread = (a: Actor, identifier: string, commentId: unknown, resolved: boolean) =>
  changeIssueComments(a, identifier, (id, time, workspace) => resolveThread(a, "issue", id, workspace, commentId, resolved, time));

/** Adds or removes your reaction on an issue's description. Doesn't bump updated_at or notify anyone. */
export function reactToIssue(a: Actor, identifier: string, emoji: unknown, on: boolean): Issue {
  const { id, workspace } = liveIssue(a, identifier);
  setReaction(a, `issue:${id}`, { issueId: id }, emoji, on, now());
  const issue = getIssue(a, identifier);
  changed("issue", workspace, issue.id);
  return issue;
}

/** Adds or removes your reaction on a comment of this issue (404 if `commentId` isn't one). Doesn't bump updated_at. */
export function reactToIssueComment(a: Actor, identifier: string, commentId: unknown, emoji: unknown, on: boolean): Issue {
  const { id, workspace } = liveIssue(a, identifier);
  const { id: cid } = commentRow("issue", id, workspace, commentId);
  setReaction(a, `${COMMENTS.issue.source}:${cid}`, { issueId: id }, emoji, on, now());
  const issue = getIssue(a, identifier);
  changed("issue", workspace, issue.id);
  return issue;
}

/** Follows or unfollows an issue; it sticks until you create, claim, comment on or are assigned, delegated or mentioned in it. */
export function subscribeIssue(a: Actor, identifier: string, on: boolean): Issue {
  const issue = liveIssue(a, identifier);
  if (on) inbox.subscribe(a.id, { issueId: issue.id }, now());
  else inbox.unsubscribe(a.id, { issueId: issue.id });
  changed("issue", issue.workspace, issue.ref, a.id);
  return getIssue(a, identifier);
}

// --- Labels: a workspace's or one team's own, optionally in a group (one level); issues name them by path ---

type LabelRow = {
  id: number;
  workspace: string;
  team_id: number | null;
  team_key: string | null;
  parent_id: number | null;
  name: string;
  group_name: string | null;
  path: string;
  color: string;
  is_group: number;
  created_at: string;
};

const LABEL_COLUMNS = `l.id, l.workspace, l.team_id, t.key AS team_key, l.parent_id, l.name, g.name AS group_name, ${LABEL_PATH} AS path,
  l.color, l.is_group, l.created_at`;
const LABEL_FROM = "FROM labels l LEFT JOIN labels g ON g.id = l.parent_id LEFT JOIN teams t ON t.id = l.team_id";
const LABEL_SELECT = `SELECT ${LABEL_COLUMNS} ${LABEL_FROM}`;
// Plus `open`: live issues outside the completed and canceled categories carrying it (a group: any of its labels).
const LABEL_SELECT_OPEN = `SELECT ${LABEL_COLUMNS},
    (SELECT COUNT(DISTINCT x.issue_id) FROM issue_labels x JOIN labels o ON o.id = x.label_id JOIN issues i ON i.id = x.issue_id
     LEFT JOIN workflow_statuses ws ON ws.team_id = i.team_id AND ws.key = i.status
     WHERE (o.id = l.id OR o.parent_id = l.id) AND i.deleted_at IS NULL
       AND COALESCE(ws.category, '') NOT IN (${CLOSED_CATEGORIES.map((c) => `'${c}'`).join(", ")})) AS open
  ${LABEL_FROM}`;

/** Names and paths compare case-insensitively. */
const fold = (s: string) => s.toLowerCase();

const toLabel = (r: LabelRow & { open: number }): Label => ({
  id: r.id,
  workspace: r.workspace,
  team: r.team_key,
  name: r.name,
  path: r.path,
  group: r.group_name,
  isGroup: r.is_group === 1,
  color: r.color,
  open: r.open,
  createdAt: r.created_at,
});

const workspaceLabels = (workspace: string) => db.query<LabelRow, [string]>(`${LABEL_SELECT} WHERE l.workspace = ? ORDER BY l.id`).all(workspace);
const readLabel = (id: number) =>
  toLabel(db.query<LabelRow & { open: number }, [number]>(`${LABEL_SELECT_OPEN} WHERE l.id = ?`).get(id)!);

/** Adds a label; its color defaults to the next of LABEL_COLORS, by how many the workspace has. */
function insertLabel(workspace: string, l: { teamId: number | null; parentId: number | null; name: string; color?: string; isGroup?: boolean }, time: string): number {
  const { n } = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM labels WHERE workspace = ?").get(workspace)!;
  return db
    .query<{ id: number }, SQLQueryBindings[]>(
      "INSERT INTO labels (workspace, team_id, parent_id, name, color, is_group, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get(workspace, l.teamId, l.parentId, l.name, l.color ?? LABEL_COLORS[n % LABEL_COLORS.length]!, l.isGroup ? 1 : 0, time)!.id;
}

/**
 * An issue's labels from names, in its workspace, case-insensitively: a label's path ("Bug", "Type/Bug"), else a bare
 * name of one grouped label usable here ("Bug" for Type/Bug), else a new workspace label (Group/Label: in that group,
 * found or created, in its scope). Never a group, another team's own label, or two labels of one group (400). Returns
 * the label ids, and the ids of the labels it created.
 */
function resolveLabels(workspace: string, team: TeamRef, names: string[], time: string): { ids: number[]; created: number[] } {
  const all = workspaceLabels(workspace);
  const created: number[] = [];
  const usable = (l: LabelRow) => l.team_id === null || l.team_id === team.id;
  const byPath = (path: string) => all.find((l) => fold(l.path) === fold(path));
  const create = (name: string, group: LabelRow | null, isGroup = false) => {
    const id = insertLabel(workspace, { teamId: group?.team_id ?? null, parentId: group?.id ?? null, name: capLength(name, "label"), isGroup }, time);
    created.push(id);
    const row = db.query<LabelRow, [number]>(`${LABEL_SELECT} WHERE l.id = ?`).get(id)!;
    all.push(row);
    return row;
  };
  const check = (l: LabelRow) => {
    if (l.is_group) {
      const child = all.find((c) => c.parent_id === l.id);
      throw new AppError(`${l.name} is a label group: pick one of its labels${child ? `, e.g. ${child.path}` : ""}`);
    }
    if (!usable(l)) throw new AppError(`Label "${l.path}" belongs to team ${l.team_key}`);
    return l;
  };
  const pick = (given: string): LabelRow => {
    const slash = given.indexOf("/");
    const [groupName, name] = slash < 0 ? [null, given] : [given.slice(0, slash).trim(), given.slice(slash + 1).trim()];
    const found = byPath(given) ?? (groupName === null ? undefined : byPath(`${groupName}/${name}`));
    if (found) return check(found);
    if (groupName === null) {
      const grouped = all.filter((l) => l.parent_id !== null && usable(l) && fold(l.name) === fold(given));
      if (grouped.length > 1) throw new AppError(`"${given}" is ambiguous: ${grouped.map((l) => l.path).join(" or ")}`);
      return grouped[0] ?? create(given, null);
    }
    if (!groupName || !name || name.includes("/")) throw new AppError(`Invalid label "${given}": use a name, or Group/Label`);
    const group = all.find((l) => l.parent_id === null && fold(l.name) === fold(groupName));
    if (group && !group.is_group) throw new AppError(`${group.name} is a label, not a group`);
    if (group && !usable(group)) throw new AppError(`Label group ${group.name} belongs to team ${group.team_key}`);
    return create(name, group ?? create(groupName, null, true));
  };
  const picked = [...new Map(names.map(pick).map((l) => [l.id, l])).values()];
  for (const l of picked) {
    const same = picked.filter((o) => o.parent_id !== null && o.parent_id === l.parent_id);
    if (same.length > 1) throw new AppError(`Only one label per group: ${same.map((o) => o.path).join(", ")}`);
  }
  return { ids: picked.map((l) => l.id), created };
}

/** Replaces an issue's labels (see resolveLabels), in the caller's transaction. Returns the labels it created. */
function setIssueLabels(issueId: number, workspace: string, team: TeamRef, names: string[], time: string): number[] {
  const { ids, created } = resolveLabels(workspace, team, names, time);
  db.query("DELETE FROM issue_labels WHERE issue_id = ?").run(issueId);
  for (const id of ids) db.query("INSERT INTO issue_labels (issue_id, label_id) VALUES (?, ?)").run(issueId, id);
  return created;
}

/** The request's workspace's labels and groups, by path; `team`: only those usable on its issues (the workspace's and its own). */
export function listLabels(a: Actor, filter: { team?: string } = {}): Label[] {
  const workspace = requestWorkspace(a);
  const params: SQLQueryBindings[] = [workspace];
  if (filter.team) {
    const team = db.query<{ id: number }, [string, string]>("SELECT id FROM teams WHERE workspace = ? AND key = ?").get(workspace, filter.team.trim().toUpperCase());
    if (!team) throw new AppError(`Unknown team "${filter.team}"`);
    params.push(team.id);
  }
  return db
    .query<LabelRow & { open: number }, SQLQueryBindings[]>(
      `${LABEL_SELECT_OPEN} WHERE l.workspace = ?${filter.team ? " AND (l.team_id IS NULL OR l.team_id = ?)" : ""}
       ORDER BY path COLLATE NOCASE, l.id`,
    )
    .all(...params)
    .map(toLabel);
}

const NO_AGENT_LABELS = "Only people can manage labels";

/** A label of the request's workspace, by id, for a person to manage; anything else is 404. */
function managedLabel(a: Actor, id: unknown): LabelRow {
  requirePerson(a, NO_AGENT_LABELS);
  const row = db.query<LabelRow, [number, string]>(`${LABEL_SELECT} WHERE l.id = ? AND l.workspace = ?`).get(Number(id), requestWorkspace(a));
  if (!row) throw new AppError(`Label ${id} not found`, 404);
  return row;
}

/** A new name: no "/" (Group/Label is a group's; names from before labels were entities keep theirs). */
function labelName(value: unknown): string {
  const name = requireText(value, "name");
  if (name.includes("/")) throw new AppError("Use a group for Group/Label: a label's name can't contain /");
  return name;
}

/** A group of the workspace, by name. */
function labelGroup(workspace: string, name: unknown): LabelRow {
  const given = typeof name === "string" ? fold(name.trim()) : "";
  const group = workspaceLabels(workspace).find((l) => l.is_group && fold(l.name) === given);
  if (!group) throw new AppError(`Unknown label group "${name}"`);
  return group;
}

/** A scope: a team of the request's workspace (its id), or null for the workspace. */
const labelScope = (a: Actor, team: unknown): number | null => (team === null ? null : teamRow(a, team).id);

function sameScope(teamId: number | null, group: LabelRow) {
  if (teamId !== group.team_id) {
    throw new AppError(`A label's scope is its group's: ${group.name} is ${group.team_key ? `team ${group.team_key}'s` : "a workspace group"}`);
  }
}

/** A path no other label of the workspace has (409). */
function freePath(workspace: string, path: string, self?: number) {
  if (workspaceLabels(workspace).some((l) => l.id !== self && fold(l.path) === fold(path))) throw new AppError(`Label "${path}" already exists`, 409);
}

/** Creates a label or group (people only): a workspace's, or with `team` that team's own; in `group`, its group's scope. */
export function createLabel(a: Actor, input: LabelInput): Label {
  requirePerson(a, NO_AGENT_LABELS);
  const workspace = requestWorkspace(a);
  if (input.workspace !== undefined && String(input.workspace).trim().toLowerCase() !== workspace) {
    throw new AppError("Labels are created in the workspace you're in");
  }
  const name = labelName(input.name);
  if (input.isGroup !== undefined && typeof input.isGroup !== "boolean") throw new AppError("isGroup must be true or false");
  const group = input.group == null ? null : labelGroup(workspace, input.group);
  if (group && input.isGroup) throw new AppError("A group can't be in a group");
  const teamId = input.team === undefined ? (group?.team_id ?? null) : labelScope(a, input.team);
  if (group) sameScope(teamId, group);
  const color = input.color === undefined ? undefined : checkColor(input.color);
  freePath(workspace, group ? `${group.name}/${name}` : name);
  const id = insertLabel(workspace, { teamId, parentId: group?.id ?? null, name, color, isGroup: input.isGroup }, now());
  changed("label", workspace, String(id));
  return readLabel(id);
}

/** Issues carrying any of these labels (trashed ones too). */
const carrying = (ids: number[]) =>
  db.query<{ id: number; team_id: number }, SQLQueryBindings[]>(
    `SELECT DISTINCT i.id, i.team_id FROM issue_labels x JOIN issues i ON i.id = x.issue_id WHERE x.label_id IN (${inList(ids)})`,
  ).all(...ids);

/**
 * Renames, recolors, rescopes or regroups a label (people only). Rescoping never strands an issue (409), and a group
 * takes its labels along; a label joins a group only if no issue would carry two of it (409). A new path (name or
 * group) shows on every issue carrying it: they're bumped, so a stale whole-list write gets baseUpdatedAt's 409.
 */
export function updateLabel(a: Actor, id: unknown, patch: LabelPatch): Label {
  const label = managedLabel(a, id);
  const all = workspaceLabels(label.workspace);
  const children = all.filter((l) => l.parent_id === label.id);
  const name = patch.name === undefined || patch.name === label.name ? label.name : labelName(patch.name);
  let group = all.find((l) => l.id === label.parent_id) ?? null;
  if (patch.group !== undefined) {
    if (label.is_group && patch.group !== null) throw new AppError("A group can't be in a group");
    group = patch.group === null ? null : labelGroup(label.workspace, patch.group);
  }
  const teamId = patch.team === undefined ? label.team_id : labelScope(a, patch.team);
  if (group) sameScope(teamId, group);
  const color = patch.color === undefined ? label.color : checkColor(patch.color);
  const regrouped = (group?.id ?? null) !== label.parent_id;
  const renamed = name !== label.name || regrouped;
  if (renamed) {
    freePath(label.workspace, group ? `${group.name}/${name}` : name, label.id);
    for (const c of children) freePath(label.workspace, `${name}/${c.name}`, c.id);
  }
  const ids = [label.id, ...children.map((c) => c.id)];
  if (teamId !== null && teamId !== label.team_id) {
    const outside = carrying(ids).filter((i) => i.team_id !== teamId).length;
    if (outside) throw new AppError(`Used on ${outside} ${outside === 1 ? "issue" : "issues"} outside ${teamRow(a, patch.team).key}`, 409);
  }
  if (group && regrouped) {
    const { n } = db
      .query<{ n: number }, [number, number, number]>(
        `SELECT COUNT(DISTINCT x.issue_id) AS n FROM issue_labels x JOIN issue_labels y ON y.issue_id = x.issue_id JOIN labels o ON o.id = y.label_id
         WHERE x.label_id = ? AND o.parent_id = ? AND o.id != ?`,
      )
      .get(label.id, group.id, label.id)!;
    if (n) throw new AppError(`${n} ${n === 1 ? "issue already has" : "issues already have"} a ${group.name} label`, 409);
  }
  const time = now();
  const refs = db.transaction(() => {
    db.query("UPDATE labels SET name = ?, color = ?, team_id = ?, parent_id = ? WHERE id = ?").run(name, color, teamId, group?.id ?? null, label.id);
    db.query("UPDATE labels SET team_id = ? WHERE parent_id = ?").run(teamId, label.id);
    return renamed ? bumpIssues(carrying(ids).map((i) => i.id), time) : [];
  }).immediate();
  changed("label", label.workspace, String(label.id));
  for (const ref of refs) changed("issue", label.workspace, ref);
  return readLabel(label.id);
}

/**
 * Deletes a label for good (people only), as Linear does: it comes off every issue carrying it, each logged as that
 * issue's own labels change would be (history, webhooks). A group must be empty first (409).
 */
export function deleteLabel(a: Actor, id: unknown): Label {
  const label = managedLabel(a, id);
  if (label.is_group && db.query("SELECT 1 FROM labels WHERE parent_id = ?").get(label.id)) throw new AppError("Move or delete its labels first", 409);
  const deleted = readLabel(label.id);
  const time = now();
  const read = db.query<IssueRow, [number]>(`${ISSUE_SELECT} WHERE i.id = ?`);
  const refs = db.transaction(() => {
    const issues = carrying([label.id]).map((i) => i.id);
    const before = issues.map((issue) => read.get(issue)!);
    db.query("DELETE FROM issue_labels WHERE label_id = ?").run(label.id);
    db.query("DELETE FROM labels WHERE id = ?").run(label.id);
    const refs = bumpIssues(issues, time);
    issues.forEach((issue, n) => logActivity(a, issue, label.workspace, changes(before[n]!, read.get(issue)!), time));
    return refs;
  }).immediate();
  changed("label", label.workspace, String(label.id));
  for (const ref of refs) changed("issue", label.workspace, ref);
  return deleted;
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

/** Rebuilds the issues a document mentions: identifiers of real issues in its workspace (or ones they had before a move), first-mention order. */
function saveRefs(documentId: number, content: string, workspace: string) {
  db.query("DELETE FROM document_refs WHERE document_id = ?").run(documentId);
  const ids = new Set<number>();
  for (const [, key, number] of content.matchAll(/\b([A-Z]{2,5})-(\d+)\b/g)) {
    const id = findIssue(workspace, key!, Number(number)); // an identifier from before a move too
    if (id !== null) ids.add(id);
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

export const addDocumentComment = (a: Actor, slug: string, body: unknown, parent?: unknown) =>
  changeDocumentComments(a, slug, (id, time, workspace) => insertComment(a, "document", id, workspace, body, time, parent));

export const updateDocumentComment = (a: Actor, slug: string, commentId: unknown, body: unknown) =>
  changeDocumentComments(a, slug, (id, time, workspace) => updateComment(a, "document", id, workspace, commentId, body, time));

export const deleteDocumentComment = (a: Actor, slug: string, commentId: unknown) =>
  changeDocumentComments(a, slug, (id, time, workspace) => deleteComment(a, "document", id, workspace, commentId, time));

export const resolveDocumentThread = (a: Actor, slug: string, commentId: unknown, resolved: boolean) =>
  changeDocumentComments(a, slug, (id, time, workspace) => resolveThread(a, "document", id, workspace, commentId, resolved, time));

/** Adds or removes your reaction on a comment of this document (404 if `commentId` isn't one). */
export const reactToDocumentComment = (a: Actor, slug: string, commentId: unknown, emoji: unknown, on: boolean) =>
  changeDocumentComments(a, slug, (id, time, workspace) => {
    const { id: cid } = commentRow("document", id, workspace, commentId);
    setReaction(a, `${COMMENTS.document.source}:${cid}`, { documentId: id }, emoji, on, time);
  });

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
  const numbered = `IN (${mine.map((_, n) => `?${n + 3}`).join(", ") || "NULL"})`; // after ?1 and ?2, used twice
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
                // Its current identifier, or one it had before it moved team.
                `SELECT t.workspace, t.created_at, t.id FROM issues i JOIN teams t ON t.id = i.team_id
                 WHERE t.key = ?1 AND i.number = ?2 AND t.workspace ${numbered}
                 UNION ALL SELECT t.workspace, t.created_at, t.id FROM issue_aliases a JOIN teams t ON t.id = a.team_id
                 WHERE t.key = ?1 AND a.number = ?2 AND t.workspace ${numbered}
                 ORDER BY 2, 3`,
              )
              .get(issue[1]!.toUpperCase(), Number(issue[2]), ...mine)
          : null;
  if (!row) throw new AppError("Not found", 404);
  return { workspace: row.workspace };
}

// Anything that expired while the server was down goes now; later deletes and trash views purge as they go.
purgeTrash();
// Likewise, a team's already-old closed issues archive now, even if nothing in it changes for a while.
autoArchive();

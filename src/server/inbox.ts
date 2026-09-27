// The inbox, as in Linear: who follows which issue or doc (subscriptions) and what each person is told
// (notifications). tracker.ts calls the fan-out helpers inside each mutation's transaction; the rest acts for the
// caller alone, in the request's workspace: nobody sees, marks or deletes anyone else's notifications.
import type { SQLQueryBindings } from "bun:sqlite";
import type { Inbox, Notification, NotificationKind, Status, UserKind } from "../shared/types.ts";
import { type Actor, requestWorkspace, usernameOf } from "./access.ts";
import { AppError, changed, db, now } from "./db.ts";

/** An issue or a doc, by row id. */
export type Target = { issueId: number } | { documentId: number };

const column = (t: Target) => ("issueId" in t ? "issue_id" : "document_id");
const idOf = (t: Target) => ("issueId" in t ? t.issueId : t.documentId);

// --- Subscriptions ---

export function subscribe(userId: number, target: Target, time: string) {
  db.query(`INSERT OR IGNORE INTO subscriptions (user_id, ${column(target)}, created_at) VALUES (?, ?, ?)`).run(userId, idOf(target), time);
}

export function unsubscribe(userId: number, target: Target) {
  db.query(`DELETE FROM subscriptions WHERE user_id = ? AND ${column(target)} = ?`).run(userId, idOf(target));
}

export const isSubscribed = (userId: number, target: Target) =>
  db.query(`SELECT 1 FROM subscriptions WHERE user_id = ? AND ${column(target)} = ?`).get(userId, idOf(target)) !== null;

export const subscribers = (target: Target) =>
  db.query<{ user_id: number }, [number]>(`SELECT user_id FROM subscriptions WHERE ${column(target)} = ?`).all(idOf(target)).map((r) => r.user_id);

// --- Fan-out ---

/** Each person's inbox keeps their newest 2,000 notifications per workspace, as in Linear. */
const KEEP = 2000;

export interface Event {
  kind: NotificationKind;
  actorId: number;
  workspace: string;
  target: Target;
  commentId?: number;
  status?: Status;
}

/**
 * One notification for each recipient who is an active member of the workspace, never the actor, and a live
 * `inbox` event to each. Runs in the mutation's transaction (bun:sqlite is synchronous: the event leaves in the
 * same tick as the commit; after a rollback it only costs a refetch).
 */
export function notify(recipients: Iterable<number>, e: Event, time: string) {
  const ids = [...new Set(recipients)].filter((id) => id !== e.actorId);
  if (!ids.length) return;
  const members = db
    .query<{ user_id: number; username: string }, [string, string]>(
      "SELECT user_id, username FROM workspace_members WHERE workspace = ? AND suspended_at IS NULL AND user_id IN (SELECT value FROM json_each(?))",
    )
    .all(e.workspace, JSON.stringify(ids));
  const insert = db.query(
    `INSERT INTO notifications (user_id, workspace, kind, actor_id, ${column(e.target)}, comment_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const trim = db.query(
    `DELETE FROM notifications WHERE user_id = ?1 AND workspace = ?2
     AND id <= (SELECT id FROM notifications WHERE user_id = ?1 AND workspace = ?2 ORDER BY id DESC LIMIT 1 OFFSET ${KEEP})`,
  );
  for (const m of members) {
    insert.run(m.user_id, e.workspace, e.kind, e.actorId, idOf(e.target), e.commentId ?? null, e.status ?? null, time);
    trim.run(m.user_id, e.workspace);
    changed("inbox", e.workspace, m.username, m.user_id);
  }
}

/** Someone new is mentioned in a text: they follow what it's on, and hear about it. */
export function mentioned(ids: number[], e: Omit<Event, "kind">, time: string) {
  for (const id of ids) subscribe(id, e.target, time);
  notify(ids, { ...e, kind: "mentioned" }, time);
}

/** A comment is gone: so are the notifications about it. */
export function commentDeleted(target: Target, commentId: number) {
  const where = `comment_id = ? AND ${column(target)} = ?`;
  const hit = db
    .query<{ user_id: number; workspace: string; username: string }, [number, number]>(
      `SELECT DISTINCT n.user_id, n.workspace, m.username FROM notifications n
       JOIN workspace_members m ON m.user_id = n.user_id AND m.workspace = n.workspace WHERE ${where}`,
    )
    .all(commentId, idOf(target));
  db.query(`DELETE FROM notifications WHERE ${where}`).run(commentId, idOf(target));
  for (const r of hit) changed("inbox", r.workspace, r.username, r.user_id);
}

// --- Your inbox ---

const MAX_LIST = 500;

const SELECT = `
  SELECT n.id, n.kind, n.workspace, n.status, n.comment_id, n.created_at, n.read_at,
    am.username AS actor_username, am.name AS actor_name, au.kind AS actor_kind,
    t.key || '-' || i.number AS issue_ref, i.title AS issue_title, i.status AS issue_status,
    d.slug AS doc_slug, d.title AS doc_title,
    CASE WHEN n.issue_id IS NOT NULL THEN (SELECT body FROM comments WHERE id = n.comment_id AND issue_id = n.issue_id)
      ELSE (SELECT body FROM document_comments WHERE id = n.comment_id AND document_id = n.document_id) END AS comment_body
  FROM notifications n
  JOIN users au ON au.id = n.actor_id
  LEFT JOIN workspace_members am ON am.user_id = n.actor_id AND am.workspace = n.workspace
  LEFT JOIN issues i ON i.id = n.issue_id LEFT JOIN teams t ON t.id = i.team_id
  LEFT JOIN documents d ON d.id = n.document_id
  WHERE n.user_id = ? AND n.workspace = ?`;

const excerpt = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 200);

function toNotification(r: Record<string, any>): Notification {
  return {
    id: r.id,
    kind: r.kind,
    workspace: r.workspace,
    actor: { username: r.actor_username, name: r.actor_name, kind: r.actor_kind as UserKind },
    issue: r.issue_ref ? { id: r.issue_ref, title: r.issue_title, status: r.issue_status } : null,
    document: r.doc_slug ? { slug: r.doc_slug, title: r.doc_title } : null,
    comment: r.comment_body == null ? null : { id: r.comment_id, excerpt: excerpt(r.comment_body) },
    status: r.status,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

/** Yours in the request's workspace, newest first: `unread` only those, at most `limit` (500). */
export function listInbox(a: Actor, { unread = false, limit = MAX_LIST }: { unread?: boolean; limit?: number } = {}): Inbox {
  const workspace = requestWorkspace(a);
  const notifications = db
    .query<Record<string, any>, [number, string]>(`${SELECT}${unread ? " AND n.read_at IS NULL" : ""} ORDER BY n.id DESC LIMIT ${Math.min(limit, MAX_LIST)}`)
    .all(a.id, workspace)
    .map(toNotification);
  // Counted like the inbox shows them: one per issue or doc with anything unread.
  const { n } = db
    .query<{ n: number }, [number, string]>(
      "SELECT COUNT(DISTINCT COALESCE('i' || issue_id, 'd' || document_id)) AS n FROM notifications WHERE user_id = ? AND workspace = ? AND read_at IS NULL",
    )
    .get(a.id, workspace)!;
  return { notifications, unread: n };
}

/** Which of yours a write touches: `ids` (each must be yours here, else 404), or all of yours here. */
function scope(a: Actor, workspace: string, ids: unknown): { where: string; params: SQLQueryBindings[] } {
  const where = "user_id = ? AND workspace = ?";
  if (ids === undefined) return { where, params: [a.id, workspace] };
  if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id))) throw new AppError("ids must be an array of notification ids");
  const list = JSON.stringify(ids);
  const mine = db
    .query<{ id: number }, [number, string, string]>(`SELECT id FROM notifications WHERE ${where} AND id IN (SELECT value FROM json_each(?))`)
    .all(a.id, workspace, list)
    .map((r) => r.id);
  const missing = ids.find((id) => !mine.includes(id));
  if (missing !== undefined) throw new AppError(`Notification ${missing} not found`, 404);
  return { where: `${where} AND id IN (SELECT value FROM json_each(?))`, params: [a.id, workspace, list] };
}

/** Marks `ids`, or all of yours here, read (or unread). */
export function markRead(a: Actor, input: { ids?: unknown; read?: unknown }): Inbox {
  const workspace = requestWorkspace(a);
  if (typeof input.read !== "boolean") throw new AppError("read must be true or false");
  const { where, params } = scope(a, workspace, input.ids);
  db.query(`UPDATE notifications SET read_at = ${input.read ? "COALESCE(read_at, ?)" : "NULL"} WHERE ${where}`).run(
    ...(input.read ? [now()] : []),
    ...params,
  );
  changed("inbox", workspace, usernameOf(a)!, a.id);
  return listInbox(a);
}

/** Deletes `ids`, or with `read`, all of yours here that are read. */
export function deleteNotifications(a: Actor, input: { ids?: unknown; read?: boolean }): Inbox {
  const workspace = requestWorkspace(a);
  if ((input.ids === undefined) === (input.read !== true)) throw new AppError("Pass either ids or read=true");
  const { where, params } = scope(a, workspace, input.ids);
  db.query(`DELETE FROM notifications WHERE ${where}${input.read ? " AND read_at IS NOT NULL" : ""}`).run(...params);
  changed("inbox", workspace, usernameOf(a)!, a.id);
  return listInbox(a);
}

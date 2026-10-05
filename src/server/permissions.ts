// Who may do what. A member's role (roles, role_permissions) is a set of permissions (PERMISSIONS in shared/types.ts) in
// its workspace; a credential may narrow it (its cap, api_keys.permissions): a session has every one, an API key only
// some, and never one that's BROWSER_ONLY. Every access check goes through here; 403s keep the wording they had before roles.
import { BROWSER_ONLY, LEGACY_WRITE_KEY, ROLE_PERMISSIONS, type ApiKeyScope, type Permission, type Role, type UserKind } from "../shared/types.ts";
import { type Actor, requestWorkspace } from "./access.ts";
import { AppError, db } from "./db.ts";

export const ADMINS_ONLY = "Only workspace admins can do that";
export const BROWSER = "Sign in to the web app to manage access; API keys can't";

/** A new workspace's built-in roles: admin, member, guest and agent (ROLE_PERMISSIONS). */
export function addBuiltinRoles(workspace: string, time: string) {
  for (const [key, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    const { id } = db
      .query<{ id: number }, [string, string, string, string, string, string]>(
        "INSERT INTO roles (workspace, key, name, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(workspace, key, key[0]!.toUpperCase() + key.slice(1), key, time, time)!;
    for (const p of permissions) db.query("INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)").run(id, p);
  }
}

/** SQL: a built-in role's id in workspace `w` (an SQL expression). */
export const builtinRole = (w: string, role: Role) => `(SELECT id FROM roles WHERE workspace = ${w} AND key = '${role}')`;

/** SQL: whether role `roleId` (an SQL expression) holds `p`. */
export const roleHas = (roleId: string, p: Permission) => `EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = ${roleId} AND rp.permission = '${p}')`;

/** A new key's cap: a read key's nothing, a person's write key LEGACY_WRITE_KEY, an agent's token (null) its role's. */
export const capOf = (kind: UserKind, scope: ApiKeyScope): readonly Permission[] | null => (scope === "read" ? [] : kind === "agent" ? null : LEGACY_WRITE_KEY);

/** Whether member `userId` of `workspace` holds `p` by their role, whatever they sign in with (e.g. whether they browse). */
export const memberHolds = (workspace: string, userId: number, p: Permission): boolean =>
  db.query(`SELECT 1 FROM workspace_members m WHERE m.workspace = ? AND m.user_id = ? AND ${roleHas("m.role_id", p)}`).get(workspace, userId) !== null;

/** A workspace (its key), or a team in one; default: the request's workspace. */
export type Where = string | { workspace: string };

const roleHolds = (a: Actor, p: Permission, where?: Where) =>
  a.workspaces.get(where === undefined ? requestWorkspace(a) : typeof where === "string" ? where : where.workspace)?.has(p) ?? false;

const browserOnly = (a: Actor, p: Permission) => a.sessionId === null && BROWSER_ONLY.includes(p);

/** Whether `a` may do `p`: their role holds it and their credential allows it. Seeing is never capped: a key sees what its owner does. */
export function can(a: Actor, p: Permission, where?: Where): boolean {
  if (!roleHolds(a, p, where)) return false;
  return p === "workspace.browse" || (!browserOnly(a, p) && (a.cap === null || a.cap.includes(p)));
}

/** 403 unless `a` may do `p`: `message` if their role doesn't hold it, `refused` if their credential doesn't allow it (checked first). */
export function requirePermission(a: Actor, p: Permission, message: string, where?: Where, refused = BROWSER) {
  if (browserOnly(a, p)) throw new AppError(refused, 403);
  if (!roleHolds(a, p, where)) throw new AppError(message, 403);
  if (!can(a, p, where)) throw new AppError(refused, 403);
}

/**
 * Before looking something up: 403 for those who browse the workspace but hold none of `ps`, as when these were for
 * people only (so a team they don't see is 403 for them, not 404). Anyone else gets the lookup's 404 first.
 */
export function requireUpfront(a: Actor, ps: Permission[], message: string) {
  if (can(a, "workspace.browse") && !ps.some((p) => can(a, p))) throw new AppError(message, 403);
}

/** A read-only key: it holds nothing beyond seeing. */
export const readOnly = (a: Actor) => a.cap !== null && a.cap.length === 0;

// Who may do what. A member's role (roles, role_permissions) is a set of permissions (PERMISSIONS in shared/types.ts) in
// its workspace; in a team, a role of their own there (team_members.role_id) replaces it for the team's permissions
// (TEAM_PERMISSIONS). A credential may narrow it (its cap, api_keys.permissions): a session has every one, an API key only
// some, and never one that's BROWSER_ONLY. Every access check goes through here; 403s keep the wording they had before roles.
import { ACCESS, BROWSER_ONLY, LEGACY_WRITE_KEY, PERMISSIONS, ROLE_PERMISSIONS, TEAM_PERMISSIONS, type ApiKeyScope, type Permission, type Role, type UserKind } from "../shared/types.ts";
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

/** SQL: whether role `roleId` (an SQL expression) holds every permission: an admin's. */
export const fullRole = (roleId: string) => `((SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = ${roleId}) = ${PERMISSIONS.length})`;

/** Permissions in catalog order. */
export const inOrder = (ps: Iterable<string>): Permission[] => {
  const set = new Set(ps);
  return PERMISSIONS.filter((p) => set.has(p));
};

/** A role's permissions, by id. */
export const permissionsOf = (roleId: number): Permission[] =>
  inOrder(db.query<{ permission: string }, [number]>("SELECT permission FROM role_permissions WHERE role_id = ?").all(roleId).map((r) => r.permission));

/** A new key's cap: a read key's nothing, a person's write key LEGACY_WRITE_KEY, an agent's token (null) its role's. */
export const capOf = (kind: UserKind, scope: ApiKeyScope): readonly Permission[] | null => (scope === "read" ? [] : kind === "agent" ? null : LEGACY_WRITE_KEY);

/** Whether member `userId` of `workspace` holds `p` by their role, whatever they sign in with (e.g. whether they browse). */
export const memberHolds = (workspace: string, userId: number, p: Permission): boolean =>
  db.query(`SELECT 1 FROM workspace_members m WHERE m.workspace = ? AND m.user_id = ? AND ${roleHas("m.role_id", p)}`).get(workspace, userId) !== null;

/** A workspace (its key), or a team in one (`teamId`, for its own roles); default: the request's workspace. */
export type Where = string | { workspace: string; teamId?: number };

/** A team row as a Where. */
export const inTeam = (team: { workspace: string; id: number }): Where => ({ workspace: team.workspace, teamId: team.id });

function roleHolds(a: Actor, p: Permission, where?: Where) {
  const workspace = where === undefined ? requestWorkspace(a) : typeof where === "string" ? where : where.workspace;
  const own = typeof where === "object" && where.teamId !== undefined && TEAM_PERMISSIONS.includes(p) ? a.teams.get(where.teamId) : undefined;
  if (!a.workspaces.has(workspace)) return false;
  return (own?.workspace === workspace ? own.permissions : a.workspaces.get(workspace)!).has(p);
}

/** Whether `a`'s credential allows `p` (whatever their role): a session everything, a key its cap but never what's BROWSER_ONLY. */
const allows = (a: Actor, p: Permission) =>
  p === "workspace.browse" || a.sessionId !== null || (!BROWSER_ONLY.includes(p) && (a.cap === null || a.cap.includes(p)));

/** Whether `a` may do `p`: their role holds it and their credential allows it. Seeing is never capped: a key sees what its owner does. */
export const can = (a: Actor, p: Permission, where?: Where): boolean => roleHolds(a, p, where) && allows(a, p);

/** Whether `a` may do `p` somewhere in the request's workspace: there, or in a team by its own role there (MCP's tools/list). */
export const holdsAnywhere = (a: Actor, p: Permission): boolean =>
  can(a, p) || [...a.teams.keys()].some((teamId) => can(a, p, { workspace: requestWorkspace(a), teamId }));

/** Every permission `a` may use (there, by default the request's workspace). */
export const held = (a: Actor, where?: Where): Permission[] => PERMISSIONS.filter((p) => can(a, p, where));

/** Whether a key is refused `p` before its role is asked: what's never a key's, what its cap lacks, and access it can't manage. */
export const keyRefused = (a: Actor, p: Permission, where?: Where) => a.sessionId === null && (ACCESS.includes(p) ? !can(a, p, where) : !allows(a, p));

/** What a key that can't do `p` is told. */
export const refusal = (p: Permission) => (BROWSER_ONLY.includes(p) || ACCESS.includes(p) ? BROWSER : `This API key doesn't allow ${p}`);

/**
 * 403 unless `a` may do `p`: `message` if their role doesn't hold it, `refused` if their credential doesn't allow it (checked
 * first; by default, for access and what's browser-only, "sign in to the web app").
 */
export function requirePermission(a: Actor, p: Permission, message: string, where?: Where, refused = refusal(p)) {
  if (keyRefused(a, p, where)) throw new AppError(refused, 403);
  if (!roleHolds(a, p, where)) throw new AppError(message, 403);
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

/** 403 unless `a` holds every one of `ps` (there): nobody grants what they can't do themselves. */
export function assertContained(a: Actor, ps: Iterable<Permission>, where?: Where) {
  const missing = [...new Set(ps)].filter((p) => !can(a, p, where));
  if (missing.length) throw new AppError(`You can't give permissions you don't have: ${missing.join(", ")}`, 403);
}

/** 409 unless some active person in `workspace` still holds every permission (call it inside the change's transaction). */
export function requireAdmin(workspace: string) {
  const admin = db.query(
    `SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace = ? AND m.suspended_at IS NULL AND u.kind = 'person' AND ${fullRole("m.role_id")}`,
  );
  if (!admin.get(workspace)) throw new AppError("Add another admin first", 409);
}

/** Unused invites whose maker no longer may invite (or give the invite's role) die, so no one pre-mints a way back in. */
export function dropInvites(workspace: string) {
  db.query(
    `DELETE FROM codes WHERE workspace = ?1 AND purpose = 'invite' AND used_at IS NULL AND NOT EXISTS (
       SELECT 1 FROM workspace_members m WHERE m.workspace = ?1 AND m.user_id = codes.created_by AND m.suspended_at IS NULL
         AND ${roleHas("m.role_id", "members.invite")}
         AND NOT EXISTS (SELECT 1 FROM role_permissions g WHERE g.role_id = codes.role_id
           AND NOT EXISTS (SELECT 1 FROM role_permissions h WHERE h.role_id = m.role_id AND h.permission = g.permission)))`,
  ).run(workspace);
}

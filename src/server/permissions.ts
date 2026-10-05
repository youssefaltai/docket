// Who may do what. A member's role is a set of permissions (PERMISSIONS in shared/types.ts) in its workspace; a
// credential may narrow it (its cap): a session has every one, an API key only some, and never one that's BROWSER_ONLY.
// Every access check goes through here; 403s keep the wording they had before roles.
import { BROWSER_ONLY, LEGACY_WRITE_KEY, ROLE_PERMISSIONS, type ApiKeyScope, type Permission, type Role, type UserKind } from "../shared/types.ts";
import { type Actor, requestWorkspace } from "./access.ts";
import { AppError, db } from "./db.ts";

export const ADMINS_ONLY = "Only workspace admins can do that";
export const BROWSER = "Sign in to the web app to manage access; API keys can't";

/** A role's permissions. */
export const permissionsOf = (role: Role): ReadonlySet<Permission> => new Set(ROLE_PERMISSIONS[role]);

/** A key's cap: a read key's nothing, a person's write key LEGACY_WRITE_KEY, an agent's token (null) its role's. */
export const capOf = (kind: UserKind, scope: ApiKeyScope): readonly Permission[] | null => (scope === "read" ? [] : kind === "agent" ? null : LEGACY_WRITE_KEY);

/** Whether member `userId` of `workspace` holds `p` by their role, whatever they sign in with (e.g. whether they browse). */
export function memberHolds(workspace: string, userId: number, p: Permission): boolean {
  const row = db.query<{ role: Role }, [string, number]>("SELECT role FROM workspace_members WHERE workspace = ? AND user_id = ?").get(workspace, userId);
  return !!row && ROLE_PERMISSIONS[row.role].includes(p);
}

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

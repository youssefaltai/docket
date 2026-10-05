// Roles: each workspace's named sets of permissions (permissions.ts says what they let you do). Members hold one there,
// and may hold one of their own in a team. Nobody gives a permission they can't use themselves, or changes their own role.
import { PERMISSIONS, TEAM_PERMISSIONS, type Permission, type Role, type RoleInput, type RolePatch, type UserRef, type UserKind, type WorkspaceRole } from "../shared/types.ts";
import { type Actor, SEES_TEAM, requestWorkspace, requireIn, revokeAccess } from "./access.ts";
import { AppError, changed, db, now, optionalText, pickSlug, requireText } from "./db.ts";
import { assertContained, can, dropInvites, inTeam, permissionsOf, requireAdmin } from "./permissions.ts";

interface RoleRow {
  id: number;
  key: string;
  name: string;
  description: string;
  builtin: Role | null;
}

type RoleOf = RoleRow & { permissions: Permission[] };

const ROLE_SELECT = "SELECT id, key, name, description, builtin FROM roles";

/** A list of permissions (400 for anything else), without repeats, in catalog order. */
export function checkPermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) throw new AppError('permissions must be an array, e.g. ["issues.write"]');
  const unknown = value.filter((p) => !PERMISSIONS.includes(p));
  if (unknown.length) throw new AppError(`Unknown permission ${unknown.map((p) => `"${p}"`).join(", ")}. Use some of: ${PERMISSIONS.join(", ")}`);
  return PERMISSIONS.filter((p) => value.includes(p));
}

const withPermissions = (row: RoleRow): RoleOf => ({ ...row, permissions: permissionsOf(row.id) });

/** A role of `workspace` by key, to give someone: 400 if there's none. */
export function roleIn(workspace: string, key: unknown): RoleOf {
  const row = typeof key === "string" ? db.query<RoleRow, [string, string]>(`${ROLE_SELECT} WHERE workspace = ? AND key = ?`).get(workspace, key.trim().toLowerCase()) : null;
  if (!row) throw new AppError(`Unknown role "${key}"`);
  return withPermissions(row);
}

/** A role of `workspace` by key, to manage: 404 if there's none. */
function roleRow(workspace: string, key: unknown): RoleOf {
  try {
    return roleIn(workspace, key);
  } catch {
    throw new AppError(`Role ${key} not found`, 404);
  }
}

/** Who holds a role: in the workspace, or in a team. */
const holders = (roleId: number) =>
  db
    .query<{ user_id: number }, [number]>("SELECT user_id FROM workspace_members WHERE role_id = ?1 UNION SELECT user_id FROM team_members WHERE role_id = ?1")
    .all(roleId)
    .map((r) => r.user_id);

const toRole = (row: RoleOf): WorkspaceRole => ({
  key: row.key,
  name: row.name,
  description: row.description,
  builtin: row.builtin,
  permissions: row.permissions,
  members: holders(row.id).length,
});

/** The request's workspace's roles: built-in ones first, then by name. */
export function listRoles(a: Actor): WorkspaceRole[] {
  return db
    .query<RoleRow, [string]>(`${ROLE_SELECT} WHERE workspace = ? ORDER BY builtin IS NULL, id`)
    .all(requestWorkspace(a))
    .map((row) => toRole(withPermissions(row)));
}

/** A role you could change: not Admin (copy it instead), not one you hold, none with a permission you lack. */
function managedRole(a: Actor, key: unknown): { workspace: string; role: RoleOf } {
  const workspace = requireIn(a, requestWorkspace(a), "roles.manage");
  const role = roleRow(workspace, key);
  if (role.builtin === "admin") throw new AppError("The Admin role can't be changed: duplicate it instead");
  if (holders(role.id).includes(a.id)) throw new AppError("You can't change your own role", 403);
  assertContained(a, role.permissions, workspace);
  return { workspace, role };
}

/** Replaces a role's permissions. */
function setPermissions(roleId: number, permissions: Permission[]) {
  db.query("DELETE FROM role_permissions WHERE role_id = ?").run(roleId);
  for (const p of permissions) db.query("INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)").run(roleId, p);
}

/** A new role (roles.manage), of permissions you hold: copying Admin is how you get a role near it. */
export function createRole(a: Actor, input: RoleInput): WorkspaceRole {
  const workspace = requireIn(a, requestWorkspace(a), "roles.manage");
  const name = requireText(input.name, "name");
  const description = optionalText(input.description, "description");
  const permissions = checkPermissions(input.permissions);
  assertContained(a, permissions, workspace);
  const taken = (k: string) => !!db.query("SELECT 1 FROM roles WHERE workspace = ? AND key = ?").get(workspace, k);
  const key = pickSlug(input.key, name, taken, { label: "role key", fallback: "role" });
  const time = now();
  const id = db.transaction(() => {
    const { id } = db
      .query<{ id: number }, [string, string, string, string, string, string]>(
        "INSERT INTO roles (workspace, key, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(workspace, key, name, description, time, time)!;
    setPermissions(id, permissions);
    return id;
  }).immediate();
  changed("workspace", workspace, workspace);
  return toRole(withPermissions(db.query<RoleRow, [number]>(`${ROLE_SELECT} WHERE id = ?`).get(id)!));
}

/** Renames, redescribes or changes what a role may do; those holding it may do the new set at once. */
export function updateRole(a: Actor, key: string, patch: RolePatch): WorkspaceRole {
  const { workspace, role } = managedRole(a, key);
  const name = patch.name === undefined ? role.name : requireText(patch.name, "name");
  const description = patch.description === undefined ? role.description : optionalText(patch.description, "description");
  const permissions = patch.permissions === undefined ? role.permissions : checkPermissions(patch.permissions);
  assertContained(a, permissions, workspace);
  db.transaction(() => {
    db.query("UPDATE roles SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(name, description, now(), role.id);
    setPermissions(role.id, permissions);
    requireAdmin(workspace);
    dropInvites(workspace);
  }).immediate();
  revokeAccess(holders(role.id));
  changed("workspace", workspace, workspace);
  return toRole(roleRow(workspace, role.key));
}

/**
 * Deletes a role that isn't built in. Those holding it (members, team roles and unused invites) move to `moveTo`, a role you
 * could give; while anyone holds it, it's required (409).
 */
export function deleteRole(a: Actor, key: string, moveTo?: string | null) {
  const { workspace, role } = managedRole(a, key);
  if (role.builtin) throw new AppError("Built-in roles can't be deleted");
  const moved = holders(role.id);
  const invites = db.query<{ n: number }, [number, string]>("SELECT COUNT(*) AS n FROM codes WHERE role_id = ? AND used_at IS NULL AND expires_at > ?").get(role.id, now())!.n;
  let target: RoleOf | null = null;
  if (moveTo) {
    target = roleIn(workspace, moveTo);
    if (target.id === role.id) throw new AppError("Move its members to another role");
    assertContained(a, target.permissions, workspace);
  } else if (moved.length || invites) {
    throw new AppError(`${moved.length} members and ${invites} invites hold ${role.name}: say which role they move to (moveTo)`, 409);
  }
  db.transaction(() => {
    if (target) {
      db.query("UPDATE workspace_members SET role = (SELECT COALESCE(builtin, 'member') FROM roles WHERE id = ?1), role_id = ?1 WHERE role_id = ?2").run(target.id, role.id);
      db.query("UPDATE team_members SET role_id = ? WHERE role_id = ?").run(target.id, role.id);
    }
    db.query("UPDATE codes SET role = (SELECT COALESCE(builtin, 'member') FROM roles WHERE id = ?1), role_id = ?1 WHERE role_id = ?2").run(target?.id ?? null, role.id);
    db.query("DELETE FROM roles WHERE id = ?").run(role.id);
    requireAdmin(workspace);
    dropInvites(workspace);
  }).immediate();
  revokeAccess(moved);
  changed("workspace", workspace, workspace);
}

/**
 * Gives a member of a team a role of their own there (`role`, a role's key), or with null takes it away so their workspace
 * role applies. It replaces their role for the team's permissions only (TEAM_PERMISSIONS), never for what they see. Takes
 * team.roles in the team or members.assign_role, holding the team's permissions of both their roles, and not being them.
 */
export function setTeamRole(a: Actor, teamKey: string, username: unknown, role: unknown): { user: UserRef; team: string; role: string | null } {
  const workspace = requestWorkspace(a);
  const team =
    typeof teamKey === "string"
      ? db.query<{ id: number; key: string; workspace: string }, [string, string]>(`SELECT t.id, t.key, t.workspace FROM teams t WHERE t.workspace = ?1 AND t.key = ?2 AND ${SEES_TEAM(String(a.id), "t")}`).get(workspace, teamKey.trim().toUpperCase())
      : null;
  if (!team) throw new AppError(`Team ${teamKey} not found`, 404);
  const where = inTeam(team);
  if (!can(a, "team.roles", where) && !can(a, "members.assign_role", workspace)) throw new AppError("Only workspace admins can change roles in a team", 403);
  type Row = { id: number; username: string; name: string; kind: UserKind; role_id: number; team_role: number | null };
  const who =
    typeof username === "string"
      ? db
          .query<Row, [number, string, string]>(
            `SELECT m.user_id AS id, m.username, m.name, u.kind, m.role_id, tm.role_id AS team_role FROM team_members tm
             JOIN workspace_members m ON m.user_id = tm.user_id AND m.workspace = ?2 AND m.suspended_at IS NULL JOIN users u ON u.id = m.user_id
             WHERE tm.team_id = ?1 AND m.username = ?3`,
          )
          .get(team.id, workspace, username.trim().toLowerCase())
      : null;
  if (!who) throw new AppError(`${username} isn't in ${team.key}`, 404);
  const next = role === null ? null : roleIn(workspace, role);
  if ((next?.id ?? null) === who.team_role) return { user: { username: who.username, name: who.name, kind: who.kind }, team: team.key, role: next?.key ?? null };
  if (who.id === a.id) throw new AppError("You can't change your own role", 403);
  const teamOnly = (ps: Permission[]) => ps.filter((p) => TEAM_PERMISSIONS.includes(p));
  assertContained(a, teamOnly(permissionsOf(who.team_role ?? who.role_id)), where);
  assertContained(a, teamOnly(next?.permissions ?? permissionsOf(who.role_id)), where);
  db.query("UPDATE team_members SET role_id = ? WHERE team_id = ? AND user_id = ?").run(next?.id ?? null, team.id, who.id);
  revokeAccess([who.id]);
  changed("team", workspace, team.key);
  changed("member", workspace, who.username);
  return { user: { username: who.username, name: who.name, kind: who.kind }, team: team.key, role: next?.key ?? null };
}

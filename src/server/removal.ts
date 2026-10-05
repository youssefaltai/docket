// Deleting a team or a whole workspace for good: an admin's own hand (a browser session, never an API key or agent), after
// typing its key. Everything inside goes with it. Foreign keys are checked at the commit, so a table missed here rolls the
// whole delete back instead of leaving rows pointing at nothing.
import { requireIn, requestWorkspace, revokeAccess } from "./access.ts";
import type { Actor } from "./access.ts";
import { files } from "./attachments.ts";
import { AppError, BUMPED_AT, changed, db, now } from "./db.ts";

const confirmed = (given: unknown, key: string, what: string) => {
  if (typeof given !== "string" || given.trim().toLowerCase() !== key.toLowerCase()) throw new AppError(`Type the ${what}'s key to confirm: ${key}`);
};

/** Deletes a team's rows, in the open transaction; returns its attachments' ids, whose files go after the commit. */
function dropTeam(id: number, workspace: string, orphaned: string[]): string[] {
  const issues = "SELECT id FROM issues WHERE team_id = ?";
  // Sub-issues in other teams lose their parent.
  const orphans = db
    .query<{ id: number; ref: string }, [number, number]>(
      `SELECT i.id, t.key || '-' || i.number AS ref FROM issues i JOIN teams t ON t.id = i.team_id WHERE i.team_id != ? AND i.parent_id IN (${issues})`,
    )
    .all(id, id);
  const time = now();
  const attachments = db.query<{ id: string }, [number]>("SELECT id FROM attachments WHERE team_id = ?").all(id).map((r) => r.id);
  orphaned.push(...orphans.map((o) => o.ref));
  db.query(`DELETE FROM issues WHERE team_id = ?`).run(id);
  for (const o of orphans) db.query(`UPDATE issues SET ${BUMPED_AT} WHERE id = ?`).run(time, time, o.id);
  for (const table of ["issue_aliases", "documents", "cycles", "workflow_statuses", "issue_templates", "project_teams", "attachments", "team_members"]) {
    db.query(`DELETE FROM ${table} WHERE team_id = ?`).run(id);
  }
  db.query("DELETE FROM labels WHERE team_id = ?").run(id);
  db.query("DELETE FROM teams WHERE id = ?").run(id);
  return attachments;
}

const dropFiles = (ids: string[]) => Promise.allSettled(ids.map((id) => files.delete(id)));

/** Deletes a team with its issues, docs, cycles, workflow, templates and labels. Workspace admins only. */
export async function deleteTeam(a: Actor, key: string, confirm: unknown) {
  const workspace = requireIn(a, requestWorkspace(a), "team.delete");
  const team = db.query<{ id: number; key: string }, [string, string]>("SELECT id, key FROM teams WHERE workspace = ? AND key = ?").get(workspace, String(key).trim().toUpperCase());
  if (!team) throw new AppError(`Team ${key} not found`, 404);
  confirmed(confirm, team.key, "team");
  const orphaned: string[] = [];
  const attachments = db.transaction(() => {
    db.run("PRAGMA defer_foreign_keys = ON");
    return dropTeam(team.id, workspace, orphaned);
  })();
  for (const ref of orphaned) changed("issue", workspace, ref);
  await dropFiles(attachments);
  changed("team", workspace, team.key);
  return { ok: true };
}

/** Deletes a workspace with everything in it: teams, projects, labels, members' memberships, agents, keys, webhooks, views, files. */
export async function deleteWorkspace(a: Actor, key: string, confirm: unknown) {
  const workspace = requireIn(a, key, "workspace.delete");
  confirmed(confirm, workspace, "workspace");
  const members = db.query<{ user_id: number }, [string]>("SELECT user_id FROM workspace_members WHERE workspace = ?").all(workspace).map((m) => m.user_id);
  const attachments = db.transaction(() => {
    db.run("PRAGMA defer_foreign_keys = ON");
    const ids = db.query<{ id: number }, [string]>("SELECT id FROM teams WHERE workspace = ?").all(workspace).flatMap((t) => dropTeam(t.id, workspace, []));
    ids.push(...db.query<{ id: string }, [string]>("SELECT id FROM attachments WHERE workspace = ?").all(workspace).map((r) => r.id));
    db.query("DELETE FROM projects WHERE workspace = ?").run(workspace); // milestones and project teams cascade
    db.query("DELETE FROM labels WHERE workspace = ?").run(workspace);
    db.query("DELETE FROM workspaces WHERE key = ?").run(workspace); // members, keys, codes, webhooks, views, notifications, GitHub, attachments cascade
    // An agent belongs to one workspace: its account goes with it.
    const agents = members.length ? db.query<{ id: number }, number[]>(`SELECT id FROM users WHERE kind = 'agent' AND system = 0 AND id IN (${members.map(() => "?").join(",")})`).all(...members) : [];
    for (const { id } of agents) {
      db.query("DELETE FROM api_keys WHERE user_id = ?").run(id);
      db.query("DELETE FROM users WHERE id = ?").run(id);
    }
    return ids;
  })();
  await dropFiles(attachments);
  revokeAccess(members); // their sockets reconnect with the workspaces they still have
  return { ok: true };
}

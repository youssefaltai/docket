// Migration 30 (roles) on a database at 29 with every kind of member, invite and key, on both paths (a SQLite file and a
// Durable Object's): every member gets their built-in role, and what each credential may do, and which teams each member
// sees, is what it was before roles (the role names and key scopes of version 29).
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BROWSER_ONLY, LEGACY_WRITE_KEY, PERMISSIONS, ROLE_PERMISSIONS, type Role } from "../src/shared/types.ts";
import { type Actor, keyActor, seesTeam, sessionActor } from "../src/server/access.ts";
import { open } from "../src/server/db.ts";
import { can } from "../src/server/permissions.ts";
import { migrate } from "../src/server/schema.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** A database at 29: two workspaces; people as admin, member, guest (one suspended); agents; invites; sessions; keys. */
function v29(durable: boolean) {
  const db = new Database(":memory:");
  migrate(db, [], durable);
  const t = "2026-01-01T00:00:00.000Z";
  const seen = new Date().toISOString();
  db.run(`INSERT INTO workspaces VALUES ('acme', 'Acme', '${t}', '${t}'), ('beta', 'Beta', '${t}', '${t}')`);
  const users: [number, "person" | "agent"][] = [[1, "person"], [2, "person"], [3, "person"], [4, "agent"], [5, "person"], [6, "agent"]];
  for (const [id, kind] of users) db.run(`INSERT INTO users (id, kind, created_at) VALUES (${id}, '${kind}', '${t}')`);
  db.run(`INSERT INTO users (id, kind, system, created_at) VALUES (7, 'agent', 1, '${t}')`);
  const members: [string, number, Role, string | null][] = [
    ["acme", 1, "admin", null],
    ["acme", 2, "member", null],
    ["acme", 3, "guest", null],
    ["acme", 4, "agent", null],
    ["acme", 5, "member", t],
    ["beta", 2, "admin", null],
    ["beta", 3, "member", null],
    ["beta", 6, "agent", null],
  ];
  for (const [w, id, role, suspended] of members) {
    db.query("INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at, suspended_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(w, id, `u${id}`, `U${id}`, role, t, suspended);
  }
  db.run(`INSERT INTO teams (id, workspace, key, name, created_at, updated_at, private) VALUES
    (1, 'acme', 'PUB', 'Public', '${t}', '${t}', 0), (2, 'acme', 'PRIV', 'Private', '${t}', '${t}', 1), (3, 'beta', 'BET', 'Beta', '${t}', '${t}', 0)`);
  for (const [team, user] of [[1, 1], [1, 2], [2, 1], [2, 4], [2, 3], [3, 3], [3, 6]]) {
    db.run(`INSERT INTO team_members (team_id, user_id, created_at) VALUES (${team}, ${user}, '${t}')`);
  }
  for (const id of [1, 2, 3, 5]) db.run(`INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, user_agent, ip) VALUES (${id}, ${id}, '${hash(`s${id}`)}', '${t}', '${seen}', '', '')`);
  const keys: [number, string, "read" | "write"][] = [
    [1, "acme", "read"], [1, "acme", "write"], [2, "acme", "read"], [2, "acme", "write"], [2, "beta", "write"],
    [3, "acme", "read"], [3, "acme", "write"], [3, "beta", "read"], [4, "acme", "write"], [6, "beta", "write"], [5, "acme", "write"],
  ];
  for (const [i, [user, w, scope]] of keys.entries()) {
    db.query("INSERT INTO api_keys (user_id, workspace, name, scope, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(user, w, "k", scope, hash(`k${i}`), t);
  }
  const codes: [string, string | null, number | null][] = [["invite", "admin", null], ["invite", "member", null], ["invite", "guest", null], ["sign-in", null, 2]];
  for (const [i, [purpose, role, user]] of codes.entries()) {
    db.query("INSERT INTO codes (code_hash, purpose, user_id, workspace, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(hash(`c${i}`), purpose, user, i === 1 ? "beta" : "acme", role, t, t);
  }
  return { db, keys, members };
}

for (const durable of [false, true]) {
  test(`migration 30 keeps everyone's access${durable ? " (Durable Object)" : ""}`, () => {
    const { db, keys, members } = v29(durable);
    // As before roles: by role name, and for a key its scope and owner's kind.
    const sees = (user: number, team: number) =>
      db.query(
        `SELECT 1 FROM teams t JOIN workspace_members sm ON sm.workspace = t.workspace AND sm.user_id = ?2 AND sm.suspended_at IS NULL
         WHERE t.id = ?1 AND ((t.private = 0 AND sm.role != 'guest') OR EXISTS (SELECT 1 FROM team_members st WHERE st.team_id = t.id AND st.user_id = ?2))`,
      ).get(team, user) !== null;
    const before = members.flatMap(([, user]) => [1, 2, 3].map((team) => sees(user, team)));
    open(db, durable);

    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT workspace, key, builtin FROM roles ORDER BY id").all()).toEqual(
      ["acme", "beta"].flatMap((workspace) => ["admin", "member", "guest", "agent"].map((key) => ({ workspace, key, builtin: key }))),
    );
    // Every member and invite has its role, the one its name said.
    expect(db.query("SELECT COUNT(*) AS n FROM workspace_members m LEFT JOIN roles r ON r.id = m.role_id WHERE r.key IS NOT m.role OR r.workspace IS NOT m.workspace").get()).toEqual({ n: 0 });
    expect(db.query("SELECT purpose, role, (SELECT key FROM roles WHERE id = role_id) AS role_key FROM codes ORDER BY id").all()).toEqual([
      { purpose: "invite", role: "admin", role_key: "admin" },
      { purpose: "invite", role: "member", role_key: "member" },
      { purpose: "invite", role: "guest", role_key: "guest" },
      { purpose: "sign-in", role: null, role_key: null },
    ]);
    // Visibility, for every member and team.
    expect(members.flatMap(([, user]) => [1, 2, 3].map((team) => seesTeam(user, team)))).toEqual(before);

    // Every permission, for every credential in every workspace it's in.
    const old = (role: Role, p: string, key: { kind: string; scope: string } | null) =>
      ROLE_PERMISSIONS[role].includes(p as never) &&
      (key === null || p === "workspace.browse" || (!BROWSER_ONLY.includes(p as never) && (key.scope === "write" && (key.kind === "agent" || LEGACY_WRITE_KEY.includes(p as never)))));
    const check = (a: Actor | null, user: number, key: { kind: string; scope: string } | null, only?: string) => {
      const active = members.filter(([w, id, , suspended]) => id === user && !suspended && (!only || w === only));
      if (!active.length) return expect(a === null || a.workspaces.size === 0).toBe(true);
      expect([...a!.workspaces.keys()].sort()).toEqual(active.map(([w]) => w).sort());
      for (const [w, , role] of active) for (const p of PERMISSIONS) expect([w, user, key, p, can(a!, p, w)]).toEqual([w, user, key, p, old(role, p, key)]);
    };
    for (const id of [1, 2, 3, 5]) check(sessionActor(`s${id}`), id, null);
    for (const [i, [user, w, scope]] of keys.entries()) {
      const kind = user === 4 || user === 6 ? "agent" : "person";
      check(keyActor(`k${i}`), user, { kind, scope }, w);
    }
    expect(db.query("SELECT DISTINCT scope, permissions FROM api_keys ORDER BY scope, permissions").all()).toEqual([
      { scope: "read", permissions: "[]" },
      { scope: "write", permissions: null },
      { scope: "write", permissions: JSON.stringify(LEGACY_WRITE_KEY) },
    ]);
  });
}

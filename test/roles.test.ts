// Roles: named sets of permissions per workspace, held in the workspace and, for team permissions, per team. Nobody gives
// what they can't do themselves or changes their own role; some active person always holds every permission; a change
// applies at once (sockets reconnect) and kills invites their maker can no longer give.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PERMISSIONS, ROLE_PERMISSIONS, TEAM_PERMISSIONS } from "../src/shared/types.ts";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let mgr: Caller; // "manager": a member who also manages roles and assigns them
let ana: Caller; // member
let gus: Caller; // guest, in WEB
const ws = "acme";

const MEMBER = ROLE_PERMISSIONS.member;
const ok = async (reply: Promise<{ status: number; body: any }>, status = 200) => {
  const r = await reply;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const fails = async (reply: Promise<{ status: number; body: any }>, status: number, error?: string | RegExp) => {
  const r = await reply;
  expect(r.status).toBe(status);
  if (typeof error === "string") expect(r.body.error).toBe(error);
  else if (error) expect(r.body.error).toMatch(error);
};
const role = (name: string, permissions: readonly string[], key?: string) => ok(s.api("POST", "/api/roles", { name, permissions, key }), 201);
const assign = (username: string, roleKey: string, by: Caller = s.admin) => by.api("PATCH", `/api/workspaces/${ws}/members/${username}`, { role: roleKey });
const teamRole = (team: string, username: string, roleKey: string | null, by: Caller = s.admin) => by.api("PATCH", `/api/teams/${team}/members/${username}`, { role: roleKey });
const member = async (username: string) => (await ok(s.api("GET", `/api/workspaces/${ws}/members`))).find((m: any) => m.user.username === username);

beforeAll(async () => {
  s = await startServer();
  await ok(s.api("POST", "/api/teams", { key: "WEB", name: "Web" }), 201);
  await ok(s.api("POST", "/api/teams", { key: "OPS", name: "Ops" }), 201);
  mgr = await s.user("mgr");
  ana = await s.user("ana");
  gus = await s.user("gus", { role: "guest", teams: ["WEB"] });
  await role("Manager", [...MEMBER, "roles.manage", "members.assign_role", "members.invite"], "manager");
  await ok(assign("mgr", "manager"));
});
afterAll(() => s.stop());

describe("roles", () => {
  test("every member sees the roles: the four built in, then custom ones, with their permissions and holders", async () => {
    const list = await ok(ana.api("GET", "/api/roles"));
    expect(list.map((r: any) => [r.key, r.name, r.builtin])).toEqual([
      ["admin", "Admin", "admin"],
      ["member", "Member", "member"],
      ["guest", "Guest", "guest"],
      ["agent", "Agent", "agent"],
      ["manager", "Manager", null],
    ]);
    expect(list[0].permissions).toEqual([...PERMISSIONS]);
    expect(list.find((r: any) => r.key === "manager").members).toBe(1);
    const m = await member("mgr");
    expect([m.role, m.roleKey, m.roleName]).toEqual(["member", "manager", "Manager"]);
    const me = (await ok(mgr.api("GET", "/api/me"))).workspaces[0];
    expect([me.roleKey, me.roleName]).toEqual(["manager", "Manager"]);
    expect(me.permissions).toContain("roles.manage");
  });

  test("creating, editing and deleting roles takes roles.manage", async () => {
    await fails(ana.api("POST", "/api/roles", { name: "Mine", permissions: [] }), 403, "Only workspace admins can do that");
    await fails(ana.api("PATCH", "/api/roles/manager", { name: "x" }), 403);
    await fails(ana.api("DELETE", "/api/roles/manager"), 403);
    // A write key made before roles never manages them.
    await fails(s.as("admin", "bearer").api("POST", "/api/roles", { name: "K", permissions: [] }), 403, "Sign in to the web app to manage access; API keys can't");
    await fails(s.api("POST", "/api/roles", { name: "Bad", permissions: ["issues.fly"] }), 400, /Unknown permission "issues.fly"/);
    await fails(s.api("PATCH", "/api/roles/manager", { key: "boss" }), 400, "A role's key never changes");
  });

  test("nobody gives permissions they don't have: creating and editing roles", async () => {
    const helper = await ok(mgr.api("POST", "/api/roles", { name: "Helper", permissions: ["workspace.browse", "issues.write"] }), 201);
    expect(helper).toMatchObject({ key: "helper", builtin: null, permissions: ["workspace.browse", "issues.write"], members: 0 });
    await fails(mgr.api("POST", "/api/roles", { name: "Suspender", permissions: ["members.suspend"] }), 403, "You can't give permissions you don't have: members.suspend");
    await fails(mgr.api("PATCH", "/api/roles/helper", { permissions: ["workspace.browse", "webhooks.manage"] }), 403, /webhooks\.manage/);
    expect((await ok(mgr.api("PATCH", "/api/roles/helper", { name: "Helpers", permissions: ["workspace.browse", "comments.write"] }))).permissions).toEqual([
      "workspace.browse",
      "comments.write",
    ]);
    // A role holding more than you, even if the change would only take away.
    await role("Big", [...MEMBER, "members.suspend"], "big");
    await fails(mgr.api("PATCH", "/api/roles/big", { permissions: [] }), 403, /members\.suspend/);
    await fails(mgr.api("DELETE", "/api/roles/big"), 403, /members\.suspend/);
    // Your own role, and Admin, are never edited; Admin is copied instead.
    await fails(mgr.api("PATCH", "/api/roles/manager", { name: "Boss" }), 403, "You can't change your own role");
    await fails(mgr.api("PATCH", "/api/roles/manager", { permissions: [...MEMBER] }), 403, "You can't change your own role");
    await fails(s.api("PATCH", "/api/roles/admin", { name: "Owner" }), 400, "The Admin role can't be changed: duplicate it instead");
    expect((await role("Owner", PERMISSIONS, "owner")).permissions).toEqual([...PERMISSIONS]);
    await fails(mgr.api("POST", "/api/roles", { name: "Copy", permissions: PERMISSIONS }), 403);
  });

  test("assigning a role: any role to any member, people and agents, within what you hold, never your own", async () => {
    const bot = await s.agent("rolebot");
    await s.user("pat");
    await s.user("tim2");
    expect((await ok(assign("pat", "helper", mgr))).roleKey).toBe("helper");
    expect((await ok(assign("rolebot", "helper", mgr))).roleKey).toBe("helper");
    expect((await ok(bot.api("GET", "/api/me"))).workspaces[0].roleKey).toBe("helper");
    await fails(assign("pat", "big", mgr), 403, /members\.suspend/); // the role holds more than you
    await fails(assign("pat", "admin", mgr), 403);
    await fails(assign("admin", "member", mgr), 403); // their role does
    await fails(assign("mgr", "member", mgr), 403, "You can't change your own role");
    await ok(assign("mgr", "member")); // an admin can
    await ok(assign("mgr", "manager"));
    await fails(assign("pat", "nope"), 400, 'Unknown role "nope"');
    // Agents take any role, Admin too: the token then manages what the role lets it, but never what's browser-only, so
    // it can't give that either: not even Member, which may delete forever.
    await ok(assign("rolebot", "admin"));
    expect((await ok(bot.api("GET", "/api/me"))).workspaces[0].permissions).toContain("members.assign_role");
    expect((await ok(bot.api("GET", "/api/me"))).workspaces[0].permissions).not.toContain("members.invite");
    await fails(assign("pat", "member", bot), 403, "You can't give permissions you don't have: trash.purge");
    await ok(assign("tim2", "helper"));
    expect((await ok(assign("tim2", "agent", bot))).roleKey).toBe("agent"); // a person may hold the agents' role too
    await fails(bot.api("POST", `/api/workspaces/${ws}/invites`, { role: "member" }), 403, "Sign in to the web app to manage access; API keys can't");
    await ok(assign("rolebot", "agent"));
  });

  test("suspending takes holding the member's role", async () => {
    await role("Suspender", [...MEMBER, "members.suspend"], "suspender");
    const sus = await s.user("sus");
    await ok(assign("sus", "suspender"));
    await fails(sus.api("PATCH", `/api/workspaces/${ws}/members/mgr`, { suspended: true }), 403, /roles\.manage/);
    await ok(sus.api("PATCH", `/api/workspaces/${ws}/members/pat`, { suspended: true }));
    await ok(sus.api("PATCH", `/api/workspaces/${ws}/members/pat`, { suspended: false }));
  });

  test("deleting a role moves its members, team roles and invites to another you could give; built-in ones stay", async () => {
    await role("Temp", ["workspace.browse", "issues.write"], "temp");
    await s.user("tim");
    await ok(assign("tim", "temp"));
    await ok(s.api("POST", "/api/teams/WEB/members", { username: "pat" }));
    await ok(teamRole("WEB", "pat", "temp"));
    await ok(s.api("POST", `/api/workspaces/${ws}/invites`, { role: "temp" }), 201);
    await fails(s.api("DELETE", "/api/roles/temp"), 409, /2 members and 1 invites hold Temp/);
    await fails(mgr.api("DELETE", "/api/roles/temp?moveTo=big"), 403, /members\.suspend/);
    await fails(s.api("DELETE", "/api/roles/temp?moveTo=temp"), 400);
    await ok(s.api("DELETE", "/api/roles/temp?moveTo=helper"));
    expect((await member("tim")).roleKey).toBe("helper");
    expect(s.sql("SELECT r.key FROM team_members tm JOIN roles r ON r.id = tm.role_id JOIN teams t ON t.id = tm.team_id WHERE t.key = 'WEB'")).toEqual([{ key: "helper" }]);
    expect(s.sql("SELECT r.key FROM codes c JOIN roles r ON r.id = c.role_id WHERE c.used_at IS NULL")).toContainEqual({ key: "helper" });
    await fails(s.api("DELETE", "/api/roles/member?moveTo=helper"), 400, "Built-in roles can't be deleted");
    await fails(s.api("DELETE", "/api/roles/nope"), 404);
    await ok(s.api("DELETE", "/api/roles/big")); // nobody holds it
    expect(s.sql("PRAGMA foreign_key_check")).toEqual([]);
  });
});

describe("invites, agents and their roles", () => {
  test("an invite or a new agent gets a role you could give; a role that doesn't browse needs a team", async () => {
    await fails(mgr.api("POST", `/api/workspaces/${ws}/invites`, { role: "admin" }), 403);
    await fails(mgr.api("POST", `/api/workspaces/${ws}/invites`, { role: "owner" }), 403);
    await fails(mgr.api("POST", `/api/workspaces/${ws}/invites`, { role: "nope" }), 400);
    await ok(s.api("POST", `/api/workspaces/${ws}/invites`, { role: "suspender" }), 201);
    await role("Outsider", ["issues.write", "comments.write"], "outsider");
    await fails(s.api("POST", `/api/workspaces/${ws}/invites`, { role: "outsider" }), 400, "Pick at least one team for a guest");
    const code = (await ok(mgr.api("POST", `/api/workspaces/${ws}/invites`, { role: "helper" }), 201)).code;
    const joined = await ok(s.anon.api("POST", "/api/auth/redeem", { code, name: "Hal", username: "hal" }));
    expect(joined.user.username).toBe("hal");
    expect((await member("hal")).roleKey).toBe("helper");
    const agent = await ok(s.api("POST", `/api/workspaces/${ws}/agents`, { name: "Op", username: "opbot", role: "outsider" }), 201);
    expect((await member("opbot")).roleKey).toBe("outsider");
    expect(agent.token).toStartWith("dk_");
    await fails(s.api("POST", `/api/workspaces/${ws}/agents`, { name: "X", username: "xbot", role: "nope" }), 400);
    // Making an agent, or a new token for one, takes holding its role.
    await role("Ops", [...MEMBER, "agents.manage"], "ops");
    const ops = await s.user("ops");
    await ok(assign("ops", "ops"));
    await fails(ops.api("POST", `/api/workspaces/${ws}/agents`, { name: "Y", username: "ybot", role: "admin" }), 403);
    await ok(ops.api("POST", `/api/workspaces/${ws}/agents`, { name: "Y", username: "ybot", role: "outsider" }), 201);
    await ok(assign("ybot", "admin"));
    await fails(ops.api("POST", `/api/workspaces/${ws}/agents/ybot/token`), 403);
  });

  test("invites die when their maker can no longer give them: role changed, their role edited, the invite's role grown", async () => {
    const live = () => s.sql("SELECT COUNT(*) AS n FROM codes WHERE purpose = 'invite' AND used_at IS NULL AND created_by = (SELECT user_id FROM workspace_members WHERE username = 'mgr')")[0].n;
    const before = live();
    await ok(mgr.api("POST", `/api/workspaces/${ws}/invites`, { role: "helper" }), 201);
    expect(live()).toBe(before + 1);
    // The invite's role now holds more than its maker.
    await ok(s.api("PATCH", "/api/roles/helper", { permissions: ["workspace.browse", "members.suspend"] }));
    expect(live()).toBe(0);
    await ok(s.api("PATCH", "/api/roles/helper", { permissions: ["workspace.browse", "comments.write"] }));
    const code = (await ok(mgr.api("POST", `/api/workspaces/${ws}/invites`, { role: "helper" }), 201)).code;
    // Their role loses members.invite.
    await ok(s.api("PATCH", "/api/roles/manager", { permissions: [...MEMBER, "roles.manage", "members.assign_role"] }));
    expect(live()).toBe(0);
    await fails(s.anon.api("POST", "/api/auth/redeem", { code, name: "Late", username: "late" }), 401);
    await ok(s.api("PATCH", "/api/roles/manager", { permissions: [...MEMBER, "roles.manage", "members.assign_role", "members.invite"] }));
    // They lose the role.
    await ok(mgr.api("POST", `/api/workspaces/${ws}/invites`, { role: "member" }), 201);
    await ok(assign("mgr", "member"));
    expect(live()).toBe(0);
    await ok(assign("mgr", "manager"));
  });

  test("redeeming re-checks the maker's role, in case it changed without a role change", async () => {
    const code = (await ok(mgr.api("POST", `/api/workspaces/${ws}/invites`, { role: "member" }), 201)).code;
    // As if the role lost a permission without going through the API (e.g. a migration): the code is still there.
    const id = s.sql("SELECT id FROM roles WHERE key = 'manager'")[0].id;
    s.sql("DELETE FROM role_permissions WHERE role_id = ? AND permission = 'trash.purge'", id);
    await fails(s.anon.api("POST", "/api/auth/redeem", { code, name: "Rex", username: "rex" }), 403, "This invite is no longer valid: ask for a new one");
    s.sql("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'trash.purge')", id);
  });
});

describe("the last admin", () => {
  test("some active person keeps every permission", async () => {
    const t = await startServer();
    try {
      const eve = await t.user("eve");
      const bot = await t.agent("boss-bot");
      expect((await t.api("POST", "/api/roles", { name: "Owner", permissions: PERMISSIONS, key: "owner" })).status).toBe(201);
      expect((await t.api("PATCH", "/api/workspaces/acme/members/eve", { role: "owner" })).status).toBe(200);
      expect((await t.api("PATCH", "/api/workspaces/acme/members/boss-bot", { role: "admin" })).status).toBe(200);
      // eve (Owner) demotes the setup admin: she's now the only person holding everything; an admin agent doesn't count.
      expect((await eve.api("PATCH", "/api/workspaces/acme/members/admin", { role: "member" })).status).toBe(200);
      const suspend = await eve.api("PATCH", "/api/workspaces/acme/members/eve", { suspended: true });
      expect([suspend.status, suspend.body.error]).toEqual([409, "Add another admin first"]);
      // The agent can't take it away either: Owner holds what no token can.
      expect((await bot.api("PATCH", "/api/roles/owner", { permissions: [] })).status).toBe(403);
      expect((await bot.api("DELETE", "/api/roles/owner?moveTo=member")).status).toBe(403);
      expect((await bot.api("PATCH", "/api/workspaces/acme/members/eve", { suspended: true })).status).toBe(403);
      expect(t.sql("SELECT COUNT(*) AS n FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE key = 'owner')")[0].n).toBe(PERMISSIONS.length);
      // Once another person holds everything, it all goes through.
      expect((await eve.api("PATCH", "/api/workspaces/acme/members/admin", { role: "admin" })).status).toBe(200);
      expect((await t.api("DELETE", "/api/roles/owner?moveTo=member")).status).toBe(200);
    } finally {
      await t.stop();
    }
  });
});

describe("a role of one's own in a team", () => {
  test("it replaces the workspace role for the team's permissions, in that team only", async () => {
    await role("Reader", ["workspace.browse"], "reader");
    await ok(s.api("POST", "/api/teams/WEB/members", { username: "ana" }));
    await ok(s.api("POST", "/api/teams/OPS/members", { username: "ana" }));
    await ok(teamRole("WEB", "ana", "reader"));
    await fails(ana.api("PATCH", "/api/teams/WEB", { description: "x" }), 403);
    await ok(ana.api("PATCH", "/api/teams/OPS", { description: "x" }));
    // The web reads it: the team's members with their role there, and her permissions per team in /api/me.
    const listed = (await ok(ana.api("GET", "/api/teams/WEB/members"))).find((m: any) => m.username === "ana");
    expect(listed).toMatchObject({ role: "reader", roleName: "Reader" });
    const mine = (await ok(ana.api("GET", "/api/me"))).workspaces.find((w: any) => w.key === ws);
    expect(Object.keys(mine.teams)).toEqual(["WEB"]);
    expect(mine.teams.WEB).toContain("workspace.browse"); // the workspace's permissions stay hers in the team
    expect(mine.teams.WEB).not.toContain("team.settings");
    expect(mine.permissions).toContain("team.settings");
    // Lowering never hides: she still sees WEB and its issues.
    expect((await ok(ana.api("GET", "/api/teams"))).map((t: any) => t.key)).toContain("WEB");
    await ok(ana.api("GET", "/api/issues?team=WEB"));
    // Back to her workspace role.
    await ok(teamRole("WEB", "ana", null));
    await ok(ana.api("PATCH", "/api/teams/WEB", { description: "y" }));
  });

  test("it can raise, but only the team's permissions: never the workspace's, never what you see", async () => {
    await ok(teamRole("WEB", "gus", "admin"));
    await ok(gus.api("PATCH", "/api/teams/WEB", { description: "by gus" })); // a guest can't, but gus's role in WEB can
    await fails(gus.api("POST", "/api/teams", { key: "GUS", name: "Gus" }), 403, "Guests can't create teams"); // teams.create is the workspace's
    expect((await ok(gus.api("GET", "/api/teams"))).map((t: any) => t.key)).toEqual(["WEB"]); // workspace.browse too
    await fails(gus.api("PATCH", "/api/teams/OPS", { description: "x" }), 404);
    await ok(teamRole("WEB", "gus", null));
    await fails(gus.api("PATCH", "/api/teams/WEB", { description: "x" }), 403);
  });

  test("only for the team's members: leaving drops it", async () => {
    await ok(s.api("DELETE", "/api/teams/WEB/members/tim"));
    await fails(teamRole("WEB", "tim", "reader"), 404, "tim isn't in WEB");
    await ok(s.api("POST", "/api/teams/OPS/members", { username: "tim" }));
    await ok(teamRole("OPS", "tim", "reader"));
    await ok(s.api("DELETE", "/api/teams/OPS/members/tim"));
    await ok(s.api("POST", "/api/teams/OPS/members", { username: "tim" }));
    expect(s.sql("SELECT tm.role_id FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN workspace_members m ON m.user_id = tm.user_id WHERE t.key = 'OPS' AND m.username = 'tim'")).toEqual([{ role_id: null }]);
  });

  test("set by team.roles in that team or members.assign_role, within the team's permissions you hold, never yours", async () => {
    // ana: Member in the workspace, with team.roles in WEB through her role there.
    await role("Lead", [...MEMBER.filter((p) => TEAM_PERMISSIONS.includes(p)), "team.roles"], "lead");
    await ok(teamRole("WEB", "ana", "lead"));
    await ok(s.api("POST", "/api/teams/WEB/members", { username: "tim" }));
    await ok(s.api("POST", "/api/teams/OPS/members", { username: "pat" }));
    expect((await ok(teamRole("WEB", "tim", "reader", ana))).role).toBe("reader");
    await fails(teamRole("OPS", "tim", "reader", ana), 403, "Only workspace admins can change roles in a team"); // not in OPS
    await fails(teamRole("WEB", "tim", "admin", ana), 403, /team\.privacy/); // Admin's team permissions are more than hers there
    await ok(teamRole("WEB", "tim", "admin"));
    await fails(teamRole("WEB", "tim", "reader", ana), 403, /team\.privacy/); // so is tim's role there now
    await ok(teamRole("WEB", "tim", null));
    await fails(teamRole("WEB", "ana", null, ana), 403, "You can't change your own role");
    await fails(teamRole("WEB", "tim", "nope"), 400);
    // mgr assigns roles workspace-wide, so in any team, within what they hold.
    expect((await ok(teamRole("WEB", "tim", "member", mgr))).role).toBe("member");
    await fails(teamRole("WEB", "tim", "lead", mgr), 403, /team\.roles/);
    await fails(teamRole("WEB", "tim", "reader", s.as("tim")), 403);
  });
});

describe("changes apply at once", () => {
  test("sockets reconnect when a member's role, their role's permissions or their role in a team change", async () => {
    const pat = await s.user("sox");
    const reconnects = async (change: () => Promise<unknown>) => {
      const socket = pat.ws();
      expect(await socket.opened).toBe(true);
      await change();
      expect(await socket.closed).toBe(4401);
    };
    await reconnects(() => ok(assign("sox", "helper")));
    await reconnects(() => ok(s.api("PATCH", "/api/roles/helper", { permissions: ["workspace.browse", "comments.write", "issues.write"] })));
    await reconnects(() => ok(teamRole("WEB", "sox", "reader")));
    await reconnects(() => ok(s.api("DELETE", "/api/roles/helper?moveTo=member")));
    expect((await member("sox")).roleKey).toBe("member");
  });
});

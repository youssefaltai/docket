// What keys and agents may do under roles: a key's permissions are some of its owner's (never what's browser-only), and
// MCP shows each caller the tools their role and key allow, including those managing roles.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BROWSER_ONLY, LEGACY_WRITE_KEY, ROLE_PERMISSIONS } from "../src/shared/types.ts";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let ana: Caller; // member
const ws = "acme";

const ok = async (reply: Promise<{ status: number; body: any }>, status = 200) => {
  const r = await reply;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const key = async (who: Caller, body: Record<string, unknown>) => s.with({ token: (await ok(who.api("POST", "/api/api-keys", { name: "k", workspace: ws, ...body }), 201)).token });
const mePermissions = async (who: Caller) => (await ok(who.api("GET", "/api/me"))).workspaces[0].permissions;
const ROLE_TOOLS = ["create_role", "delete_role", "list_roles", "set_member_role", "set_team_role", "update_role"];

beforeAll(async () => {
  s = await startServer();
  await ok(s.api("POST", "/api/teams", { key: "WEB", name: "Web" }), 201);
  await ok(s.api("POST", "/api/teams", { key: "OPS", name: "Ops" }), 201);
  ana = await s.user("ana");
  await ok(s.api("POST", "/api/roles", { name: "Commenter", key: "commenter", permissions: ["workspace.browse", "comments.write"] }), 201);
  await ok(s.api("POST", "/api/roles", { name: "Manager", key: "manager", permissions: [...ROLE_PERMISSIONS.member, "roles.manage", "members.assign_role"] }), 201);
});
afterAll(() => s.stop());

describe("API keys", () => {
  test("a key's permissions: some of yours, never what's browser-only, or inherit your role's", async () => {
    await ok(ana.api("POST", "/api/api-keys", { name: "x", workspace: ws, permissions: ["members.suspend"] }), 403);
    await ok(ana.api("POST", "/api/api-keys", { name: "x", workspace: ws, permissions: ["trash.purge"] }), 400);
    await ok(ana.api("POST", "/api/api-keys", { name: "x", workspace: ws, permissions: ["issues.fly"] }), 400);
    await ok(ana.api("POST", "/api/api-keys", { name: "x", workspace: ws, scope: "read", permissions: ["issues.write"] }), 400);
    await ok(s.as("ana", "bearer").api("POST", "/api/api-keys", { name: "x", workspace: ws, permissions: [] }), 403); // keys never mint keys
    const made = await ok(ana.api("POST", "/api/api-keys", { name: "issues", workspace: ws, permissions: ["issues.write", "workspace.browse"] }), 201);
    expect(made.apiKey.permissions).toEqual(["workspace.browse", "issues.write"]);
    const listed = await ok(ana.api("GET", "/api/api-keys"));
    expect(listed.find((k: any) => k.id === made.apiKey.id).permissions).toEqual(["workspace.browse", "issues.write"]);
    expect(listed.find((k: any) => k.name === "tests").permissions).toEqual([...LEGACY_WRITE_KEY]);
    const issues = s.with({ token: made.token });
    expect(await mePermissions(issues)).toEqual(["workspace.browse", "issues.write"]);
    const issue = await ok(issues.api("POST", "/api/issues", { team: "WEB", title: "By a narrow key" }), 201);
    const comment = await issues.api("POST", `/api/issues/${issue.id}/comments`, { body: "no" });
    expect([comment.status, comment.body.error]).toEqual([403, "This API key doesn't allow comments.write"]);
    // inherit: whatever the role holds, but what only a browser may do.
    const inherit = await key(ana, { permissions: "inherit" });
    expect(await mePermissions(inherit)).toEqual(ROLE_PERMISSIONS.member.filter((p) => !BROWSER_ONLY.includes(p)));
    expect((await ok(ana.api("GET", "/api/api-keys"))).at(-1).permissions).toBeNull();
  });

  test("a key never does more than its owner's role, as it is now", async () => {
    const wide = await key(ana, { permissions: ["workspace.browse", "issues.write", "comments.write"] });
    const inherit = await key(ana, { permissions: "inherit" });
    await ok(s.api("PATCH", `/api/workspaces/${ws}/members/ana`, { role: "commenter" }));
    for (const k of [wide, inherit]) {
      expect(await mePermissions(k)).toEqual(["workspace.browse", "comments.write"]);
      expect((await k.api("POST", "/api/issues", { team: "WEB", title: "no" })).status).toBe(403);
    }
    await ok(s.api("PATCH", `/api/workspaces/${ws}/members/ana`, { role: "member" }));
    expect((await wide.api("POST", "/api/issues", { team: "WEB", title: "yes" })).status).toBe(201);
  });

  test("a key with access permissions manages access within them", async () => {
    const mgr = await s.user("mgr");
    await ok(s.api("PATCH", `/api/workspaces/${ws}/members/mgr`, { role: "manager" }));
    const k = await key(mgr, { permissions: ["workspace.browse", "roles.manage", "members.assign_role", "comments.write"] });
    await ok(k.api("POST", "/api/roles", { name: "Quiet", key: "quiet", permissions: ["workspace.browse"] }), 201);
    // Only within the key's own permissions, not the role's.
    expect((await k.api("POST", "/api/roles", { name: "Loud", permissions: ["workspace.browse", "issues.write"] })).status).toBe(403);
    await ok(k.api("PATCH", `/api/workspaces/${ws}/members/ana`, { role: "commenter" }), 403); // Member holds more than the key
    // A write key made the old way manages nothing.
    expect((await s.as("mgr", "bearer").api("POST", "/api/roles", { name: "Old", permissions: [] })).body.error).toBe("Sign in to the web app to manage access; API keys can't");
  });
});

describe("MCP", () => {
  test("tools/list shows what the caller's role and key allow", async () => {
    const commenter = await s.agent("commentbot");
    await ok(s.api("PATCH", `/api/workspaces/${ws}/members/commentbot`, { role: "commenter" }));
    const tools = await commenter.tools();
    for (const t of ["comment_issue", "comment_document", "update_comment", "delete_comment", "resolve_thread", "react", "get_issue", "list_issues"]) expect(tools).toContain(t);
    for (const t of ["create_issue", "update_issue", "claim_issue", "create_document", "attach_file", "create_project", "mark_notifications_read", "update_workspace", ...ROLE_TOOLS]) {
      expect(tools).not.toContain(t);
    }
    // A hidden tool is not found.
    expect((await commenter.toolResult("create_issue", { team: "WEB", title: "x" })).isError).toBe(true);

    const admin = await s.agent("adminbot");
    await ok(s.api("PATCH", `/api/workspaces/${ws}/members/adminbot`, { role: "admin" }));
    expect(await admin.tools()).toEqual(expect.arrayContaining([...ROLE_TOOLS, "update_workspace", "create_issue"]));
    // A member's inherit key: no role tools, until a role in a team holds team.roles.
    const inherit = await key(ana, { permissions: "inherit" });
    expect((await inherit.tools()).filter((t) => ROLE_TOOLS.includes(t))).toEqual([]);
    await ok(s.api("POST", "/api/roles", { name: "Lead", key: "lead", permissions: [...ROLE_PERMISSIONS.member, "team.roles"] }), 201);
    await ok(s.api("PATCH", "/api/teams/WEB/members/ana", { role: "lead" }));
    const lead = await key(ana, { permissions: "inherit" });
    expect((await lead.tools()).filter((t) => ROLE_TOOLS.includes(t))).toEqual(["list_roles", "set_team_role"]);
    await ok(s.api("PATCH", "/api/teams/WEB/members/ana", { role: null }));
    // A role in a team never lends the workspace's permissions: a guest who is Admin in WEB manages nothing workspace-wide.
    await s.user("gus", { role: "guest", teams: ["WEB"] });
    await ok(s.api("PATCH", "/api/teams/WEB/members/gus", { role: "admin" }));
    const gus = await key(s.as("gus"), { permissions: "inherit" });
    expect((await gus.tools()).filter((t) => [...ROLE_TOOLS, "update_workspace"].includes(t))).toEqual(["list_roles", "set_team_role"]);
    expect(await mePermissions(gus)).toEqual(ROLE_PERMISSIONS.guest);
    // A read key sees none.
    expect((await (await key(s.admin, { scope: "read" })).tools()).filter((t) => ROLE_TOOLS.includes(t))).toEqual([]);
  });

  test("roles through MCP: list, create, update, delete, a member's and a team role, within what the token holds", async () => {
    const admin = s.as("adminbot");
    expect(await admin.tool("list_roles")).toContain("admin · Admin · built-in");
    expect(await admin.tool("create_role", { name: "Triager", permissions: ["workspace.browse", "issues.write"] })).toContain("Created role triager · Triager");
    expect((await admin.toolResult("create_role", { name: "Purger", permissions: ["trash.purge"] })).isError).toBe(true); // browser-only
    expect(await admin.tool("update_role", { key: "triager", permissions: ["workspace.browse", "issues.write", "comments.write"] })).toContain("issues.write, comments.write");
    await s.user("tri");
    await ok(s.api("PATCH", `/api/workspaces/${ws}/members/tri`, { role: "commenter" }));
    expect(await admin.tool("set_member_role", { username: "tri", role: "triager" })).toBe("@tri is now Triager");
    expect(await admin.tool("list_members")).toContain("@tri · tri · Triager");
    expect(await admin.tool("set_team_role", { team: "WEB", username: "tri", role: "commenter" })).toBe("@tri in WEB: commenter");
    expect(await admin.tool("set_team_role", { team: "WEB", username: "tri", role: null })).toBe("@tri in WEB: their workspace role");
    expect((await admin.toolResult("set_member_role", { username: "adminbot", role: "member" })).content[0].text).toContain("You can't change your own role");
    expect((await admin.toolResult("delete_role", { key: "triager" })).isError).toBe(true); // tri holds it
    expect(await admin.tool("delete_role", { key: "triager", moveTo: "commenter" })).toContain("Deleted role triager");
    expect(s.sql("SELECT r.key FROM workspace_members m JOIN roles r ON r.id = m.role_id WHERE m.username = 'tri'")).toEqual([{ key: "commenter" }]);
  });
});

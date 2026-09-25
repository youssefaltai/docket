// Regression tests from the access-core security review: nobody gets into an account, workspace or
// credential they weren't given, whatever codes, links, emails, keys or team moves they use.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sessionCookie, startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "SEC", workspace: s.workspace, name: "Secret" });
  await s.api("POST", "/api/issues", { team: "SEC", title: "SECRET TITLE" });
  await s.user("mallory");
  await s.as("mallory").api("POST", "/api/workspaces", { name: "Evil", key: "evil" });
  await s.user("bob");
});
afterAll(() => s.stop());

/** Redeems a code with no session; resolves to who that made you, and where, or null if refused. */
async function redeemAnon(code: string, profile: object = {}) {
  const res = await s.anon.api("POST", "/api/auth/redeem", { code, ...profile });
  if (res.status !== 200) return null;
  const me = (await s.with({ cookie: sessionCookie(res.headers) }, "cookie").api("GET", "/api/me")).body;
  return { username: me.user.username as string, workspaces: me.workspaces.map((w: any) => w.key) as string[] };
}

test("inviting someone else's email doesn't sign the inviter in as them", async () => {
  const { code } = (await s.as("mallory").api("POST", "/api/workspaces/evil/invites", { email: "admin@example.com", role: "member" })).body;
  const got = await redeemAnon(code, { name: "M", username: "mallory2" });
  expect(got?.username).not.toBe("admin");
  expect(got?.workspaces ?? []).not.toContain("acme");
});

test("an admin's sign-in link for a member can't open that member's other workspaces", async () => {
  await s.user("bob", { workspace: "evil", by: "mallory" });
  const link = await s.as("mallory").api("POST", "/api/workspaces/evil/members/bob/sign-in-links");
  if (link.status === 201) {
    const got = await redeemAnon(link.body.code);
    expect(got?.workspaces ?? []).not.toContain(s.workspace);
  } else {
    expect(link.status).toBe(403);
  }
});

test("taking someone's email doesn't take their invites", async () => {
  await s.as("mallory").api("PATCH", "/api/me", { email: "carol@example.com" });
  await s.api("POST", "/api/workspaces", { name: "Secret", key: "secret" });
  const { code } = (await s.api("POST", "/api/workspaces/secret/invites", { email: "carol@example.com", role: "member" })).body;
  const carol = await redeemAnon(code, { name: "Carol", username: "carol" });
  expect(carol?.username).not.toBe("mallory");
  const mallorys = (await s.as("mallory").api("GET", "/api/workspaces")).body.map((w: any) => w.key);
  expect(mallorys).not.toContain("secret");
});

test("a member can't move a team out of the workspace", async () => {
  await s.api("POST", "/api/teams", { key: "MOV", workspace: s.workspace, name: "Movable" });
  const moved = await s.as("mallory").api("PATCH", "/api/teams/MOV", { workspace: "evil" });
  expect(moved.status).toBeGreaterThanOrEqual(400);
  expect((await s.api("GET", "/api/teams/MOV")).body.workspace ?? s.workspace).toBe(s.workspace);
});

test("moving a team never shows another workspace's titles", async () => {
  // A team in "side" whose issue and doc point at acme's SEC team, then moved into acme's view... and the reverse.
  await s.api("POST", "/api/workspaces", { name: "Side", key: "side" });
  await s.api("POST", "/api/teams", { key: "MIX", workspace: s.workspace, name: "Mixed" });
  const parent = (await s.api("POST", "/api/issues", { team: "MIX", title: "Parent" })).body;
  await s.api("POST", "/api/issues", { team: "SEC", title: "SECRET CHILD", parent: parent.id });
  await s.api("POST", "/api/documents", { team: "MIX", title: "Plan", content: "See SEC-1." });
  await s.api("POST", "/api/documents", { team: "SEC", title: "SECRET DOC", content: `About ${parent.id}.` });
  await s.user("sidekick", { workspace: "side" });
  await s.api("PATCH", "/api/teams/MIX", { workspace: "side" });
  const view = JSON.stringify([
    (await s.as("sidekick").api("GET", `/api/issues/${parent.id}`)).body,
    (await s.as("sidekick").api("GET", "/api/documents/plan")).body,
    (await s.as("sidekick").api("GET", "/api/issues")).body,
  ]);
  expect(view).not.toContain("SECRET");
});

test("an API key can't mint credentials or change who it belongs to", async () => {
  const key = s.as("bob", "bearer");
  expect((await key.api("POST", "/api/api-keys", { name: "copy" })).status).toBe(403);
  expect((await key.api("POST", "/api/sign-in-links")).status).toBe(403);
  expect((await key.api("DELETE", "/api/sessions")).status).toBe(403);
  expect((await key.api("PATCH", "/api/me", { email: "bob2@example.com" })).status).toBe(403);
  // Nor can an admin's key: an invite, agent or promotion made with a leaked key would outlive it.
  const admin = s.as("admin", "bearer");
  const ws = s.workspace;
  expect((await admin.api("POST", `/api/workspaces/${ws}/invites`, { role: "admin" })).status).toBe(403);
  expect((await admin.api("PATCH", `/api/workspaces/${ws}/members/bob`, { role: "admin" })).status).toBe(403);
  expect((await admin.api("POST", `/api/workspaces/${ws}/members/bob/sign-in-links`)).status).toBe(403);
  expect((await admin.api("POST", `/api/workspaces/${ws}/agents`, { name: "Leak", username: "leak" })).status).toBe(403);
  // Revoking still works with a key, so a leaked key can be killed from a script.
  const spare = (await s.as("bob").api("POST", "/api/api-keys", { name: "spare" })).body;
  expect((await key.api("DELETE", `/api/api-keys/${spare.apiKey.id}`)).status).toBeLessThan(300);
  // The browser session still can.
  expect((await s.as("bob", "cookie").api("POST", "/api/sign-in-links")).status).toBe(201);
});

test("cookie-authenticated writes need our Origin", async () => {
  // Raw fetch: the harness always sends our Origin, and this test is about other ones.
  const cookie = s.as("bob", "cookie").cookie!;
  const post = (headers: Record<string, string>) =>
    fetch(new URL("/api/sign-in-links", s.url), { method: "POST", headers: { Cookie: cookie, ...headers } });
  expect((await post({ Origin: "http://localhost:1" })).status).toBe(403);
  expect((await post({ Origin: "https://evil.example", "Content-Type": "application/json" })).status).toBe(403);
  expect((await post({ "Content-Type": "text/plain" })).status).toBeGreaterThanOrEqual(400);
  expect((await post({ Origin: new URL(s.url).origin, "Content-Type": "application/json" })).status).toBe(201);
});

test("a sign-in link dies with its person's last membership", async () => {
  await s.user("dave");
  const { code } = (await s.as("dave", "cookie").api("POST", "/api/sign-in-links")).body;
  await s.api("PATCH", `/api/workspaces/${s.workspace}/members/dave`, { suspended: true });
  expect((await s.anon.api("POST", "/api/auth/redeem", { code })).status).toBe(401);
});

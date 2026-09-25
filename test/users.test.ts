// Workspaces, members, roles and agents: who can manage whom, suspension, and never locking out the last admin.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sessionCookie, startServer, type TestServer } from "./server.ts";

let s: TestServer;
let ws: string;
beforeAll(async () => {
  s = await startServer();
  ws = s.workspace!;
  await s.api("POST", "/api/teams", { key: "USR", workspace: ws, name: "Users" });
  await s.user("ana");
  await s.agent("bot", { name: "Bot" });
});
afterAll(() => s.stop());

const members = async () => (await s.api("GET", `/api/workspaces/${ws}/members`)).body as any[];
const role = async (username: string) => (await members()).find((m) => m.user.username === username)?.role;
const patch = (username: string, body: object, by = s.admin) => by.api("PATCH", `/api/workspaces/${ws}/members/${username}`, body);

test("/api/me says who you are and where you belong", async () => {
  const me = (await s.api("GET", "/api/me")).body;
  expect(me.user).toMatchObject({ username: "admin", name: "Admin", kind: "person", email: "admin@example.com" });
  expect(me.workspaces).toEqual([{ key: ws, name: "Acme", role: "admin" }]);
  expect((await s.as("bot").api("GET", "/api/me")).body.user).toMatchObject({ username: "bot", name: "Bot", kind: "agent" });
});

test("members lists people and agents with their roles", async () => {
  const list = await members();
  expect(list.map((m) => [m.user.username, m.role])).toEqual(
    expect.arrayContaining([["admin", "admin"], ["ana", "member"], ["bot", "agent"]]),
  );
  expect(list.every((m) => m.suspendedAt === null)).toBeTrue();
});

test("only admins manage the workspace", async () => {
  const ana = s.as("ana");
  expect((await ana.api("GET", `/api/workspaces/${ws}/members`)).status).toBe(200);
  expect((await ana.api("POST", `/api/workspaces/${ws}/invites`, { role: "member" })).status).toBe(403);
  expect((await ana.api("POST", `/api/workspaces/${ws}/agents`, { name: "Rogue", username: "rogue" })).status).toBe(403);
  expect((await patch("admin", { suspended: true }, ana)).status).toBe(403);
  expect((await patch("ana", { role: "admin" }, ana)).status).toBe(403);
  expect((await ana.api("PATCH", `/api/workspaces/${ws}`, { name: "Mine" })).status).toBe(403);
  expect((await ana.api("POST", `/api/workspaces/${ws}/members/admin/sign-in-links`)).status).toBe(403);
  expect((await ana.api("POST", `/api/workspaces/${ws}/agents/bot/token`)).status).toBe(403);
  // Agents can't manage anything either, even with their own key.
  expect((await s.as("bot").api("POST", `/api/workspaces/${ws}/invites`, { role: "admin" })).status).toBe(403);
});

test("usernames are validated and globally unique", async () => {
  const redeem = async (username: string) => {
    const { code } = (await s.api("POST", `/api/workspaces/${ws}/invites`, { role: "member" })).body;
    return (await s.anon.api("POST", "/api/auth/redeem", { code, name: "N", username })).status;
  };
  for (const bad of ["A", "has space", "x", "a".repeat(33), "ümlaut"]) expect([bad, await redeem(bad)]).toEqual([bad, 400]);
  expect(await redeem("ana")).toBe(409);
  expect(await redeem("ANA")).toBe(409); // usernames fold to lowercase
  expect(await redeem("bot")).toBe(409);
  expect((await s.api("POST", `/api/workspaces/${ws}/agents`, { name: "Dup", username: "ana" })).status).toBe(409);
});

test("an invite to a second workspace adds it to the same user", async () => {
  await s.api("POST", "/api/workspaces", { name: "Side", key: "side" });
  await s.user("ana", { workspace: "side" });
  const keys = (await s.as("ana").api("GET", "/api/me")).body.workspaces.map((w: any) => w.key).sort();
  expect(keys).toEqual([ws, "side"]);
});

test("a workspace you're not in is invisible: 404, and absent from lists", async () => {
  await s.api("POST", "/api/workspaces", { name: "Hidden", key: "hidden" });
  await s.api("POST", "/api/teams", { key: "HID", workspace: "hidden", name: "Hidden" });
  const issue = (await s.api("POST", "/api/issues", { team: "HID", title: "Secret" })).body;
  await s.api("POST", "/api/documents", { team: "HID", title: "Secret plan" });

  for (const who of [s.as("ana"), s.as("bot")]) {
    expect((await who.api("GET", `/api/issues/${issue.id}`)).status).toBe(404);
    expect((await who.api("GET", "/api/documents/secret-plan")).status).toBe(404);
    expect((await who.api("GET", "/api/workspaces/hidden/members")).status).toBe(404);
    expect((await who.api("POST", "/api/issues", { team: "HID", title: "In" })).status).toBe(404);
    expect((await who.api("POST", `/api/issues/${issue.id}/comments`, { body: "hi" })).status).toBe(404);
    const everything = JSON.stringify([
      (await who.api("GET", "/api/workspaces")).body,
      (await who.api("GET", "/api/teams")).body,
      (await who.api("GET", "/api/issues")).body,
      (await who.api("GET", "/api/documents")).body,
    ]);
    expect(everything).not.toContain("HID");
    expect(everything).not.toContain("hidden");
    expect(await who.tool("list_teams")).not.toContain("HID");
  }
  // And people outside it can't be assigned there.
  expect((await s.api("PATCH", `/api/issues/${issue.id}`, { assignee: "ana" })).status).toBeGreaterThanOrEqual(400);
});

test("events only reach members of the event's workspace", async () => {
  const ana = s.as("ana").ws();
  const admin = s.admin.ws();
  expect(await ana.opened).toBeTrue();
  expect(await admin.opened).toBeTrue();
  const secret = (await s.api("POST", "/api/issues", { team: "HID", title: "Quiet" })).body;
  const open = (await s.api("POST", "/api/issues", { team: "USR", title: "Loud" })).body;
  expect((await admin.until((e) => e.id === secret.id)).workspace).toBe("hidden");
  expect((await ana.until((e) => e.id === open.id)).workspace).toBe(ws);
  expect(ana.events.some((e) => e.workspace === "hidden")).toBeFalse();
  ana.close();
  admin.close();
});

test("suspending from your last workspace signs you out everywhere; reinstating lets you sign in again", async () => {
  const sam = await s.user("sam");
  const cookie = s.as("sam", "cookie");
  const socket = sam.ws();
  expect(await socket.opened).toBeTrue();
  const other = s.as("ana").ws();
  expect(await other.opened).toBeTrue();

  expect((await patch("sam", { suspended: true })).status).toBe(200);
  expect(await socket.closed).toBe(4401);
  expect((await sam.api("GET", "/api/me")).status).toBe(401);
  expect((await cookie.api("GET", "/api/me")).status).toBe(401);
  await expect(sam.tool("list_teams")).rejects.toThrow();
  expect(await sam.ws().opened).toBeFalse();
  expect((await role("sam"))).toBe("member");
  expect((await members()).find((m) => m.user.username === "sam").suspendedAt).toBeString();
  // Others stay connected.
  await Bun.sleep(50);
  const stillOpen = await Promise.race([other.closed.then(() => false), Bun.sleep(50).then(() => true)]);
  expect(stillOpen).toBeTrue();
  other.close();

  expect((await patch("sam", { suspended: false })).status).toBe(200);
  expect((await sam.api("GET", "/api/me")).status).toBe(401);
  expect((await (await s.signIn("sam")).api("GET", "/api/me")).status).toBe(200);
});

test("an agent's token rotates and its sockets close; deleting suspends it and kills its keys", async () => {
  await s.agent("temp-bot");
  const old = s.as("temp-bot");
  const socket = old.ws();
  expect(await socket.opened).toBeTrue();
  const rotated = await s.api("POST", `/api/workspaces/${ws}/agents/temp-bot/token`);
  expect(rotated.body.token).toMatch(/^dk_/);
  expect(await socket.closed).toBe(4401);
  expect((await old.api("GET", "/api/me")).status).toBe(401);
  const fresh = s.with({ token: rotated.body.token });
  expect((await fresh.api("GET", "/api/me")).body.user.username).toBe("temp-bot");

  expect((await s.api("DELETE", `/api/workspaces/${ws}/agents/temp-bot`)).status).toBeLessThan(300);
  expect((await fresh.api("GET", "/api/me")).status).toBe(401);
  expect((await members()).find((m) => m.user.username === "temp-bot").suspendedAt).toBeString();
  // Agents have no sessions, so no sign-in links either.
  expect((await s.api("POST", `/api/workspaces/${ws}/members/bot/sign-in-links`)).status).toBeGreaterThanOrEqual(400);
});

test("an admin's sign-in link for a person signs them in once", async () => {
  const link = await s.api("POST", `/api/workspaces/${ws}/members/ana/sign-in-links`);
  expect(link.status).toBe(201);
  const res = await s.anon.api("POST", "/api/auth/redeem", { code: link.body.code });
  expect((await s.with({ cookie: sessionCookie(res.headers) }, "cookie").api("GET", "/api/me")).body.user.username).toBe("ana");
});

test("the last active admin can't be suspended or demoted", async () => {
  expect((await patch("admin", { suspended: true })).status).toBe(409);
  expect((await patch("admin", { role: "member" })).status).toBe(409);
  // A suspended admin doesn't count.
  await s.user("eve", { role: "admin" });
  await patch("eve", { suspended: true });
  expect((await patch("admin", { role: "member" })).status).toBe(409);
  // With a second active admin it's allowed, and the new last admin is then protected.
  await patch("eve", { suspended: false });
  await s.signIn("eve");
  expect((await patch("admin", { role: "member" })).status).toBe(200);
  expect((await patch("eve", { role: "member" }, s.as("eve"))).status).toBe(409);
  expect((await patch("eve", { suspended: true }, s.as("eve"))).status).toBe(409);
  expect((await patch("admin", { role: "admin" }, s.as("eve"))).status).toBe(200);
});

test("PATCH /api/me renames you without breaking your key", async () => {
  const ana = s.as("ana");
  expect((await ana.api("PATCH", "/api/me", { name: "Ana B" })).status).toBe(200);
  expect((await ana.api("PATCH", "/api/me", { username: "bot" })).status).toBe(409);
  expect((await ana.api("PATCH", "/api/me", { username: "Bad Name" })).status).toBe(400);
  expect((await ana.api("GET", "/api/me")).body.user).toMatchObject({ username: "ana", name: "Ana B" });
});

test("sign-in-link CLI: a shell on the server can always get a person back in", async () => {
  const out = await s.cli("sign-in-link", "admin");
  expect(out.exitCode).toBe(0);
  const code = out.stdout.match(/\/login#([A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5})/)?.[1];
  expect(code).toBeString();
  const res = await s.anon.api("POST", "/api/auth/redeem", { code });
  expect(res.status).toBe(200);
  expect(res.body.user.username).toBe("admin");

  expect((await s.cli("sign-in-link", "nobody")).exitCode).not.toBe(0);
  expect((await s.cli("sign-in-link", "bot")).exitCode).not.toBe(0);
  // Nothing over HTTP mints a link without being signed in.
  for (const path of ["/api/sign-in-links", `/api/workspaces/${ws}/members/admin/sign-in-links`, "/api/sign-in-link/admin"])
    expect((await s.anon.api("POST", path, { username: "admin" })).status).toBeGreaterThanOrEqual(400);
});

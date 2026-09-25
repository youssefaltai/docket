// Regression tests for the S2 access findings from the black-box e2e run against Linear's model:
// no admin impersonation, invites join only with the invitee's say-so, and suspension really revokes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  await s.user("ana");
  await s.user("bob");
  await s.as("bob").api("POST", "/api/workspaces", { name: "Side", key: "side" });
});
afterAll(() => s.stop());

const workspaces = async (username: string) =>
  ((await s.as(username).api("GET", "/api/me")).body.workspaces as { key: string }[]).map((w) => w.key);

test("an admin can't mint a sign-in link for anyone else, over any route", async () => {
  for (const path of [
    `/api/workspaces/${s.workspace}/members/ana/sign-in-links`,
    `/api/workspaces/${s.workspace}/members/admin/sign-in-links`,
  ]) {
    expect((await s.as("admin", "cookie").api("POST", path)).status).toBe(404);
  }
  // Your own link still works (for your other devices), and only for you.
  const own = await s.as("admin", "cookie").api("POST", "/api/sign-in-links", { username: "ana" });
  expect(own.status).toBe(201);
  expect((await s.anon.api("POST", "/api/auth/peek", { code: own.body.code })).body.username).toBe("admin");
});

test("opening an invite while signed in changes nothing until the invitee accepts", async () => {
  const { code } = (await s.as("bob").api("POST", "/api/workspaces/side/invites", { role: "member" })).body;
  const peeked = await s.as("ana", "cookie").api("POST", "/api/auth/peek", { code });
  expect(peeked.status).toBe(200);
  expect(peeked.body).toMatchObject({ kind: "invite", workspace: "Side", needsProfile: false, you: { username: "ana" } });
  // Peeking (what the page does on open) didn't add ana anywhere.
  expect(await workspaces("ana")).not.toContain("side");
  const sideMembers = (await s.as("bob").api("GET", "/api/workspaces/side/members")).body.map((m: any) => m.user.username);
  expect(sideMembers).not.toContain("ana");
  // Accepting is the explicit redeem.
  expect((await s.as("ana", "cookie").api("POST", "/api/auth/redeem", { code })).status).toBe(200);
  expect(await workspaces("ana")).toContain("side");
  // Signed out, a peek says who'd join: nobody yet (a new account needs a profile).
  const other = (await s.as("bob").api("POST", "/api/workspaces/side/invites", { role: "member" })).body.code;
  expect((await s.anon.api("POST", "/api/auth/peek", { code: other })).body).toMatchObject({ you: null, needsProfile: true });
});

test("suspension in one workspace ends access there at once but leaves the others alone", async () => {
  // ana is in acme and side (from the test above), with a session and an API key.
  expect(await workspaces("ana")).toEqual(expect.arrayContaining([s.workspace, "side"]));
  const cookie = s.as("ana", "cookie");
  const key = s.as("ana", "bearer");
  await s.api("POST", "/api/teams", { key: "ACM", workspace: s.workspace, name: "Acme team" });
  const socket = key.ws();
  expect(await socket.opened).toBeTrue();

  // bob, admin of side, suspends ana there: she loses side at once, and nothing else.
  const patch = (suspended: boolean) => s.as("bob", "cookie").api("PATCH", "/api/workspaces/side/members/ana", { suspended });
  expect((await patch(true)).status).toBe(200);
  expect(await socket.closed).toBe(4401); // reconnects without side's events
  for (const who of [cookie, key]) {
    expect((await who.api("GET", "/api/me")).status).toBe(200);
    expect((await who.api("GET", "/api/workspaces/side/members")).status).toBe(404);
    expect((await who.api("GET", "/api/teams?workspace=" + s.workspace)).status).toBe(200);
  }
  expect(await workspaces("ana")).not.toContain("side");
  // Reinstated, the same account is back in side.
  expect((await patch(false)).status).toBe(200);
  expect(await workspaces("ana")).toContain("side");
});

test("suspension from your only workspace deletes every credential; reinstating doesn't restore them", async () => {
  await s.user("carl");
  const carl = s.as("carl", "cookie");
  const key = s.as("carl", "bearer");
  const { code } = (await carl.api("POST", "/api/sign-in-links")).body;
  const socket = key.ws();
  expect(await socket.opened).toBeTrue();

  const patch = (suspended: boolean) => s.as("admin", "cookie").api("PATCH", `/api/workspaces/${s.workspace}/members/carl`, { suspended });
  expect((await patch(true)).status).toBe(200);
  expect((await s.as("carl", "cookie").api("GET", "/api/me")).status).toBe(401);
  expect((await key.api("GET", "/api/me")).status).toBe(401);
  expect(await socket.closed).toBe(4401);
  expect((await s.anon.api("POST", "/api/auth/redeem", { code })).status).toBe(401);

  expect((await patch(false)).status).toBe(200);
  expect((await s.as("carl", "cookie").api("GET", "/api/me")).status).toBe(401);
  expect((await key.api("GET", "/api/me")).status).toBe(401);
  // A clean account: they sign in again, with only a fresh key.
  const back = await s.signIn("carl");
  expect(await workspaces("carl")).toEqual([s.workspace!]);
  expect((await back.api("GET", "/api/api-keys")).body.map((k: any) => k.name)).toEqual(["tests"]);
});

test("suspending an agent kills its token for good; only a new token brings it back", async () => {
  const bot = await s.agent("e2e-bot");
  expect((await bot.api("GET", "/api/me")).status).toBe(200);
  const patch = (suspended: boolean) => s.as("admin", "cookie").api("PATCH", `/api/workspaces/${s.workspace}/members/e2e-bot`, { suspended });
  expect((await patch(true)).status).toBe(200);
  expect((await bot.api("GET", "/api/me")).status).toBe(401);
  expect((await patch(false)).status).toBe(200);
  expect((await bot.api("GET", "/api/me")).status).toBe(401);
  const { token } = (await s.as("admin", "cookie").api("POST", `/api/workspaces/${s.workspace}/agents/e2e-bot/token`)).body;
  expect((await s.with({ token }).api("GET", "/api/me")).body.user.username).toBe("e2e-bot");
});

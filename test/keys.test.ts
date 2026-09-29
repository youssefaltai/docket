// Every API key and agent token belongs to one workspace and acts only there (DKT-4).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let side: Caller; // ana's key for "side"; ana is in acme and side
let acmeIssue: string;
let sideIssue: string;
beforeAll(async () => {
  s = await startServer();
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  await s.api("POST", "/api/teams", { key: "ACM", workspace: "acme", name: "Acme team" });
  await s.as("admin", "cookie", "side").api("POST", "/api/teams", { key: "SID", workspace: "side", name: "Side team" });
  acmeIssue = (await s.api("POST", "/api/issues", { team: "ACM", title: "Acme secret" })).body.id;
  sideIssue = (await s.as("admin", "cookie", "side").api("POST", "/api/issues", { team: "SID", title: "Side work" })).body.id;
  await s.api("POST", "/api/documents", { team: "ACM", title: "Acme plan" });
  await s.user("ana");
  await s.user("ana", { workspace: "side" });
  side = s.as("ana", "bearer", "side");
});
afterAll(() => s.stop());

const keys = (list: { key: string }[]) => list.map((w) => w.key);

test("a key for one workspace sees only that one", async () => {
  expect(keys((await side.api("GET", "/api/workspaces")).body)).toEqual(["side"]);
  expect(keys((await side.api("GET", "/api/me")).body.workspaces)).toEqual(["side"]);
  expect((await side.api("GET", "/api/teams")).body.map((t: any) => t.key)).toEqual(["SID"]);
  const teams = await side.tool("list_teams");
  expect(teams).toContain("SID");
  expect(teams).not.toContain("ACM");
  // The session still sees both.
  expect(keys((await s.as("ana").api("GET", "/api/workspaces")).body).sort()).toEqual(["acme", "side"]);
});

test("another workspace of the same account is 404 to the key, over REST and MCP", async () => {
  expect((await side.api("GET", `/api/issues/${acmeIssue}`)).status).toBe(404);
  expect((await side.api("PATCH", `/api/issues/${acmeIssue}`, { title: "Mine" })).status).toBe(404);
  expect((await side.api("POST", `/api/issues/${acmeIssue}/comments`, { body: "hi" })).status).toBe(404);
  expect((await side.api("GET", "/api/documents/acme-plan")).status).toBe(404);
  expect((await side.api("GET", "/api/workspaces/acme/members")).status).toBe(404);
  expect((await side.api("GET", "/api/teams/ACM")).status).toBe(404);
  await expect(side.tool("get_issue", { id: acmeIssue })).rejects.toThrow(/not found/);
  expect((await s.api("GET", `/api/issues/${acmeIssue}`)).body.title).toBe("Acme secret");
});

test("a key's socket hears only its workspace", async () => {
  const socket = side.ws();
  expect(await socket.opened).toBeTrue();
  await s.api("PATCH", `/api/issues/${acmeIssue}`, { priority: 1 });
  await s.as("admin", "cookie", "side").api("PATCH", `/api/issues/${sideIssue}`, { priority: 1 });
  await socket.until((e) => e.id === sideIssue);
  expect(socket.events.some((e) => e.workspace === "acme")).toBeFalse();
  socket.close();
});

test("POST /api/api-keys makes a key for one workspace", async () => {
  const ana = s.as("ana");
  expect((await ana.api("POST", "/api/api-keys", { name: "x", workspace: "nope" })).status).toBe(404);
  const none = await ana.api("POST", "/api/api-keys", { name: "x" });
  expect([none.status, none.body.error]).toEqual([400, "Pick a workspace: send X-Docket-Workspace"]);
  const byHeader = await ana.api("POST", "/api/api-keys", { name: "x" }, { "X-Docket-Workspace": "side" });
  expect([byHeader.status, byHeader.body.apiKey.workspace]).toEqual([201, "side"]);
  expect(keys((await s.with({ token: byHeader.body.token }).api("GET", "/api/me")).body.workspaces)).toEqual(["side"]);
  expect((await ana.api("POST", "/api/api-keys", { name: "x" }, { "X-Docket-Workspace": "nope" })).status).toBe(404);
  // Someone in one workspace needs to name none.
  const solo = await s.user("solo");
  const own = await solo.api("POST", "/api/api-keys", { name: "x" });
  expect([own.status, own.body.apiKey.workspace]).toEqual([201, "acme"]);
  // A key can't make keys.
  expect((await side.api("POST", "/api/api-keys", { name: "x", workspace: "side" })).status).toBe(403);
  // Every key says where it works.
  const listed = (await ana.api("GET", "/api/api-keys")).body as { workspace: string }[];
  expect(listed.length).toBeGreaterThan(2);
  expect(listed.every((k) => k.workspace === "acme" || k.workspace === "side")).toBeTrue();
});

test("a key naming another workspace in X-Docket-Workspace is 404", async () => {
  expect((await side.api("GET", "/api/me", undefined, { "X-Docket-Workspace": "acme" })).status).toBe(404);
  expect((await side.api("GET", "/api/me", undefined, { "X-Docket-Workspace": "side" })).status).toBe(200);
});

test("MCP works in the key's workspace: no workspace arguments or workspace tools", async () => {
  const listed = await side.tool("list_issues", { workspace: "acme" }); // ignored
  expect(listed).toContain(sideIssue);
  expect(listed).not.toContain(acmeIssue);
  await expect(s.tool("create_workspace", { name: "Via MCP" })).rejects.toThrow(/not found/);
  await expect(s.tool("list_workspaces")).rejects.toThrow(/not found/);
  expect(await s.tool("update_workspace", { name: "Acme Inc" })).toContain("acme · Acme Inc");
  expect((await s.api("GET", "/api/workspaces")).body.find((w: any) => w.key === "acme").name).toBe("Acme Inc");
});

test("creating a workspace needs a session", async () => {
  const res = await s.as("admin", "bearer").api("POST", "/api/workspaces", { name: "Keyed", key: "keyed" });
  expect([res.status, res.body.error]).toEqual([403, "Sign in to the web app to create a workspace; API keys work in one workspace"]);
  expect((await s.api("POST", "/api/workspaces", { name: "Signed", key: "signed" })).status).toBe(201);
});

test("suspension kills that workspace's keys only; the session goes with the last one", async () => {
  const acme = s.as("ana", "bearer", "acme");
  const cookie = s.as("ana", "cookie");
  expect((await s.api("PATCH", "/api/workspaces/side/members/ana", { suspended: true })).status).toBe(200);
  expect((await side.api("GET", "/api/me")).status).toBe(401);
  expect((await acme.api("GET", "/api/me")).status).toBe(200);
  expect((await cookie.api("GET", "/api/me")).status).toBe(200);

  expect((await s.api("PATCH", "/api/workspaces/side/members/ana", { suspended: false })).status).toBe(200);
  expect((await side.api("GET", "/api/me")).status).toBe(401); // reinstating doesn't bring keys back
  await s.api("PATCH", "/api/workspaces/side/members/ana", { suspended: true });
  await s.api("PATCH", "/api/workspaces/acme/members/ana", { suspended: true });
  expect((await acme.api("GET", "/api/me")).status).toBe(401);
  expect((await cookie.api("GET", "/api/me")).status).toBe(401);
});

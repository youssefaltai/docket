// Auto-archive (DKT-31): a per-team setting, independent of the 30-day trash, that hides old completed/canceled
// issues from default views once they've been closed for `autoArchiveDays`. A sweep runs at startup and after
// any change that closes an issue; archiving/unarchiving by hand is REST-only (no MCP tool), attributed to whoever
// did it, or to @docket with no onBehalfOf for the time-based sweep.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

// A webhook receiver: every Issue event body it gets.
const events: any[] = [];
const receiver = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => (events.push(await req.json()), new Response("ok")) });

let s: TestServer;
beforeAll(async () => {
  s = await startServer({ env: { DOCKET_WEBHOOK_ALLOW_PRIVATE: "true" } });
  await s.api("POST", "/api/workspaces/acme/webhooks", { url: `http://127.0.0.1:${receiver.port}/`, resourceTypes: ["Issue"] });
  await s.api("POST", "/api/teams", { key: "ARC", name: "Archive" });
  await s.user("ana");
  await s.agent("claude");
});
afterAll(async () => {
  await s.stop();
  receiver.stop(true);
});

const DOCKET = { username: "docket", name: "Docket", kind: "agent" };
const create = async (team: string, title: string, extra: object = {}) => (await s.api("POST", "/api/issues", { team, title, ...extra })).body.id as string;
const get = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body;

/** Backdates an issue's completedAt directly in the fixture DB (the acceptance test's suggested shortcut). */
function backdate(id: string, iso: string) {
  const [, key, number] = /^([A-Z]+)-(\d+)$/.exec(id)!;
  const db = new Database(s.databasePath);
  db.run("UPDATE issues SET completed_at = ? WHERE team_id = (SELECT id FROM teams WHERE key = ?) AND number = ?", [iso, key!, Number(number)]);
  db.close();
}

/** The sweep runs after any change that closes an issue: close a throwaway one in `team` to trigger it. */
async function sweep(team: string) {
  const trigger = await create(team, "sweep trigger");
  await s.api("PATCH", `/api/issues/${trigger}`, { status: "done" });
}

test("PATCH /api/teams/:key { autoArchiveDays } round-trips through GET /api/teams; invalid values are 400", async () => {
  const fresh = (await s.api("GET", "/api/teams")).body.find((t: any) => t.key === "ARC");
  expect(fresh.autoArchiveDays).toBeNull();

  const patched = await s.api("PATCH", "/api/teams/ARC", { autoArchiveDays: 90 });
  expect(patched.body.autoArchiveDays).toBe(90);
  expect((await s.api("GET", "/api/teams")).body.find((t: any) => t.key === "ARC").autoArchiveDays).toBe(90);

  expect((await s.api("PATCH", "/api/teams/ARC", { autoArchiveDays: null })).body.autoArchiveDays).toBeNull();
  for (const bad of [0, -5, 1.5, "30"]) expect((await s.api("PATCH", "/api/teams/ARC", { autoArchiveDays: bad })).status).toBe(400);
  // No dedicated MCP tool for archiving/unarchiving by hand (REST-only): only update_team's autoArchiveDays.
  expect(await s.as("claude").tools()).not.toContain("archive_issue");
});

test("MCP update_team sets autoArchiveDays with the same validation as REST", async () => {
  expect(await s.tool("update_team", { key: "ARC", autoArchiveDays: 60 })).toContain("Updated team ARC");
  expect((await s.api("GET", "/api/teams")).body.find((t: any) => t.key === "ARC").autoArchiveDays).toBe(60);
  expect(await s.tool("update_team", { key: "ARC", autoArchiveDays: null })).toContain("Updated team ARC");
  expect((await s.api("GET", "/api/teams")).body.find((t: any) => t.key === "ARC").autoArchiveDays).toBeNull();
  const bad = await s.admin.toolResult("update_team", { key: "ARC", autoArchiveDays: 0 });
  expect(bad.isError).toBeTrue();
});

test("a team with autoArchiveDays unset (the default) never archives, no matter how old", async () => {
  const id = await create("ARC", "Ancient but unmanaged");
  await s.api("PATCH", `/api/issues/${id}`, { status: "done" });
  backdate(id, "2000-01-01T00:00:00.000Z");
  await sweep("ARC");
  expect((await get(id)).archivedAt).toBeNull();
  expect((await s.api("GET", "/api/issues?team=ARC")).body.map((i: any) => i.id)).toContain(id);
});

test("window boundary: not yet due stays live, just past it gets archived by the sweep", async () => {
  await s.api("PATCH", "/api/teams/ARC", { autoArchiveDays: 30 });
  const soon = await create("ARC", "29 days closed");
  const due = await create("ARC", "31 days closed");
  await s.api("PATCH", `/api/issues/${soon}`, { status: "done" });
  await s.api("PATCH", `/api/issues/${due}`, { status: "done" });
  const day = 24 * 60 * 60 * 1000;
  backdate(soon, new Date(Date.now() - 29 * day).toISOString());
  backdate(due, new Date(Date.now() - 31 * day).toISOString());
  await sweep("ARC");
  expect((await get(soon)).archivedAt).toBeNull();
  expect((await get(due)).archivedAt).toBeString();
});

test("archived issues are excluded from default lists but still found by q and by id; attributed to @docket, no onBehalfOf", async () => {
  const id = await create("ARC", "Findable once archived");
  await s.api("PATCH", `/api/issues/${id}`, { status: "done" });
  backdate(id, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString());
  const socket = s.admin.ws();
  await socket.opened;
  await sweep("ARC");
  await socket.until((e) => e.entity === "issue" && e.id === id);
  socket.close();

  const archived = await get(id);
  expect(archived.archivedAt).toBeString();
  expect(archived.activity.at(-1)).toMatchObject({ kind: "archived", actor: DOCKET, onBehalfOf: null, from: null, to: null });

  expect((await s.api("GET", "/api/issues?team=ARC")).body.map((i: any) => i.id)).not.toContain(id);
  expect((await s.api("GET", `/api/issues?team=ARC&q=${encodeURIComponent("Findable once archived")}`)).body.map((i: any) => i.id)).toContain(id);
  expect((await s.api("GET", "/api/issues?team=ARC&archived=true")).body.map((i: any) => i.id)).toContain(id);
  expect((await s.api("GET", `/api/issues/${id}`)).status).toBe(200); // openable by id regardless

  // No one is notified by the automated sweep (there's no notification kind for it).
  const { body: inbox } = await s.api("GET", "/api/notifications");
  expect(inbox.notifications.find((n: any) => n.issue?.id === id)).toBeUndefined();
});

test("an archived issue is read-only (edit, comment, claim: 409); unarchiving makes it normal again", async () => {
  const id = await create("ARC", "Manually archived");
  const archived = await s.api("POST", `/api/issues/${id}/archive`);
  expect(archived.status).toBe(200);
  expect(archived.body.archivedAt).toBeString();
  expect(archived.body.activity.at(-1)).toMatchObject({ kind: "archived", actor: { username: "admin" }, onBehalfOf: null });

  expect((await s.api("PATCH", `/api/issues/${id}`, { title: "x" })).status).toBe(409);
  expect((await s.api("POST", `/api/issues/${id}/comments`, { body: "x" })).status).toBe(409);
  expect((await s.as("ana").api("POST", `/api/issues/${id}/claim`)).status).toBe(409);
  expect((await s.api("POST", `/api/issues/${id}/archive`)).status).toBe(409); // already archived

  const unarchived = await s.api("POST", `/api/issues/${id}/unarchive`);
  expect(unarchived.status).toBe(200);
  expect(unarchived.body.archivedAt).toBeNull();
  expect(unarchived.body.activity.at(-1)).toMatchObject({ kind: "unarchived", actor: { username: "admin" }, onBehalfOf: null });
  expect((await s.api("POST", `/api/issues/${id}/unarchive`)).status).toBe(409); // already live

  expect((await s.api("PATCH", `/api/issues/${id}`, { title: "Editable again" })).status).toBe(200);
  expect((await s.api("GET", "/api/issues?team=ARC")).body.map((i: any) => i.id)).toContain(id);
});

test("archiving is refused on a trashed issue, and a trashed issue's archived_at (if any) stays as it is", async () => {
  const id = await create("ARC", "Trashed first");
  await s.api("DELETE", `/api/issues/${id}`);
  expect((await s.api("POST", `/api/issues/${id}/archive`)).status).toBe(409);
});

test("archiving and unarchiving touch nothing else: labels, team counts, relations and comments stay", async () => {
  const blocker = await create("ARC", "Blocker");
  const id = await create("ARC", "Fully wired", { labels: ["keep-me"], blockedBy: [blocker] });
  await s.api("POST", `/api/issues/${id}/comments`, { body: "still here" });
  const before = await s.api("GET", "/api/teams");
  const countsBefore = before.body.find((t: any) => t.key === "ARC").counts;

  const archived = (await s.api("POST", `/api/issues/${id}/archive`)).body;
  expect(archived).toMatchObject({ labels: ["keep-me"], blockedBy: [blocker], status: archived.status });
  expect(archived.comments).toHaveLength(1);
  const countsAfter = (await s.api("GET", "/api/teams")).body.find((t: any) => t.key === "ARC").counts;
  expect(countsAfter).toEqual(countsBefore); // archiving alone doesn't change status, so counts don't move
  expect((await s.api("GET", "/api/labels")).body.some((l: any) => l.path === "keep-me")).toBe(true);

  await s.api("POST", `/api/issues/${id}/unarchive`);
});

test("webhooks: archiving and unarchiving each send an Issue update with updatedFrom.archivedAt", async () => {
  const id = await create("ARC", "Webhook watched");
  await s.api("POST", `/api/issues/${id}/archive`);
  await s.api("POST", `/api/issues/${id}/unarchive`);
  const updates = () => events.filter((e) => e.type === "Issue" && e.action === "update" && e.data.id === id);
  for (const end = Date.now() + 3000; updates().length < 2 && Date.now() < end; ) await Bun.sleep(10);
  const [archived, unarchived] = updates();
  expect(archived).toMatchObject({ updatedFrom: { archivedAt: null }, data: { archivedAt: expect.any(String) } });
  expect(unarchived).toMatchObject({ updatedFrom: { archivedAt: expect.any(String) }, data: { archivedAt: null } });
});

test("MCP list_issues excludes archived issues by default, matching REST; archived: true includes them", async () => {
  const id = await create("ARC", "MCP visibility");
  await s.api("POST", `/api/issues/${id}/archive`);
  const claude = s.as("claude");
  expect(await claude.tool("list_issues", { team: "ARC", category: ["completed", "canceled", "backlog", "unstarted", "started"] })).not.toContain(id);
  expect(await claude.tool("list_issues", { team: "ARC", category: ["completed", "canceled", "backlog", "unstarted", "started"], archived: true })).toContain(id);
  expect((await s.api("GET", "/api/issues?team=ARC&archived=true")).body.map((i: any) => i.id)).toContain(id);
  // get_issue still works on an archived issue (openable by id).
  expect(await claude.tool("get_issue", { id })).toContain(id);
  await s.api("POST", `/api/issues/${id}/unarchive`);
});

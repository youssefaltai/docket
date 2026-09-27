// Issue history: every change is recorded once, by whoever made it, in the change's transaction.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;

beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "ACT", name: "Activity" });
  await s.user("ana");
  await s.agent("claude");
});
afterAll(() => s.stop());

const create = async (title: string, extra: object = {}) => (await s.api("POST", "/api/issues", { team: "ACT", title, ...extra })).body;
const activity = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body.activity as any[];
/** The rows added since `before`, as [kind, actor, from, to]. */
const added = async (id: string, before: any[]) =>
  (await activity(id)).slice(before.length).map((r) => [r.kind, r.actor.username, r.from, r.to]);

test("creating with an assignee and a delegate logs created, assignee and delegate by the creator", async () => {
  const issue = await create("Staffed", { assignee: "ana", delegate: "claude" });
  expect(issue.activity.map((r: any) => [r.kind, r.actor.username, r.from, r.to])).toEqual([
    ["created", "admin", null, null],
    ["assignee", "admin", null, { username: "ana", name: "ana", kind: "person" }],
    ["delegate", "admin", null, { username: "claude", name: "claude", kind: "agent" }],
  ]);
  expect(new Set(issue.activity.map((r: any) => r.createdAt))).toEqual(new Set([issue.createdAt]));
});

test("a PATCH logs only what really changed, one row per field, at one time", async () => {
  const { id } = await create("Fields");
  let before = await activity(id);
  await s.api("PATCH", `/api/issues/${id}`, { status: "in_progress", priority: 2 });
  let rows = (await activity(id)).slice(before.length);
  expect(rows.map((r) => [r.kind, r.actor.username, r.from, r.to])).toEqual([
    ["status", "admin", "backlog", "in_progress"],
    ["priority", "admin", 0, 2],
  ]);
  expect(rows[0].createdAt).toBe(rows[1].createdAt);

  // The same values again, labels in another order, an unchanged title: nothing.
  await s.api("PATCH", `/api/issues/${id}`, { labels: ["a", "b"] });
  before = await activity(id);
  await s.api("PATCH", `/api/issues/${id}`, { status: "in_progress", priority: 2, labels: ["b", "a"], title: "Fields", assignee: null });
  expect(await added(id, before)).toEqual([]);

  expect((await s.api("PATCH", `/api/issues/${id}`, { labels: ["b", "c"] })).status).toBe(200);
  expect(await added(id, before)).toEqual([["labels", "admin", ["b", "a"], ["b", "c"]]]);

  const blocker = await create("Blocker");
  const parent = await create("Parent");
  before = await activity(id);
  await s.api("PATCH", `/api/issues/${id}`, { blockedBy: [blocker.id], parent: parent.id });
  await s.api("PATCH", `/api/issues/${id}`, { blockedBy: [], parent: null });
  await s.api("PATCH", `/api/issues/${id}`, { title: "Renamed", description: "Now with words" });
  expect(await added(id, before)).toEqual([
    ["parent", "admin", null, parent.id],
    ["blockedBy", "admin", [], [blocker.id]],
    ["parent", "admin", parent.id, null],
    ["blockedBy", "admin", [blocker.id], []],
    ["title", "admin", "Fields", "Renamed"],
    ["description", "admin", null, null],
  ]);
  // Related issues bumped by the change get no rows of their own.
  expect((await activity(blocker.id)).map((r) => r.kind)).toEqual(["created"]);
  expect((await activity(parent.id)).map((r) => r.kind)).toEqual(["created"]);
});

test("a refused PATCH (409 stale version, 400 invalid) logs nothing", async () => {
  const issue = await create("Refused");
  await s.api("PATCH", `/api/issues/${issue.id}`, { title: "Moved on" });
  const before = await activity(issue.id);
  const stale = await s.api("PATCH", `/api/issues/${issue.id}`, { status: "todo", baseUpdatedAt: issue.updatedAt });
  expect(stale.status).toBe(409);
  expect((await s.api("PATCH", `/api/issues/${issue.id}`, { title: "Valid", status: "nope" })).status).toBe(400);
  expect(await added(issue.id, before)).toEqual([]);
});

test("claiming logs claimed by the claimer; claiming again logs nothing", async () => {
  const { id } = await create("Claim me", { status: "todo" });
  const before = await activity(id);
  await s.as("claude").tool("claim_issue", { id });
  await s.as("claude").tool("claim_issue", { id });
  expect(await added(id, before)).toEqual([["claimed", "claude", "todo", "in_progress"]]);
});

test("delete and restore log trashed and restored", async () => {
  const { id } = await create("Round trip");
  await s.api("DELETE", `/api/issues/${id}`);
  await s.api("POST", `/api/issues/${id}/restore`);
  expect((await activity(id)).map((r) => r.kind)).toEqual(["created", "trashed", "restored"]);
});

test("history shows people as they're known now: renames carry to earlier rows", async () => {
  const { id } = await create("Ana's", { assignee: "ana" });
  await s.as("ana").api("PATCH", `/api/issues/${id}`, { status: "todo" });
  expect((await s.as("ana").api("PATCH", `/api/workspaces/${s.workspace}/profile`, { username: "ana-renamed", name: "Ana R" })).status).toBe(200);
  const rows = await activity(id);
  expect(rows.map((r) => [r.kind, r.actor.username, r.to?.username ?? r.to])).toEqual([
    ["created", "admin", null],
    ["assignee", "admin", "ana-renamed"],
    ["status", "ana-renamed", "todo"],
  ]);
  expect(rows[2].actor.name).toBe("Ana R");
  await s.as("ana").api("PATCH", `/api/workspaces/${s.workspace}/profile`, { username: "ana", name: "ana" });
});

test("a removed (suspended) agent's history keeps its name", async () => {
  const { id } = await create("Temp work");
  await s.agent("temp", { name: "Temp bot" });
  await s.as("temp").tool("update_issue", { id, priority: 3 });
  expect((await s.api("DELETE", `/api/workspaces/${s.workspace}/agents/temp`)).status).toBe(200);
  expect((await activity(id)).at(-1)).toMatchObject({ kind: "priority", actor: { username: "temp", name: "Temp bot", kind: "agent" } });
});

test("MCP: update_issue shows up in get_issue's History, one line per change", async () => {
  const { id } = await create("Via MCP");
  await s.as("claude").tool("update_issue", { id, status: "todo", labels: ["mcp"] });
  const text = await s.as("claude").tool("get_issue", { id });
  expect(text).toContain("## History");
  expect(text).toContain("@claude · status backlog → todo, labels +mcp");
  await s.as("claude").tool("comment_issue", { id, body: "done" });
  const after = await s.as("claude").tool("get_issue", { id });
  expect(after.indexOf("## History")).toBeLessThan(after.indexOf("## Comments"));
});

test("MCP: get_issue shows the latest 30 lines of history", async () => {
  const { id } = await create("Busy");
  for (let n = 1; n <= 31; n++) await s.api("PATCH", `/api/issues/${id}`, { title: `Busy ${n}` });
  const text = await s.tool("get_issue", { id });
  const history = text.slice(text.indexOf("## History")).split("\n");
  expect(history[1]).toMatch(/^\([12] earlier changes\)$/); // 2, or 1 if creation and the first rename shared a millisecond
  expect(history.slice(2).filter(Boolean)).toHaveLength(30);
  expect(text).toContain('title "Busy 30" → "Busy 31"');
});

test("purging an issue from the trash removes its history", async () => {
  const { id } = await create("Purge me");
  await s.api("DELETE", `/api/issues/${id}`);
  const db = new Database(s.databasePath);
  const row = db.query("SELECT i.id FROM issues i JOIN teams t ON t.id = i.team_id WHERE t.key || '-' || i.number = ?").get(id) as { id: number };
  const count = () => (db.query("SELECT COUNT(*) AS n FROM issue_activity WHERE issue_id = ?").get(row.id) as { n: number }).n;
  expect(count()).toBe(2);
  db.run("UPDATE issues SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [row.id]);
  expect((await s.api("GET", "/api/teams/ACT/trash")).status).toBe(200);
  expect(count()).toBe(0);
  db.close();
});

// Bulk edits (DKT-17): POST /api/issues/bulk applies one change to many issues, each exactly as its own
// PATCH or DELETE would, and one failure doesn't stop the rest.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
const bulk = (ids: string[], patch: unknown, caller = s.api) => caller("POST", "/api/issues/bulk", { ids, patch });
const create = async (title: string, extra: Record<string, unknown> = {}) =>
  (await s.api("POST", "/api/issues", { team: "BLK", title, ...extra })).body.id as string;
const get = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body;

beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "BLK", name: "Bulk" });
  await s.user("ana");
  await s.agent("bot");
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  const side = s.as("admin", "cookie", "side");
  await side.api("POST", "/api/teams", { key: "SID", name: "Side" });
  await side.api("POST", "/api/issues", { team: "SID", title: "Elsewhere" });
});
afterAll(() => s.stop());

test("one change applies to every issue, each logged, notified and announced like its own edit", async () => {
  const a = await create("A");
  const b = await create("B");
  const socket = s.as("ana").ws();
  expect(await socket.opened).toBeTrue();
  const res = await bulk([a, b], { status: "in_progress", priority: 2, assignee: "ana", delegate: "bot" });
  expect(res.status).toBe(200);
  expect(res.body.results.map((r: any) => [r.id, r.issue.status, r.issue.priority, r.issue.assignee.username, r.issue.delegate.username])).toEqual([
    [a, "in_progress", 2, "ana", "bot"],
    [b, "in_progress", 2, "ana", "bot"],
  ]);
  for (const id of [a, b]) {
    expect((await get(id)).activity.map((r: any) => r.kind)).toEqual(["created", "status", "priority", "assignee", "delegate"]);
    await socket.until((e) => e.type === "changed" && e.entity === "issue" && e.id === id);
  }
  socket.close();
  const inbox = (await s.as("ana").api("GET", "/api/notifications")).body.notifications;
  expect(inbox.filter((n: any) => n.kind === "assigned").map((n: any) => n.issue.id).sort()).toEqual([a, b].sort());
});

test("labels: add and remove edit each issue's own; labels replaces them", async () => {
  const a = await create("La", { labels: ["bug", "ui"] });
  const b = await create("Lb", { labels: ["api"] });
  let res = await bulk([a, b], { addLabels: ["urgent"], removeLabels: ["ui"] });
  expect(res.body.results.map((r: any) => r.issue.labels)).toEqual([
    ["bug", "urgent"],
    ["api", "urgent"],
  ]);
  res = await bulk([a, b], { labels: ["one"] });
  expect(res.body.results.map((r: any) => r.issue.labels)).toEqual([["one"], ["one"]]);
});

test("estimate and project apply like their own PATCH, and fail an issue whose team lacks estimates", async () => {
  const a = await create("Ea");
  const b = await create("Eb");
  expect((await s.api("PATCH", "/api/teams/BLK", { estimateScale: "linear" })).status).toBe(200);
  const project = (await s.api("POST", "/api/projects", { teams: ["BLK"], name: "Bulk project" })).body;
  const res = await bulk([a, b], { estimate: 3, project: project.slug });
  expect(res.body.results.map((r: any) => [r.issue.estimate, r.issue.project])).toEqual([
    [3, project.slug],
    [3, project.slug],
  ]);
  expect((await get(a)).activity.map((r: any) => r.kind)).toEqual(["created", "estimate", "project"]);

  // Turn estimates off again: the same bulk field now fails each issue with updateIssue's own message.
  expect((await s.api("PATCH", "/api/teams/BLK", { estimateScale: null })).status).toBe(200);
  const off = await bulk([a], { estimate: 2 });
  expect(off.body.results).toEqual([{ id: a, error: "Turn on estimates for this team first", status: 400 }]);
});

test("a failing issue reports its error in its slot and the others still change", async () => {
  const a = await create("Ok");
  const gone = await create("Gone");
  await s.api("DELETE", `/api/issues/${gone}`);
  const res = await bulk([a, "SID-1", gone, "nope"], { priority: 1 });
  expect(res.status).toBe(200);
  expect(res.body.results.map((r: any) => [r.id, r.status ?? 200, r.error ?? r.issue.priority])).toEqual([
    [a, 200, 1],
    ["SID-1", 404, "Issue SID-1 not found"], // another workspace's, as if it didn't exist
    [gone, 409, `${gone} is in the trash; restore it first`],
    ["nope", 400, 'Invalid issue identifier "nope" (expected e.g. BRD-12)'],
  ]);
  expect((await get(a)).priority).toBe(1);
  // Side's SID-1 is untouched.
  const side = await s.as("admin", "cookie", "side").api("GET", "/api/issues/SID-1");
  expect(side.body.priority).toBe(0);
});

test("an unknown assignee fails each issue with updateIssue's own message, not a 500", async () => {
  const a = await create("Who");
  const single = await s.api("PATCH", `/api/issues/${a}`, { assignee: "nobody" });
  const res = await bulk([a], { assignee: "nobody" });
  expect(res.status).toBe(200);
  expect(res.body.results).toEqual([{ id: a, error: single.body.error, status: single.status }]);
});

test("delete moves each to the trash, and each restores on its own", async () => {
  const a = await create("Da");
  const b = await create("Db");
  const res = await bulk([a, b], { delete: true });
  expect(res.body.results.map((r: any) => [r.id, !!r.issue.deletedAt])).toEqual([
    [a, true],
    [b, true],
  ]);
  expect((await s.api("GET", "/api/issues?team=BLK")).body.map((i: any) => i.id)).not.toContain(a);
  expect((await s.api("POST", `/api/issues/${a}/restore`)).status).toBe(200);
  expect((await get(a)).deletedAt).toBeNull();
  expect((await get(b)).deletedAt).not.toBeNull();
});

test("bad requests are 400, a read-only key 403", async () => {
  const a = await create("Guard");
  const token = (await s.as("ana").api("POST", "/api/api-keys", { name: "ro", scope: "read" })).body.token;
  const res = await bulk([a], { priority: 1 }, s.with({ token }).api);
  expect([res.status, res.body.error]).toEqual([403, "This API key is read-only"]);
  expect((await get(a)).priority).toBe(0);

  const ids = Array.from({ length: 101 }, (_, n) => `BLK-${n + 1}`);
  expect(await bulk(ids, { priority: 1 }).then((r) => [r.status, r.body.error])).toEqual([400, "Select at most 100 issues"]);
  expect((await bulk(ids.slice(0, 100), { priority: 3 })).status).toBe(200);
  expect((await bulk([], { priority: 1 })).status).toBe(400);
  expect((await bulk([a], {})).status).toBe(400);
  expect((await bulk([a], { title: "x" })).body.error).toContain('Unknown field "title"');
  expect((await bulk([a], { delete: true, status: "done" })).status).toBe(400);
  expect((await s.api("POST", "/api/issues/bulk", { ids: [a], patch: { priority: 1 }, extra: 1 })).status).toBe(400);
});

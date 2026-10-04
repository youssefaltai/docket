// Per-team workflow statuses (DKT-18): each team's own statuses in Linear's fixed categories, named by a stable key.
// Categories, not keys, decide completedAt, claims, overdue, open counts and status notifications; only people change a
// workflow, only in their workspace; a status in use goes only with moveTo; Triage waits outside the default lists.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let ana: Caller;
const DEFAULT_KEYS = ["backlog", "todo", "in_progress", "in_review", "done", "canceled", "duplicate"];

beforeAll(async () => {
  s = await startServer();
  for (const key of ["WF", "OTH", "CLW", "TRI", "ORD", "DEL"]) expect((await s.api("POST", "/api/teams", { key, name: key })).status).toBe(201);
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  expect((await s.api("POST", "/api/teams", { key: "SDE", name: "Side" }, { "X-Docket-Workspace": "side" })).status).toBe(201);
  ana = await s.user("ana");
  await s.agent("bot");
});
afterAll(() => s.stop());

const team = async (key: string) => (await s.api("GET", "/api/teams")).body.find((t: any) => t.key === key);
const keys = async (key: string) => (await team(key)).statuses.map((x: any) => x.key);
const create = async (key: string, fields: Record<string, unknown> = {}) => {
  const res = await s.api("POST", "/api/issues", { team: key, title: "An issue", ...fields });
  expect(res.status).toBe(201);
  return res.body;
};
const patch = (id: string, body: Record<string, unknown>) => s.api("PATCH", `/api/issues/${id}`, body);
const addStatus = (key: string, body: Record<string, unknown>) => s.api("POST", `/api/teams/${key}/statuses`, body);
const get = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body;

test("a new team has the default workflow, starts new issues in backlog, and counts every status", async () => {
  const wf = await team("WF");
  expect(wf.statuses).toEqual([
    { key: "backlog", name: "Backlog", category: "backlog", color: "#a3a3a3", position: 1 },
    { key: "todo", name: "Todo", category: "unstarted", color: "#8f8f8f", position: 2 },
    { key: "in_progress", name: "In Progress", category: "started", color: "#e8a800", position: 3 },
    { key: "in_review", name: "In Review", category: "started", color: "#30a46c", position: 4 },
    { key: "done", name: "Done", category: "completed", color: "#5e6ad2", position: 5 },
    { key: "canceled", name: "Canceled", category: "canceled", color: "#b4b4b4", position: 6 },
    { key: "duplicate", name: "Duplicate", category: "canceled", color: "#b4b4b4", position: 7 },
  ]);
  expect(wf.defaultStatus).toBe("backlog");
  expect(wf.counts).toEqual(Object.fromEntries(DEFAULT_KEYS.map((k) => [k, 0])));
  expect(await create("WF")).toMatchObject({ status: "backlog", statusCategory: "backlog", completedAt: null });
});

test("people add, rename, recolor and reorder statuses; keys never change; bad input 400, clashes 409, agents 403, other workspaces 404", async () => {
  const socket = s.admin.ws();
  await socket.opened;
  const added = await addStatus("WF", { name: "In QA", category: "started" });
  expect(added.status).toBe(201);
  expect(added.body.statuses.find((x: any) => x.key === "in_qa")).toEqual({ key: "in_qa", name: "In QA", category: "started", color: "#e8a800", position: 5 });
  expect(await keys("WF")).toEqual(["backlog", "todo", "in_progress", "in_review", "in_qa", "done", "canceled", "duplicate"]);
  await socket.until((e) => e.entity === "team" && e.id === "WF");

  const issue = await create("WF", { status: "in_qa" });
  const renamed = await s.api("PATCH", "/api/teams/WF/statuses/in_qa", { name: "Quality", color: "#AA00FF", position: 3.5 });
  expect(renamed.status).toBe(200);
  expect(renamed.body.statuses.find((x: any) => x.key === "in_qa")).toEqual({ key: "in_qa", name: "Quality", category: "started", color: "#aa00ff", position: 3.5 });
  expect(await keys("WF")).toEqual(["backlog", "todo", "in_progress", "in_qa", "in_review", "done", "canceled", "duplicate"]);
  expect((await get(issue.id)).status).toBe("in_qa");

  // Keys derive from the name; one with no Latin letters gets status_1.
  expect((await addStatus("WF", { name: "مراجعة", category: "unstarted" })).body.statuses.map((x: any) => x.key)).toContain("status_1");
  expect((await addStatus("WF", { name: "Blocked", category: "unstarted", key: "wf_blocked" })).status).toBe(201);

  const refused: [string, string, string, unknown, number, string?][] = [
    ["POST", "/api/teams/WF/statuses", "bad color", { name: "X", category: "started", color: "red" }, 400, 'Invalid color "red"'],
    ["POST", "/api/teams/WF/statuses", "bad category", { name: "X", category: "doing" }, 400, 'Invalid category "doing"'],
    ["POST", "/api/teams/WF/statuses", "no name", { category: "started" }, 400, "name is required"],
    ["POST", "/api/teams/WF/statuses", "bad key", { name: "X", category: "started", key: "Not-OK" }, 400, 'Invalid key "Not-OK"'],
    ["POST", "/api/teams/WF/statuses", "taken name", { name: "todo", category: "started" }, 409, "WF already has a status named Todo"],
    ["POST", "/api/teams/WF/statuses", "taken key", { name: "Y", category: "started", key: "done" }, 409],
    ["PATCH", "/api/teams/WF/statuses/in_qa", "category", { category: "completed" }, 400, "A status's category never changes"],
    ["PATCH", "/api/teams/WF/statuses/in_qa", "key", { key: "qa" }, 400, "A status's key never changes"],
    ["PATCH", "/api/teams/WF/statuses/in_qa", "taken name", { name: "DONE" }, 409],
    ["PATCH", "/api/teams/WF/statuses/duplicate", "Duplicate", { name: "Dupe" }, 400, "Duplicate is a system status"],
    ["PATCH", "/api/teams/WF/statuses/nope", "unknown", { name: "Z" }, 404],
  ];
  for (const [method, path, why, body, status, error] of refused) {
    const res = await s.api(method, path, body);
    expect([why, res.status]).toEqual([why, status]);
    if (error) expect(res.body.error).toStartWith(error);
  }
  // Agents read workflows; only people change them. Another workspace's team doesn't exist here.
  const bot = s.as("bot");
  expect((await bot.api("POST", "/api/teams/WF/statuses", { name: "Bot", category: "started" })).status).toBe(403);
  expect((await bot.api("PATCH", "/api/teams/WF/statuses/in_qa", { name: "Bot" })).status).toBe(403);
  expect((await bot.api("DELETE", "/api/teams/WF/statuses/in_qa")).status).toBe(403);
  expect((await ana.api("POST", "/api/teams/SDE/statuses", { name: "Mine", category: "started" })).status).toBe(404);
  expect((await ana.api("PATCH", "/api/teams/SDE/statuses/todo", { name: "Mine" })).status).toBe(404);
  expect((await ana.api("DELETE", "/api/teams/SDE/statuses/todo")).status).toBe(404);
  expect((await ana.api("POST", "/api/teams/WF/statuses", { name: "Ana's", category: "backlog" })).status).toBe(201); // any person here
  socket.close();
});

test("an issue takes a status by key or name, only from its own team's workflow", async () => {
  expect((await addStatus("OTH", { name: "Waiting", category: "unstarted" })).status).toBe(201);
  const issue = await create("WF");
  expect((await patch(issue.id, { status: "quality" })).body.status).toBe("in_qa"); // by name, any case
  expect((await patch(issue.id, { status: "IN_REVIEW" })).body.status).toBe("in_review");
  const nope = await patch(issue.id, { status: "nope" });
  expect(nope.status).toBe(400);
  expect(nope.body.error).toStartWith('Invalid status "nope" for WF. Use one of: backlog, ');
  expect((await patch(issue.id, { status: "waiting" })).status).toBe(400); // only OTH has it
  expect((await s.api("POST", "/api/issues", { team: "WF", title: "x", status: "waiting" })).status).toBe(400);
  expect((await s.api("POST", "/api/issues/bulk", { ids: [issue.id], patch: { status: "waiting" } })).body.results[0].status).toBe(400);
  // Filters: every key must be some team's in scope.
  expect((await s.api("GET", "/api/issues?team=WF&status=waiting")).status).toBe(400);
  expect((await s.api("GET", "/api/issues?status=waiting")).status).toBe(200);
  expect((await s.api("GET", "/api/issues?status=nope")).body.error).toBe('Unknown status "nope"');
  expect((await s.api("GET", "/api/issues?category=doing")).status).toBe(400);
  expect((await s.api("GET", "/api/issues?team=WF&category=started")).body.every((i: any) => i.statusCategory === "started")).toBeTrue();
});

test("completedAt, overdue and open counts follow the category, not the key", async () => {
  expect((await addStatus("WF", { name: "Shipped", category: "completed" })).status).toBe(201);
  const issue = await create("WF", { status: "todo", dueOn: "2020-01-01", labels: ["ship"] });
  const shipped = (await patch(issue.id, { status: "shipped" })).body;
  expect(shipped).toMatchObject({ status: "shipped", statusCategory: "completed" });
  expect(shipped.completedAt).toBeString();
  expect((await patch(issue.id, { status: "done" })).body.completedAt).toBe(shipped.completedAt); // within completed
  expect((await patch(issue.id, { status: "canceled" })).body.completedAt).toBe(shipped.completedAt); // completed → canceled: still closed
  expect((await patch(issue.id, { status: "shipped" })).body.completedAt).toBe(shipped.completedAt);
  // Finished work is never overdue, and isn't open.
  const overdue = async () => (await s.api("GET", "/api/issues?team=WF&due=overdue")).body.map((i: any) => i.id);
  expect(await overdue()).not.toContain(issue.id);
  expect(await s.tool("list_labels")).toMatch(/^ship · #[0-9a-f]{6} · 0 open$/m);
  expect((await patch(issue.id, { status: "in_qa" })).body.completedAt).toBeNull();
  expect(await overdue()).toContain(issue.id);
  expect(await s.tool("list_labels")).toMatch(/^ship · #[0-9a-f]{6} · 1 open$/m);
  expect((await patch(issue.id, { status: "shipped" })).body.completedAt).toBeString();
  const wf = await team("WF");
  expect(wf.counts.shipped).toBe(1);
  expect(await s.tool("list_teams")).toMatch(/^WF · WF · workspace acme · member · \d+ open · statuses: backlog \(default\), .*shipped/m);
});

test("the default status: new issues start there over REST and MCP; it must be backlog or unstarted", async () => {
  const set = await s.api("PATCH", "/api/teams/WF", { defaultStatus: "todo" });
  expect(set.body.defaultStatus).toBe("todo");
  expect((await create("WF")).status).toBe("todo");
  expect(await s.tool("create_issue", { team: "WF", title: "Via MCP" })).toMatch(/\nWF-\d+ · todo · /);
  expect(await s.tool("list_teams")).toContain("statuses: backlog, ana_s, todo (default),");
  const done = await s.api("PATCH", "/api/teams/WF", { defaultStatus: "done" });
  expect([done.status, done.body.error]).toEqual([400, "The default status must be in Backlog or Unstarted"]);
  expect((await s.api("PATCH", "/api/teams/WF", { defaultStatus: "nope" })).status).toBe(400);
  expect((await s.api("PATCH", "/api/teams/WF", { defaultStatus: "backlog" })).body.defaultStatus).toBe("backlog");
});

test("deleting a status in use needs moveTo: live and trashed issues move, with history and events; the default, the last of a category and Duplicate stay", async () => {
  expect((await addStatus("DEL", { name: "Parked", category: "backlog" })).status).toBe(201);
  const [live, trashed] = [await create("DEL", { status: "parked" }), await create("DEL", { status: "parked" })];
  expect((await s.api("DELETE", `/api/issues/${trashed.id}`)).status).toBe(200);
  const refused = await s.api("DELETE", "/api/teams/DEL/statuses/parked");
  expect([refused.status, refused.body.error]).toEqual([409, "2 issues are Parked: pass moveTo"]);
  expect((await s.api("DELETE", "/api/teams/DEL/statuses/parked?moveTo=parked")).status).toBe(400);
  expect((await s.api("DELETE", "/api/teams/DEL/statuses/parked?moveTo=waiting")).status).toBe(400); // OTH's

  const socket = s.admin.ws();
  await socket.opened;
  const gone = await s.api("DELETE", "/api/teams/DEL/statuses/parked?moveTo=todo");
  expect(gone.status).toBe(200);
  expect(gone.body.statuses.map((x: any) => x.key)).toEqual(DEFAULT_KEYS);
  await Promise.all([live.id, trashed.id, "DEL"].map((id) => socket.until((e) => e.id === id)));
  socket.close();
  for (const id of [live.id, trashed.id]) {
    const issue = await get(id);
    expect([issue.status, issue.completedAt]).toEqual(["todo", null]);
    expect(issue.activity.at(-1)).toMatchObject({ kind: "status", from: "parked", to: "todo" });
  }
  expect((await get(trashed.id)).deletedAt).toBeString();

  // Moving across categories fixes completedAt; within a category it stays.
  expect((await addStatus("DEL", { name: "Archived", category: "completed" })).status).toBe(201);
  expect((await addStatus("DEL", { name: "Gone", category: "canceled" })).status).toBe(201);
  const archived = await create("DEL", { status: "archived" });
  const dropped = await create("DEL", { status: "gone" });
  await s.api("DELETE", "/api/teams/DEL/statuses/archived?moveTo=backlog");
  expect((await get(archived.id)).completedAt).toBeNull();
  await s.api("DELETE", "/api/teams/DEL/statuses/gone?moveTo=done");
  expect((await get(dropped.id)).completedAt).toBe(dropped.completedAt);

  const cases: [string, number, string][] = [
    ["backlog", 409, "Backlog is the default status: make another status the default first"],
    ["duplicate", 400, "Duplicate is a system status: it can't be deleted"],
    ["done", 409, "Done is the last Completed status: add another first"],
    ["canceled", 409, "Canceled is the last Canceled status: add another first"], // Duplicate doesn't count
    ["todo", 409, "Todo is the last Unstarted status: add another first"],
  ];
  for (const [key, status, error] of cases) {
    const res = await s.api("DELETE", `/api/teams/DEL/statuses/${key}?moveTo=in_progress`);
    expect([key, res.status, res.body.error]).toEqual([key, status, error]);
  }
  expect((await s.api("DELETE", "/api/teams/DEL/statuses/in_review")).status).toBe(200); // none in it: no moveTo needed
  expect((await s.api("DELETE", "/api/teams/DEL/statuses/in_progress?moveTo=todo")).body.error).toBe(
    "In Progress is the last Started status: add another first",
  );
});

test("claim: triage, backlog and unstarted issues move to the first started status; started ones keep theirs; completed and canceled are 409", async () => {
  expect((await addStatus("CLW", { name: "Doing", category: "started", position: 0 })).status).toBe(201);
  expect((await addStatus("CLW", { name: "Shipped", category: "completed" })).status).toBe(201);
  expect((await addStatus("CLW", { category: "triage" })).status).toBe(201);
  const bot = s.as("bot");
  for (const status of ["backlog", "todo", "triage"]) {
    const issue = await create("CLW", { status });
    expect((await bot.api("POST", `/api/issues/${issue.id}/claim`, {})).body).toMatchObject({ status: "doing", delegate: { username: "bot" } });
  }
  const reviewing = await create("CLW", { status: "in_review" });
  expect((await bot.api("POST", `/api/issues/${reviewing.id}/claim`, {})).body.status).toBe("in_review");
  for (const status of ["shipped", "duplicate"]) {
    const issue = await create("CLW", { status });
    const res = await bot.api("POST", `/api/issues/${issue.id}/claim`, {});
    expect([res.status, res.body.error]).toEqual([409, `${issue.id} is ${status}`]);
  }
});

test("triage: turned on by adding its status and off by deleting it; its issues stay out of the default lists", async () => {
  const on = await addStatus("TRI", { category: "triage" });
  expect(on.status).toBe(201);
  expect(on.body.statuses[0]).toEqual({ key: "triage", name: "Triage", category: "triage", color: "#f76b15", position: 1 });
  expect((await addStatus("TRI", { category: "triage", name: "Inbox" })).body.error).toBe("TRI already has Triage");
  const waiting = await create("TRI", { status: "triage" });
  expect(waiting).toMatchObject({ status: "triage", statusCategory: "triage" });
  const open = await create("TRI", { status: "todo" });
  expect(await s.tool("list_teams")).toContain("TRI · TRI · workspace acme · member · 1 open · statuses: triage, backlog (default), todo,");
  const mcp = await s.tool("list_issues", { team: "TRI" });
  expect([mcp.includes(open.id), mcp.includes(waiting.id)]).toEqual([true, false]);
  expect(await s.tool("list_issues", { team: "TRI", category: ["triage"] })).toBe(`${waiting.id} · triage · no priority · An issue`);
  expect((await s.api("GET", "/api/issues?team=TRI&category=triage")).body.map((i: any) => i.id)).toEqual([waiting.id]);
  expect((await s.api("GET", "/api/issues?team=TRI")).body.map((i: any) => i.id)).toEqual([waiting.id, open.id]); // REST: everything
  // Off: its issues go where they're told.
  const off = await s.api("DELETE", "/api/teams/TRI/statuses/triage?moveTo=backlog");
  expect(off.body.statuses.map((x: any) => x.key)).toEqual(DEFAULT_KEYS);
  expect((await get(waiting.id)).status).toBe("backlog");
});

test("order: category, then the team's order, then priority; pages walk it, and cursors from before are refused", async () => {
  expect((await addStatus("ORD", { name: "Early", category: "started", position: 2.5 })).status).toBe(201);
  const made: Record<string, string> = {};
  for (const [name, status, priority] of [
    ["review", "in_review", 1],
    ["done", "done", 1],
    ["early-low", "early", 4],
    ["progress", "in_progress", 1],
    ["early-urgent", "early", 1],
    ["backlog", "backlog", 0],
  ] as const) {
    made[name] = (await create("ORD", { status, priority })).id;
  }
  const expected = ["backlog", "early-urgent", "early-low", "progress", "review", "done"].map((n) => made[n]!);
  expect((await s.api("GET", "/api/issues?team=ORD")).body.map((i: any) => i.id)).toEqual(expected);
  const walked: string[] = [];
  for (let after: string | undefined, more = true; more; ) {
    const page = (await s.api("GET", `/api/issues?team=ORD&first=2${after ? `&after=${after}` : ""}`)).body;
    walked.push(...page.issues.map((i: any) => i.id));
    [after, more] = [page.pageInfo.endCursor, page.pageInfo.hasNextPage];
  }
  expect(walked).toEqual(expected);
  const old = Buffer.from(JSON.stringify([0, 5, "2026-01-01T00:00:00.000Z", 1, null])).toString("base64url");
  expect((await s.api("GET", `/api/issues?team=ORD&first=2&after=${old}`)).status).toBe(400);
});

test("subscribers hear of moves into in_review or a completed or canceled status, not of others", async () => {
  expect((await addStatus("OTH", { name: "Shipped", category: "completed" })).status).toBe(201);
  const issue = await create("OTH", { status: "todo" });
  await ana.api("PUT", `/api/issues/${issue.id}/subscription`);
  for (const status of ["in_progress", "waiting", "in_review", "shipped", "backlog", "canceled"]) await patch(issue.id, { status });
  const told = (await ana.api("GET", "/api/notifications")).body.notifications.filter((n: any) => n.issue?.id === issue.id);
  expect(told.map((n: any) => n.status).reverse()).toEqual(["in_review", "shipped", "canceled"]);
  expect(await ana.tool("list_notifications")).toContain(`status → shipped · ${issue.id}`);
});

// Cycles (DKT-30): per-team repeating planning periods on UTC dates. Turning them on makes the current cycle and the
// upcoming ones; issues go in the current or an upcoming one; when a cycle ends its unfinished issues roll over to the
// next (by @docket); changing the length re-dates only cycles not started; turning them off ends the current one and
// removes the upcoming ones. Time moves by shifting cycle dates in the database, then reading the cycles (which syncs).
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

// A webhook receiver: every Issue event body it gets.
const hooks: any[] = [];
const receiver = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => (hooks.push(await req.json()), new Response("ok")) });

let s: TestServer;
let ana: Caller;
let bot: Caller;
beforeAll(async () => {
  s = await startServer({ env: { DOCKET_WEBHOOK_ALLOW_PRIVATE: "true" } });
  await s.api("POST", "/api/workspaces/acme/webhooks", { url: `http://127.0.0.1:${receiver.port}/`, resourceTypes: ["Issue"] });
  for (const key of ["CYC", "OFF", "FUT", "DUO", "MCY"]) expect((await s.api("POST", "/api/teams", { key, name: key })).status).toBe(201);
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  expect((await s.as("admin", "cookie", "side").api("POST", "/api/teams", { key: "SID", name: "Side" })).status).toBe(201);
  ana = await s.user("ana");
  bot = await s.agent("bot");
});
afterAll(async () => {
  await s.stop();
  receiver.stop(true);
});

const DAY = 24 * 60 * 60 * 1000;
const today = () => `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
const plus = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY).toISOString();
const DOCKET = { username: "docket", name: "Docket", kind: "agent" };

const cycles = async (team: string) => (await s.api("GET", `/api/teams/${team}/cycles`)).body as any[];
const team = async (key: string) => (await s.api("GET", "/api/teams")).body.find((t: any) => t.key === key);
const get = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body;
const create = async (team: string, extra: object = {}) => {
  const res = await s.api("POST", "/api/issues", { team, title: `In ${team}`, ...extra });
  expect(res.status).toBe(201);
  return res.body;
};
const refused = async (res: Promise<{ status: number; body: any }>, status: number, error?: string) => {
  const { status: got, body } = await res;
  expect([got, error === undefined ? undefined : body.error]).toEqual([status, error]);
};

/** Moves a team's cycles `days` into the past, as if that much time went by. */
function age(team: string, days: number) {
  const db = new Database(s.databasePath);
  const shift = (column: string) => `${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column}, '-${days} days')`;
  db.run(`UPDATE cycles SET ${shift("starts_at")}, ${shift("ends_at")}, ${shift("completed_at")} WHERE team_id = (SELECT id FROM teams WHERE key = ?)`, [team]);
  db.close();
}

test("turning cycles on makes the current cycle and the upcoming ones; bad settings are refused", async () => {
  expect(await team("CYC")).toMatchObject({ cycleWeeks: null, upcomingCycles: 2, currentCycle: null });
  expect(await cycles("CYC")).toEqual([]);
  for (const cycleWeeks of [0, 9, 1.5, "2"]) await refused(s.api("PATCH", "/api/teams/CYC", { cycleWeeks }), 400);
  for (const upcomingCycles of [0, 16, 2.5]) await refused(s.api("PATCH", "/api/teams/CYC", { upcomingCycles }), 400);
  await refused(s.api("PATCH", "/api/teams/CYC", { cycleWeeks: 2, cycleStartsOn: "2000-01-01" }), 400, "cycleStartsOn must be today or later");
  await refused(s.api("PATCH", "/api/teams/CYC", { cycleStartsOn: today().slice(0, 10) }), 400, "cycleStartsOn only applies when turning cycles on");
  await refused(bot.api("PATCH", "/api/teams/CYC", { cycleWeeks: 2 }), 403);
  await refused(ana.api("PATCH", "/api/teams/SID", { cycleWeeks: 2 }), 404);
  await refused(s.api("GET", "/api/teams/SID/cycles"), 404);
  expect(await cycles("CYC")).toEqual([]); // nothing refused changed anything

  const on = await ana.api("PATCH", "/api/teams/CYC", { cycleWeeks: 2 });
  expect(on.body).toMatchObject({ cycleWeeks: 2, upcomingCycles: 2, currentCycle: 1 });
  const start = today();
  expect(await cycles("CYC")).toEqual([
    { team: "CYC", number: 1, startsAt: start, endsAt: plus(start, 14), state: "current", issueCount: 0, completedCount: 0, progress: 0 },
    { team: "CYC", number: 2, startsAt: plus(start, 14), endsAt: plus(start, 28), state: "upcoming", issueCount: 0, completedCount: 0, progress: 0 },
    { team: "CYC", number: 3, startsAt: plus(start, 28), endsAt: plus(start, 42), state: "upcoming", issueCount: 0, completedCount: 0, progress: 0 },
  ]);
  await refused(s.api("PATCH", "/api/teams/CYC", { cycleWeeks: 3, cycleStartsOn: today().slice(0, 10) }), 400, "cycleStartsOn only applies when turning cycles on");
});

test("issues go in the current, the next or a numbered cycle, and come out; teams without cycles and unknown ones refuse", async () => {
  expect((await create("CYC", { cycle: "current" })).cycle).toBe(1);
  const next = await create("CYC", { cycle: "next" });
  expect(next.cycle).toBe(2);
  expect((await create("CYC", { cycle: 3 })).cycle).toBe(3);
  expect((await create("CYC")).cycle).toBeNull();
  await refused(s.api("POST", "/api/issues", { team: "CYC", title: "x", cycle: 99 }), 400, "Unknown cycle 99 in CYC");
  await refused(s.api("POST", "/api/issues", { team: "CYC", title: "x", cycle: "later" }), 400, 'cycle must be a cycle number, "current", "next" or null');
  await refused(s.api("POST", "/api/issues", { team: "OFF", title: "x", cycle: "current" }), 400, "OFF doesn't use cycles");
  expect((await create("OFF", { cycle: null })).cycle).toBeNull();

  // Starting tomorrow: no current cycle yet, but "next" is its first.
  const tomorrow = plus(today(), 1);
  expect((await s.api("PATCH", "/api/teams/FUT", { cycleWeeks: 1, cycleStartsOn: tomorrow.slice(0, 10) })).body).toMatchObject({ currentCycle: null });
  expect((await cycles("FUT")).map((c) => [c.number, c.state, c.startsAt])).toEqual([
    [1, "upcoming", tomorrow],
    [2, "upcoming", plus(tomorrow, 7)],
  ]);
  await refused(s.api("POST", "/api/issues", { team: "FUT", title: "x", cycle: "current" }), 400, "FUT has no current cycle");
  expect((await create("FUT", { cycle: "next" })).cycle).toBe(1);

  // Taking it out, over REST and by an agent over MCP, each logged as a cycle change.
  expect((await s.api("PATCH", `/api/issues/${next.id}`, { cycle: null })).body.cycle).toBeNull();
  expect(await bot.tool("update_issue", { id: next.id, cycle: "current" })).toContain(`Updated ${next.id}`);
  const activity = (await get(next.id)).activity.filter((r: any) => r.kind === "cycle");
  expect(activity.map((r: any) => [r.actor.username, r.from, r.to])).toEqual([
    ["admin", 2, null],
    ["bot", null, 1],
  ]);
  const hook = await waitFor(() => hooks.find((e) => e.action === "update" && e.data.id === next.id && e.actor.username === "bot"));
  expect(hook).toMatchObject({ data: { cycle: 1 }, updatedFrom: { cycle: null } });
});

test("when a cycle ends, its unfinished issues roll over to the next, bumped, as @docket; finished, trashed and archived ones stay", async () => {
  const [done, todo, started, canceled, trashed, archived, backlog] = await Promise.all(
    ["done", "todo", "in_progress", "canceled", "todo", "todo", "backlog"].map((status) => create("CYC", { status, cycle: 1 })),
  );
  await s.api("DELETE", `/api/issues/${trashed.id}`);
  await s.api("POST", `/api/issues/${archived.id}/archive`);
  const before = await Promise.all([todo, started, backlog].map((i) => get(i.id)));
  const socket = s.admin.ws();
  expect(await socket.opened).toBe(true);

  age("CYC", 14);
  const list = await cycles("CYC");
  expect(list.map((c) => [c.number, c.state])).toEqual([
    [1, "completed"],
    [2, "current"],
    [3, "upcoming"],
    [4, "upcoming"],
  ]);
  expect(list[3]).toMatchObject({ startsAt: plus(today(), 28), endsAt: plus(today(), 42) });
  for (const [n, issue] of [todo, started, backlog].entries()) {
    const now = await get(issue.id);
    expect(now.cycle).toBe(2);
    expect(now.updatedAt > before[n].updatedAt).toBe(true);
    expect(now.activity.at(-1)).toMatchObject({ kind: "cycle", actor: DOCKET, onBehalfOf: null, from: 1, to: 2 });
    await socket.until((e) => e.entity === "issue" && e.id === issue.id);
  }
  for (const issue of [done, canceled, trashed, archived]) expect((await get(issue.id)).cycle).toBe(1);
  socket.close();
  // The completed cycle keeps what stayed: done (1), canceled (left out) and archived todo (0); the trashed one isn't counted.
  expect(list[0]).toMatchObject({ issueCount: 3, completedCount: 1, progress: 0.5 });
  await refused(s.api("PATCH", `/api/issues/${todo.id}`, { cycle: 1 }), 400, "Cycle 1 is over");
  expect((await waitFor(() => hooks.find((e) => e.data.id === todo.id && e.actor.username === "docket"))).updatedFrom).toEqual({ cycle: 1 });

  // Idempotent: syncing again changes nothing.
  const again = await get(todo.id);
  expect(await cycles("CYC")).toEqual(list);
  expect((await get(todo.id)).updatedAt).toBe(again.updatedAt);

  // Down for a month: each ended cycle completes in turn, and the issue rolls through them.
  age("CYC", 28);
  expect((await cycles("CYC")).map((c) => [c.number, c.state])).toEqual([
    [1, "completed"],
    [2, "completed"],
    [3, "completed"],
    [4, "current"],
    [5, "upcoming"],
    [6, "upcoming"],
  ]);
  const rolled = await get(todo.id);
  expect(rolled.cycle).toBe(4);
  expect(rolled.activity.filter((r: any) => r.kind === "cycle").map((r: any) => [r.from, r.to])).toEqual([
    [1, 2],
    [2, 3],
    [3, 4],
  ]);
  expect(await team("CYC")).toMatchObject({ currentCycle: 4 });
});

test("cycle=current lists every team's current-cycle issues; a number needs a team", async () => {
  await s.api("PATCH", "/api/teams/DUO", { cycleWeeks: 2 });
  const duo = await create("DUO", { cycle: "current", status: "todo" });
  const cyc = await create("CYC", { cycle: "current", status: "todo" });
  const upcoming = await create("CYC", { cycle: "next", status: "todo" });
  const current = (await s.api("GET", "/api/issues?cycle=current")).body.map((i: any) => i.id);
  expect(current).toContain(duo.id);
  expect(current).toContain(cyc.id);
  expect(current).not.toContain(upcoming.id);
  await refused(s.api("GET", "/api/issues?cycle=5"), 400, "Filter by cycle number needs a team");
  await refused(s.api("GET", "/api/issues?cycle=99&team=CYC"), 400, "Unknown cycle 99 in CYC");
  await refused(s.api("GET", "/api/issues?cycle=soon"), 400, 'Invalid cycle "soon": use current or a cycle number');
  expect((await s.api("GET", "/api/issues?cycle=5&team=CYC")).body.map((i: any) => i.id)).toEqual([upcoming.id]);
  // Views save it like any other filter.
  const view = await s.api("POST", "/api/views", { name: "This cycle", filter: { cycle: "current" } });
  expect(view.body.filter).toEqual({ cycle: "current" });
  await refused(s.api("POST", "/api/views", { name: "x", filter: { cycle: "5" } }), 400, "Filter by cycle number needs a team");
});

test("a sub-issue joins its parent's cycle when it starts unstarted or started, in the same team", async () => {
  const parent = await create("CYC", { cycle: 5, status: "todo" });
  expect((await create("CYC", { parent: parent.id, status: "todo" })).cycle).toBe(5);
  expect((await create("CYC", { parent: parent.id, status: "in_progress" })).cycle).toBe(5);
  expect((await create("CYC", { parent: parent.id })).cycle).toBeNull(); // backlog
  expect((await create("CYC", { parent: parent.id, status: "done" })).cycle).toBeNull();
  expect((await create("CYC", { parent: parent.id, status: "todo", cycle: null })).cycle).toBeNull();
  expect((await create("CYC", { parent: parent.id, status: "todo", cycle: 6 })).cycle).toBe(6);
  expect((await create("DUO", { parent: parent.id, status: "todo" })).cycle).toBeNull();
});

test("a moved issue leaves its cycle, unless the move names one of its new team's", async () => {
  const issue = await create("CYC", { cycle: "current", status: "todo" });
  const moved = (await s.api("PATCH", `/api/issues/${issue.id}`, { team: "OFF" })).body;
  expect(moved.cycle).toBeNull();
  expect(moved.activity.at(-1)).toMatchObject({ kind: "cycle", from: 4, to: null });
  const back = (await s.api("PATCH", `/api/issues/${moved.id}`, { team: "DUO", cycle: "next" })).body;
  expect(back.cycle).toBe(2);
});

test("a new length re-dates only cycles that haven't started; fewer upcoming cycles deletes none", async () => {
  const before = await cycles("CYC");
  const current = before.find((c) => c.state === "current");
  expect((await s.api("PATCH", "/api/teams/CYC", { cycleWeeks: 1 })).body.cycleWeeks).toBe(1);
  const after = await cycles("CYC");
  expect(after.filter((c) => c.state !== "upcoming")).toEqual(before.filter((c) => c.state !== "upcoming"));
  expect(after.filter((c) => c.state === "upcoming").map((c) => [c.number, c.startsAt, c.endsAt])).toEqual([
    [5, current.endsAt, plus(current.endsAt, 7)],
    [6, plus(current.endsAt, 7), plus(current.endsAt, 14)],
  ]);
  expect((await s.api("PATCH", "/api/teams/CYC", { upcomingCycles: 4 })).body.upcomingCycles).toBe(4);
  expect((await cycles("CYC")).filter((c) => c.state === "upcoming").map((c) => [c.number, c.startsAt])).toEqual([
    [5, current.endsAt],
    [6, plus(current.endsAt, 7)],
    [7, plus(current.endsAt, 14)],
    [8, plus(current.endsAt, 21)],
  ]);
  await s.api("PATCH", "/api/teams/CYC", { upcomingCycles: 1 });
  expect((await cycles("CYC")).length).toBe(8);
});

test("turning cycles off ends the current one now and removes the upcoming ones, whose issues leave them; on again continues the numbers", async () => {
  const stays = await create("CYC", { cycle: "current", status: "todo" });
  const leaves = await create("CYC", { cycle: 7, status: "todo" });
  const socket = s.admin.ws();
  expect(await socket.opened).toBe(true);
  const at = new Date().toISOString();
  const off = (await ana.api("PATCH", "/api/teams/CYC", { cycleWeeks: null })).body;
  expect(off).toMatchObject({ cycleWeeks: null, currentCycle: null });
  const list = await cycles("CYC");
  expect(list.map((c) => [c.number, c.state])).toEqual([1, 2, 3, 4].map((n) => [n, "completed"]));
  expect(list[3].endsAt >= at && list[3].endsAt <= new Date().toISOString()).toBe(true);
  expect((await get(stays.id)).cycle).toBe(4);
  const left = await get(leaves.id);
  expect(left.cycle).toBeNull();
  expect(left.activity.at(-1)).toMatchObject({ kind: "cycle", actor: { username: "ana" }, from: 7, to: null });
  await socket.until((e) => e.entity === "issue" && e.id === leaves.id);
  socket.close();
  await refused(s.api("PATCH", `/api/issues/${stays.id}`, { cycle: "current" }), 400, "CYC doesn't use cycles");

  // Nothing ends a cycle that's already over: syncing leaves the team alone.
  age("CYC", 1);
  expect((await cycles("CYC")).length).toBe(4);

  const on = (await s.api("PATCH", "/api/teams/CYC", { cycleWeeks: 2 })).body;
  expect(on).toMatchObject({ cycleWeeks: 2, currentCycle: 5 });
  expect((await cycles("CYC")).map((c) => [c.number, c.state]).slice(4)).toEqual([
    [5, "current"],
    [6, "upcoming"],
  ]);
});

test("MCP: list_cycles, list_teams and get_issue show cycles; list_issues and update_issue take them", async () => {
  expect(await s.tool("list_teams")).toMatch(/^CYC · CYC · .* · cycles every 2 weeks, current 5$/m);
  expect(await s.tool("list_teams")).toMatch(/^FUT · FUT · .* · cycles every week$/m);
  expect(await s.tool("list_teams")).toMatch(/^OFF · OFF · workspace acme · member · \d+ open · statuses: [^·]+$/m);
  const text = await bot.tool("list_cycles", { team: "cyc" });
  expect(text.split("\n")[0]).toMatch(/^Cycle 1 · completed · \d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2} · 1\/3 done · 50%$/);
  // Shows the last day (endsAt minus one), not the exclusive end.
  expect(text).toContain(`Cycle 5 · current · ${today().slice(0, 10)} – ${plus(today(), 13).slice(0, 10)} · 0/0 done · 0%`);
  expect(await bot.tool("list_cycles", { team: "OFF" })).toBe("OFF has no cycles.");
  const issue = await create("CYC", { status: "todo" });
  expect(await bot.tool("update_issue", { id: issue.id, cycle: "current" })).toContain(`Updated ${issue.id}`);
  expect(await bot.tool("get_issue", { id: issue.id })).toContain("· cycle 5 ·");
  expect(await bot.tool("list_issues", { cycle: "current", team: "CYC" })).toContain(issue.id);
  expect(await bot.tool("list_issues", { cycle: 5, team: "CYC" })).toContain(issue.id);
  expect(await bot.tool("create_issue", { team: "CYC", title: "Planned", cycle: "next" })).toMatch(/^Created CYC-\d+/);
  expect(await bot.instructions()).toContain("A team may use cycles, repeating 1–8 week planning periods (list_cycles)");
});

test("MCP update_team turns cycles on and off with the same validation as REST; agents can't", async () => {
  expect(await team("MCY")).toMatchObject({ cycleWeeks: null, currentCycle: null });
  const start = today();
  expect(await s.tool("update_team", { key: "MCY", cycleWeeks: 2, upcomingCycles: 3, cycleStartsOn: start.slice(0, 10) })).toContain("Updated team MCY");
  expect(await team("MCY")).toMatchObject({ cycleWeeks: 2, upcomingCycles: 3, currentCycle: 1 });
  // 1 current + upcomingCycles (3) kept ready.
  expect(await cycles("MCY")).toEqual([
    { team: "MCY", number: 1, startsAt: start, endsAt: plus(start, 14), state: "current", issueCount: 0, completedCount: 0, progress: 0 },
    { team: "MCY", number: 2, startsAt: plus(start, 14), endsAt: plus(start, 28), state: "upcoming", issueCount: 0, completedCount: 0, progress: 0 },
    { team: "MCY", number: 3, startsAt: plus(start, 28), endsAt: plus(start, 42), state: "upcoming", issueCount: 0, completedCount: 0, progress: 0 },
    { team: "MCY", number: 4, startsAt: plus(start, 42), endsAt: plus(start, 56), state: "upcoming", issueCount: 0, completedCount: 0, progress: 0 },
  ]);

  // Same validation as REST: rejects a bad length, and a start date only when turning cycles on.
  let bad = await s.admin.toolResult("update_team", { key: "MCY", cycleWeeks: 9 });
  expect(bad.isError).toBeTrue();
  bad = await s.admin.toolResult("update_team", { key: "MCY", cycleStartsOn: start.slice(0, 10) });
  expect(bad.isError).toBeTrue();
  bad = await bot.toolResult("update_team", { key: "MCY", cycleWeeks: 3 });
  expect(bad.isError).toBeTrue(); // agents can't change team settings

  // Off ends the current cycle now and drops the upcoming ones.
  expect(await s.tool("update_team", { key: "MCY", cycleWeeks: null })).toContain("Updated team MCY");
  expect(await team("MCY")).toMatchObject({ cycleWeeks: null, currentCycle: null });
});

/** Polls until `find` returns something (webhook deliveries are sent by a background loop). */
async function waitFor<T>(find: () => T | undefined, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
    const hit = find();
    if (hit) return hit;
  }
  throw new Error("timed out");
}

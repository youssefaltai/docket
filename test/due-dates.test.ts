// Due dates (DKT-23): a calendar date on an issue, Linear's due filters by the server's date (UTC), a due-date sort
// that pages like the default one, and parity over MCP, history and webhooks.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer({ env: { DOCKET_WEBHOOK_ALLOW_PRIVATE: "true" } });
  for (const key of ["DUE", "SRT", "MCP"]) await s.api("POST", "/api/teams", { key, name: key });
});
afterAll(() => s.stop());

/** The server's date `n` days from today, as SQLite's date('now') sees it (UTC). */
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const create = async (team: string, title: string, extra: object = {}) => {
  const res = await s.api("POST", "/api/issues", { team, title, ...extra });
  expect(res.status).toBe(201);
  return res.body;
};
const patch = (id: string, body: object) => s.api("PATCH", `/api/issues/${id}`, body);
const ids = async (query: string) => {
  const res = await s.api("GET", `/api/issues?${query}`);
  expect(res.status).toBe(200);
  return res.body.map((i: any) => i.id).sort();
};

test("dueOn round-trips through create, update and lists; null clears it; each change is history", async () => {
  const a = await create("DUE", "Round trip", { dueOn: "2026-10-01" });
  expect(a.dueOn).toBe("2026-10-01");
  expect((await create("DUE", "Undated")).dueOn).toBeNull();
  expect((await patch(a.id, { dueOn: "2027-02-28" })).body.dueOn).toBe("2027-02-28");
  expect((await patch(a.id, { title: "Round trip, renamed" })).body.dueOn).toBe("2027-02-28"); // untouched by other edits
  expect((await s.api("GET", "/api/issues?team=DUE")).body.find((i: any) => i.id === a.id).dueOn).toBe("2027-02-28");
  const cleared = (await patch(a.id, { dueOn: null })).body;
  expect(cleared.dueOn).toBeNull();
  await patch(a.id, { dueOn: null }); // no change, no history
  expect(cleared.activity.filter((x: any) => x.kind === "dueOn").map((x: any) => [x.from, x.to])).toEqual([
    ["2026-10-01", "2027-02-28"],
    ["2027-02-28", null],
  ]);
  expect((await s.api("GET", `/api/issues/${a.id}`)).body.activity.filter((x: any) => x.kind === "dueOn")).toHaveLength(2);
  // Creating with one is part of the creation, like status or priority.
  expect(a.activity.map((x: any) => x.kind)).toEqual(["created"]);
});

test("invalid dates are 400 and change nothing", async () => {
  const a = await create("DUE", "Invalid", { dueOn: "2026-10-01" });
  for (const dueOn of ["2026-13-40", "tomorrow", "2026-02-30", "2026-9-1", "2026-09-01T00:00:00Z", "", 20260901, true]) {
    const res = await patch(a.id, { dueOn });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("dueOn must be a date like 2026-09-30");
    expect((await s.api("POST", "/api/issues", { team: "DUE", title: "x", dueOn })).status).toBe(400);
  }
  expect((await patch(a.id, { dueOn: "2028-02-29" })).body.dueOn).toBe("2028-02-29"); // a leap day exists
  expect((await s.api("GET", `/api/issues/${a.id}`)).body.dueOn).toBe("2028-02-29");
});

test("due filters follow Linear: overdue skips finished work; soon is today to 7 days out; today, any, none", async () => {
  await s.api("POST", "/api/teams", { key: "FLT", name: "Filters" });
  const past = await create("FLT", "Past, open", { dueOn: day(-3), status: "todo" });
  const pastDone = await create("FLT", "Past, done", { dueOn: day(-3), status: "done" });
  const pastCanceled = await create("FLT", "Past, canceled", { dueOn: day(-1), status: "canceled" });
  const today = await create("FLT", "Today", { dueOn: day(0), labels: ["ship"] });
  const todayDone = await create("FLT", "Today, done", { dueOn: day(0), status: "done" });
  const week = await create("FLT", "In 7 days", { dueOn: day(7), labels: ["ship"] });
  const later = await create("FLT", "In 8 days", { dueOn: day(8) });
  const none = await create("FLT", "No date");
  const sorted = (...issues: any[]) => issues.map((i) => i.id).sort();
  expect(await ids("team=FLT&due=overdue")).toEqual(sorted(past));
  expect(await ids("team=FLT&due=soon")).toEqual(sorted(today, todayDone, week));
  expect(await ids("team=FLT&due=today")).toEqual(sorted(today, todayDone));
  expect(await ids("team=FLT&due=any")).toEqual(sorted(past, pastDone, pastCanceled, today, todayDone, week, later));
  expect(await ids("team=FLT&due=none")).toEqual(sorted(none));
  // Combined with the other filters and search.
  expect(await ids("team=FLT&due=soon&label=ship")).toEqual(sorted(today, week));
  expect(await ids("team=FLT&due=soon&q=7%20days")).toEqual(sorted(week));
  expect(await ids("team=FLT&due=overdue&status=todo,done")).toEqual(sorted(past));
  // An issue that's finished stops being overdue; reopening it makes it overdue again.
  await patch(past.id, { status: "done" });
  expect(await ids("team=FLT&due=overdue")).toEqual([]);
  await patch(pastDone.id, { status: "in_progress" });
  expect(await ids("team=FLT&due=overdue")).toEqual(sorted(pastDone));
  expect((await s.api("GET", "/api/issues?due=late")).status).toBe(400);
});

test("sort=due: earliest first, undated last, ties in the default order; pages resume across every boundary", async () => {
  const make = (title: string, extra: object) => create("SRT", title, extra);
  const undatedUrgent = await make("Undated, todo", { priority: 1, status: "todo" }); // status ranks before priority
  const d2 = await make("Due in 2", { dueOn: day(2) });
  const d1low = await make("Due in 1, low", { dueOn: day(1), priority: 4, status: "todo" });
  const d1high = await make("Due in 1, high", { dueOn: day(1), priority: 2, status: "todo" });
  const past = await make("Due last year", { dueOn: "2025-01-01" });
  const undated = await make("Undated", {});
  const d1done = await make("Due in 1, done", { dueOn: day(1), status: "done" });
  const order = [past, d1high, d1low, d1done, d2, undated, undatedUrgent].map((i) => i.id);
  const all = (await s.api("GET", "/api/issues?team=SRT&sort=due")).body;
  expect(all.map((i: any) => i.id)).toEqual(order);
  // Every page size walks the same order, with no repeats or gaps (a boundary lands inside the ties and at the undated ones).
  for (const first of [1, 2, 3, 4]) {
    const seen: string[] = [];
    let after = "";
    for (;;) {
      const page = (await s.api("GET", `/api/issues?team=SRT&sort=due&first=${first}${after && `&after=${after}`}`)).body;
      seen.push(...page.issues.map((i: any) => i.id));
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    expect(seen).toEqual(order);
  }
  // The default order still pages as before.
  const byDefault = (await s.api("GET", "/api/issues?team=SRT")).body.map((i: any) => i.id);
  expect(byDefault).not.toEqual(order);
  const pages: string[] = [];
  let after = "";
  for (;;) {
    const page = (await s.api("GET", `/api/issues?team=SRT&first=3${after && `&after=${after}`}`)).body;
    pages.push(...page.issues.map((i: any) => i.id));
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  expect(pages).toEqual(byDefault);
  // Filters narrow the sorted list too.
  expect((await s.api("GET", "/api/issues?team=SRT&sort=due&due=any&status=todo")).body.map((i: any) => i.id)).toEqual([d1high.id, d1low.id]);
  expect((await s.api("GET", "/api/issues?sort=newest")).status).toBe(400);
  expect((await s.api("GET", `/api/issues?first=2&after=${Buffer.from("[0,5,\"x\",1]").toString("base64url")}`)).status).toBe(400);
});

test("MCP: create_issue and update_issue take dueOn; list_issues filters, sorts and shows it; history names it", async () => {
  const created = await s.tool("create_issue", { team: "MCP", title: "Late", dueOn: day(-2), status: "todo" });
  const late = /Created (MCP-\d+)/.exec(created)![1]!;
  expect(created).toContain(`· overdue ${day(-2)}`);
  const soon = /Created (MCP-\d+)/.exec(await s.tool("create_issue", { team: "MCP", title: "Soon", dueOn: day(3) }))![1]!;
  await s.tool("create_issue", { team: "MCP", title: "Whenever" });
  expect((await s.api("GET", `/api/issues/${soon}`)).body.dueOn).toBe(day(3));
  const listed = await s.tool("list_issues", { team: "MCP", due: "any", sort: "due" });
  expect(listed.split("\n")).toEqual([`${late} · todo · no priority · Late · overdue ${day(-2)}`, `${soon} · backlog · no priority · Soon · due ${day(3)}`]);
  expect(await s.tool("list_issues", { team: "MCP", due: "overdue" })).toStartWith(`${late} ·`);
  expect(await s.tool("list_issues", { team: "MCP", due: "none" })).toContain("Whenever");
  // Done: no longer overdue, in the line or the filter.
  expect(await s.tool("update_issue", { id: late, status: "done" })).toContain(`· due ${day(-2)}`);
  expect(await s.tool("list_issues", { team: "MCP", due: "overdue", status: ["done"] })).toBe("No matching issues.");
  await s.tool("update_issue", { id: soon, dueOn: null });
  expect((await s.api("GET", `/api/issues/${soon}`)).body.dueOn).toBeNull();
  expect(await s.tool("get_issue", { id: soon })).toContain(`due date ${day(3)} → none`);
  await expect(s.tool("update_issue", { id: soon, dueOn: "tomorrow" })).rejects.toThrow();
  await expect(s.tool("update_issue", { id: soon, dueOn: "2026-02-30" })).rejects.toThrow("dueOn must be a date like 2026-09-30");
  await expect(s.tool("list_issues", { due: "late" })).rejects.toThrow();
});

test("webhooks carry the previous due date in updatedFrom", async () => {
  const hook = await s.api("POST", "/api/workspaces/acme/webhooks", { url: "http://127.0.0.1:1/hook", resourceTypes: ["Issue"] });
  expect(hook.status).toBe(201);
  const a = await create("DUE", "Hooked");
  const sql = (query: string) => {
    const db = new Database(s.databasePath, { readonly: true });
    try {
      return db.query(query).all() as any[];
    } finally {
      db.close();
    }
  };
  const mark = sql("SELECT COALESCE(MAX(id), 0) AS id FROM webhook_deliveries")[0].id;
  await patch(a.id, { dueOn: "2026-10-01" });
  await patch(a.id, { dueOn: "2026-10-02", priority: 2 });
  await patch(a.id, { dueOn: null });
  const log = sql(`SELECT json_extract(payload, '$.updatedFrom') AS was, json_extract(payload, '$.data.dueOn') AS due FROM webhook_deliveries WHERE id > ${mark} ORDER BY id`);
  expect(log.map((d) => [JSON.parse(d.was), d.due])).toEqual([
    [{ dueOn: null }, "2026-10-01"],
    [{ priority: 0, dueOn: "2026-10-01" }, "2026-10-02"],
    [{ dueOn: "2026-10-02" }, null],
  ]);
  await s.api("DELETE", `/api/workspaces/acme/webhooks/${hook.body.webhook.id}`);
});

// Custom views (DKT-28): a workspace's saved filters with display options. Every member sees and uses them; only
// the creator or an admin changes or deletes one; stars are per person; nothing crosses workspaces.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let ana: Caller;
let bob: Caller;
let bot: Caller;
beforeAll(async () => {
  s = await startServer();
  expect((await s.api("POST", "/api/teams", { key: "WEB", name: "Web" })).status).toBe(201);
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  ana = await s.user("ana");
  bob = await s.user("bob");
  bot = await s.agent("bot");
});
afterAll(() => s.stop());

const create = async (body: Record<string, unknown>, caller = ana) => {
  const res = await caller.api("POST", "/api/views", body);
  expect(res.status).toBe(201);
  return res.body;
};

test("a view saves a filter and display options; every member lists and reads it, live", async () => {
  const ws = bob.ws();
  expect(await ws.opened).toBe(true);
  const view = await create({ name: "  My bugs ", filter: { team: "WEB", label: "Bug", assignee: "me", q: " crash ", due: "", status: [] } });
  expect(view).toMatchObject({
    workspace: "acme",
    name: "My bugs",
    filter: { team: "WEB", label: "Bug", assignee: "me", q: "crash" }, // trimmed; unset fields dropped
    display: { groupBy: "status", orderBy: "priority", layout: "list" },
    creator: { username: "ana", name: "ana", kind: "person" },
    favorite: false,
  });
  expect(Object.keys(view.filter).sort()).toEqual(["assignee", "label", "q", "team"]);
  await ws.until((e) => e.entity === "view" && e.id === String(view.id) && e.workspace === "acme");
  ws.close();

  expect((await bob.api("GET", `/api/views/${view.id}`)).body).toEqual(view);
  expect((await bot.api("GET", "/api/views")).body.map((v: any) => v.name)).toContain("My bugs");
  const all = await create({ name: "all open", display: { groupBy: "label", orderBy: "created", layout: "board" } }, bob);
  expect(all).toMatchObject({ filter: {}, display: { groupBy: "label", orderBy: "created", layout: "board" } });
  // By name, case-insensitively.
  expect((await s.api("GET", "/api/views")).body.map((v: any) => v.name)).toEqual(["all open", "My bugs"]);
});

test("the creator edits a view; others see the change live; a partial display keeps the rest", async () => {
  const view = await create({ name: "Triage-ish", filter: { status: ["todo"] }, display: { layout: "board" } });
  const ws = bob.ws();
  expect(await ws.opened).toBe(true);
  const res = await ana.api("PATCH", `/api/views/${view.id}`, { name: "Todo", filter: { priority: undefined, delegate: "bot" }, display: { groupBy: "priority" } });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ name: "Todo", filter: { delegate: "bot" }, display: { groupBy: "priority", orderBy: "priority", layout: "board" } });
  expect(res.body.filter.status).toBeUndefined(); // filter replaces the whole filter
  expect(res.body.updatedAt >= view.updatedAt).toBe(true);
  await ws.until((e) => e.entity === "view" && e.id === String(view.id));
  ws.close();
  expect((await bob.api("GET", `/api/views/${view.id}`)).body.name).toBe("Todo");
});

test("only the creator or a workspace admin changes or deletes a view; any member uses it", async () => {
  const view = await create({ name: "Ana's" });
  for (const [method, body] of [["PATCH", { name: "Mine now" }], ["DELETE", undefined]] as const) {
    for (const caller of [bob, bot]) {
      const res = await caller.api(method, `/api/views/${view.id}`, body);
      expect([res.status, res.body.error]).toEqual([403, "Only the view's creator or a workspace admin can change it"]);
    }
  }
  expect((await s.api("PATCH", `/api/views/${view.id}`, { name: "Renamed by admin" })).body.name).toBe("Renamed by admin");
  // Agents save views too, and own the ones they save.
  const bots = await create({ name: "Bot's" }, bot);
  expect(bots.creator).toMatchObject({ username: "bot", kind: "agent" });
  expect((await bot.api("PATCH", `/api/views/${bots.id}`, { name: "Bot's queue" })).status).toBe(200);
  expect((await s.api("DELETE", `/api/views/${bots.id}`)).status).toBe(200);
  expect((await ana.api("DELETE", `/api/views/${view.id}`)).body.name).toBe("Renamed by admin");
  // Gone for everyone.
  expect((await ana.api("GET", `/api/views/${view.id}`)).status).toBe(404);
  expect((await ana.api("PATCH", `/api/views/${view.id}`, { name: "x" })).status).toBe(404);
  expect((await ana.api("DELETE", `/api/views/${view.id}`)).status).toBe(404);
});

test("stars are per person: each sees their own, twice changes nothing, and only they hear about it", async () => {
  const view = await create({ name: "Starred" });
  const anaWs = ana.ws();
  const bobWs = bob.ws();
  expect(await anaWs.opened).toBe(true);
  expect(await bobWs.opened).toBe(true);
  for (let n = 0; n < 2; n++) expect((await bob.api("PUT", `/api/views/${view.id}/favorite`)).body.favorite).toBe(true);
  await bobWs.until((e) => e.entity === "view" && e.id === String(view.id));
  expect((await bot.api("PUT", `/api/views/${view.id}/favorite`)).body.favorite).toBe(true);
  expect((await ana.api("GET", `/api/views/${view.id}`)).body.favorite).toBe(false);
  expect((await bob.api("GET", "/api/views")).body.find((v: any) => v.id === view.id).favorite).toBe(true);
  expect(anaWs.events.some((e) => e.entity === "view" && e.id === String(view.id))).toBe(false);
  anaWs.close();
  bobWs.close();

  for (let n = 0; n < 2; n++) expect((await bob.api("DELETE", `/api/views/${view.id}/favorite`)).body.favorite).toBe(false);
  expect((await bot.api("GET", `/api/views/${view.id}`)).body.favorite).toBe(true);
  // Deleting the view takes its stars along (and a new view never inherits one).
  await ana.api("DELETE", `/api/views/${view.id}`);
  expect((await bot.api("PUT", `/api/views/${view.id}/favorite`)).status).toBe(404);
  expect((await create({ name: "Fresh" })).favorite).toBe(false);
});

test("filter and display take only known fields and values, checked as issue lists check them", async () => {
  const bad = async (body: Record<string, unknown>, error: string, method = "POST", path = "/api/views") => {
    const res = await ana.api(method, path, body);
    expect([res.status, res.body.error]).toEqual([400, error]);
  };
  const fields = "team, status, category, label, assignee, delegate, creator, parent, project, q, subscribed, due, archived";
  await bad({ name: "x", filter: { workspace: "side" } }, `Unknown filter field "workspace": use ${fields}`);
  await bad({ name: "x", filter: { sort: "due" } }, `Unknown filter field "sort": use ${fields}`);
  await bad({ name: "x", filter: { priority: 1 } }, `Unknown filter field "priority": use ${fields}`);
  await bad({ name: "x", filter: { project: "nope" } }, 'Unknown project "nope"');
  await bad({ name: "x", filter: ["team"] }, "filter must be an object");
  await bad({ name: "x", filter: { team: 5 } }, "filter.team must be a string");
  await bad({ name: "x", filter: { status: "todo" } }, "filter.status must be an array of strings");
  await bad({ name: "x", filter: { subscribed: "yes" } }, "filter.subscribed must be true or false");
  await bad({ name: "x", filter: { team: "NOPE" } }, 'Unknown team "NOPE"');
  await bad({ name: "x", filter: { assignee: "nobody" } }, 'Unknown assignee "nobody"');
  await bad({ name: "x", filter: { status: ["nope"] } }, 'Unknown status "nope"');
  await bad({ name: "x", filter: { due: "later" } }, 'Invalid due "later". Use one of: overdue, soon, today, any, none');
  await bad({ name: "x", display: { groupBy: "team" } }, 'Invalid groupBy "team". Use one of: status, assignee, priority, label');
  await bad({ name: "x", display: { orderBy: "due" } }, 'Invalid orderBy "due". Use one of: priority, updated, created');
  await bad({ name: "x", display: { layout: "table" } }, 'Invalid layout "table". Use one of: list, board');
  await bad({ name: "x", display: { density: "compact" } }, 'Unknown display field "density": use groupBy, orderBy, layout');
  await bad({ name: " " }, "name is required");
  await bad({ name: "x", sort: "due" }, 'Unknown field "sort" for a view: use name, workspace, filter, display');
  await bad({ name: "x", workspace: "side" }, "Views are created in the workspace you're in");
  expect((await s.api("POST", "/api/projects", { name: "Launch", slug: "launch", teams: ["WEB"] })).status).toBe(201);
  const view = await create({ name: "Strict", workspace: "acme", filter: { subscribed: true, archived: false, category: ["started"], project: "launch" } });
  expect(view.filter).toEqual({ subscribed: true, category: ["started"], project: "launch" });
  const at = `/api/views/${view.id}`;
  await bad({ workspace: "side" }, "Views can't move between workspaces", "PATCH", at);
  await bad({ favorite: true }, 'Unknown field "favorite" for a view: use name, filter, display', "PATCH", at);
  await bad({ filter: { creator: "ghost" } }, 'Unknown creator "ghost"', "PATCH", at);
  // A refused edit changes nothing.
  expect((await ana.api("GET", at)).body).toEqual(view);
});

test("views never cross workspaces", async () => {
  const side = s.as("admin", "cookie", "side");
  const theirs = (await side.api("POST", "/api/views", { name: "Side view" })).body;
  expect(theirs.workspace).toBe("side");
  const ours = await create({ name: "Acme view" });
  expect((await side.api("GET", "/api/views")).body.map((v: any) => v.name)).toEqual(["Side view"]);
  expect((await s.api("GET", "/api/views")).body.map((v: any) => v.name)).not.toContain("Side view");
  // The admin of both, acting in acme, can't reach side's view by id; ana isn't in side at all.
  for (const [method, path] of [["GET", ""], ["PATCH", ""], ["DELETE", ""], ["PUT", "/favorite"]] as const) {
    expect((await s.api(method, `/api/views/${theirs.id}${path}`, method === "PATCH" ? { name: "x" } : undefined)).status).toBe(404);
    expect((await ana.api(method, `/api/views/${theirs.id}${path}`, method === "PATCH" ? { name: "x" } : undefined)).status).toBe(404);
    expect((await side.api(method, `/api/views/${ours.id}${path}`, method === "PATCH" ? { name: "x" } : undefined)).status).toBe(404);
  }
  // A filter resolves in the view's workspace: acme's team isn't side's.
  expect((await side.api("POST", "/api/views", { name: "x", filter: { team: "WEB" } })).body.error).toBe('Unknown team "WEB"');
});

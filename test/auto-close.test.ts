// Auto-close (Linear's per-team settings): a parent closes when its last open sub-issue does, and closing a parent
// closes its open sub-issues. Docket makes those changes itself, as @docket, on behalf of whoever set them off.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

// A webhook receiver: every Issue event body it gets.
const events: any[] = [];
const receiver = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => (events.push(await req.json()), new Response("ok")) });

let s: TestServer;

beforeAll(async () => {
  s = await startServer({ env: { DOCKET_WEBHOOK_ALLOW_PRIVATE: "true" } });
  await s.api("POST", "/api/workspaces/acme/webhooks", { url: `http://127.0.0.1:${receiver.port}/`, resourceTypes: ["Issue"] });
  await s.api("POST", "/api/teams", { key: "OFF", name: "Off" });
  await s.api("POST", "/api/teams", { key: "AUT", name: "Auto" });
  await s.api("PATCH", "/api/teams/AUT", { autoCloseParent: true, autoCloseChildren: true });
  await s.api("POST", "/api/teams/AUT/statuses", { name: "Released", category: "completed" }); // after Done
  // A team without "done": sub-issues there close to its own statuses, the first of the category.
  await s.api("POST", "/api/teams", { key: "OTH", name: "Other" });
  await s.api("POST", "/api/teams/OTH/statuses", { name: "Shipped", category: "completed", position: 0 });
  await s.api("POST", "/api/teams/OTH/statuses", { name: "Verified", category: "completed" });
  await s.api("DELETE", "/api/teams/OTH/statuses/done");
  await s.user("ana");
  await s.agent("claude");
});
afterAll(async () => {
  await s.stop();
  receiver.stop(true);
});

const DOCKET = { username: "docket", name: "Docket", kind: "agent" };
const create = async (team: string, title: string, extra: object = {}) =>
  (await s.api("POST", "/api/issues", { team, title, status: "todo", ...extra })).body.id as string;
const get = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body;
const statusOf = async (id: string) => (await get(id)).status;
const setStatus = (id: string, status: string, as = "ana") => s.as(as).api("PATCH", `/api/issues/${id}`, { status });
const lastRow = async (id: string) => (await get(id)).activity.at(-1);

test("both settings are off by default and switch per team, people only", async () => {
  const off = (await s.api("GET", "/api/teams")).body.find((t: any) => t.key === "OFF");
  expect([off.autoCloseParent, off.autoCloseChildren]).toEqual([false, false]);
  const aut = (await s.api("GET", "/api/teams")).body.find((t: any) => t.key === "AUT");
  expect([aut.autoCloseParent, aut.autoCloseChildren]).toEqual([true, true]);

  const bad = await s.api("PATCH", "/api/teams/OFF", { autoCloseParent: "yes" });
  expect([bad.status, bad.body.error]).toEqual([400, "autoCloseParent must be true or false"]);
  expect((await s.as("claude").api("PATCH", "/api/teams/OFF", { autoCloseParent: true })).status).toBe(403);

  // MCP update_team sets them too; a new team can start with them on.
  await s.tool("update_team", { key: "OFF", autoCloseChildren: true });
  expect((await s.api("PATCH", "/api/teams/OFF", {})).body).toMatchObject({ autoCloseParent: false, autoCloseChildren: true });
  await s.tool("update_team", { key: "OFF", autoCloseChildren: false });
  const made = await s.api("POST", "/api/teams", { key: "NEW", name: "New", autoCloseParent: true });
  expect(made.body).toMatchObject({ autoCloseParent: true, autoCloseChildren: false });
});

test("with the settings off, closing sub-issues never touches the parent and closing the parent never touches them", async () => {
  const parent = await create("OFF", "Parent");
  const a = await create("OFF", "A", { parent });
  const b = await create("OFF", "B", { parent });
  await setStatus(a, "done");
  await setStatus(b, "canceled");
  expect(await statusOf(parent)).toBe("todo");

  const other = await create("OFF", "Other parent");
  const c = await create("OFF", "C", { parent: other });
  await setStatus(other, "done");
  expect(await statusOf(c)).toBe("todo");
});

test("closing the last open sub-issue closes the parent, as @docket on behalf of whoever closed it", async () => {
  const parent = await create("AUT", "Parent");
  const a = await create("AUT", "A", { parent });
  const b = await create("AUT", "B", { parent });
  const trashed = await create("AUT", "Trashed", { parent });
  await s.api("DELETE", `/api/issues/${trashed}`); // trashed sub-issues don't hold the parent open

  await setStatus(a, "canceled");
  expect(await statusOf(parent)).toBe("todo");
  await setStatus(b, "in_progress"); // not closing: nothing
  expect(await statusOf(parent)).toBe("todo");
  await setStatus(b, "done", "ana");
  const closed = await get(parent);
  expect([closed.status, closed.completedAt === null]).toEqual(["done", false]); // done even though one was canceled
  expect(closed.activity.at(-1)).toMatchObject({ kind: "status", actor: DOCKET, onBehalfOf: { username: "ana" }, from: "todo", to: "done" });
  // The sub-issue's own change stays ana's.
  expect(await lastRow(b)).toMatchObject({ kind: "status", actor: { username: "ana" }, onBehalfOf: null });

  // One-directional: reopening a sub-issue leaves the parent closed.
  await setStatus(b, "todo");
  expect(await statusOf(parent)).toBe("done");
});

test("closing a parent closes its open sub-issues to the same status; closed ones are left alone", async () => {
  const parent = await create("AUT", "Parent");
  const open = await create("AUT", "Open", { parent });
  const started = await create("AUT", "Started", { parent, status: "in_progress" });
  const done = await create("AUT", "Done already", { parent, status: "done" });
  const elsewhere = await create("OTH", "In another team", { parent });
  const doneRows = (await get(done)).activity.length;

  await setStatus(parent, "canceled");
  expect(await statusOf(open)).toBe("canceled");
  expect(await statusOf(started)).toBe("canceled");
  expect(await statusOf(elsewhere)).toBe("canceled");
  expect(await statusOf(done)).toBe("done");
  expect((await get(done)).activity.length).toBe(doneRows); // no row, no event for it
  expect(await lastRow(open)).toMatchObject({ kind: "status", actor: DOCKET, onBehalfOf: { username: "ana" }, from: "todo", to: "canceled" });

  // Done in a team without "done": its own first completed status. Duplicate never spreads: the first other canceled one.
  const p2 = await create("AUT", "Parent 2");
  const e2 = await create("OTH", "Elsewhere 2", { parent: p2 });
  const c2 = await create("AUT", "Same team 2", { parent: p2 });
  await setStatus(p2, "released");
  expect([await statusOf(c2), await statusOf(e2)]).toEqual(["released", "shipped"]);
  const p3 = await create("AUT", "Parent 3");
  const c3 = await create("AUT", "Child 3", { parent: p3 });
  const canonical = await create("AUT", "Canonical");
  await s.api("PATCH", `/api/issues/${p3}`, { duplicateOf: canonical });
  expect([await statusOf(p3), await statusOf(c3)]).toEqual(["duplicate", "canceled"]);

  // Only closing sets it off: not a move between closed statuses, not reopening.
  const p4 = await create("AUT", "Closed before its sub-issue", { status: "done" });
  const c4 = await create("AUT", "Child 4", { parent: p4 });
  await setStatus(p4, "canceled");
  await setStatus(p4, "todo");
  expect(await statusOf(c4)).toBe("todo");
});

test("a chain cascades: up from the last leaf, and down from the top", async () => {
  const top = await create("AUT", "Top");
  const mid = await create("AUT", "Mid", { parent: top });
  const leaf = await create("OTH", "Leaf", { parent: mid });
  const socket = s.admin.ws();
  await socket.opened;
  await setStatus(leaf, "shipped");
  expect([await statusOf(mid), await statusOf(top)]).toEqual(["done", "done"]);
  for (const id of [leaf, mid, top]) await socket.until((e) => e.entity === "issue" && e.id === id);
  expect(await lastRow(top)).toMatchObject({ actor: DOCKET, onBehalfOf: { username: "ana" } });

  // A parent in a team that doesn't auto-close parents stays open, and the chain stops there.
  const offTop = await create("AUT", "Top 2");
  const offMid = await create("OFF", "Mid 2", { parent: offTop });
  const offLeaf = await create("AUT", "Leaf 2", { parent: offMid });
  await setStatus(offLeaf, "done");
  expect([await statusOf(offMid), await statusOf(offTop)]).toEqual(["todo", "todo"]);

  const root = await create("AUT", "Root");
  const branch = await create("AUT", "Branch", { parent: root });
  const twig = await create("AUT", "Twig", { parent: branch });
  await setStatus(root, "done");
  expect([await statusOf(branch), await statusOf(twig)]).toEqual(["done", "done"]);
  socket.close();
});

test("followers and webhooks hear of an auto-close from Docket, and MCP history says whose change set it off", async () => {
  const parent = await create("AUT", "Watched"); // the admin created it, so follows it
  const child = await create("AUT", "Last one", { parent });
  await s.as("claude").tool("update_issue", { id: child, status: "done" }); // MCP runs the same cascade as REST
  expect(await statusOf(parent)).toBe("done");
  const [latest] = (await s.api("GET", "/api/notifications")).body.notifications;
  expect(latest).toMatchObject({ kind: "status", status: "done", actor: DOCKET, issue: { id: parent } });
  expect(await s.tool("get_issue", { id: parent })).toMatch(/ · @docket · closed the issue, status todo → done \(after @claude's change\)/);
  const update = (id: string) => events.find((e) => e.data.id === id && e.action === "update");
  for (const end = Date.now() + 3000; !(update(child) && update(parent)) && Date.now() < end; ) await Bun.sleep(10);
  expect(update(child)).toMatchObject({ actor: { username: "claude" }, updatedFrom: { status: "todo" } });
  expect(update(parent)).toMatchObject({ actor: DOCKET, updatedFrom: { status: "todo" }, data: { status: "done" } });
});

test("docket is reserved and never a member: no one can take it, assign it, delegate to it or mention it", async () => {
  const reserved = [400, '"docket" is reserved'];
  const invite = (await s.api("POST", "/api/workspaces/acme/invites", {})).body.code;
  const redeem = await s.anon.api("POST", "/api/auth/redeem", { code: invite, name: "D", username: "docket" });
  expect([redeem.status, redeem.body.error]).toEqual(reserved);
  const agent = await s.api("POST", "/api/workspaces/acme/agents", { name: "D", username: "Docket" });
  expect([agent.status, agent.body.error]).toEqual(reserved);
  const profile = await s.api("PATCH", "/api/workspaces/acme/profile", { username: "docket" });
  expect([profile.status, profile.body.error]).toEqual(reserved);

  const members = (await s.api("GET", "/api/workspaces/acme/members")).body.map((m: any) => m.user.username);
  expect(members).not.toContain("docket");
  const id = await create("AUT", "Try");
  expect((await s.api("PATCH", `/api/issues/${id}`, { assignee: "docket" })).status).toBe(400);
  expect((await s.api("PATCH", `/api/issues/${id}`, { delegate: "docket" })).status).toBe(400);
  expect((await s.api("GET", "/api/issues?assignee=docket")).status).toBe(400);
  expect(await s.as("claude").tool("list_members")).not.toContain("docket");
  await s.api("POST", `/api/issues/${id}/comments`, { body: "Thanks @docket" }); // mentions no one (checked below)
  const setup = await startServer({ setup: false });
  try {
    const res = await setup.anon.api("POST", "/api/setup", { code: "TESTS-SETUP", name: "D", username: "docket", workspace: { name: "D" } });
    expect([res.status, res.body.error]).toEqual(reserved);
  } finally {
    await setup.stop();
  }
});

test("Docket's account never signs in: no sign-in link, and a session or key naming it is refused", async () => {
  const link = await s.cli("sign-in-link", "docket");
  expect(link.exitCode).not.toBe(0);
  // Plant credentials straight in the database: even then they don't work.
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  const [session, key] = ["f".repeat(64), `dk_${"f".repeat(64)}`];
  const [{ id }] = s.sql("SELECT id FROM users WHERE system = 1");
  expect(s.sql("SELECT * FROM mentions WHERE user_id = ?", id)).toEqual([]);
  const time = new Date().toISOString();
  s.sql("INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, 'x', 'x')", id, hash(session), time, time);
  s.sql("INSERT INTO api_keys (user_id, workspace, name, scope, token_hash, created_at) VALUES (?, 'acme', 'x', 'write', ?, ?)", id, hash(key), time);
  expect((await s.with({ cookie: `docket_session=${session}` }, "cookie").api("GET", "/api/me")).status).toBe(401);
  expect((await s.with({ token: key }).api("GET", "/api/me")).status).toBe(401);
});

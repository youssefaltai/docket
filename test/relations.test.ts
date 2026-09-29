// Related and duplicate-of issues (DKT-22): related is two-way, a duplicate points at its canonical issue and is
// set to its team's Duplicate status (a canceled one); neither names the issue itself, a trashed issue or one in another workspace, and duplicates never loop.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer({ env: { DOCKET_WEBHOOK_ALLOW_PRIVATE: "true" } });
  await s.api("POST", "/api/teams", { key: "REL", name: "Relations" });
  await s.user("ana");
});
afterAll(() => s.stop());

const create = async (title: string, extra: object = {}) => {
  const res = await s.api("POST", "/api/issues", { team: "REL", title, ...extra });
  expect(res.status).toBe(201);
  return res.body;
};
const get = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body;
const patch = (id: string, body: object) => s.api("PATCH", `/api/issues/${id}`, body);

test("related is symmetric: set from either side, both show it; removing it from one side removes it from both", async () => {
  const [a, b, c] = [await create("A"), await create("B"), await create("C")];
  expect((await patch(a.id, { relatedTo: [b.id, c.id, b.id] })).body.relatedTo).toEqual([b.id, c.id]);
  expect((await get(b.id)).relatedTo).toEqual([a.id]);
  expect((await get(c.id)).relatedTo).toEqual([a.id]);
  // Lists carry it too.
  const listed = (await s.api("GET", "/api/issues?team=REL")).body.find((i: any) => i.id === b.id);
  expect(listed.relatedTo).toEqual([a.id]);
  // Setting it from the other side too keeps one pair.
  expect((await patch(b.id, { relatedTo: [a.id] })).status).toBe(200);
  expect(s.sql(`SELECT COUNT(*) AS n FROM issue_relations WHERE kind = 'related'`)[0].n).toBe(2);
  // B drops A: gone from A as well; C stays.
  expect((await patch(b.id, { relatedTo: [] })).body.relatedTo).toEqual([]);
  expect((await get(a.id)).relatedTo).toEqual([c.id]);
  // History is A's and B's own changes; C gained the relation but logs nothing, as with blockers.
  expect((await get(a.id)).activity.filter((x: any) => x.kind === "relatedTo").map((x: any) => [x.from, x.to])).toEqual([[[], [b.id, c.id]]]);
  expect((await get(b.id)).activity.filter((x: any) => x.kind === "relatedTo").map((x: any) => [x.from, x.to])).toEqual([[[a.id], []]]);
  expect((await get(c.id)).activity.map((x: any) => x.kind)).toEqual(["created"]);
  // On create too.
  const d = await create("D", { relatedTo: [c.id] });
  expect(d.relatedTo).toEqual([c.id]);
  expect((await get(c.id)).relatedTo).toEqual([a.id, d.id]);
});

test("marking a duplicate sets its team's Duplicate status (canceled) and lists it on the canonical issue; clearing leaves the status", async () => {
  const canonical = await create("Canonical");
  const dup = await create("Dup", { status: "todo" });
  const marked = (await patch(dup.id, { duplicateOf: canonical.id.toLowerCase() })).body;
  expect(marked).toMatchObject({ duplicateOf: canonical.id, status: "duplicate" });
  expect(marked.completedAt).toBeString();
  expect((await get(canonical.id)).duplicates).toEqual([dup.id]);
  expect(marked.activity.slice(-2).map((x: any) => [x.kind, x.from, x.to])).toEqual([
    ["status", "todo", "duplicate"],
    ["duplicateOf", null, canonical.id],
  ]);
  const cleared = (await patch(dup.id, { duplicateOf: null })).body;
  expect(cleared).toMatchObject({ duplicateOf: null, status: "duplicate" });
  expect((await get(canonical.id)).duplicates).toEqual([]);
  expect(cleared.activity.at(-1)).toMatchObject({ kind: "duplicateOf", from: canonical.id, to: null });
  // Created as a duplicate: Duplicate from the start. Pointing it elsewhere moves it.
  const other = await create("Other");
  const born = await create("Born dup", { duplicateOf: canonical.id, status: "todo" });
  expect(born).toMatchObject({ duplicateOf: canonical.id, status: "duplicate" });
  expect((await patch(born.id, { duplicateOf: other.id })).body.duplicateOf).toBe(other.id);
  expect((await get(canonical.id)).duplicates).toEqual([]);
  expect((await get(other.id)).duplicates).toEqual([born.id]);
});

test("an issue can't relate to or duplicate itself, and duplicates never loop", async () => {
  const [a, b, c] = [await create("Self A"), await create("Self B"), await create("Self C")];
  for (const [body, error] of [
    [{ relatedTo: [b.id, a.id] }, "An issue can't be related to itself"],
    [{ duplicateOf: a.id }, "An issue can't be a duplicate of itself"],
    [{ relatedTo: b.id }, "relatedTo must be an array of issue identifiers"],
  ] as const) {
    const res = await patch(a.id, body);
    expect([res.status, res.body.error]).toEqual([400, error]);
  }
  expect((await patch(a.id, { duplicateOf: b.id })).status).toBe(200);
  expect((await patch(b.id, { duplicateOf: c.id })).status).toBe(200);
  for (const [from, to] of [
    [b.id, a.id],
    [c.id, a.id],
  ]) {
    const res = await patch(from, { duplicateOf: to });
    expect([res.status, res.body.error]).toEqual([400, `${to} is already a duplicate of this issue (directly or indirectly); that would be a cycle`]);
  }
  // A refused change changes nothing, not even the status.
  const refused = await patch(c.id, { duplicateOf: a.id, title: "Renamed" });
  expect(refused.status).toBe(400);
  expect(await get(c.id)).toMatchObject({ title: "Self C", status: "backlog", duplicateOf: null });
});

test("relations name only live issues of the request's workspace; the trash hides them until restored", async () => {
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  const side = s.as("admin", "cookie", "side");
  expect((await side.api("POST", "/api/teams", { key: "SID", name: "Side" })).status).toBe(201);
  const elsewhere = (await side.api("POST", "/api/issues", { team: "SID", title: "Elsewhere" })).body;
  const [a, gone] = [await create("Here"), await create("Gone")];
  for (const body of [{ relatedTo: [elsewhere.id] }, { duplicateOf: elsewhere.id }]) {
    const res = await patch(a.id, body);
    expect([res.status, res.body.error]).toEqual([404, `Issue ${elsewhere.id} not found`]);
    expect((await s.api("POST", "/api/issues", { team: "REL", title: "x", ...body })).status).toBe(404);
  }
  expect((await get(a.id)).activity.map((x: any) => x.kind)).toEqual(["created"]);

  expect((await patch(a.id, { relatedTo: [gone.id], duplicateOf: gone.id })).status).toBe(200);
  await s.api("DELETE", `/api/issues/${gone.id}`);
  expect(await get(a.id)).toMatchObject({ relatedTo: [], duplicateOf: null });
  for (const body of [{ relatedTo: [gone.id] }, { duplicateOf: gone.id }]) {
    const res = await patch(a.id, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(`${gone.id} is in the trash`);
  }
  await s.api("POST", `/api/issues/${gone.id}/restore`);
  expect(await get(a.id)).toMatchObject({ relatedTo: [gone.id], duplicateOf: gone.id });
  expect((await get(gone.id)).duplicates).toEqual([a.id]);
});

test("realtime: both ends of a related pair and of a duplicate get a changed event", async () => {
  const [a, b, c] = [await create("Live A"), await create("Live B"), await create("Live C")];
  const socket = s.admin.ws();
  expect(await socket.opened).toBeTrue();
  const seen = (id: string) => socket.until((e) => e.entity === "issue" && e.id === id, 2000);
  await patch(a.id, { relatedTo: [b.id] });
  await Promise.all([seen(a.id), seen(b.id)]);
  socket.events.length = 0;
  await patch(c.id, { duplicateOf: b.id });
  await Promise.all([seen(c.id), seen(b.id)]);
  socket.events.length = 0;
  await patch(b.id, { relatedTo: [] });
  await Promise.all([seen(b.id), seen(a.id)]);
  socket.close();
});

test("MCP create_issue and update_issue take relatedTo and duplicateOf, with the REST rules", async () => {
  const bot = s.admin;
  const target = await create("MCP target");
  const created = await bot.tool("create_issue", { team: "REL", title: "From MCP", relatedTo: [target.id] });
  const id = /Created (REL-\d+)/.exec(created)![1]!;
  expect((await get(target.id)).relatedTo).toEqual([id]);
  await bot.tool("update_issue", { id, duplicateOf: target.id });
  const text = await bot.tool("get_issue", { id });
  expect(text).toContain(`related to ${target.id}`);
  expect(text).toContain(`duplicate of ${target.id}`);
  expect(text).toMatch(new RegExp(`status backlog → duplicate, duplicate of none → ${target.id}`));
  expect(await bot.tool("get_issue", { id: target.id })).toContain(`duplicates: ${id}`);
  await expect(bot.tool("update_issue", { id, duplicateOf: id })).rejects.toThrow("An issue can't be a duplicate of itself");
  await expect(bot.tool("update_issue", { id, relatedTo: [id] })).rejects.toThrow("An issue can't be related to itself");
  await bot.tool("update_issue", { id, duplicateOf: null, relatedTo: [] });
  expect(await get(id)).toMatchObject({ duplicateOf: null, relatedTo: [], status: "duplicate" });
  expect(await bot.tool("get_issue", { id })).toContain(`related −${target.id}, duplicate of ${target.id} → none`);
});

test("webhooks carry the relation's previous value; subscribers hear of a duplicate only when its status changes", async () => {
  const hook = await s.api("POST", "/api/workspaces/acme/webhooks", { url: "http://127.0.0.1:1/hook", resourceTypes: ["Issue"] });
  expect(hook.status).toBe(201);
  const [canonical, dup] = [await create("Hook canonical"), await create("Hook dup", { status: "todo" })];
  await s.as("ana").api("PUT", `/api/issues/${dup.id}/subscription`);
  const mark = s.sql("SELECT COALESCE(MAX(id), 0) AS id FROM webhook_deliveries")[0].id;
  await patch(dup.id, { relatedTo: [canonical.id] });
  await patch(dup.id, { duplicateOf: canonical.id });
  const log = s.sql(`SELECT entity, json_extract(payload, '$.updatedFrom') AS was FROM webhook_deliveries WHERE id > ${mark} ORDER BY id`);
  // One event each, for the issue that changed; the canonical issue was only bumped, so it sends nothing.
  expect(log.map((d) => [d.entity, JSON.parse(d.was)])).toEqual([
    [dup.id, { relatedTo: [] }],
    [dup.id, { status: "todo", duplicateOf: null }],
  ]);
  const inbox = async () => (await s.as("ana").api("GET", "/api/notifications")).body.notifications.filter((n: any) => n.issue?.id === dup.id);
  expect((await inbox()).map((n: any) => [n.kind, n.status])).toEqual([["status", "duplicate"]]);
  // Already a duplicate: marking it again (elsewhere) notifies no one.
  const other = await create("Hook other");
  await patch(dup.id, { duplicateOf: other.id });
  expect(await inbox()).toHaveLength(1);
  await s.api("DELETE", `/api/workspaces/acme/webhooks/${hook.body.webhook.id}`);
});

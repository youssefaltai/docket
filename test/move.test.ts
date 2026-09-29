// Moving an issue to another team of its workspace (DKT-20): it takes that team's next number, its old identifier keeps
// resolving (REST, MCP, /api/locate, doc mentions), its status carries over by key, else by category, else the default,
// and the old team's own labels come off. Relations, comments, subscribers and doc refs come along.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let ana: Caller;
beforeAll(async () => {
  s = await startServer({ env: { DOCKET_WEBHOOK_ALLOW_PRIVATE: "true" } });
  for (const key of ["SRC", "DST"]) expect((await s.api("POST", "/api/teams", { key, name: key })).status).toBe(201);
  // SRC has statuses DST lacks: a started one, a completed one and Triage. DST starts new issues in todo.
  for (const status of [{ name: "In QA", category: "started" }, { name: "Shipped", category: "completed" }, { category: "triage" }]) {
    expect((await s.api("POST", "/api/teams/SRC/statuses", status)).status).toBe(201);
  }
  expect((await s.api("PATCH", "/api/teams/DST", { defaultStatus: "todo" })).status).toBe(200);
  // Another workspace, with a team of its own and one whose key DST also has.
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  for (const key of ["SID", "DST"]) expect((await s.as("admin", "cookie", "side").api("POST", "/api/teams", { key, name: key })).status).toBe(201);
  ana = await s.user("ana");
});
afterAll(() => s.stop());

const create = async (title: string, extra: object = {}, team = "SRC") => {
  const res = await s.api("POST", "/api/issues", { team, title, ...extra });
  expect(res.status).toBe(201);
  return res.body;
};
const get = async (id: string, caller = s.admin) => (await caller.api("GET", `/api/issues/${id}`)).body;
const move = (id: string, team: string, extra: object = {}) => s.api("PATCH", `/api/issues/${id}`, { team, ...extra });
const nextNumber = (key: string) => s.sql(`SELECT next_number AS n FROM teams WHERE workspace = 'acme' AND key = '${key}'`)[0].n as number;

test("a moved issue takes the team's next number; every identifier it had still resolves to it, and history says so", async () => {
  const issue = await create("Filed in the wrong team", { status: "todo", priority: 2, dueOn: "2026-10-01" });
  const n = nextNumber("DST");
  const socket = s.admin.ws();
  expect(await socket.opened).toBe(true);
  const res = await move(issue.id.toLowerCase(), "dst");
  expect(res.status).toBe(200);
  const moved = res.body;
  expect(moved).toMatchObject({ id: `DST-${n}`, team: "DST", number: n, title: "Filed in the wrong team", status: "todo", priority: 2, dueOn: "2026-10-01" });
  expect(moved.previousIdentifiers).toEqual([issue.id]);
  expect(moved.createdAt).toBe(issue.createdAt);
  expect(moved.activity.at(-1)).toMatchObject({ kind: "team", from: issue.id, to: moved.id, actor: { username: "admin" } });
  expect(nextNumber("DST")).toBe(n + 1);
  // Both identifiers are announced: lists showing the old one refetch, and the new one's.
  for (const id of [issue.id, moved.id]) await socket.until((e) => e.entity === "issue" && e.id === id);
  socket.close();

  // The old identifier reads the issue as it is now; it's gone from its old team's list, and in its new one's.
  expect(await get(issue.id)).toMatchObject({ id: moved.id, team: "DST" });
  expect((await s.api("GET", "/api/issues?team=SRC")).body.map((i: any) => i.id)).not.toContain(issue.id);
  expect((await s.api("GET", "/api/issues?team=DST")).body.find((i: any) => i.id === moved.id).previousIdentifiers).toEqual([issue.id]);
  // Edits through the old identifier land on it too.
  expect((await s.api("PATCH", `/api/issues/${issue.id}`, { title: "Renamed" })).body).toMatchObject({ id: moved.id, title: "Renamed" });
  // SRC never reuses the number; a new issue there takes the next one.
  expect((await create("Next")).number).toBeGreaterThan(issue.number);

  // Moving back gives yet another number; both old identifiers resolve.
  const back = (await move(moved.id, "SRC")).body;
  expect(back.id).not.toBe(issue.id);
  expect(back.previousIdentifiers).toEqual([issue.id, moved.id]);
  for (const id of [issue.id, moved.id]) expect((await get(id)).id).toBe(back.id);
  expect(back.activity.filter((x: any) => x.kind === "team").map((x: any) => [x.from, x.to])).toEqual([
    [issue.id, moved.id],
    [moved.id, back.id],
  ]);
  // Moving to its own team changes nothing.
  const same = (await move(back.id, "SRC")).body;
  expect(same).toMatchObject({ id: back.id, updatedAt: expect.any(String) });
  expect(same.activity.filter((x: any) => x.kind === "team").length).toBe(2);
  expect(s.sql(`SELECT COUNT(*) AS n FROM issue_aliases WHERE issue_id = (SELECT id FROM issues WHERE title = 'Renamed')`)[0].n).toBe(2);
});

test("its status carries over by key, else the team's first of that category, else the team's default; completedAt follows categories", async () => {
  const kept = (await move((await create("Kept", { status: "in_progress" })).id, "DST")).body;
  expect(kept.status).toBe("in_progress");
  const qa = (await move((await create("QA", { status: "in_qa" })).id, "DST")).body;
  expect(qa).toMatchObject({ status: "in_progress", completedAt: null });
  expect(qa.activity.slice(-2).map((x: any) => [x.kind, x.from, x.to])).toEqual([
    ["team", expect.stringMatching(/^SRC-/), qa.id],
    ["status", "in_qa", "in_progress"],
  ]);
  const shipped = await create("Shipped", { status: "shipped" });
  const done = (await move(shipped.id, "DST")).body;
  expect(done).toMatchObject({ status: "done", completedAt: shipped.completedAt });
  const triaged = (await move((await create("Triaged", { status: "triage" })).id, "DST")).body;
  expect(triaged.status).toBe("todo"); // DST has no triage: its default
  const dup = (await move((await create("Dup", { status: "duplicate" })).id, "DST")).body;
  expect(dup.status).toBe("duplicate");
  // A status sent with the move is the new team's; one only the old team has is refused, and nothing moves.
  const told = await create("Told");
  const numbered = nextNumber("DST");
  const refused = await move(told.id, "DST", { status: "in_qa" });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain('Invalid status "in_qa" for DST');
  expect((await get(told.id)).id).toBe(told.id);
  expect(nextNumber("DST")).toBe(numbered);
  const closed = (await move(told.id, "DST", { status: "Done" })).body;
  expect(closed).toMatchObject({ team: "DST", status: "done", completedAt: expect.any(String) });
});

test("it keeps workspace labels and drops its old team's own; labels sent with the move must fit the new team", async () => {
  for (const body of [{ name: "src-only", team: "SRC" }, { name: "dst-only", team: "DST" }, { name: "everywhere" }]) {
    expect((await s.api("POST", "/api/labels", body)).status).toBe(201);
  }
  const issue = await create("Labeled", { labels: ["src-only", "everywhere"] });
  const moved = (await move(issue.id, "DST")).body;
  expect(moved.labels).toEqual(["everywhere"]);
  expect(moved.activity.slice(-2)).toMatchObject([
    { kind: "team", from: issue.id, to: moved.id },
    { kind: "labels", from: ["everywhere", "src-only"], to: ["everywhere"] },
  ]);
  const other = await create("Relabeled", { labels: ["src-only"] });
  const refused = await move(other.id, "DST", { labels: ["src-only"] });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toBe('Label "src-only" belongs to team SRC');
  expect(await get(other.id)).toMatchObject({ id: other.id, labels: ["src-only"] });
  expect((await move(other.id, "DST", { labels: ["dst-only", "everywhere"] })).body.labels).toEqual(["dst-only", "everywhere"]);
});

test("parent, sub-issues, blockers, related, duplicates, comments, reactions, subscribers and docs come along", async () => {
  const parent = await create("Parent");
  const blocker = await create("Blocker");
  const related = await create("Related");
  const canonical = await create("Canonical");
  const issue = await create("Moving", { parent: parent.id, blockedBy: [blocker.id], relatedTo: [related.id], description: "Hey @ana" });
  const child = await create("Child", { parent: issue.id });
  const blocked = await create("Blocked", { blockedBy: [issue.id] });
  const dup = await create("Dup", { duplicateOf: issue.id });
  const commented = (await s.api("POST", `/api/issues/${issue.id}/comments`, { body: "Before the move" })).body;
  expect((await s.api("PUT", `/api/issues/${issue.id}/reactions/👍`)).status).toBe(200);
  const doc = (await s.api("POST", "/api/documents", { team: "SRC", title: "Plan", content: `Tracks ${issue.id}.` })).body;
  expect(doc.issues.map((i: any) => i.id)).toEqual([issue.id]);

  const moved = (await move(issue.id, "DST")).body;
  expect(moved).toMatchObject({
    parent: parent.id,
    blockedBy: [blocker.id],
    relatedTo: [related.id],
    description: "Hey @ana",
    reactions: [{ emoji: "👍", users: [{ username: "admin" }] }],
    comments: [{ id: commented.comments[0].id, body: "Before the move" }],
  });
  expect(moved.children.map((c: any) => c.id)).toEqual([child.id]);
  expect(moved.duplicates).toEqual([dup.id]);
  expect(moved.docs.map((d: any) => d.slug)).toEqual([doc.slug]);
  expect((await get(child.id)).parent).toBe(moved.id);
  expect((await get(blocked.id)).blockedBy).toEqual([moved.id]);
  expect((await get(blocker.id)).blocks).toEqual([moved.id]);
  expect((await get(related.id)).relatedTo).toEqual([moved.id]);
  expect((await get(dup.id)).duplicateOf).toBe(moved.id);
  expect((await get(parent.id)).children.map((c: any) => c.id)).toEqual([moved.id]);
  expect((await s.api("GET", `/api/documents/${doc.slug}`)).body.issues.map((i: any) => i.id)).toEqual([moved.id]);
  // ana was mentioned, so subscribed: she still is, and hears of what happens next under the new identifier.
  expect((await get(moved.id, ana)).subscribed).toBe(true);
  await s.api("POST", `/api/issues/${moved.id}/comments`, { body: "After the move" });
  const inbox = (await ana.api("GET", "/api/notifications")).body.notifications;
  expect(inbox[0]).toMatchObject({ kind: "commented", issue: { id: moved.id } });
  // Old identifiers work as relation inputs too.
  expect((await s.api("PATCH", `/api/issues/${canonical.id}`, { blockedBy: [issue.id] })).body.blockedBy).toEqual([moved.id]);
});

test("a doc written after the move that names the old identifier links to the issue", async () => {
  const issue = await create("Linked later");
  const moved = (await move(issue.id, "DST")).body;
  const doc = (await s.api("POST", "/api/documents", { team: "DST", title: "Later", content: `See ${issue.id}.` })).body;
  expect(doc.issues.map((i: any) => i.id)).toEqual([moved.id]);
  expect((await get(moved.id)).docs.map((d: any) => d.slug)).toEqual([doc.slug]);
  // Both identifiers are one issue, listed once.
  const both = (await s.api("PATCH", `/api/documents/${doc.slug}`, { content: `See ${issue.id} and ${moved.id}.` })).body;
  expect(both.issues.map((i: any) => i.id)).toEqual([moved.id]);
});

test("only to a team of the same workspace: another workspace's team, an unknown team or a trashed issue is refused", async () => {
  const issue = await create("Stays");
  const numbered = nextNumber("DST");
  for (const team of ["SID", "NOPE", 7]) {
    const res = await move(issue.id, team as string);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Unknown team "${team}": an issue moves only to a team of its workspace`);
  }
  // A key both workspaces have is this workspace's team.
  const moved = (await move(issue.id, "DST")).body;
  expect(moved.id).toBe(`DST-${numbered}`);
  expect(s.sql(`SELECT t.workspace FROM issues i JOIN teams t ON t.id = i.team_id WHERE i.title = 'Stays'`)).toEqual([{ workspace: "acme" }]);
  expect((await s.as("admin", "cookie", "side").api("GET", `/api/issues/${issue.id}`)).status).toBe(404);
  const trashed = await create("Trashed");
  await s.api("DELETE", `/api/issues/${trashed.id}`);
  expect((await move(trashed.id, "DST")).status).toBe(409);
  // No stray aliases from the refusals.
  expect(s.sql(`SELECT COUNT(*) AS n FROM issue_aliases a JOIN issues i ON i.id = a.issue_id WHERE i.title IN ('Stays', 'Trashed')`)[0].n).toBe(1);
});

test("MCP update_issue moves the same way; get_issue and /api/locate resolve the old identifier", async () => {
  const issue = await create("Via MCP", { status: "in_qa" });
  const text = await s.tool("update_issue", { id: issue.id, team: "DST" });
  const moved = await get(issue.id);
  expect(moved).toMatchObject({ team: "DST", status: "in_progress", previousIdentifiers: [issue.id] });
  expect(text).toStartWith(`Moved ${issue.id} to ${moved.id}\n`);
  const got = await s.admin.toolResult("get_issue", { id: issue.id });
  expect(got.structuredContent.issue.id).toBe(moved.id);
  const shown = got.content[0].text as string;
  expect(shown).toStartWith(`${moved.id} · in_progress`);
  expect(shown).toContain(`previously ${issue.id}`);
  expect(shown).toMatch(new RegExp(`· @admin · team ${issue.id} → ${moved.id}, status in_qa → in_progress`));
  const refused = await s.admin.toolResult("update_issue", { id: moved.id, team: "SID" });
  expect(refused.isError).toBe(true);

  expect((await s.api("GET", `/api/locate?issue=${issue.id}`)).body).toEqual({ workspace: "acme" });
  expect((await s.api("GET", `/api/locate?issue=${issue.id.toLowerCase()}`)).body).toEqual({ workspace: "acme" });
  const zed = await s.user("zed", { workspace: "side" });
  expect((await zed.api("GET", `/api/locate?issue=${issue.id}`)).status).toBe(404);
});

test("webhooks send one Issue update whose updatedFrom has the old identifier, team and number", async () => {
  const hook = (await s.api("POST", "/api/workspaces/acme/webhooks", { url: "http://127.0.0.1:9/move", resourceTypes: ["Issue"] })).body.webhook;
  const issue = await create("Hooked", { status: "in_qa" });
  const moved = (await move(issue.id, "DST")).body;
  const deliveries = s.sql(`SELECT entity, payload FROM webhook_deliveries WHERE webhook_id = ${hook.id} ORDER BY id`).map((d) => [d.entity, JSON.parse(d.payload)]);
  expect(deliveries.map(([entity, p]) => [entity, p.action])).toEqual([
    [issue.id, "create"],
    [moved.id, "update"],
  ]);
  const update = deliveries[1]![1];
  expect(update.updatedFrom).toEqual({ id: issue.id, team: "SRC", number: issue.number, status: "in_qa" });
  expect(update.data).toMatchObject({ id: moved.id, team: "DST", number: moved.number, status: "in_progress", previousIdentifiers: [issue.id] });
  expect(update.url).toEndWith(`/acme/issue/${moved.id}`);
  await s.api("DELETE", `/api/workspaces/acme/webhooks/${hook.id}`);
});

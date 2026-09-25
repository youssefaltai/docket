// Linear parity on the server: trash instead of hard delete, claims that respect started work, backlog
// by default, filters that name unknown things as errors, strict PATCH bodies, and cursor pagination.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "PAR", workspace: s.workspace, name: "Parity" });
  await s.user("ana");
  await s.agent("bot");
});
afterAll(() => s.stop());

const ids = (list: { id: string }[]) => list.map((i) => i.id);
const create = async (title: string, extra: object = {}) => (await s.api("POST", "/api/issues", { team: "PAR", title, ...extra })).body;

test("deleting an issue moves it to the trash; it hides everywhere and comes back on restore", async () => {
  const parent = await create("Parent", { labels: ["trashy"] });
  const child = await create("Child", { parent: parent.id });
  const blocked = await create("Blocked", { blockedBy: [parent.id] });
  const doc = (await s.api("POST", "/api/documents", { team: "PAR", title: "Mentions", content: `See ${parent.id}.` })).body;
  expect(doc.issues.map((i: any) => i.id)).toEqual([parent.id]);

  const trashed = await s.api("DELETE", `/api/issues/${parent.id}`);
  expect(trashed.status).toBe(200);
  expect(trashed.body.deletedAt).toBeString();
  // Gone from lists, search, relations, doc refs, labels and counts; still readable directly.
  expect(ids((await s.api("GET", "/api/issues?team=PAR")).body)).not.toContain(parent.id);
  expect(ids((await s.api("GET", "/api/issues?q=Parent")).body)).not.toContain(parent.id);
  expect((await s.api("GET", `/api/issues/${blocked.id}`)).body.blockedBy).toEqual([]);
  expect((await s.api("GET", `/api/documents/${doc.slug}`)).body.issues).toEqual([]);
  expect((await s.api("GET", "/api/labels")).body).not.toContain("trashy");
  // The sub-issue stays, still pointing at its (trashed) parent, as in Linear.
  expect((await s.api("GET", `/api/issues/${child.id}`)).body.parent).toBe(parent.id);
  // A trashed issue is read-only.
  expect((await s.api("PATCH", `/api/issues/${parent.id}`, { title: "x" })).status).toBe(409);
  expect((await s.api("POST", `/api/issues/${parent.id}/comments`, { body: "x" })).status).toBe(409);
  expect((await s.as("ana").api("POST", `/api/issues/${parent.id}/claim`)).status).toBe(409);
  expect((await s.api("POST", "/api/issues", { team: "PAR", title: "x", parent: parent.id })).status).toBe(400);
  expect((await s.api("DELETE", `/api/issues/${parent.id}`)).status).toBe(409);

  const trash = (await s.api("GET", "/api/teams/PAR/trash")).body;
  expect(ids(trash.issues)).toEqual([parent.id]);

  const restored = await s.api("POST", `/api/issues/${parent.id}/restore`);
  expect(restored.body.deletedAt).toBeNull();
  expect((await s.api("GET", `/api/issues/${blocked.id}`)).body.blockedBy).toEqual([parent.id]);
  expect((await s.api("GET", `/api/documents/${doc.slug}`)).body.issues.map((i: any) => i.id)).toEqual([parent.id]);
  expect((await s.api("POST", `/api/issues/${parent.id}/restore`)).status).toBe(409);
  expect((await s.api("GET", "/api/teams/PAR/trash")).body.issues).toEqual([]);
});

test("docs go to the trash too, and anything there for 30 days is purged", async () => {
  const doc = (await s.api("POST", "/api/documents", { team: "PAR", title: "Draft", content: "x" })).body;
  expect((await s.api("DELETE", `/api/documents/${doc.slug}`)).body.deletedAt).toBeString();
  expect((await s.api("GET", "/api/documents?team=PAR")).body.map((d: any) => d.slug)).not.toContain(doc.slug);
  expect((await s.api("PATCH", `/api/documents/${doc.slug}`, { title: "y" })).status).toBe(409);
  expect((await s.api("POST", `/api/documents/${doc.slug}/restore`)).body.deletedAt).toBeNull();

  const old = await create("Old");
  await s.api("DELETE", `/api/issues/${old.id}`);
  await s.api("DELETE", `/api/documents/${doc.slug}`);
  // Age both past the 30 days, then look at the trash, which purges as it goes.
  const db = new Database(s.databasePath);
  db.run("UPDATE issues SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE deleted_at IS NOT NULL");
  db.run("UPDATE documents SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE deleted_at IS NOT NULL");
  db.close();
  expect((await s.api("GET", "/api/teams/PAR/trash")).body).toEqual({ issues: [], documents: [] });
  expect((await s.api("GET", `/api/issues/${old.id}`)).status).toBe(404);
  expect((await s.api("GET", `/api/documents/${doc.slug}`)).status).toBe(404);
});

test("claiming keeps started work's status; only backlog and todo move to in_progress", async () => {
  const review = await create("In review", { status: "in_review" });
  const claimed = await s.as("bot").api("POST", `/api/issues/${review.id}/claim`);
  expect(claimed.body).toMatchObject({ status: "in_review", delegate: { username: "bot" } });
  for (const status of ["backlog", "todo"]) {
    const fresh = await create(`From ${status}`, { status });
    expect((await s.as("ana").api("POST", `/api/issues/${fresh.id}/claim`)).body).toMatchObject({ status: "in_progress", assignee: { username: "ana" } });
  }
});

test("new issues start in backlog, over REST and MCP", async () => {
  expect((await create("Default")).status).toBe("backlog");
  expect(await s.as("bot").tool("create_issue", { team: "PAR", title: "Via MCP" })).toMatch(/· backlog ·/);
});

test("a filter naming something unknown is 400, not an empty list", async () => {
  for (const query of ["assignee=nobody", "delegate=nobody", "team=ZZZ", "workspace=nope", "parent=PAR-9999", "parent=garbage"]) {
    const res = await s.api("GET", `/api/issues?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown/);
  }
  expect((await s.api("GET", "/api/documents?team=ZZZ")).status).toBe(400);
  // A label nobody uses yet is a fine question with an empty answer.
  expect((await s.api("GET", "/api/issues?label=never-used")).body).toEqual([]);
  expect((await s.api("GET", "/api/issues?assignee=ana")).status).toBe(200);
  await expect(s.as("bot").tool("list_issues", { assignee: "nobody" })).rejects.toThrow("Unknown assignee");
});

test("PATCH refuses fields it can't change, naming them", async () => {
  const issue = await create("Strict");
  const doc = (await s.api("POST", "/api/documents", { team: "PAR", title: "Strict doc", content: "" })).body;
  const cases: [string, string, object, string][] = [
    ["PATCH", `/api/issues/${issue.id}`, { team: "OTH" }, "Issues can't move between teams"],
    ["PATCH", `/api/issues/${issue.id}`, { titel: "typo" }, '"titel"'],
    ["PATCH", `/api/documents/${doc.slug}`, { slug: "new" }, "slug never changes"],
    ["PATCH", "/api/teams/PAR", { workspace: "other" }, "Teams can't move between workspaces"],
    ["PATCH", `/api/workspaces/${s.workspace}`, { key: "new" }, "key never changes"],
    ["PATCH", "/api/me", { role: "admin" }, '"role"'],
    ["PATCH", `/api/workspaces/${s.workspace}/members/ana`, { email: "x@y.z" }, '"email"'],
  ];
  for (const [method, path, body, message] of cases) {
    const res = await s.as("admin", "cookie").api(method, path, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(message);
  }
  expect((await s.api("PATCH", `/api/issues/${issue.id}`, { title: "Fine" })).body.title).toBe("Fine");
});

test("issues page with first/after cursors, in list order, over REST and MCP", async () => {
  await s.api("POST", "/api/teams", { key: "PGE", workspace: s.workspace, name: "Pages" });
  for (let i = 0; i < 7; i++) await s.api("POST", "/api/issues", { team: "PGE", title: `P${i}`, priority: i % 3 });
  const all = ids((await s.api("GET", "/api/issues?team=PGE")).body);
  expect(all).toHaveLength(7);

  const seen: string[] = [];
  let after = "";
  for (let n = 0; n < 10; n++) {
    const page = (await s.api("GET", `/api/issues?team=PGE&first=3${after ? `&after=${after}` : ""}`)).body;
    expect(page.issues.length).toBeLessThanOrEqual(3);
    seen.push(...ids(page.issues));
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  expect(seen).toEqual(all);
  expect((await s.api("GET", "/api/issues?team=PGE&first=0")).status).toBe(400);
  expect((await s.api("GET", "/api/issues?team=PGE&after=not-a-cursor")).status).toBe(400);

  const text = await s.as("bot").tool("list_issues", { team: "PGE", limit: 4 });
  const cursor = text.match(/after: "([^"]+)"/)?.[1];
  expect(cursor).toBeString();
  const rest = await s.as("bot").tool("list_issues", { team: "PGE", limit: 4, after: cursor });
  expect(rest).not.toMatch(/after:/);
  expect([...text.matchAll(/PGE-\d+/g), ...rest.matchAll(/PGE-\d+/g)].map((m) => m[0])).toEqual(all);
});

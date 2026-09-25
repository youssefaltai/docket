import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "API", workspace: s.workspace, name: "API" });
});
afterAll(() => s.stop());

test("serves the web UI", async () => {
  const res = await fetch(s.url);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<div id=\"root\"");
});

test("workspaces and teams", async () => {
  const { body: workspaces } = await s.api("GET", "/api/workspaces");
  expect(workspaces.map((w: any) => w.key)).toContain(s.workspace);

  const { body: teams } = await s.api("GET", `/api/teams?workspace=${s.workspace}`);
  expect(teams).toHaveLength(1);
  expect(teams[0]).toMatchObject({ key: "API", workspace: s.workspace, name: "API" });

  const dup = await s.api("POST", "/api/teams", { key: "API", workspace: s.workspace, name: "Again" });
  expect(dup.status).toBeGreaterThanOrEqual(400);
  expect(dup.body.error).toBeString();
});

test("issue lifecycle", async () => {
  const created = await s.api("POST", "/api/issues", { team: "API", title: "First", priority: 2, labels: ["bug"] });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ id: "API-1", status: "backlog", priority: 2, labels: ["bug"] });

  const child = await s.api("POST", "/api/issues", { team: "API", title: "Child", parent: "API-1", blockedBy: ["API-1"] });
  expect(child.body).toMatchObject({ id: "API-2", parent: "API-1", blockedBy: ["API-1"] });

  const patched = await s.api("PATCH", "/api/issues/API-1", { status: "done" });
  expect(patched.body.status).toBe("done");
  expect(patched.body.completedAt).toBeString();

  const comment = await s.api("POST", "/api/issues/API-1/comments", { body: "Shipped" });
  expect(comment.status).toBe(201);

  const { body: issue } = await s.api("GET", "/api/issues/api-1");
  expect(issue.children.map((c: any) => c.id)).toEqual(["API-2"]);
  expect(issue.blocks).toEqual(["API-2"]);
  // s.api acts as the setup admin, so the comment's author is admin's UserRef.
  expect(issue.comments.map((c: any) => [c.author.username, c.body])).toEqual([["admin", "Shipped"]]);

  const { body: open } = await s.api("GET", "/api/issues?team=API&status=backlog");
  expect(open.map((i: any) => i.id)).toEqual(["API-2"]);

  const { body: labels } = await s.api("GET", "/api/labels");
  expect(labels).toContain("bug");
});

test("deleted issue numbers are never reused", async () => {
  const { body: temp } = await s.api("POST", "/api/issues", { team: "API", title: "Temp" });
  expect((await s.api("DELETE", `/api/issues/${temp.id}`)).status).toBe(200);
  // Deleting moves it to the trash; the number stays taken either way.
  expect((await s.api("GET", `/api/issues/${temp.id}`)).body.deletedAt).toBeString();
  const { body: next } = await s.api("POST", "/api/issues", { team: "API", title: "Next" });
  expect(next.number).toBe(temp.number + 1);
});

test("documents, versions and issue links", async () => {
  const created = await s.api("POST", "/api/documents", { team: "API", title: "Design Notes", content: "See API-1." });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ slug: "design-notes" });
  expect(created.body.updatedBy.username).toBe("admin");
  expect(created.body.issues.map((i: any) => i.id)).toEqual(["API-1"]);

  const stale = created.body.updatedAt;
  const edited = await s.api("PATCH", "/api/documents/design-notes", {
    edits: [{ oldText: "API-1", newText: "API-2" }],
    checkpoint: true,
    baseUpdatedAt: stale,
  });
  expect(edited.status).toBe(200);
  expect(edited.body.content).toBe("See API-2.");

  // A fixed old timestamp: two saves in the same millisecond share an updatedAt.
  const conflict = await s.api("PATCH", "/api/documents/design-notes", {
    content: "lost",
    baseUpdatedAt: "2000-01-01T00:00:00.000Z",
  });
  expect(conflict.status).toBe(409);

  const raw = await s.api("GET", "/api/documents/design-notes/raw");
  expect(raw.body).toBe("See API-2.");

  const { body: versions } = await s.api("GET", "/api/documents/design-notes/versions");
  expect(versions.length).toBeGreaterThanOrEqual(2);

  const { body: issue } = await s.api("GET", "/api/issues/API-2");
  expect(issue.docs.map((d: any) => d.slug)).toEqual(["design-notes"]);
});

test("rejects bad requests", async () => {
  // Raw fetch: this test is about the 415 itself (a non-JSON content type), which s.api can't
  // send. We still authenticate, using s.admin.token for the bearer header as the one allowed
  // exception to "no hand-built auth headers".
  const form = await fetch(new URL("/api/issues", s.url), {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${s.admin.token}` },
    body: JSON.stringify({ team: "API", title: "x" }),
  });
  expect(form.status).toBe(415);
  expect((await s.api("GET", "/api/nope")).status).toBe(404);
  expect((await s.api("GET", "/api/issues/API-999")).status).toBe(404);
});

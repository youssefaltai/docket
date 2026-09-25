import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/workspaces", { key: "acme", name: "Acme" });
  await s.api("POST", "/api/projects", { key: "API", workspace: "acme", name: "API" });
});
afterAll(() => s.stop());

test("serves the web UI", async () => {
  const res = await fetch(s.url);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<div id=\"root\"");
});

test("workspaces and projects", async () => {
  const { body: workspaces } = await s.api("GET", "/api/workspaces");
  expect(workspaces.map((w: any) => w.key)).toContain("acme");

  const { body: projects } = await s.api("GET", "/api/projects?workspace=acme");
  expect(projects).toHaveLength(1);
  expect(projects[0]).toMatchObject({ key: "API", workspace: "acme", name: "API" });

  const dup = await s.api("POST", "/api/projects", { key: "API", workspace: "acme", name: "Again" });
  expect(dup.status).toBeGreaterThanOrEqual(400);
  expect(dup.body.error).toBeString();
});

test("issue lifecycle", async () => {
  const created = await s.api("POST", "/api/issues", { project: "API", title: "First", priority: 2, labels: ["bug"] });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ id: "API-1", status: "todo", priority: 2, labels: ["bug"] });

  const child = await s.api("POST", "/api/issues", { project: "API", title: "Child", parent: "API-1", blockedBy: ["API-1"] });
  expect(child.body).toMatchObject({ id: "API-2", parent: "API-1", blockedBy: ["API-1"] });

  const patched = await s.api("PATCH", "/api/issues/API-1", { status: "done" });
  expect(patched.body.status).toBe("done");
  expect(patched.body.completedAt).toBeString();

  const comment = await s.api("POST", "/api/issues/API-1/comments", { body: "Shipped", author: "tester" });
  expect(comment.status).toBe(201);

  const { body: issue } = await s.api("GET", "/api/issues/api-1");
  expect(issue.children.map((c: any) => c.id)).toEqual(["API-2"]);
  expect(issue.blocks).toEqual(["API-2"]);
  expect(issue.comments.map((c: any) => [c.author, c.body])).toEqual([["tester", "Shipped"]]);

  const { body: open } = await s.api("GET", "/api/issues?project=API&status=todo");
  expect(open.map((i: any) => i.id)).toEqual(["API-2"]);

  const { body: labels } = await s.api("GET", "/api/labels");
  expect(labels).toContain("bug");
});

test("deleted issue numbers are never reused", async () => {
  const { body: temp } = await s.api("POST", "/api/issues", { project: "API", title: "Temp" });
  expect((await s.api("DELETE", `/api/issues/${temp.id}`)).status).toBe(200);
  expect((await s.api("GET", `/api/issues/${temp.id}`)).status).toBe(404);
  const { body: next } = await s.api("POST", "/api/issues", { project: "API", title: "Next" });
  expect(next.number).toBe(temp.number + 1);
});

test("documents, versions and issue links", async () => {
  const created = await s.api("POST", "/api/documents", { project: "API", title: "Design Notes", content: "See API-1." });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ slug: "design-notes", updatedBy: "anonymous" });
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
  const form = await fetch(new URL("/api/issues", s.url), {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ project: "API", title: "x" }),
  });
  expect(form.status).toBe(415);
  expect((await s.api("GET", "/api/nope")).status).toBe(404);
  expect((await s.api("GET", "/api/issues/API-999")).status).toBe(404);
});

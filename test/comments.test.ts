import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/workspaces", { key: "acme", name: "Acme" });
  await s.api("POST", "/api/workspaces", { key: "side", name: "Side" });
  await s.api("POST", "/api/projects", { key: "COM", workspace: "acme", name: "Comments" });
  await s.api("POST", "/api/projects", { key: "SID", workspace: "side", name: "Side" });
  await s.api("POST", "/api/issues", { project: "COM", title: "One" });
  await s.api("POST", "/api/documents", { project: "COM", title: "Notes", content: "x", author: "ana" });
});
afterAll(() => s.stop());

test("REST: the author edits and deletes an issue comment", async () => {
  const added = await s.api("POST", "/api/issues/COM-1/comments", { body: "Tpyo", author: "Ana" });
  const comment = added.body.comments.at(-1);
  expect(comment.editedAt).toBeNull();
  const before = added.body.updatedAt;
  await Bun.sleep(5); // so the bump lands on a later millisecond

  const edited = await s.api("PATCH", `/api/issues/COM-1/comments/${comment.id}`, { body: "Typo", author: "ana" });
  expect(edited.status).toBe(200);
  expect(edited.body.comments.at(-1)).toMatchObject({ id: comment.id, body: "Typo", author: "Ana" });
  expect(edited.body.comments.at(-1).editedAt).toBeString();
  expect(edited.body.updatedAt > before).toBeTrue();

  const deleted = await s.api("DELETE", `/api/issues/COM-1/comments/${comment.id}`, { author: "Ana" });
  expect(deleted.status).toBe(200);
  expect(deleted.body.comments.find((c: any) => c.id === comment.id)).toBeUndefined();
});

test("REST: only the author may change a comment, and ids are scoped to their owner", async () => {
  const { body } = await s.api("POST", "/api/issues/COM-1/comments", { body: "Mine", author: "ana" });
  const id = body.comments.at(-1).id;

  expect(await s.api("PATCH", `/api/issues/COM-1/comments/${id}`, { body: "Yours", author: "claude" })).toMatchObject({
    status: 403,
    body: { error: "Only ana can change this comment" },
  });
  expect((await s.api("DELETE", `/api/issues/COM-1/comments/${id}`, {})).status).toBe(403); // "anonymous"
  expect((await s.api("PATCH", `/api/documents/notes/comments/${id}`, { body: "x", author: "ana" })).status).toBe(404);
  expect((await s.api("PATCH", `/api/issues/COM-1/comments/abc`, { body: "x", author: "ana" })).status).toBe(404);
  expect((await s.api("PATCH", `/api/issues/COM-1/comments/${id}`, { body: " ", author: "ana" })).status).toBe(400);
  expect((await s.api("GET", "/api/issues/COM-1")).body.comments.at(-1).body).toBe("Mine");
});

test("REST: doc comments can be edited without touching the doc's updatedAt", async () => {
  const added = await s.api("POST", "/api/documents/notes/comments", { body: "Hi", author: "ana" });
  const id = added.body.comments.at(-1).id;
  const edited = await s.api("PATCH", `/api/documents/notes/comments/${id}`, { body: "Hello", author: "ana" });
  expect(edited.body.comments.at(-1)).toMatchObject({ body: "Hello" });
  expect(edited.body.updatedAt).toBe(added.body.updatedAt);
  const deleted = await s.api("DELETE", `/api/documents/notes/comments/${id}`, { author: "ana" });
  expect(deleted.body.comments).toEqual([]);
});

test("MCP: an agent edits and deletes its own comments, not other people's", async () => {
  await s.tool("comment_issue", { id: "COM-1", body: "Halfway" });
  const ours = (await s.api("GET", "/api/issues/COM-1")).body.comments.at(-1).id;
  expect(await s.tool("get_issue", { id: "COM-1" })).toContain(`**claude** · #${ours} ·`);

  expect(await s.tool("update_comment", { issue: "COM-1", comment: ours, body: "Done" })).toBe(`Edited comment #${ours} on COM-1`);
  expect(await s.tool("get_issue", { id: "COM-1" })).toMatch(new RegExp(`#${ours} · \\S+ · edited\\nDone`));

  const theirs = (await s.api("GET", "/api/issues/COM-1")).body.comments.find((c: any) => c.body === "Mine").id;
  await expect(s.tool("update_comment", { issue: "COM-1", comment: theirs, body: "x" })).rejects.toThrow("Only ana");
  await expect(s.tool("delete_comment", { comment: ours })).rejects.toThrow("exactly one of issue or document");

  await s.tool("delete_comment", { issue: "COM-1", comment: ours });
  expect(await s.tool("get_issue", { id: "COM-1" })).not.toContain("Done");

  await s.tool("comment_document", { slug: "notes", body: "Reviewed" });
  const docComment = (await s.api("GET", "/api/documents/notes")).body.comments.at(-1).id;
  await s.tool("update_comment", { document: "notes", comment: docComment, body: "Reviewed twice" });
  expect(await s.tool("get_document", { slug: "notes" })).toContain("Reviewed twice");
});

test("labels: counts of open issues, scoped by workspace", async () => {
  await s.api("POST", "/api/issues", { project: "COM", title: "A", labels: ["bug", "ui"] });
  await s.api("POST", "/api/issues", { project: "COM", title: "B", labels: ["bug"], status: "done" });
  await s.api("POST", "/api/issues", { project: "SID", title: "C", labels: ["infra"] });

  expect((await s.api("GET", "/api/labels")).body).toEqual(["bug", "infra", "ui"]);
  expect((await s.api("GET", "/api/labels?workspace=acme")).body).toEqual(["bug", "ui"]);
  expect(await s.tool("list_labels", { workspace: "acme" })).toBe("bug · 1 open\nui · 1 open");
  expect(await s.tool("list_labels", { workspace: "side" })).toBe("infra · 1 open");
});

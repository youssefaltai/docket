import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let ana: Caller;
let claude: Caller;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/workspaces", { key: "side", name: "Side" });
  await s.api("POST", "/api/teams", { key: "COM", workspace: s.workspace, name: "Comments" });
  await s.api("POST", "/api/teams", { key: "SID", workspace: "side", name: "Side" });
  await s.api("POST", "/api/issues", { team: "COM", title: "One" });
  await s.api("POST", "/api/documents", { team: "COM", title: "Notes", content: "x" });
  ana = await s.user("ana");
  claude = await s.agent("claude");
});
afterAll(() => s.stop());

test("REST: the author edits and deletes an issue comment", async () => {
  const added = await ana.api("POST", "/api/issues/COM-1/comments", { body: "Tpyo" });
  const comment = added.body.comments.at(-1);
  expect(comment.author.username).toBe("ana");
  expect(comment.editedAt).toBeNull();
  const before = added.body.updatedAt;
  await Bun.sleep(5); // so the bump lands on a later millisecond

  const edited = await ana.api("PATCH", `/api/issues/COM-1/comments/${comment.id}`, { body: "Typo" });
  expect(edited.status).toBe(200);
  expect(edited.body.comments.at(-1)).toMatchObject({ id: comment.id, body: "Typo" });
  expect(edited.body.comments.at(-1).author.username).toBe("ana");
  expect(edited.body.comments.at(-1).editedAt).toBeString();
  expect(edited.body.updatedAt > before).toBeTrue();

  const deleted = await ana.api("DELETE", `/api/issues/COM-1/comments/${comment.id}`);
  expect(deleted.status).toBe(200);
  expect(deleted.body.comments.find((c: any) => c.id === comment.id)).toBeUndefined();
});

test("REST: only the author may change a comment, and ids are scoped to their owner", async () => {
  const { body } = await ana.api("POST", "/api/issues/COM-1/comments", { body: "Mine" });
  const id = body.comments.at(-1).id;

  // claude (an agent, not the comment's author) may not edit or delete ana's comment.
  expect((await claude.api("PATCH", `/api/issues/COM-1/comments/${id}`, { body: "Yours" })).status).toBe(403);
  expect((await claude.api("DELETE", `/api/issues/COM-1/comments/${id}`)).status).toBe(403);
  expect((await ana.api("PATCH", `/api/documents/notes/comments/${id}`, { body: "x" })).status).toBe(404);
  expect((await ana.api("PATCH", `/api/issues/COM-1/comments/abc`, { body: "x" })).status).toBe(404);
  expect((await ana.api("PATCH", `/api/issues/COM-1/comments/${id}`, { body: " " })).status).toBe(400);
  expect((await s.api("GET", "/api/issues/COM-1")).body.comments.at(-1).body).toBe("Mine");
});

test("REST: doc comments can be edited without touching the doc's updatedAt", async () => {
  const added = await ana.api("POST", "/api/documents/notes/comments", { body: "Hi" });
  const id = added.body.comments.at(-1).id;
  const edited = await ana.api("PATCH", `/api/documents/notes/comments/${id}`, { body: "Hello" });
  expect(edited.body.comments.at(-1)).toMatchObject({ body: "Hello" });
  expect(edited.body.updatedAt).toBe(added.body.updatedAt);
  const deleted = await ana.api("DELETE", `/api/documents/notes/comments/${id}`);
  expect(deleted.body.comments).toEqual([]);
});

test("MCP: an agent edits and deletes its own comments, not other people's", async () => {
  await claude.tool("comment_issue", { id: "COM-1", body: "Halfway" });
  const ours = (await s.api("GET", "/api/issues/COM-1")).body.comments.at(-1).id;
  expect(await claude.tool("get_issue", { id: "COM-1" })).toContain(`**@claude** · #${ours} ·`);

  expect(await claude.tool("update_comment", { issue: "COM-1", comment: ours, body: "Done" })).toBe(`Edited comment #${ours} on COM-1`);
  expect(await claude.tool("get_issue", { id: "COM-1" })).toMatch(new RegExp(`#${ours} · \\S+ · edited\\nDone`));

  const theirs = (await s.api("GET", "/api/issues/COM-1")).body.comments.find((c: any) => c.body === "Mine").id;
  await expect(claude.tool("update_comment", { issue: "COM-1", comment: theirs, body: "x" })).rejects.toThrow();
  await expect(claude.tool("delete_comment", { comment: ours })).rejects.toThrow("exactly one of issue or document");

  await claude.tool("delete_comment", { issue: "COM-1", comment: ours });
  expect(await claude.tool("get_issue", { id: "COM-1" })).not.toContain("Done");

  await claude.tool("comment_document", { slug: "notes", body: "Reviewed" });
  const docComment = (await s.api("GET", "/api/documents/notes")).body.comments.at(-1).id;
  await claude.tool("update_comment", { document: "notes", comment: docComment, body: "Reviewed twice" });
  expect(await claude.tool("get_document", { slug: "notes" })).toContain("Reviewed twice");
});

test("labels: counts of open issues, scoped by workspace", async () => {
  await s.api("POST", "/api/issues", { team: "COM", title: "A", labels: ["bug", "ui"] });
  await s.api("POST", "/api/issues", { team: "COM", title: "B", labels: ["bug"], status: "done" });
  await s.api("POST", "/api/issues", { team: "SID", title: "C", labels: ["infra"] });

  expect((await s.api("GET", "/api/labels")).body).toEqual(["bug", "infra", "ui"]);
  expect((await s.api("GET", `/api/labels?workspace=${s.workspace}`)).body).toEqual(["bug", "ui"]);
  expect(await s.tool("list_labels", { workspace: s.workspace })).toBe("bug · 1 open\nui · 1 open");
  expect(await s.tool("list_labels", { workspace: "side" })).toBe("infra · 1 open");
});

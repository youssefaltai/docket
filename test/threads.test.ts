// Threaded comment replies and resolving threads (DKT-25): one level of replies, anyone resolves or reopens a thread
// from its first comment, a reply reopens it, and a root with replies can't be deleted. Issues and docs alike.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let ana: Caller;
let bob: Caller;
let claude: Caller;
let olga: Caller;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "THR", name: "Threads" });
  await s.api("POST", "/api/issues", { team: "THR", title: "Threaded" });
  await s.api("POST", "/api/issues", { team: "THR", title: "Elsewhere" });
  await s.api("POST", "/api/documents", { team: "THR", title: "Plan", content: "x" });
  ana = await s.user("ana");
  bob = await s.user("bob");
  claude = await s.agent("claude");
  await s.api("POST", "/api/workspaces", { key: "side", name: "Side" });
  olga = await s.user("olga", { workspace: "side" });
  // Issue and doc comments are numbered apart: start the docs' past the issues', so a doc comment's id is no THR-1 comment's.
  await s.api("POST", "/api/documents", { team: "THR", title: "Pad", content: "x" });
  for (let i = 0; i < 20; i++) await s.api("POST", "/api/documents/pad/comments", { body: `pad ${i}` });
});
afterAll(() => s.stop());

const comments = async (id = "THR-1") => (await s.api("GET", `/api/issues/${id}`)).body.comments as any[];
let root: number;
let bobs: number;

test("a reply goes under its thread; a reply to a reply joins the same thread", async () => {
  const added = await ana.api("POST", "/api/issues/THR-1/comments", { body: "Which database?" });
  expect(added.status).toBe(201);
  root = added.body.comments.at(-1).id;
  expect(added.body.comments.at(-1)).toMatchObject({ parent: null, resolvedAt: null, resolvedBy: null });

  const replied = await bob.api("POST", "/api/issues/THR-1/comments", { body: "SQLite", parent: root });
  expect(replied.status).toBe(201);
  bobs = replied.body.comments.at(-1).id;
  expect(replied.body.comments.at(-1)).toMatchObject({ parent: root, body: "SQLite", author: { username: "bob" } });

  expect(await claude.tool("comment_issue", { id: "THR-1", body: "Agreed", parent: bobs })).toBe(`Replied to #${bobs} on THR-1`);
  expect((await comments()).at(-1)).toMatchObject({ parent: root, author: { username: "claude" } });
});

test("a parent from another issue, a doc, or nowhere is 404, and nothing is added", async () => {
  const other = (await ana.api("POST", "/api/issues/THR-2/comments", { body: "Other" })).body.comments.at(-1).id;
  const onDoc = (await ana.api("POST", "/api/documents/plan/comments", { body: "On the doc" })).body.comments.at(-1).id;
  const before = await comments();
  expect(before.map((c) => c.id)).not.toContain(onDoc); // ids are per table: make sure it isn't one of THR-1's
  expect((await ana.api("POST", "/api/issues/THR-1/comments", { body: "x", parent: other })).status).toBe(404);
  expect((await ana.api("POST", "/api/issues/THR-1/comments", { body: "x", parent: onDoc })).status).toBe(404);
  expect((await ana.api("POST", "/api/issues/THR-1/comments", { body: "x", parent: "abc" })).status).toBe(404);
  await expect(claude.tool("comment_issue", { id: "THR-1", body: "x", parent: other })).rejects.toThrow(`Comment ${other} not found`);
  expect(await comments()).toEqual(before);
});

test("anyone resolves and reopens a thread from its first comment; a new reply reopens it", async () => {
  const resolved = await bob.api("PUT", `/api/issues/THR-1/comments/${root}/resolved`);
  expect(resolved.status).toBe(200);
  const r = resolved.body.comments.find((c: any) => c.id === root);
  expect(r.resolvedAt).toBeString();
  expect(r.resolvedBy.username).toBe("bob");
  expect((await bob.api("PUT", `/api/issues/THR-1/comments/${root}/resolved`)).body.comments[0].resolvedAt).toBe(r.resolvedAt); // idempotent

  const onReply = await bob.api("PUT", `/api/issues/THR-1/comments/${bobs}/resolved`);
  expect(onReply.status).toBe(400);
  expect(onReply.body.error).toBe("Resolve a thread from its first comment");
  expect((await bob.api("DELETE", `/api/issues/THR-1/comments/${bobs}/resolved`)).status).toBe(400);

  const reopened = await ana.api("DELETE", `/api/issues/THR-1/comments/${root}/resolved`);
  expect(reopened.body.comments.find((c: any) => c.id === root)).toMatchObject({ resolvedAt: null, resolvedBy: null });

  await claude.api("PUT", `/api/issues/THR-1/comments/${root}/resolved`);
  expect((await comments()).find((c) => c.id === root).resolvedBy.username).toBe("claude");
  const answered = await ana.api("POST", "/api/issues/THR-1/comments", { body: "One more thing", parent: root });
  expect(answered.body.comments.find((c: any) => c.id === root)).toMatchObject({ resolvedAt: null, resolvedBy: null });
});

test("a root with replies can't be deleted; replies can; only authors edit or delete", async () => {
  const del = await ana.api("DELETE", `/api/issues/THR-1/comments/${root}`);
  expect(del.status).toBe(409);
  expect(del.body.error).toBe("This comment has replies; edit it instead");
  expect((await ana.api("PATCH", `/api/issues/THR-1/comments/${root}`, { body: "Which database, and why?" })).status).toBe(200);
  expect((await claude.api("PATCH", `/api/issues/THR-1/comments/${bobs}`, { body: "x" })).status).toBe(403);
  expect((await ana.api("DELETE", `/api/issues/THR-1/comments/${bobs}`)).status).toBe(403);
  expect((await bob.api("DELETE", `/api/issues/THR-1/comments/${bobs}`)).status).toBe(200);
  expect((await comments()).map((c) => c.id)).not.toContain(bobs);

  // A root without replies deletes as before.
  const lone = (await bob.api("POST", "/api/issues/THR-2/comments", { body: "Lone" })).body.comments.at(-1).id;
  expect((await bob.api("DELETE", `/api/issues/THR-2/comments/${lone}`)).status).toBe(200);
});

test("MCP: resolve_thread, and get_issue shows replies under their root and resolved threads collapsed", async () => {
  await bob.api("POST", "/api/issues/THR-1/comments", { body: "Postgres later", parent: root });
  const open = await claude.tool("get_issue", { id: "THR-1" });
  expect(open).toMatch(new RegExp(`\\*\\*@ana\\*\\* · #${root} · \\S+ · edited\\nWhich database, and why\\?\\n\\n↳ \\*\\*@claude\\*\\* · #\\d+ · \\S+\\nAgreed`));
  expect(open).toContain("↳ **@bob** ·");

  expect(await bob.tool("resolve_thread", { issue: "THR-1", comment: root })).toBe(`Resolved thread #${root} on THR-1`);
  const text = await claude.tool("get_issue", { id: "THR-1" });
  expect(text).toMatch(new RegExp(`\\*\\*@ana\\*\\* · #${root} · \\S+ · edited · resolved by @bob · 3 replies`));
  expect(text).not.toContain("Agreed");
  expect(text).not.toContain("↳");
  const replyId = (await comments()).at(-1).id;
  await expect(bob.tool("resolve_thread", { issue: "THR-1", comment: replyId })).rejects.toThrow("Resolve a thread from its first comment");
  await expect(bob.tool("resolve_thread", { comment: root })).rejects.toThrow("exactly one of issue or document");
  expect(await claude.tool("resolve_thread", { issue: "THR-1", comment: root, resolved: false })).toBe(`Reopened thread #${root} on THR-1`);
  expect(await claude.tool("get_issue", { id: "THR-1" })).toContain("Agreed");
});

test("doc comments thread and resolve the same way, without touching the doc's updatedAt", async () => {
  const before = (await s.api("GET", "/api/documents/plan")).body;
  const docRoot = (await ana.api("POST", "/api/documents/plan/comments", { body: "Section 2?" })).body.comments.at(-1).id;
  const replied = await bob.api("POST", "/api/documents/plan/comments", { body: "Rewritten", parent: docRoot });
  expect(replied.status).toBe(201);
  expect(replied.body.comments.at(-1)).toMatchObject({ parent: docRoot });
  expect((await ana.api("POST", "/api/documents/plan/comments", { body: "x", parent: root })).status).toBe(404); // an issue comment's id

  const resolved = await bob.api("PUT", `/api/documents/plan/comments/${docRoot}/resolved`);
  expect(resolved.body.comments.find((c: any) => c.id === docRoot).resolvedBy.username).toBe("bob");
  expect(resolved.body.updatedAt).toBe(before.updatedAt);
  expect((await bob.api("PUT", `/api/documents/plan/comments/${replied.body.comments.at(-1).id}/resolved`)).status).toBe(400);
  expect(await claude.tool("get_document", { slug: "plan" })).toContain("resolved by @bob · 1 reply");
  expect((await ana.api("DELETE", `/api/documents/plan/comments/${docRoot}`)).status).toBe(409);

  expect(await claude.tool("comment_document", { slug: "plan", body: "Looks good", parent: docRoot })).toBe(`Replied to #${docRoot} on document plan`);
  const doc = (await s.api("GET", "/api/documents/plan")).body;
  expect(doc.comments.find((c: any) => c.id === docRoot).resolvedAt).toBeNull();
  expect(doc.updatedAt).toBe(before.updatedAt);
  await claude.tool("resolve_thread", { document: "plan", comment: docRoot });
  expect((await ana.api("DELETE", `/api/documents/plan/comments/${docRoot}/resolved`)).body.comments.find((c: any) => c.id === docRoot).resolvedAt).toBeNull();
});

test("a trashed issue takes no replies or resolutions; outsiders get 404", async () => {
  expect((await olga.api("POST", "/api/issues/THR-1/comments", { body: "Hi", parent: root })).status).toBe(404);
  expect((await olga.api("PUT", `/api/issues/THR-1/comments/${root}/resolved`)).status).toBe(404);
  expect((await olga.api("PUT", `/api/documents/plan/comments/${root}/resolved`)).status).toBe(404);

  await s.api("DELETE", "/api/issues/THR-1");
  expect((await bob.api("POST", "/api/issues/THR-1/comments", { body: "Late", parent: root })).status).toBe(409);
  expect((await bob.api("PUT", `/api/issues/THR-1/comments/${root}/resolved`)).status).toBe(409);
  await s.api("POST", "/api/issues/THR-1/restore");
  expect((await bob.api("PUT", `/api/issues/THR-1/comments/${root}/resolved`)).status).toBe(200);
});

test("replies notify subscribers like any comment; a mention in a reply is a mention", async () => {
  const inbox = async (c: Caller) => (await c.api("GET", "/api/notifications")).body;
  const q = (await ana.api("POST", "/api/issues/THR-2/comments", { body: "Anyone?" })).body.comments.at(-1).id;
  const r = (await bob.api("POST", "/api/issues/THR-2/comments", { body: "Me, and @claude", parent: q })).body.comments.at(-1).id;
  const flat = (n: any) => (Array.isArray(n) ? n : n.notifications);
  expect(flat(await inbox(ana)).find((n: any) => n.comment?.id === r)).toMatchObject({ kind: "commented" });
  const forClaude = (await claude.api("GET", "/api/notifications")).body;
  expect(flat(forClaude).find((n: any) => n.comment?.id === r)).toMatchObject({ kind: "mentioned" });
});

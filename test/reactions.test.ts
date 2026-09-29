// Emoji reactions (DKT-35): on an issue's description, issue comments and doc comments. Add/remove is
// idempotent and yours alone, validated as a single emoji, capped, never bumps updatedAt or notifies anyone.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let ana: Caller;
let bob: Caller;
let claude: Caller;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "RX", workspace: s.workspace, name: "Reactions" });
  await s.api("POST", "/api/workspaces", { key: "side", name: "Side" });
  await s.as("admin", "cookie", "side").api("POST", "/api/teams", { key: "SID", name: "Side" });
  ana = await s.user("ana");
  bob = await s.user("bob");
  claude = await s.agent("claude");
});
afterAll(() => s.stop());

const usernames = (reactions: any[]) => reactions.map((r: any) => [r.emoji, r.users.map((u: any) => u.username)]);

test("REST: reacting to a comment is yours alone, idempotent, and additive across people", async () => {
  const issue = (await s.api("POST", "/api/issues", { team: "RX", title: "Comment reactions" })).body;
  const cid = (await s.api("POST", `/api/issues/${issue.id}/comments`, { body: "Ship it" })).body.comments.at(-1).id;

  const first = await ana.api("PUT", `/api/issues/${issue.id}/comments/${cid}/reactions/${encodeURIComponent("👍")}`);
  expect(first.status).toBe(200);
  const reacted = first.body.comments.find((c: any) => c.id === cid);
  expect(usernames(reacted.reactions)).toEqual([["👍", ["ana"]]]);

  // Again: unchanged (idempotent).
  const again = await ana.api("PUT", `/api/issues/${issue.id}/comments/${cid}/reactions/${encodeURIComponent("👍")}`);
  expect(usernames(again.body.comments.find((c: any) => c.id === cid).reactions)).toEqual([["👍", ["ana"]]]);

  // Bob adds the same emoji: both listed, in the order they reacted.
  const withBob = await bob.api("PUT", `/api/issues/${issue.id}/comments/${cid}/reactions/${encodeURIComponent("👍")}`);
  expect(usernames(withBob.body.comments.find((c: any) => c.id === cid).reactions)).toEqual([["👍", ["ana", "bob"]]]);

  // Ana removes hers: only bob's stays.
  const removed = await ana.api("DELETE", `/api/issues/${issue.id}/comments/${cid}/reactions/${encodeURIComponent("👍")}`);
  expect(usernames(removed.body.comments.find((c: any) => c.id === cid).reactions)).toEqual([["👍", ["bob"]]]);
});

test("REST: reacting to the issue description doesn't bump updatedAt", async () => {
  const issue = (await s.api("POST", "/api/issues", { team: "RX", title: "Description reactions" })).body;
  const res = await ana.api("PUT", `/api/issues/${issue.id}/reactions/${encodeURIComponent("🎉")}`);
  expect(res.status).toBe(200);
  expect(usernames(res.body.reactions)).toEqual([["🎉", ["ana"]]]);
  expect(res.body.updatedAt).toBe(issue.updatedAt);
  const removed = await ana.api("DELETE", `/api/issues/${issue.id}/reactions/${encodeURIComponent("🎉")}`);
  expect(removed.body.reactions).toEqual([]);
  expect(removed.body.updatedAt).toBe(issue.updatedAt);
});

test("emoji validation: single emoji (any form) accepted, everything else 400", async () => {
  const issue = (await s.api("POST", "/api/issues", { team: "RX", title: "Validation" })).body;
  for (const emoji of ["👍🏽", "👨‍👩‍👧", "🇸🇦", "1️⃣"]) {
    const res = await ana.api("PUT", `/api/issues/${issue.id}/reactions/${encodeURIComponent(emoji)}`);
    expect([emoji, res.status]).toEqual([emoji, 200]);
    expect(res.body.reactions.map((r: any) => r.emoji)).toContain(emoji);
    await ana.api("DELETE", `/api/issues/${issue.id}/reactions/${encodeURIComponent(emoji)}`);
  }
  for (const bad of ["abc", "a", "👍👍", "a👍"]) {
    const res = await ana.api("PUT", `/api/issues/${issue.id}/reactions/${encodeURIComponent(bad)}`);
    expect([bad, res.status]).toEqual([bad, 400]);
  }
});

test("comment id from another issue is 404; a trashed issue is 409; another workspace's member is 404; a read-only key is 403", async () => {
  const a = (await s.api("POST", "/api/issues", { team: "RX", title: "A" })).body;
  const b = (await s.api("POST", "/api/issues", { team: "RX", title: "B" })).body;
  const cidOnB = (await s.api("POST", `/api/issues/${b.id}/comments`, { body: "on B" })).body.comments.at(-1).id;
  expect((await ana.api("PUT", `/api/issues/${a.id}/comments/${cidOnB}/reactions/${encodeURIComponent("👍")}`)).status).toBe(404);

  const trashed = (await s.api("POST", "/api/issues", { team: "RX", title: "Trashed" })).body;
  await s.api("DELETE", `/api/issues/${trashed.id}`);
  expect((await ana.api("PUT", `/api/issues/${trashed.id}/reactions/${encodeURIComponent("👍")}`)).status).toBe(409);

  const sideAdmin = s.as("admin", "cookie", "side");
  expect((await sideAdmin.api("PUT", `/api/issues/${a.id}/reactions/${encodeURIComponent("👍")}`)).status).toBe(404);

  const readOnly = s.with({ token: (await ana.api("POST", "/api/api-keys", { name: "ro", scope: "read" })).body.token });
  expect((await readOnly.api("PUT", `/api/issues/${a.id}/reactions/${encodeURIComponent("👍")}`)).status).toBe(403);
});

test("doc comment reactions", async () => {
  const doc = (await s.api("POST", "/api/documents", { team: "RX", title: "Plan", content: "x" })).body;
  const cid = (await s.api("POST", `/api/documents/${doc.slug}/comments`, { body: "Looks good" })).body.comments.at(-1).id;
  const res = await ana.api("PUT", `/api/documents/${doc.slug}/comments/${cid}/reactions/${encodeURIComponent("✅")}`);
  expect(res.status).toBe(200);
  expect(usernames(res.body.comments.find((c: any) => c.id === cid).reactions)).toEqual([["✅", ["ana"]]]);
  const removed = await ana.api("DELETE", `/api/documents/${doc.slug}/comments/${cid}/reactions/${encodeURIComponent("✅")}`);
  expect(removed.body.comments.find((c: any) => c.id === cid).reactions).toEqual([]);
});

test("deleting a comment removes its reactions", async () => {
  const issue = (await s.api("POST", "/api/issues", { team: "RX", title: "Cleanup" })).body;
  const cid = (await s.api("POST", `/api/issues/${issue.id}/comments`, { body: "temp" })).body.comments.at(-1).id;
  await ana.api("PUT", `/api/issues/${issue.id}/comments/${cid}/reactions/${encodeURIComponent("👀")}`);
  const count = () => s.sql("SELECT COUNT(*) AS n FROM reactions WHERE target = ?", `comment:${cid}`)[0].n;
  expect(count()).toBe(1);
  await s.api("DELETE", `/api/issues/${issue.id}/comments/${cid}`);
  expect(count()).toBe(0);
});

test("MCP: an agent reacts and takes it back; get_issue shows the count", async () => {
  const issue = (await s.api("POST", "/api/issues", { team: "RX", title: "MCP reactions" })).body;
  const cid = (await s.api("POST", `/api/issues/${issue.id}/comments`, { body: "Picking this up" })).body.comments.at(-1).id;
  await claude.tool("react", { issue: issue.id, comment: cid, emoji: "👀" });
  expect(await claude.tool("get_issue", { id: issue.id })).toContain("👀 1");
  await claude.tool("react", { issue: issue.id, comment: cid, emoji: "👀", remove: true });
  expect(await claude.tool("get_issue", { id: issue.id })).not.toContain("👀 1");
  await expect(claude.tool("react", { emoji: "👍" })).rejects.toThrow("exactly one of issue or document");
});

test("realtime: another member's socket receives a changed issue event", async () => {
  const issue = (await s.api("POST", "/api/issues", { team: "RX", title: "Live" })).body;
  const socket = ana.ws();
  expect(await socket.opened).toBeTrue();
  await s.api("PUT", `/api/issues/${issue.id}/reactions/${encodeURIComponent("🚀")}`);
  await socket.until((e) => e.entity === "issue" && e.id === issue.id);
  socket.close();
});

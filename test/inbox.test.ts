// The inbox (DKT-11): subscriptions and notifications. You follow what you create, claim, comment on, or are assigned,
// delegated or mentioned in; its comments, mentions and moves into in_review, done or canceled reach you, never
// your own. Only you see, mark or delete yours, and only in the workspace they're in.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let ana: Caller;
let bob: Caller;
let claude: Caller;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "INB", name: "Inbox" });
  ana = await s.user("ana");
  bob = await s.user("bob");
  claude = await s.agent("claude", { name: "Claude" });
});
afterAll(() => s.stop());

const sql = (query: string, ...params: (string | number)[]) => {
  const db = new Database(s.databasePath);
  try {
    return db.query(query).all(...params) as any[];
  } finally {
    db.close();
  }
};
/** The newest notification id so far: what a later `since` counts from. */
const mark = () => sql("SELECT COALESCE(MAX(id), 0) AS id FROM notifications")[0].id as number;
/** A caller's notifications after `after`, oldest first, as [kind, actor, issue or doc, status or excerpt]. */
async function since(c: Caller, after: number) {
  const res = await c.api("GET", "/api/notifications");
  expect(res.status).toBe(200);
  return (res.body.notifications as any[])
    .filter((n) => n.id > after)
    .reverse()
    .map((n) => [n.kind, n.actor.username, n.issue?.id ?? n.document?.slug, ...(n.status ? [n.status] : n.comment ? [n.comment.excerpt] : [])]);
}
const create = async (title: string, extra: object = {}) => (await s.api("POST", "/api/issues", { team: "INB", title, ...extra })).body;
const comment = async (c: Caller, id: string, body: string) => {
  const res = await c.api("POST", `/api/issues/${id}/comments`, { body });
  expect(res.status).toBe(201);
  return res.body.comments.at(-1).id as number;
};

test("delegating tells the agent, assigning tells the person; the actor is told nothing", async () => {
  const at = mark();
  const issue = await create("Staffed", { delegate: "claude", assignee: "ana" });
  expect(await claude.tool("list_notifications")).toMatch(new RegExp(`^#\\d+ · unread · delegated · ${issue.id} Staffed · by @admin · just now$`));
  expect(await since(ana, at)).toEqual([["assigned", "admin", issue.id]]);
  expect(await since(s.admin, at)).toEqual([]);
  // All three follow it now.
  for (const c of [s.admin, ana, claude]) expect((await c.api("GET", `/api/issues/${issue.id}`)).body.subscribed).toBe(true);
  expect((await bob.api("GET", `/api/issues/${issue.id}`)).body.subscribed).toBe(false);
});

test("comments reach the other subscribers; a mention reaches its person once, as a mention", async () => {
  const issue = await create("Talk", { delegate: "claude", assignee: "ana" });
  let at = mark();
  await claude.tool("comment_issue", { id: issue.id, body: "Found it.\n\nThe fix is small." });
  expect(await since(ana, at)).toEqual([["commented", "claude", issue.id, "Found it. The fix is small."]]);
  expect(await since(s.admin, at)).toEqual([["commented", "claude", issue.id, "Found it. The fix is small."]]);
  expect(await claude.tool("list_notifications", { unread: false })).not.toContain("Found it");

  at = mark();
  const cid = await comment(bob, issue.id, "@ana look");
  expect(await since(ana, at)).toEqual([["mentioned", "bob", issue.id, "@ana look"]]);
  expect(await since(s.admin, at)).toEqual([["commented", "bob", issue.id, "@ana look"]]);
  expect((await bob.api("GET", `/api/issues/${issue.id}`)).body.subscribed).toBe(true);

  // Editing it again doesn't mention ana again; adding someone mentions just them.
  at = mark();
  expect((await bob.api("PATCH", `/api/issues/${issue.id}/comments/${cid}`, { body: "@ana look, @admin too" })).status).toBe(200);
  expect(await since(ana, at)).toEqual([]);
  expect(await since(s.admin, at)).toEqual([["mentioned", "bob", issue.id, "@ana look, @admin too"]]);

  // Deleting the comment takes its notifications with it.
  expect((await bob.api("DELETE", `/api/issues/${issue.id}/comments/${cid}`)).status).toBe(200);
  expect(sql("SELECT COUNT(*) AS n FROM notifications WHERE comment_id = ?", cid)[0].n).toBe(0);
});

test("in_review, done and canceled tell the subscribers; other changes don't", async () => {
  const issue = await create("Ship", { delegate: "claude", assignee: "ana" });
  await comment(bob, issue.id, "Following");
  let at = mark();
  await claude.tool("update_issue", { id: issue.id, status: "in_review" });
  for (const c of [ana, s.admin, bob]) expect(await since(c, at)).toEqual([["status", "claude", issue.id, "in_review"]]);
  expect(await claude.tool("list_notifications")).not.toContain("status → in_review");
  at = mark();
  await claude.tool("update_issue", { id: issue.id, priority: 2, status: "todo", title: "Ship it", labels: ["x"] });
  await claude.tool("claim_issue", { id: issue.id });
  expect(mark()).toBe(at);
  await s.api("PATCH", `/api/issues/${issue.id}`, { status: "done" });
  expect(await since(ana, at)).toEqual([["status", "admin", issue.id, "done"]]);
  expect(await claude.tool("list_notifications", { limit: 1 })).toContain(`status → done · ${issue.id} Ship it · by @admin`);
});

test("unsubscribing sticks until you're involved again", async () => {
  const issue = await create("Quiet", { assignee: "ana" });
  const off = await ana.api("DELETE", `/api/issues/${issue.id}/subscription`);
  expect([off.status, off.body.subscribed]).toEqual([200, false]);
  let at = mark();
  await comment(bob, issue.id, "Anyone?");
  await s.api("PATCH", `/api/issues/${issue.id}`, { status: "canceled" });
  expect(await since(ana, at)).toEqual([]);
  expect((await ana.api("GET", `/api/issues/${issue.id}`)).body.subscribed).toBe(false);
  await comment(bob, issue.id, "@ana ping");
  expect(await since(ana, at)).toEqual([["mentioned", "bob", issue.id, "@ana ping"]]);
  expect((await ana.api("GET", `/api/issues/${issue.id}`)).body.subscribed).toBe(true);
  // PUT subscribes again; a trashed issue can't be followed.
  expect((await bob.api("PUT", `/api/issues/${issue.id}/subscription`)).body.subscribed).toBe(true);
  await s.api("DELETE", `/api/issues/${issue.id}`);
  expect((await bob.api("PUT", `/api/issues/${issue.id}/subscription`)).status).toBe(409);
});

test("marking and deleting: yours only, or 404", async () => {
  const issue = await create("Pile", { assignee: "ana" });
  await comment(bob, issue.id, "one");
  await comment(bob, issue.id, "two");
  const inbox = (await ana.api("GET", "/api/notifications")).body;
  const [newest, second] = inbox.notifications;
  // unread counts rows (issues and docs), not notifications: one of Pile's three read leaves Pile unread.
  const read = await ana.api("PATCH", "/api/notifications", { ids: [newest.id], read: true });
  expect([read.status, read.body.unread]).toEqual([200, inbox.unread]);
  expect(read.body.notifications[0].readAt).not.toBeNull();
  expect((await ana.api("GET", "/api/notifications?unread=true")).body.notifications.map((n: any) => n.id)).not.toContain(newest.id);

  // Someone else's is not found, whatever you try; nothing changes.
  expect((await bob.api("PATCH", "/api/notifications", { ids: [second.id], read: true })).status).toBe(404);
  expect((await bob.api("DELETE", `/api/notifications?ids=${second.id}`)).status).toBe(404);
  expect((await claude.api("PATCH", "/api/notifications", { ids: [newest.id, second.id], read: false })).status).toBe(404);
  expect((await ana.api("GET", "/api/notifications")).body.unread).toBe(inbox.unread);

  const deleted = await ana.api("DELETE", "/api/notifications?read=true");
  expect(deleted.status).toBe(200);
  expect(deleted.body.notifications.map((n: any) => n.id)).toContain(second.id);
  expect(deleted.body.notifications.map((n: any) => n.id)).not.toContain(newest.id);
  expect((await ana.api("DELETE", `/api/notifications?ids=${second.id}`)).body.notifications.map((n: any) => n.id)).not.toContain(second.id);
  expect((await ana.api("DELETE", "/api/notifications")).status).toBe(400);
  expect((await ana.api("PATCH", "/api/notifications", { read: "yes" })).status).toBe(400);

  // Reading the rest of Pile's (its assignment) takes Pile off the count.
  const now = (await ana.api("GET", "/api/notifications")).body;
  const pile = now.notifications.filter((n: any) => n.issue?.id === issue.id && !n.readAt).map((n: any) => n.id);
  expect(pile.length).toBe(1);
  expect((await ana.api("PATCH", "/api/notifications", { ids: pile, read: true })).body.unread).toBe(now.unread - 1);

  const all = await ana.api("PATCH", "/api/notifications", { read: true });
  expect(all.body.unread).toBe(0);
});

test("docs: the creator follows; comments and mentions in the content reach people", async () => {
  const doc = (await s.api("POST", "/api/documents", { team: "INB", title: "Spec", content: "Draft" })).body;
  expect(doc.subscribed).toBe(true);
  let at = mark();
  const posted = await ana.api("POST", `/api/documents/${doc.slug}/comments`, { body: "Looks good" });
  expect(await since(s.admin, at)).toEqual([["commented", "ana", doc.slug, "Looks good"]]);
  at = mark();
  await s.api("PATCH", `/api/documents/${doc.slug}`, { content: "Draft for @bob and @ana" }); // @ana is still being typed
  expect(await since(bob, at)).toEqual([["mentioned", "admin", doc.slug]]);
  expect(await since(ana, at)).toEqual([]);
  expect(await claude.tool("subscribe", { document: doc.slug })).toBe(`Subscribed to document ${doc.slug}`);
  at = mark();
  await bob.api("POST", `/api/documents/${doc.slug}/comments`, { body: "On it" });
  expect((await since(claude, at))).toEqual([["commented", "bob", doc.slug, "On it"]]);
  expect(await since(ana, at)).toEqual([["commented", "bob", doc.slug, "On it"]]);
  expect((await ana.api("DELETE", `/api/documents/${doc.slug}/subscription`)).body.subscribed).toBe(false);
  expect(posted.status).toBe(201);
});

test("an inbox event reaches only the recipient's sockets", async () => {
  const [anaSocket, bobSocket] = [ana.ws(), bob.ws()];
  expect([await anaSocket.opened, await bobSocket.opened]).toEqual([true, true]);
  const issue = await create("Live");
  await s.api("PATCH", `/api/issues/${issue.id}`, { assignee: "ana" });
  expect(await anaSocket.until((e) => e.entity === "inbox")).toEqual({ type: "changed", entity: "inbox", workspace: "acme", id: "ana" });
  // Following is yours alone too: ana's tabs hear that she unsubscribed, bob's don't.
  const heard = (events: any[]) => events.filter((e) => e.entity === "issue" && e.id === issue.id).length;
  const n = heard(anaSocket.events);
  await ana.api("DELETE", `/api/issues/${issue.id}/subscription`);
  await anaSocket.until(() => heard(anaSocket.events) > n);
  await s.api("PATCH", `/api/issues/${issue.id}`, { title: "Live!" }); // everyone hears this one, after the rest
  await bobSocket.until(() => heard(bobSocket.events) >= 3);
  expect(heard(bobSocket.events)).toBe(3); // created, assigned, renamed
  expect(bobSocket.events.filter((e) => e.entity === "inbox")).toEqual([]);
  anaSocket.close();
  bobSocket.close();
});

test("MCP: mark read, unsubscribe, and list what you follow", async () => {
  const issue = await create("Agentic", { delegate: "claude" });
  expect(await claude.tool("mark_notifications_read", { all: true })).toBe("Marked all read · 0 unread left");
  expect(await claude.tool("list_notifications")).toBe("No unread notifications.");
  await expect(claude.tool("mark_notifications_read", {})).rejects.toThrow(/exactly one of ids or all/);
  expect(await claude.tool("subscribe", { issue: issue.id, subscribed: false })).toBe(`Unsubscribed from ${issue.id}`);
  expect((await claude.api("GET", `/api/issues/${issue.id}`)).body.subscribed).toBe(false);
  await expect(claude.tool("subscribe", { issue: issue.id, document: "x" })).rejects.toThrow(/exactly one/);

  const rest = (await ana.api("GET", "/api/issues?subscribed=true")).body.map((i: any) => i.id).sort();
  const expected = sql(
    `SELECT t.key || '-' || i.number AS id FROM subscriptions s JOIN issues i ON i.id = s.issue_id JOIN teams t ON t.id = i.team_id
     JOIN workspace_members m ON m.user_id = s.user_id AND m.workspace = 'acme'
     WHERE m.username = 'ana' AND i.deleted_at IS NULL ORDER BY 1`,
  ).map((r) => r.id);
  expect(rest).toEqual(expected);
  expect(rest.length).toBeGreaterThan(2);
  const mcp = await ana.tool("list_issues", { subscribed: true, status: ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] });
  expect(mcp.split("\n").map((l) => l.split(" · ")[0]).sort()).toEqual(expected);
});

test("each inbox keeps its newest 2,000", async () => {
  const issue = await create("Busy");
  const [{ user_id: anaId }] = sql("SELECT user_id FROM workspace_members WHERE workspace = 'acme' AND username = 'ana'");
  const db = new Database(s.databasePath);
  const insert = db.query("INSERT INTO notifications (user_id, workspace, kind, actor_id, issue_id, created_at) VALUES (?, 'acme', 'assigned', 1, NULL, ?)");
  db.transaction(() => {
    for (let i = 0; i < 2000; i++) insert.run(anaId, new Date(0).toISOString());
  })();
  db.close();
  const oldest = sql("SELECT MIN(id) AS id FROM notifications WHERE user_id = ?", anaId)[0].id;
  await s.api("PATCH", `/api/issues/${issue.id}`, { assignee: "ana" });
  expect(sql("SELECT COUNT(*) AS n, MIN(id) > ? AS trimmed FROM notifications WHERE user_id = ? AND workspace = 'acme'", oldest, anaId)).toEqual([
    { n: 2000, trimmed: 1 },
  ]);
  expect((await ana.api("GET", "/api/notifications")).body.notifications.length).toBe(500);
  sql("DELETE FROM notifications WHERE issue_id IS NULL AND document_id IS NULL");
});

test("suspended members get nothing", async () => {
  const issue = await create("Without bob");
  await comment(bob, issue.id, "Subscribed");
  expect((await s.api("PATCH", "/api/workspaces/acme/members/bob", { suspended: true })).status).toBe(200);
  const at = mark();
  await comment(ana, issue.id, "@bob are you there?");
  await s.api("PATCH", `/api/issues/${issue.id}`, { status: "done" });
  const bobId = sql("SELECT user_id FROM workspace_members WHERE workspace = 'acme' AND username = 'bob'")[0].user_id;
  expect(sql("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND id > ?", bobId, at)).toEqual([{ n: 0 }]);
  expect(await since(s.admin, at)).toEqual([
    ["commented", "ana", issue.id, "@bob are you there?"],
  ]);
  expect((await s.api("PATCH", "/api/workspaces/acme/members/bob", { suspended: false })).status).toBe(200);
});

test("an inbox is per workspace: nothing crosses, even for the same person", async () => {
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  const side = s.as("admin", "cookie", "side");
  await side.api("POST", "/api/teams", { key: "SID", name: "Side" });
  await s.user("ana", { workspace: "side" });
  const anaSide = s.as("ana", "cookie", "side");
  const anaAcme = s.as("ana", "cookie", "acme");
  const acmeInbox = (await anaAcme.api("GET", "/api/notifications")).body;
  expect(acmeInbox.notifications.length).toBeGreaterThan(0);
  expect((await anaSide.api("GET", "/api/notifications")).body).toEqual({ notifications: [], unread: 0 });
  expect((await s.as("ana", "bearer", "side").tool("list_notifications", { unread: false }))).toBe("Your inbox is empty.");

  // Her side key's socket hears nothing of acme's inbox; her acme notifications can't be touched from side.
  const socket = s.as("ana", "bearer", "side").ws();
  expect(await socket.opened).toBeTrue();
  const at = mark();
  const acmeIssue = (await s.api("POST", "/api/issues", { team: "INB", title: "Acme only", assignee: "ana" })).body.id;
  await side.api("POST", "/api/issues", { team: "SID", title: "Side one", assignee: "ana" });
  await socket.until((e) => e.entity === "inbox" && e.workspace === "side");
  expect(socket.events.filter((e) => e.workspace !== "side")).toEqual([]);
  socket.close();
  expect(await since(anaSide, at)).toEqual([["assigned", "admin", "SID-1"]]);
  expect(await since(anaAcme, at)).toEqual([["assigned", "admin", acmeIssue]]);
  const acmeId = acmeInbox.notifications[0].id;
  expect((await anaSide.api("PATCH", "/api/notifications", { ids: [acmeId], read: true })).status).toBe(404);
  expect((await anaSide.api("DELETE", `/api/notifications?ids=${acmeId}`)).status).toBe(404);
  // Nobody outside acme can follow its issues.
  expect((await anaSide.api("PUT", "/api/issues/INB-1/subscription")).status).toBe(404);
});

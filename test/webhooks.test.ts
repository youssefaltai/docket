// Webhooks (DKT-12): admins (browser session) manage them; issue, comment and doc changes and agents' notifications are
// POSTed signed to a receiver, retried on failure, logged, and never sent to private addresses unless allowed.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { startServer, type Caller, type TestServer } from "./server.ts";

// The receiver: records every request; `answers` says how each path answers (default 200).
type Hit = { path: string; headers: Headers; raw: string; body: any; at: number };
const hits: Hit[] = [];
const answers = new Map<string, (hit: Hit) => Response | Promise<Response>>();
const receiver = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const raw = await req.text();
    const path = new URL(req.url).pathname;
    const hit = { path, headers: req.headers, raw, body: raw ? JSON.parse(raw) : null, at: Date.now() };
    hits.push(hit);
    return (answers.get(path) ?? (() => new Response("ok")))(hit);
  },
});
const base = `http://127.0.0.1:${receiver.port}`;

let s: TestServer;
let ana: Caller;
let zed: Caller;
beforeAll(async () => {
  s = await startServer({ env: { DOCKET_WEBHOOK_ALLOW_PRIVATE: "true", DOCKET_WEBHOOK_RETRY_MS: "50,50,50", DOCKET_WEBHOOK_TIMEOUT_MS: "300" } });
  await s.api("POST", "/api/teams", { key: "WHK", name: "Hooks" });
  ana = await s.user("ana");
  await s.agent("claude", { name: "Claude" });
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  expect((await s.as("admin", "cookie", "side").api("POST", "/api/teams", { key: "SID", name: "Side" })).status).toBe(201);
  zed = await s.user("zed", { workspace: "side", role: "admin" });
});
afterAll(async () => {
  await s.stop();
  receiver.stop(true);
});

/** Polls until `fn` returns something truthy. */
async function until<T>(fn: () => T | Promise<T>, ms = 3000): Promise<NonNullable<T>> {
  for (const end = Date.now() + ms; ; await Bun.sleep(10)) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out after ${ms}ms`);
  }
}

// Webhooks made by a test are deleted after it, so each test hears only its own.
const made: { ws: string; id: number }[] = [];
afterEach(async () => {
  for (const { ws, id } of made.splice(0)) await s.as("admin", "cookie", ws).api("DELETE", `/api/workspaces/${ws}/webhooks/${id}`);
  answers.clear();
});

/** A webhook to receiver path /h/<name>: its id, secret, what reached it, and its delivery log. */
async function hook(name: string, extra: object = {}, ws = "acme") {
  const res = await s.as("admin", "cookie", ws).api("POST", `/api/workspaces/${ws}/webhooks`, { url: `${base}/h/${name}`, ...extra });
  expect(res.status).toBe(201);
  const id = res.body.webhook.id as number;
  made.push({ ws, id });
  return {
    id,
    secret: res.body.secret as string,
    hits: () => hits.filter((h) => h.path === `/h/${name}`),
    log: async () => (await s.as("admin", "cookie", ws).api("GET", `/api/workspaces/${ws}/webhooks/${id}/deliveries`)).body as any[],
    get: async () => (await s.as("admin", "cookie", ws).api("GET", `/api/workspaces/${ws}/webhooks`)).body.find((w: any) => w.id === id),
  };
}
type Hook = Awaited<ReturnType<typeof hook>>;
/** Waits for the nth request (1-based) to reach a webhook. */
const nth = (h: Hook, n: number) => until(() => h.hits()[n - 1]);
const summary = (h: Hook) => h.hits().map((x) => `${x.body.type} ${x.body.action}${x.body.data.kind ? ` ${x.body.data.kind}` : ""}`);
const createIssue = async (extra: object = {}, c: Caller = s.admin) => {
  const res = await c.api("POST", "/api/issues", { team: "WHK", title: "Hooked", ...extra });
  expect(res.status).toBe(201);
  return res.body.id as string;
};
const sql = (query: string, ...params: (string | number)[]) => {
  const db = new Database(s.databasePath);
  try {
    return db.query(query).all(...params) as any[];
  } finally {
    db.close();
  }
};

describe("managing", () => {
  test("an admin in a browser creates, lists, edits, rotates and deletes; the secret shows once", async () => {
    const res = await s.api("POST", "/api/workspaces/acme/webhooks", { url: `${base}/h/manage`, label: "Agent runner" });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^dkwh_[0-9a-f]{64}$/);
    const { webhook } = res.body;
    expect(webhook).toMatchObject({ url: `${base}/h/manage`, label: "Agent runner", resourceTypes: ["Issue", "Comment", "Document", "Notification"], enabled: true, failures: 0 });
    expect(webhook.createdBy.username).toBe("admin");
    const list = await s.api("GET", "/api/workspaces/acme/webhooks");
    expect(list.body.map((w: any) => w.id)).toContain(webhook.id);
    expect(JSON.stringify(list.body)).not.toContain(res.body.secret);
    expect(JSON.stringify(list.body)).not.toContain("secret");

    const edited = await s.api("PATCH", `/api/workspaces/acme/webhooks/${webhook.id}`, { label: "Runner", resourceTypes: ["Notification", "Issue"], enabled: false });
    expect(edited.body).toMatchObject({ label: "Runner", resourceTypes: ["Issue", "Notification"], enabled: false });
    expect((await s.api("PATCH", `/api/workspaces/acme/webhooks/${webhook.id}`, { secret: "x" })).status).toBe(400);
    expect((await s.api("PATCH", `/api/workspaces/acme/webhooks/${webhook.id}`, { resourceTypes: ["Team"] })).status).toBe(400);
    expect((await s.api("PATCH", `/api/workspaces/acme/webhooks/${webhook.id}`, { resourceTypes: [] })).status).toBe(400);
    const rotated = await s.api("POST", `/api/workspaces/acme/webhooks/${webhook.id}/secret`);
    expect(rotated.body.secret).toMatch(/^dkwh_/);
    expect(rotated.body.secret).not.toBe(res.body.secret);
    expect((await s.api("DELETE", `/api/workspaces/acme/webhooks/${webhook.id}`)).body).toEqual({ ok: true });
    expect((await s.api("GET", `/api/workspaces/acme/webhooks/${webhook.id}/deliveries`)).status).toBe(404);
  });

  test("API keys and members get 403, other workspaces 404, and there are no MCP tools", async () => {
    const h = await hook("guarded");
    const bearer = s.as("admin", "bearer");
    expect((await bearer.api("GET", "/api/workspaces/acme/webhooks")).status).toBe(403);
    expect((await bearer.api("POST", "/api/workspaces/acme/webhooks", { url: `${base}/h/x` })).status).toBe(403);
    expect((await bearer.api("POST", `/api/workspaces/acme/webhooks/${h.id}/secret`)).status).toBe(403);
    expect((await ana.api("GET", "/api/workspaces/acme/webhooks")).status).toBe(403);
    expect((await ana.api("PATCH", `/api/workspaces/acme/webhooks/${h.id}`, { enabled: false })).status).toBe(403);
    // zed is an admin, of side only: acme doesn't exist for him, and acme's webhook isn't side's.
    expect((await zed.api("GET", "/api/workspaces/acme/webhooks")).status).toBe(404);
    expect((await zed.api("GET", `/api/workspaces/side/webhooks/${h.id}/deliveries`)).status).toBe(404);
    expect((await zed.api("DELETE", `/api/workspaces/side/webhooks/${h.id}`)).status).toBe(404);
    expect((await h.get()).enabled).toBe(true);
    expect((await s.tool("list_members")).length).toBeGreaterThan(0);
    expect((await s.admin.tools()).filter((t) => /hook/i.test(t))).toEqual([]);
  });
});

describe("events", () => {
  test("an issue: signed create, then update with updatedFrom; a change that changes nothing sends nothing", async () => {
    const h = await hook("issues", { resourceTypes: ["Issue"] });
    const id = await createIssue();
    const created = await nth(h, 1);
    expect(created.headers.get("docket-event")).toBe("Issue");
    expect(created.headers.get("content-type")).toBe("application/json");
    expect(created.headers.get("user-agent")).toBe("Docket-Webhook");
    expect(created.headers.get("docket-delivery")).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.headers.get("docket-signature")).toBe(createHmac("sha256", h.secret).update(created.raw).digest("hex"));
    expect(created.body).toMatchObject({ action: "create", type: "Issue", workspace: "acme", actor: { username: "admin" }, webhookId: h.id });
    expect(created.body.data).toMatchObject({ id, title: "Hooked", status: "backlog", description: "", creator: { username: "admin" } });
    expect(created.body.updatedFrom).toBeUndefined();
    expect(created.body.url).toEndWith(`/acme/issue/${id}`);
    expect(Math.abs(created.body.webhookTimestamp - Date.now())).toBeLessThan(60_000);
    expect(created.headers.get("docket-timestamp")).toBe(String(created.body.webhookTimestamp));

    await s.api("PATCH", `/api/issues/${id}`, { status: "todo", assignee: "ana" });
    const updated = (await nth(h, 2)).body;
    expect(updated).toMatchObject({ action: "update", data: { id, status: "todo", assignee: { username: "ana" } } });
    expect(updated.updatedFrom).toEqual({ status: "backlog", assignee: null });
    // The same status again changes nothing, so the next delivery is the priority change.
    await s.api("PATCH", `/api/issues/${id}`, { status: "todo" });
    await s.api("PATCH", `/api/issues/${id}`, { priority: 2 });
    expect((await nth(h, 3)).body.updatedFrom).toEqual({ priority: 0 });
    await s.api("DELETE", `/api/issues/${id}`);
    expect((await nth(h, 4)).body).toMatchObject({ action: "remove", data: { id } });
    await s.api("POST", `/api/issues/${id}/restore`);
    const restored = (await nth(h, 5)).body;
    expect(restored).toMatchObject({ action: "update", data: { deletedAt: null } });
    expect(restored.updatedFrom.deletedAt).toBe((await nth(h, 4)).body.data.deletedAt);
    await Bun.sleep(100);
    expect(summary(h)).toEqual(["Issue create", "Issue update", "Issue update", "Issue remove", "Issue update"]);
    // The log says so too, newest first.
    expect((await h.log()).map((d) => [d.type, d.action, d.entity, d.status, d.attempts, d.responseStatus])).toEqual([
      ["Issue", "update", id, "delivered", 1, 200],
      ["Issue", "remove", id, "delivered", 1, 200],
      ["Issue", "update", id, "delivered", 1, 200],
      ["Issue", "update", id, "delivered", 1, 200],
      ["Issue", "create", id, "delivered", 1, 200],
    ]);
  });

  test("a claim over MCP: updatedFrom has the status and the slot before", async () => {
    const h = await hook("claims", { resourceTypes: ["Issue"] });
    const id = await createIssue({ assignee: "ana" });
    await s.as("claude").tool("claim_issue", { id });
    const claimed = (await nth(h, 2)).body;
    expect(claimed).toMatchObject({ action: "update", actor: { username: "claude", kind: "agent" }, data: { status: "in_progress", delegate: { username: "claude" } } });
    expect(claimed.updatedFrom).toEqual({ status: "backlog", delegate: null });
    await ana.api("POST", `/api/issues/${id}/claim`); // started and hers already: nothing changes, nothing sent
    await s.api("PATCH", `/api/issues/${id}`, { delegate: null });
    expect((await nth(h, 3)).body.updatedFrom).toEqual({ delegate: { username: "claude", name: "Claude", kind: "agent" } });
  });

  test("a webhook's deliveries arrive one at a time, in order, even from a slow receiver", async () => {
    const h = await hook("ordered", { resourceTypes: ["Issue"] });
    answers.set("/h/ordered", async () => (await Bun.sleep(80), new Response("ok")));
    const id = await createIssue();
    for (const priority of [1, 2, 3]) await s.api("PATCH", `/api/issues/${id}`, { priority });
    await nth(h, 4);
    expect(h.hits().map((x) => x.body.data.priority)).toEqual([0, 1, 2, 3]);
  });

  test("comments: create, update with the old body, remove; on issues and docs", async () => {
    const h = await hook("comments", { resourceTypes: ["Comment"] });
    const id = await createIssue();
    const cid = (await s.api("POST", `/api/issues/${id}/comments`, { body: "First" })).body.comments[0].id;
    await s.api("PATCH", `/api/issues/${id}/comments/${cid}`, { body: "First!" });
    await s.api("PATCH", `/api/issues/${id}/comments/${cid}`, { body: "First!" }); // unchanged: nothing
    await s.api("DELETE", `/api/issues/${id}/comments/${cid}`);
    await nth(h, 3);
    const [created, updated, removed] = h.hits().map((x) => x.body);
    expect(created).toMatchObject({ action: "create", type: "Comment", data: { id: cid, body: "First", author: { username: "admin" }, issue: id, document: null } });
    expect(created.url).toEndWith(`/acme/issue/${id}`);
    expect(updated).toMatchObject({ action: "update", data: { body: "First!" }, updatedFrom: { body: "First", editedAt: null } });
    expect(removed).toMatchObject({ action: "remove", data: { id: cid, body: "First!" } });
    const doc = (await s.api("POST", "/api/documents", { team: "WHK", title: "Commented doc" })).body.slug;
    await ana.api("POST", `/api/documents/${doc}/comments`, { body: "On the doc" });
    const onDoc = (await nth(h, 4)).body;
    expect(onDoc).toMatchObject({ action: "create", actor: { username: "ana" }, data: { body: "On the doc", issue: null, document: doc } });
    expect(onDoc.url).toEndWith(`/acme/doc/${doc}`);
    await Bun.sleep(100);
    expect(h.hits()).toHaveLength(4);
  });

  test("comment threads: a reply carries its parent; resolving, reopening and a reopening reply are updates with the old resolvedAt", async () => {
    const h = await hook("threads", { resourceTypes: ["Comment"] });
    const id = await createIssue();
    const root = (await s.api("POST", `/api/issues/${id}/comments`, { body: "Q?" })).body.comments[0].id;
    const reply = (await ana.api("POST", `/api/issues/${id}/comments`, { body: "A", parent: root })).body.comments[1].id;
    const first = (await ana.api("PUT", `/api/issues/${id}/comments/${root}/resolved`)).body.comments[0].resolvedAt;
    await s.api("DELETE", `/api/issues/${id}/comments/${root}/resolved`);
    const second = (await ana.api("PUT", `/api/issues/${id}/comments/${root}/resolved`)).body.comments[0].resolvedAt;
    await s.api("PUT", `/api/issues/${id}/comments/${root}/resolved`); // already resolved: nothing
    const more = (await s.api("POST", `/api/issues/${id}/comments`, { body: "More", parent: reply })).body.comments.at(-1).id;
    await nth(h, 7);
    await Bun.sleep(100);
    const got = h.hits().map((x) => x.body);
    expect(got.map((b) => `${b.action} ${b.data.id} ${b.data.parent}`)).toEqual([
      `create ${root} null`,
      `create ${reply} ${root}`,
      `update ${root} null`,
      `update ${root} null`,
      `update ${root} null`,
      `update ${root} null`,
      `create ${more} ${root}`,
    ]);
    expect(got[2]).toMatchObject({ actor: { username: "ana" }, data: { resolvedAt: first, resolvedBy: { username: "ana" } }, updatedFrom: { resolvedAt: null } });
    expect(got[3]).toMatchObject({ actor: { username: "admin" }, data: { resolvedAt: null, resolvedBy: null }, updatedFrom: { resolvedAt: first } });
    expect(got[5]).toMatchObject({ actor: { username: "admin" }, data: { resolvedAt: null }, updatedFrom: { resolvedAt: second } });
  });

  test("docs: no content; updates wait 10 s and merge; trashing sends the held update first", async () => {
    const h = await hook("docs", { resourceTypes: ["Document"] });
    const created = await s.api("POST", "/api/documents", { team: "WHK", title: "Plan", content: "secret plans" });
    const slug = created.body.slug;
    const first = (await nth(h, 1)).body;
    expect(first).toMatchObject({ action: "create", type: "Document", data: { slug, title: "Plan", team: "WHK" } });
    expect(first.url).toEndWith(`/acme/doc/${slug}`);
    expect(first.data.content).toBeUndefined();
    expect(first.data.position).toBe(created.body.position);

    await s.api("PATCH", `/api/documents/${slug}`, { content: "secret plans, v2" });
    await ana.api("PATCH", `/api/documents/${slug}`, { title: "Plan B" });
    await ana.api("PATCH", `/api/documents/${slug}`, { title: "Plan C" });
    const [held] = await h.log();
    expect(held).toMatchObject({ action: "update", status: "pending", attempts: 0 });
    expect(Date.parse(held.nextAttemptAt) - Date.now()).toBeGreaterThan(8000);
    expect((await h.log()).length).toBe(2); // three saves, one delivery
    await Bun.sleep(200);
    expect(h.hits()).toHaveLength(1);

    await ana.api("DELETE", `/api/documents/${slug}`);
    await nth(h, 3);
    const [, update, remove] = h.hits().map((x) => x.body);
    expect(update).toMatchObject({ action: "update", actor: { username: "ana" }, data: { title: "Plan C" } });
    // Older values win: the title and editor before the first of the three saves.
    expect(update.updatedFrom).toEqual({ updatedAt: first.data.updatedAt, title: "Plan", updatedBy: { username: "admin", name: "Admin", kind: "person" } });
    expect(JSON.stringify(update)).not.toContain("secret plans");
    expect(remove).toMatchObject({ action: "remove", data: { slug } });
    expect(remove.data.deletedAt).not.toBeNull();
    await s.api("POST", `/api/documents/${slug}/restore`);
    expect((await nth(h, 4)).body).toMatchObject({ action: "update", data: { deletedAt: null }, updatedFrom: { deletedAt: remove.data.deletedAt } });
  });

  test("delegating to or mentioning an agent sends a Notification; people's notifications never go", async () => {
    const h = await hook("agents", { resourceTypes: ["Notification"] });
    const id = await createIssue({ delegate: "claude", assignee: "ana" });
    const delegated = (await nth(h, 1)).body;
    expect(delegated).toMatchObject({ action: "create", type: "Notification", actor: { username: "admin" } });
    expect(delegated.data).toMatchObject({ kind: "delegated", user: { username: "claude", kind: "agent" }, issue: { id }, workspace: "acme" });
    expect(delegated.url).toEndWith(`/acme/issue/${id}`);

    const other = await createIssue();
    await ana.api("POST", `/api/issues/${other}/comments`, { body: "@claude please look" });
    const mentioned = (await nth(h, 2)).body;
    expect(mentioned.data).toMatchObject({ kind: "mentioned", user: { username: "claude" }, actor: { username: "ana" }, comment: { excerpt: "@claude please look" } });
    // Mentioning ana (a person) sends nothing; mentioning claude again, in a new comment, does.
    const third = await createIssue();
    await s.api("POST", `/api/issues/${third}/comments`, { body: "@ana over to you" });
    await ana.api("POST", `/api/issues/${third}/comments`, { body: "@claude and you" });
    await nth(h, 3);
    // Only Notifications reach it, and only claude's.
    expect(summary(h)).toEqual(["Notification create delegated", "Notification create mentioned", "Notification create mentioned"]);
    expect(h.hits().every((x) => x.body.data.user.username === "claude")).toBe(true);
  });

  test("a workspace's webhooks hear only it; a disabled webhook hears nothing", async () => {
    const acme = await hook("acme-all");
    const side = await hook("side-all", {}, "side");
    const off = await hook("off");
    await s.api("PATCH", `/api/workspaces/acme/webhooks/${off.id}`, { enabled: false });
    const id = await createIssue({ delegate: "claude" });
    await s.api("POST", `/api/issues/${id}/comments`, { body: "@claude hi" });
    await s.api("POST", "/api/documents", { team: "WHK", title: "Acme only" });
    await nth(acme, 5); // issue, delegated, comment, mentioned, doc
    await zed.api("POST", "/api/issues", { team: "SID", title: "Side issue" });
    await nth(side, 1);
    await Bun.sleep(150);
    expect(side.hits().map((x) => [x.body.workspace, x.body.data.id])).toEqual([["side", "SID-1"]]);
    expect(acme.hits().every((x) => x.body.workspace === "acme")).toBe(true);
    expect(JSON.stringify(acme.hits().map((x) => x.body))).not.toContain("SID-1");
    expect(off.hits()).toEqual([]);
    expect(await off.log()).toEqual([]);
  });

  test("rotating the secret: the next delivery verifies only with the new one", async () => {
    const h = await hook("rotate", { resourceTypes: ["Issue"] });
    const { secret } = (await s.api("POST", `/api/workspaces/acme/webhooks/${h.id}/secret`)).body;
    await createIssue();
    const hit = await nth(h, 1);
    const signed = (key: string) => createHmac("sha256", key).update(hit.raw).digest("hex");
    expect(hit.headers.get("docket-signature")).toBe(signed(secret));
    expect(hit.headers.get("docket-signature")).not.toBe(signed(h.secret));
  });
});

describe("failures", () => {
  test("a 500 is retried: 500 then 200 is delivered on attempt 2 with the same delivery id", async () => {
    const h = await hook("flaky", { resourceTypes: ["Issue"] });
    let n = 0;
    answers.set("/h/flaky", () => new Response("no", { status: ++n === 1 ? 500 : 200 }));
    await createIssue();
    await nth(h, 2);
    const [a, b] = h.hits();
    expect(a!.headers.get("docket-delivery")).toBe(b!.headers.get("docket-delivery"));
    expect(b!.body.webhookTimestamp).toBeGreaterThan(a!.body.webhookTimestamp);
    expect(b!.headers.get("docket-signature")).toBe(createHmac("sha256", h.secret).update(b!.raw).digest("hex"));
    const [d] = await until(async () => ((await h.log())[0].status === "delivered" ? h.log() : null));
    expect(d).toMatchObject({ status: "delivered", attempts: 2, responseStatus: 200, error: null });
  });

  test("always 500: failed after 4 attempts on schedule; 10 in a row disable the webhook", async () => {
    const h = await hook("down", { resourceTypes: ["Issue"] });
    answers.set("/h/down", () => new Response("secret stack trace", { status: 500 }));
    await createIssue();
    const [d] = await until(async () => ((await h.log())[0].status === "failed" ? h.log() : null));
    expect(d).toMatchObject({ status: "failed", attempts: 4, responseStatus: 500, error: "HTTP 500", nextAttemptAt: null });
    expect(h.hits()).toHaveLength(4);
    const gaps = h.hits().slice(1).map((x, i) => x.at - h.hits()[i]!.at);
    expect(gaps.every((g) => g >= 45)).toBe(true); // DOCKET_WEBHOOK_RETRY_MS=50,50,50
    expect(JSON.stringify(await h.log())).not.toContain("stack trace");
    expect((await h.get()).failures).toBe(1);

    for (let i = 0; i < 9; i++) await createIssue();
    await until(async () => !(await h.get()).enabled, 8000);
    expect(await h.get()).toMatchObject({ enabled: false, failures: 10 });
    expect((await h.log()).every((x) => x.status === "failed")).toBe(true);
    // Enabling resets the count, and deliveries flow again.
    answers.set("/h/down", () => new Response("ok"));
    expect((await s.api("PATCH", `/api/workspaces/acme/webhooks/${h.id}`, { enabled: true })).body).toMatchObject({ enabled: true, failures: 0 });
    const before = h.hits().length;
    await createIssue();
    await nth(h, before + 1);
  }, 15_000);

  test("success resets the failure count", async () => {
    const h = await hook("recovers", { resourceTypes: ["Issue"] });
    answers.set("/h/recovers", () => new Response("no", { status: 503 }));
    await createIssue();
    await until(async () => (await h.get()).failures === 1);
    answers.set("/h/recovers", () => new Response(null, { status: 204 }));
    await createIssue();
    await until(async () => (await h.log())[0].status === "delivered");
    expect((await h.get()).failures).toBe(0);
  });

  test("a slow receiver times out and a redirect isn't followed: both count as failures", async () => {
    const slow = await hook("slow", { resourceTypes: ["Issue"] });
    answers.set("/h/slow", async () => (await Bun.sleep(800), new Response("late")));
    const moved = await hook("moved", { resourceTypes: ["Issue"] });
    answers.set("/h/moved", () => new Response(null, { status: 302, headers: { Location: `${base}/h/elsewhere` } }));
    await createIssue();
    const [late] = await until(async () => ((await slow.log())[0].attempts >= 1 ? slow.log() : null));
    expect(late).toMatchObject({ status: "pending", error: "timeout after 0.3 s", responseStatus: null });
    const [redirected] = await until(async () => ((await moved.log())[0].attempts >= 1 ? moved.log() : null));
    expect(redirected).toMatchObject({ error: "HTTP 302", responseStatus: 302 });
    await Bun.sleep(100);
    expect(hits.filter((x) => x.path === "/h/elsewhere")).toEqual([]);
  });
});

describe("targets without DOCKET_WEBHOOK_ALLOW_PRIVATE", () => {
  let strict: TestServer;
  beforeAll(async () => {
    strict = await startServer({ env: { DOCKET_WEBHOOK_RETRY_MS: "50,50,50" } });
  });
  afterAll(() => strict.stop());

  test("private, loopback, link-local, metadata and credentialed URLs, and plain http, are refused", async () => {
    const refused = {
      "http://127.0.0.1:1/": "only https URLs are allowed",
      "http://93.184.215.14/": "only https URLs are allowed",
      "ftp://93.184.215.14/": "only https URLs are allowed",
      "https://user:pw@example.com/": "no user or password in the URL",
      "https://127.1/": "127.0.0.1 is private",
      "https://0x7f000001/": "127.0.0.1 is private",
      "https://2130706433/": "127.0.0.1 is private",
      "https://localhost/": "is private",
      "https://[::1]/": "::1 is private",
      "https://[::]/": ":: is private",
      "https://[::ffff:127.0.0.1]/": "is private",
      "https://[::ffff:169.254.169.254]/": "is private",
      "https://[64:ff9b::a00:1]/": "is private",
      "https://[fe80::1]/": "is private",
      "https://[fd00::1]/": "is private",
      "https://[ff02::1]/": "is private",
      "https://169.254.169.254/latest/meta-data/": "169.254.169.254 is private",
      "https://10.0.0.1/": "10.0.0.1 is private",
      "https://172.16.5.4/": "172.16.5.4 is private",
      "https://192.168.1.1/": "192.168.1.1 is private",
      "https://100.64.0.1/": "100.64.0.1 is private",
      "https://0.0.0.0/": "0.0.0.0 is private",
      "https://198.18.0.1/": "198.18.0.1 is private",
      "https://224.0.0.1/": "224.0.0.1 is private",
      "https://255.255.255.255/": "255.255.255.255 is private",
      "not a url": "not a valid URL",
    };
    for (const [url, why] of Object.entries(refused)) {
      const res = await strict.api("POST", "/api/workspaces/acme/webhooks", { url });
      expect([url, res.status]).toEqual([url, 400]);
      expect(res.body.error).toContain("Webhook URL refused: ");
      expect(res.body.error).toContain(why);
    }
    // Public addresses (literals, so the test needs no DNS) are fine, and so is edits' check.
    for (const url of ["https://93.184.215.14/hook", "https://[2606:4700:4700::1111]/", "https://[::ffff:8.8.8.8]/", "https://172.32.0.1/"]) {
      const res = await strict.api("POST", "/api/workspaces/acme/webhooks", { url, resourceTypes: ["Document"] });
      expect([url, res.status]).toEqual([url, 201]);
      expect((await strict.api("PATCH", `/api/workspaces/acme/webhooks/${res.body.webhook.id}`, { url: "https://10.1.2.3/" })).status).toBe(400);
      await strict.api("DELETE", `/api/workspaces/acme/webhooks/${res.body.webhook.id}`);
    }
  });

  test("the target is checked again before every attempt: a private one is blocked, never contacted", async () => {
    const res = await strict.api("POST", "/api/workspaces/acme/webhooks", { url: "https://93.184.215.14/", resourceTypes: ["Issue"] });
    const id = res.body.webhook.id;
    // As if its DNS now answered with a private address (the database is the only way to get one past the save check).
    const db = new Database(strict.databasePath);
    db.run("UPDATE webhooks SET url = ? WHERE id = ?", [`${base}/h/rebound`, id]);
    db.close();
    await strict.api("POST", "/api/teams", { key: "STR", name: "Strict" });
    await strict.api("POST", "/api/issues", { team: "STR", title: "Blocked" });
    const log = async () => (await strict.api("GET", `/api/workspaces/acme/webhooks/${id}/deliveries`)).body;
    const [d] = await until(async () => ((await log())[0]?.status === "failed" ? log() : null));
    expect(d).toMatchObject({ status: "failed", attempts: 4, responseStatus: null, error: "blocked: only https URLs are allowed" });
    const db2 = new Database(strict.databasePath);
    db2.run("UPDATE webhooks SET url = ? WHERE id = ?", ["https://127.0.0.1:1/", id]);
    db2.close();
    await strict.api("POST", "/api/issues", { team: "STR", title: "Blocked again" });
    const [e] = await until(async () => ((await log())[0]?.status === "failed" && (await log()).length === 2 ? log() : null));
    expect(e.error).toBe("blocked: 127.0.0.1 is private");
    expect(hits.filter((x) => x.path === "/h/rebound")).toEqual([]);
  });
});

test("the delivery log keeps 7 days: older deliveries are purged at startup (and hourly)", async () => {
  const h = await hook("kept", { resourceTypes: ["Issue"] });
  await createIssue();
  await nth(h, 1);
  const db = new Database(s.databasePath);
  db.run("UPDATE webhook_deliveries SET created_at = ? WHERE webhook_id = ?", [new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), h.id]);
  db.close();
  await createIssue();
  await nth(h, 2);
  const restarted = await startServer({ sharing: s });
  await restarted.stop();
  expect((await h.log()).length).toBe(1);
  // Every delivery went to a webhook of the change's own workspace.
  expect(sql("SELECT COUNT(*) AS n FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE json_extract(d.payload, '$.workspace') != w.workspace")[0].n).toBe(0);
});

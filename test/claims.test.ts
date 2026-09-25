import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type TestServer } from "./server.ts";

const ROOT = "root-token";
let s: TestServer;
let alpha: string; // agent tokens
let beta: string;

/** A request as whoever holds `token`. */
async function as(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(new URL(path, s.url), {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Calls an MCP tool as whoever holds `token`; resolves to its text, or rejects with the tool error. */
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: "docket-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", s.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  try {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content.map((c) => c.text).join("\n");
    if (r.isError) throw new Error(text);
    return text;
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  s = await startServer({ env: { DOCKET_TOKEN: ROOT } });
  await s.api("POST", "/api/workspaces", { key: "acme", name: "Acme" });
  await s.api("POST", "/api/projects", { key: "CLM", workspace: "acme", name: "Claims" });
  for (const title of ["Race me", "Done already", "Root's", "Versioned", "Mine"]) {
    await s.api("POST", "/api/issues", { project: "CLM", title });
  }
  await s.api("PATCH", "/api/issues/CLM-2", { status: "done" });
  await s.api("POST", "/api/issues", { project: "CLM", title: "Legacy", assignee: "old-bot" }); // CLM-6, free text
  alpha = (await s.api("POST", "/api/members", { name: "alpha", kind: "agent" })).body.token;
  beta = (await s.api("POST", "/api/members", { name: "beta", kind: "agent" })).body.token;
});
afterAll(() => s.stop());

test("two agents racing for one issue: exactly one gets it", async () => {
  const results = await Promise.allSettled([
    tool(alpha, "claim_issue", { id: "CLM-1" }),
    tool(beta, "claim_issue", { id: "CLM-1" }),
  ]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  const { body } = await s.api("GET", "/api/issues/CLM-1");
  expect(body.status).toBe("in_progress");
  expect(lost[0]!.reason.message).toBe(`CLM-1 is claimed by ${body.assignee}`);
});

test("claiming your own again is fine; a closed issue can't be claimed", async () => {
  const holder = (await s.api("GET", "/api/issues/CLM-1")).body.assignee;
  const token = holder === "alpha" ? alpha : beta;
  const before = (await s.api("GET", "/api/issues/CLM-1")).body.updatedAt;
  expect(await tool(token, "claim_issue", { id: "clm-1", assignee: "someone-else" })).toStartWith("Claimed CLM-1");
  expect((await s.api("GET", "/api/issues/CLM-1")).body.updatedAt).toBe(before); // a no-op, not a bump

  expect(await as(alpha, "POST", "/api/issues/CLM-2/claim", {})).toMatchObject({ status: 409, body: { error: "CLM-2 is done" } });
});

test("root claims only for someone it names, and they must be a member", async () => {
  expect((await s.api("POST", "/api/issues/CLM-3/claim", {})).status).toBe(400);
  expect((await s.api("POST", "/api/issues/CLM-3/claim", { assignee: "me" })).body.error).toBe('"me" needs a member token');
  expect((await s.api("POST", "/api/issues/CLM-3/claim", { assignee: "nobody" })).status).toBe(400);
  const claimed = await s.api("POST", "/api/issues/CLM-3/claim", { assignee: "BETA" });
  expect(claimed.body).toMatchObject({ assignee: "beta", status: "in_progress" });
});

test('"me" means the caller in filters and assignments', async () => {
  expect((await as(alpha, "PATCH", "/api/issues/CLM-5", { assignee: "me" })).body.assignee).toBe("alpha");
  const mine = await as(alpha, "GET", "/api/issues?assignee=me");
  expect(mine.body.map((i: any) => i.id)).toContain("CLM-5");
  expect(mine.body.every((i: any) => i.assignee === "alpha")).toBeTrue();
  expect(await tool(alpha, "list_issues", { assignee: "me" })).toContain("CLM-5");
  expect((await s.api("GET", "/api/issues?assignee=me")).status).toBe(400);
  expect((await s.api("GET", "/api/issues?assignee=ALPHA")).body.map((i: any) => i.id)).toContain("CLM-5");
});

test("baseUpdatedAt refuses a patch when the issue changed since it was read", async () => {
  const read = (await s.api("GET", "/api/issues/CLM-4")).body;
  // Someone else comments in the meantime, which bumps the issue.
  await as(beta, "POST", "/api/issues/CLM-4/comments", { body: "note" });
  const stale = await as(alpha, "PATCH", "/api/issues/CLM-4", { labels: ["x"], baseUpdatedAt: read.updatedAt });
  expect(stale).toMatchObject({ status: 409, body: { error: "Issue changed since you read it" } });
  expect((await s.api("GET", "/api/issues/CLM-4")).body.labels).toEqual([]);

  const fresh = (await s.api("GET", "/api/issues/CLM-4")).body.updatedAt;
  expect((await as(alpha, "PATCH", "/api/issues/CLM-4", { labels: ["x"], baseUpdatedAt: fresh })).body.labels).toEqual(["x"]);
  await expect(tool(alpha, "update_issue", { id: "CLM-4", title: "t", baseUpdatedAt: fresh })).rejects.toThrow("changed since");
});

test("updated_at strictly increases, even for writes within a millisecond", async () => {
  const seen: string[] = [];
  for (let i = 0; i < 15; i++) seen.push((await s.api("PATCH", "/api/issues/CLM-4", { priority: (i % 4) + 1 })).body.updatedAt);
  for (let i = 0; i < 5; i++) seen.push((await s.api("POST", "/api/issues/CLM-4/comments", { body: `c${i}` })).body.updatedAt);
  expect([...seen].sort()).toEqual(seen);
  expect(new Set(seen).size).toBe(seen.length);
});

test("creating an issue bumps and publishes its parent and blockers", async () => {
  const parent = (await s.api("POST", "/api/issues", { project: "CLM", title: "Parent" })).body;
  const blocker = (await s.api("POST", "/api/issues", { project: "CLM", title: "Blocker" })).body;
  const events: string[] = [];
  const ws = new WebSocket(s.url.replace(/^http/, "ws") + "ws", { headers: { Authorization: `Bearer ${ROOT}` } } as any);
  await new Promise((resolve) => (ws.onopen = resolve));
  ws.onmessage = (e) => events.push(JSON.parse(String(e.data)).id);
  const child = (await s.api("POST", "/api/issues", { project: "CLM", title: "Child", parent: parent.id, blockedBy: [blocker.id] })).body;
  // Wait for the events rather than a fixed time, so a busy machine can't make this flaky.
  const want = [child.id, parent.id, blocker.id];
  for (let t = 0; t < 200 && !want.every((id) => events.includes(id)); t++) await Bun.sleep(10);
  ws.close();
  expect(events).toEqual(expect.arrayContaining(want));
  expect((await s.api("GET", `/api/issues/${parent.id}`)).body.updatedAt > parent.updatedAt).toBeTrue();
  expect((await s.api("GET", `/api/issues/${blocker.id}`)).body.updatedAt > blocker.updatedAt).toBeTrue();
});

test("an issue held by a revoked member or leftover free text can be claimed", async () => {
  const gamma = (await s.api("POST", "/api/members", { name: "gamma", kind: "agent" })).body.token;
  const held = (await s.api("POST", "/api/issues", { project: "CLM", title: "Held" })).body;
  await tool(gamma, "claim_issue", { id: held.id });
  await expect(tool(alpha, "claim_issue", { id: held.id })).rejects.toThrow("claimed by gamma");
  await s.api("DELETE", "/api/members/gamma");
  expect(await tool(alpha, "claim_issue", { id: held.id })).toStartWith(`Claimed ${held.id}`);
  // Free text from before members existed doesn't hold a claim either.
  expect(await tool(alpha, "claim_issue", { id: "CLM-6" })).toStartWith("Claimed CLM-6");
});

// Claims and issue versions under pressure: two server processes on one database (so the races go through
// SQLite's locks, not just one JS thread), every issue bump path, and "me" on every route that takes it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type TestServer } from "./server.ts";

const ROOT = "claims-hardening-root";
const N = 20;

async function as(s: TestServer, token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(new URL(path, s.url), {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function mcpTool(s: TestServer, token: string, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: "claims-hardening", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", s.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  try {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, text: r.content.map((c) => c.text).join("\n") };
  } finally {
    await client.close();
  }
}

describe("two server processes on one database", () => {
  let a: TestServer;
  let b: TestServer;
  let alpha: string;
  let beta: string;
  beforeAll(async () => {
    a = await startServer({ env: { DOCKET_TOKEN: ROOT } });
    b = await startServer({ databasePath: join(a.dir, "docket.db"), env: { DOCKET_TOKEN: ROOT } });
    alpha = (await a.api("POST", "/api/members", { name: "alpha", kind: "agent" })).body.token;
    beta = (await a.api("POST", "/api/members", { name: "beta", kind: "agent" })).body.token;
    await a.api("POST", "/api/workspaces", { key: "race", name: "Race" });
    await a.api("POST", "/api/projects", { key: "RACE", workspace: "race", name: "Race" });
    for (let i = 0; i < N + 1; i++) await a.api("POST", "/api/issues", { project: "RACE", title: `Issue ${i + 1}` });
  });
  afterAll(async () => {
    await b.stop();
    await a.stop();
  });

  test("of two claims racing across processes, exactly one wins every issue", async () => {
    const ids = Array.from({ length: N }, (_, i) => `RACE-${i + 1}`);
    const results = await Promise.all(
      ids.flatMap((id) => [
        as(a, alpha, "POST", `/api/issues/${id}/claim`, {}).then((r) => ({ id, who: "alpha", ...r })),
        as(b, beta, "POST", `/api/issues/${id}/claim`, {}).then((r) => ({ id, who: "beta", ...r })),
      ]),
    );
    for (const id of ids) {
      const pair = results.filter((r) => r.id === id);
      const won = pair.filter((r) => r.status === 200);
      const lost = pair.filter((r) => r.status === 409);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]!.body.error).toBe(`${id} is claimed by ${won[0]!.who}`);
      const { body } = await b.api("GET", `/api/issues/${id}`);
      expect(body).toMatchObject({ assignee: won[0]!.who, status: "in_progress" });
    }
  });

  test("of many writers from one base across processes, exactly one wins", async () => {
    const id = `RACE-${N + 1}`;
    const base = (await a.api("GET", `/api/issues/${id}`)).body.updatedAt;
    const saves = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).api("PATCH", `/api/issues/${id}`, { title: `edit ${i}`, baseUpdatedAt: base }),
      ),
    );
    expect(saves.filter((r) => r.status === 200)).toHaveLength(1);
    expect(saves.filter((r) => r.status === 409)).toHaveLength(19);
  });
});

describe("every issue bump path moves the version", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer();
    await s.api("POST", "/api/workspaces", { key: "v", name: "V" });
    await s.api("POST", "/api/projects", { key: "VER", workspace: "v", name: "Ver" });
    await s.api("POST", "/api/issues", { project: "VER", title: "Parent" }); // VER-1
    await s.api("POST", "/api/issues", { project: "VER", title: "Blocker" }); // VER-2
  });
  afterAll(() => s.stop());

  const version = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body.updatedAt as string;

  /** Runs `change`, then checks each issue's version moved and a patch from the old version is refused. */
  async function bumps(ids: string[], change: () => Promise<unknown>) {
    const before = await Promise.all(ids.map(version));
    await change();
    for (const [i, id] of ids.entries()) {
      expect((await version(id)) > before[i]!).toBeTrue();
      expect((await s.api("PATCH", `/api/issues/${id}`, { title: "stale", baseUpdatedAt: before[i] })).status).toBe(409);
    }
  }

  test("setting a parent and a blocker bumps them", async () => {
    await s.api("POST", "/api/issues", { project: "VER", title: "Child" }); // VER-3
    await bumps(["VER-1", "VER-2"], () => s.api("PATCH", "/api/issues/VER-3", { parent: "VER-1", blockedBy: ["VER-2"] }));
  });

  test("comment added, edited and deleted each bump the issue", async () => {
    let cid = 0;
    await bumps(["VER-3"], async () => {
      const { body } = await s.api("POST", "/api/issues/VER-3/comments", { body: "a", author: "me-too" });
      cid = body.comments.at(-1).id;
    });
    await bumps(["VER-3"], () => s.api("PATCH", `/api/issues/VER-3/comments/${cid}`, { body: "b", author: "me-too" }));
    await bumps(["VER-3"], () => s.api("DELETE", `/api/issues/VER-3/comments/${cid}`, { author: "me-too" }));
  });

  test("deleting an issue bumps its parent and its blocker", async () => {
    await bumps(["VER-1", "VER-2"], () => s.api("DELETE", "/api/issues/VER-3"));
  });
});

describe('"me" without a member token', () => {
  let s: TestServer;
  let member: string;
  beforeAll(async () => {
    s = await startServer({ env: { DOCKET_TOKEN: ROOT } });
    member = (await s.api("POST", "/api/members", { name: "gamma", kind: "agent" })).body.token;
    await s.api("POST", "/api/workspaces", { key: "m", name: "M" });
    await s.api("POST", "/api/projects", { key: "ME", workspace: "m", name: "Me" });
    await s.api("POST", "/api/issues", { project: "ME", title: "One" });
  });
  afterAll(() => s.stop());

  test("root gets a 400 on every REST route, and nothing changes", async () => {
    expect((await s.api("POST", "/api/issues", { project: "ME", title: "x", assignee: "me" })).status).toBe(400);
    expect((await s.api("POST", "/api/issues", { project: "ME", title: "x", assignee: " ME " })).status).toBe(400);
    expect((await s.api("PATCH", "/api/issues/ME-1", { assignee: "me" })).status).toBe(400);
    const { body } = await s.api("GET", "/api/issues?project=ME");
    expect(body.map((i: any) => [i.id, i.assignee])).toEqual([["ME-1", null]]);
  });

  test("root gets an error from every MCP tool, and a member doesn't", async () => {
    for (const [name, args] of [
      ["create_issue", { project: "ME", title: "x", assignee: "me" }],
      ["update_issue", { id: "ME-1", assignee: "me" }],
      ["list_issues", { assignee: "me" }],
      ["claim_issue", { id: "ME-1", assignee: "me" }],
    ] as const) {
      expect((await mcpTool(s, ROOT, name, args)).isError).toBeTrue();
    }
    expect((await mcpTool(s, member, "create_issue", { project: "ME", title: "mine", assignee: "me" })).text).toContain("@gamma");
  });
});

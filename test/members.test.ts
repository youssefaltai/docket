import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type TestServer } from "./server.ts";

/** A request as whoever holds `token` (or no one). */
async function as(s: TestServer, token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(new URL(path, s.url), {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, res };
}

/** An MCP client connected with `token`; returns a tool caller and a closer. */
async function mcpAs(s: TestServer, token: string) {
  const client = new Client({ name: "docket-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", s.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return {
    client,
    async tool(name: string, args: Record<string, unknown> = {}) {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = r.content.map((c) => c.text).join("\n");
      if (r.isError) throw new Error(text);
      return text;
    },
  };
}

describe("with DOCKET_TOKEN", () => {
  const ROOT = "root-token";
  let s: TestServer;
  let ana: string; // human admin
  let bot: string; // agent member
  beforeAll(async () => {
    s = await startServer({ env: { DOCKET_TOKEN: ROOT } });
    await s.api("POST", "/api/workspaces", { key: "acme", name: "Acme" });
    await s.api("POST", "/api/projects", { key: "IDN", workspace: "acme", name: "Identity" });
    await s.api("POST", "/api/issues", { project: "IDN", title: "Before members", assignee: "whoever" });
  });
  afterAll(() => s.stop());

  test("root is an admin with no name, and creates members with one-time tokens", async () => {
    expect((await s.api("GET", "/api/me")).body).toEqual({ member: null, admin: true, open: false });
    expect((await s.api("GET", "/api/members")).body).toEqual([]);

    const created = await s.api("POST", "/api/members", { name: "Ana", kind: "human", role: "admin" });
    expect(created.status).toBe(201);
    expect(created.body.member).toMatchObject({ name: "Ana", kind: "human", role: "admin", revokedAt: null });
    expect(created.body.token).toMatch(/^[0-9a-f]{64}$/);
    ana = created.body.token;
    bot = (await s.api("POST", "/api/members", { name: "claude-a", kind: "agent" })).body.token;

    expect((await s.api("GET", "/api/members")).body.map((m: any) => m.name)).toEqual(["Ana", "claude-a"]);
    expect(JSON.stringify((await s.api("GET", "/api/members")).body)).not.toContain(ana);
  });

  test("member input is validated", async () => {
    expect((await s.api("POST", "/api/members", { name: "ana", kind: "human" })).status).toBe(409);
    expect((await s.api("POST", "/api/members", { name: "me", kind: "human" })).status).toBe(400);
    expect((await s.api("POST", "/api/members", { name: "Anonymous", kind: "agent" })).status).toBe(400);
    expect((await s.api("POST", "/api/members", { name: "x", kind: "robot" })).status).toBe(400);
    expect((await s.api("POST", "/api/members", { name: "x", kind: "agent", role: "owner" })).status).toBe(400);
    expect((await s.api("POST", "/api/members", { name: "a\nb", kind: "agent" })).status).toBe(400);
  });

  test("a member token works as a bearer and says who you are", async () => {
    expect((await as(s, bot, "GET", "/api/me")).body).toMatchObject({ member: { name: "claude-a", role: "member" }, admin: false });
    expect((await as(s, "nope", "GET", "/api/me")).status).toBe(401);
    expect((await as(s, null, "GET", "/api/me")).status).toBe(401);
  });

  test("only admins manage members", async () => {
    expect((await as(s, bot, "POST", "/api/members", { name: "sneaky", kind: "agent" })).status).toBe(403);
    expect((await as(s, bot, "PATCH", "/api/members/claude-a", { role: "admin" })).status).toBe(403);
    expect((await as(s, bot, "POST", "/api/members/Ana/token")).status).toBe(403);
    expect((await as(s, bot, "DELETE", "/api/members/Ana")).status).toBe(403);
    // A member admin can.
    const made = await as(s, ana, "POST", "/api/members", { name: "Ben Ali", kind: "human" });
    expect(made.status).toBe(201);
    expect((await as(s, ana, "PATCH", `/api/members/${encodeURIComponent("ben ali")}`, { role: "admin" })).body.role).toBe("admin");
  });

  test("members always write as themselves; root still names itself", async () => {
    const byBot = await as(s, bot, "POST", "/api/issues/IDN-1/comments", { body: "From the bot", author: "Ana" });
    expect(byBot.body.comments.at(-1).author).toBe("claude-a");
    const byRoot = await s.api("POST", "/api/issues/IDN-1/comments", { body: "From root", author: "someone" });
    expect(byRoot.body.comments.at(-1).author).toBe("someone");

    const doc = await as(s, bot, "POST", "/api/documents", { project: "IDN", title: "Spec", content: "x", author: "Ana" });
    expect(doc.body.updatedBy).toBe("claude-a");
  });

  test("the comment author guard follows the token, not the claimed name", async () => {
    const posted = await as(s, ana, "POST", "/api/issues/IDN-1/comments", { body: "Ana's note" });
    const id = posted.body.comments.at(-1).id;
    // The bot can't pass itself off as Ana.
    expect((await as(s, bot, "PATCH", `/api/issues/IDN-1/comments/${id}`, { body: "hijack", author: "Ana" })).status).toBe(403);
    expect((await as(s, bot, "DELETE", `/api/issues/IDN-1/comments/${id}`, { author: "Ana" })).status).toBe(403);
    expect((await as(s, ana, "PATCH", `/api/issues/IDN-1/comments/${id}`, { body: "Ana's edited note" })).status).toBe(200);
  });

  test("once members exist, new assignees must be members; old ones stay", async () => {
    const bad = await s.api("PATCH", "/api/issues/IDN-1", { assignee: "whoever" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("Members: Ana, Ben Ali, claude-a");
    expect((await s.api("GET", "/api/issues/IDN-1")).body.assignee).toBe("whoever");
    expect((await s.api("PATCH", "/api/issues/IDN-1", { assignee: "CLAUDE-A" })).body.assignee).toBe("claude-a");
    expect((await s.api("PATCH", "/api/issues/IDN-1", { title: "Renamed" })).status).toBe(200);
  });

  test("login with a member token sets a cookie tied to that token", async () => {
    const login = await as(s, null, "POST", "/api/login", { token: bot });
    const cookie = login.res.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).not.toContain(bot);
    expect((await as(s, null, "GET", "/api/me", undefined, { Cookie: cookie })).body.member.name).toBe("claude-a");
    // A forged id prefix doesn't carry over to another member.
    const forged = cookie.replace(/=(\d+)\./, (_, id) => `=${Number(id) - 1}.`);
    expect((await as(s, null, "GET", "/api/me", undefined, { Cookie: forged })).status).toBe(401);
    // The root cookie is unchanged: still an HMAC of DOCKET_TOKEN alone.
    const rootLogin = await as(s, null, "POST", "/api/login", { token: ROOT });
    const rootCookie = rootLogin.res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await as(s, null, "GET", "/api/me", undefined, { Cookie: rootCookie })).body).toEqual({ member: null, admin: true, open: false });

    // Rotating signs out the old token and cookie.
    const rotated = await s.api("POST", "/api/members/claude-a/token");
    expect((await as(s, bot, "GET", "/api/me")).status).toBe(401);
    expect((await as(s, null, "GET", "/api/me", undefined, { Cookie: cookie })).status).toBe(401);
    bot = rotated.body.token;
    expect((await as(s, bot, "GET", "/api/me")).status).toBe(200);
  });

  test("logout clears the cookie, with the same Host and JSON checks as login", async () => {
    const out = await as(s, null, "POST", "/api/logout", {});
    expect(out.status).toBe(200);
    expect(out.res.headers.get("set-cookie")).toMatch(/^docket_token=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
    expect((await as(s, null, "POST", "/api/logout", undefined, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await as(s, null, "POST", "/api/logout", {}, { Host: "evil.example" })).status).toBe(403);
  });

  test("revoking signs a member out but keeps the name reserved; rotating reinstates", async () => {
    const revoked = await s.api("DELETE", "/api/members/Ben%20Ali");
    expect(revoked.body.revokedAt).toBeString();
    expect((await s.api("POST", "/api/members", { name: "ben ali", kind: "human" })).status).toBe(409);
    expect((await s.api("PATCH", "/api/issues/IDN-1", { assignee: "Ben Ali" })).status).toBe(400);
    const back = await s.api("POST", "/api/members/Ben%20Ali/token");
    expect(back.body.member.revokedAt).toBeNull();
    expect((await as(s, back.body.token, "GET", "/api/me")).body.member.name).toBe("Ben Ali");
  });

  test("names compare Unicode-aware, the same way everywhere", async () => {
    const { token } = (await s.api("POST", "/api/members", { name: "Émile", kind: "human" })).body;
    expect((await s.api("POST", "/api/members", { name: "émile", kind: "human" })).status).toBe(409);
    expect((await s.api("POST", "/api/members", { name: "ÉMILE", kind: "agent" })).status).toBe(409);
    expect((await s.api("PATCH", `/api/members/${encodeURIComponent("émile")}`, { role: "member" })).body.name).toBe("Émile");
    expect((await s.api("PATCH", "/api/issues/IDN-1", { assignee: "émile" })).body.assignee).toBe("Émile");

    const posted = await as(s, token, "POST", "/api/issues/IDN-1/comments", { body: "Bonjour" });
    const id = posted.body.comments.at(-1).id;
    // Root naming itself "émile" matches Émile's comments, just like the uniqueness rule.
    expect((await s.api("PATCH", `/api/issues/IDN-1/comments/${id}`, { body: "Salut", author: "émile" })).status).toBe(200);
  });

  test("revoking or rotating closes that member's live sockets, not others", async () => {
    const { token } = (await s.api("POST", "/api/members", { name: "socket-bot", kind: "agent" })).body;
    const open = (headers: Record<string, string>) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(s.url.replace(/^http/, "ws") + "ws", { headers } as any);
        ws.onopen = () => resolve(ws);
        ws.onerror = reject;
      });
    const closed = (ws: WebSocket) => new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));

    const bots = await Promise.all([open({ Authorization: `Bearer ${token}` }), open({ Authorization: `Bearer ${token}` })]);
    const root = await open({ Authorization: "Bearer root-token" });
    const codes = Promise.all(bots.map(closed));
    await s.api("DELETE", "/api/members/socket-bot");
    expect(await codes).toEqual([4401, 4401]);
    expect(root.readyState).toBe(WebSocket.OPEN);

    const fresh = (await s.api("POST", "/api/members/socket-bot/token")).body.token;
    const again = await open({ Authorization: `Bearer ${fresh}` });
    const code = closed(again);
    await s.api("POST", "/api/members/socket-bot/token");
    expect(await code).toBe(4401);
    root.close();
  });

  test("MCP: an agent acts as its member and can't mint credentials", async () => {
    const agent = await mcpAs(s, bot);
    const tools = (await agent.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("list_members");
    expect(tools.filter((t) => /member/.test(t))).toEqual(["list_members"]);

    expect(await agent.tool("list_members")).toContain("claude-a · agent · member · you");
    await agent.tool("comment_issue", { id: "IDN-1", body: "Via MCP", author: "Ana" });
    expect(await agent.tool("get_issue", { id: "IDN-1" })).toMatch(/\*\*claude-a\*\* · #\d+ · \S+\nVia MCP/);

    const anaNote = (await s.api("GET", "/api/issues/IDN-1")).body.comments.find((c: any) => c.author === "Ana").id;
    await expect(agent.tool("update_comment", { issue: "IDN-1", comment: anaNote, body: "x", author: "Ana" })).rejects.toThrow("Only Ana");
    await agent.client.close();

    // Root over MCP keeps the old default.
    await s.tool("comment_issue", { id: "IDN-1", body: "Root agent" });
    expect((await s.api("GET", "/api/issues/IDN-1")).body.comments.at(-1).author).toBe("claude");
  });
});

describe("open mode (no DOCKET_TOKEN)", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(() => s.stop());

  test("anyone is root; a member token only says who you are", async () => {
    expect((await as(s, null, "GET", "/api/me")).body).toEqual({ member: null, admin: true, open: true });
    // With no members yet, a stray bearer is ignored, as before members existed.
    expect((await as(s, "stale-or-random", "GET", "/api/me")).status).toBe(200);
    const { token } = (await as(s, null, "POST", "/api/members", { name: "claude-b", kind: "agent" })).body;
    expect((await as(s, token, "GET", "/api/me")).body.member.name).toBe("claude-b");
    // Once members exist, a wrong or revoked token is refused rather than becoming root.
    expect((await as(s, "stale-or-random", "GET", "/api/me")).status).toBe(401);
    await as(s, null, "DELETE", "/api/members/claude-b");
    expect((await as(s, token, "GET", "/api/me")).status).toBe(401);
    expect((await as(s, null, "GET", "/api/me")).status).toBe(200);
    const back = (await as(s, null, "POST", "/api/members/claude-b/token")).body.token;

    const login = await as(s, null, "POST", "/api/login", { token: back });
    const cookie = login.res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await as(s, null, "GET", "/api/me", undefined, { Cookie: cookie })).body.member.name).toBe("claude-b");
    // Logins that aren't a member token are refused now too, revoked ones included.
    expect((await as(s, null, "POST", "/api/login", { token: "anything" })).status).toBe(401);
    await as(s, null, "DELETE", "/api/members/claude-b");
    expect((await as(s, null, "POST", "/api/login", { token: back })).status).toBe(401);
    // The revoked member's cookie is refused and cleared, rather than quietly becoming root.
    const stale = await as(s, null, "GET", "/api/me", undefined, { Cookie: cookie });
    expect(stale.status).toBe(401);
    expect(stale.res.headers.get("set-cookie")).toMatch(/^docket_token=; .*Max-Age=0/);
    // A leftover root-style cookie (open mode never sets one) is still ignored.
    expect((await as(s, null, "GET", "/api/me", undefined, { Cookie: "docket_token=abc123" })).status).toBe(200);
  });

  test("with no members, stray logins still answer ok without a cookie", async () => {
    const fresh = await startServer();
    try {
      const res = await as(fresh, null, "POST", "/api/login", { token: "anything" });
      expect(res.status).toBe(200);
      expect(res.res.headers.get("set-cookie")).toBeNull();
    } finally {
      await fresh.stop();
    }
  });
});

// Hardening checks for member identity: forged or stale credentials, author spoofing, admin-only
// surfaces, credential leaks, and the behaviour older no-token and DOCKET_TOKEN-only setups rely on.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type TestServer } from "./server.ts";

const ROOT = "root-token-for-security-tests";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function as(s: TestServer, auth: { bearer?: string; cookie?: string }, method: string, path: string, body?: unknown) {
  const res = await fetch(new URL(path, s.url), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {}),
      ...(auth.cookie ? { Cookie: auth.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, res };
}

async function login(s: TestServer, token: string) {
  const res = await as(s, {}, "POST", "/api/login", { token });
  return { status: res.status, cookie: res.res.headers.get("set-cookie")?.split(";")[0] };
}

async function mcp(s: TestServer, bearer: string) {
  const client = new Client({ name: "docket-security-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", s.url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }),
  );
  return client;
}

/** Resolves to "open" or the close code, whichever the WebSocket reaches first. */
function ws(s: TestServer, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(new URL("/ws", s.url.replace(/^http/, "ws")), { headers } as never);
    socket.onopen = () => {
      socket.close();
      resolve("open");
    };
    socket.onerror = () => resolve("error");
  });
}

describe("with DOCKET_TOKEN", () => {
  let s: TestServer;
  let agent: string; // role member
  let admin: string; // role admin
  beforeAll(async () => {
    s = await startServer({ env: { DOCKET_TOKEN: ROOT } });
    agent = (await s.api("POST", "/api/members", { name: "bot", kind: "agent" })).body.token;
    admin = (await s.api("POST", "/api/members", { name: "Ana", kind: "human", role: "admin" })).body.token;
    await s.api("POST", "/api/workspaces", { key: "sec", name: "Sec" });
    await s.api("POST", "/api/projects", { key: "SEC", workspace: "sec", name: "Sec" });
    await s.api("POST", "/api/issues", { project: "SEC", title: "Target" });
    await s.api("POST", "/api/documents", { project: "SEC", title: "Spec" });
  });
  afterAll(() => s.stop());

  test("malformed or forged cookies are a clean 401", async () => {
    const { cookie } = await login(s, agent);
    const hmac = cookie!.split(".")[1];
    for (const value of ["abc", "NaN.x", "1.", ".", "-1.x", "99999999999999999999.x", `1e0.${hmac}`, `01.${hmac}`, `${hmac}`]) {
      expect((await as(s, { cookie: `docket_token=${value}` }, "GET", "/api/me")).status).toBe(401);
    }
  });

  test("a member cookie never passes as the root cookie, and vice versa", async () => {
    const member = (await login(s, agent)).cookie!;
    const root = (await login(s, ROOT)).cookie!;
    expect((await as(s, { cookie: member }, "GET", "/api/me")).body.member.name).toBe("bot");
    expect((await as(s, { cookie: root }, "GET", "/api/me")).body).toEqual({ member: null, admin: true, open: false });
    // Pasting the root session HMAC behind a member id doesn't make a member session.
    const spliced = `docket_token=1.${root.split("=")[1]}`;
    expect((await as(s, { cookie: spliced }, "GET", "/api/me")).status).toBe(401);
  });

  test("a plain member can't reach any admin surface", async () => {
    const me = { bearer: agent };
    expect((await as(s, me, "POST", "/api/members", { name: "evil", kind: "agent", role: "admin" })).status).toBe(403);
    expect((await as(s, me, "PATCH", "/api/members/bot", { role: "admin" })).status).toBe(403);
    expect((await as(s, me, "POST", "/api/members/Ana/token")).status).toBe(403);
    expect((await as(s, me, "DELETE", "/api/members/Ana")).status).toBe(403);
    expect((await as(s, me, "GET", "/api/me")).body).toMatchObject({ member: { name: "bot", role: "member" }, admin: false });

    const client = await mcp(s, agent);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).filter((n) => n.includes("member"))).toEqual(["list_members"]);
    await client.close();
  });

  test("members write as themselves on every REST write, whatever author they claim", async () => {
    const me = { bearer: agent };
    const comment = await as(s, me, "POST", "/api/issues/SEC-1/comments", { body: "hi", author: "Ana" });
    expect(comment.body.comments.at(-1).author).toBe("bot");
    const doc = await as(s, me, "POST", "/api/documents", { project: "SEC", title: "Bot doc", author: "Ana" });
    expect(doc.body.updatedBy).toBe("bot");
    const patched = await as(s, me, "PATCH", "/api/documents/spec", { content: "x", author: "Ana" });
    expect(patched.body.updatedBy).toBe("bot");
    const docComment = await as(s, me, "POST", "/api/documents/spec/comments", { body: "hi", author: "ANA" });
    expect(docComment.body.comments.at(-1).author).toBe("bot");
  });

  test("members write as themselves over MCP, whatever author they claim", async () => {
    const client = await mcp(s, agent);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    await call("comment_issue", { id: "SEC-1", body: "from mcp", author: "Ana" });
    await call("create_document", { project: "SEC", title: "MCP doc", content: "", author: "Ana" });
    await call("update_document", { slug: "spec", content: "y", author: "Ana" });
    await call("comment_document", { slug: "spec", body: "from mcp", author: "Ana" });
    await client.close();

    const { body: issue } = await s.api("GET", "/api/issues/SEC-1");
    expect(issue.comments.at(-1)).toMatchObject({ author: "bot", body: "from mcp" });
    expect((await s.api("GET", "/api/documents/mcp-doc")).body.updatedBy).toBe("bot");
    const { body: spec } = await s.api("GET", "/api/documents/spec");
    expect(spec.updatedBy).toBe("bot");
    expect(spec.comments.at(-1)).toMatchObject({ author: "bot", body: "from mcp" });
  });

  test("no response carries a token or its hash", async () => {
    const secrets = [agent, admin, ROOT, sha256(agent), sha256(admin)];
    const texts = [
      (await as(s, { bearer: agent }, "GET", "/api/me")).text,
      (await as(s, { bearer: agent }, "GET", "/api/members")).text,
      (await as(s, { bearer: admin }, "GET", "/api/members")).text,
      (await as(s, { bearer: admin }, "PATCH", "/api/members/bot", { role: "member" })).text,
    ];
    const client = await mcp(s, agent);
    texts.push(JSON.stringify(await client.callTool({ name: "list_members", arguments: {} })));
    await client.close();
    for (const text of texts) {
      expect(text).not.toMatch(/token_?hash/i);
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  });

  test("/ws needs a valid credential", async () => {
    expect(await ws(s, {})).not.toBe("open");
    expect(await ws(s, { Authorization: "Bearer nope" })).not.toBe("open");
    expect(await ws(s, { Authorization: `Bearer ${agent}` })).toBe("open");
  });

  test("revoking shuts every door: bearer, cookie, MCP and /ws", async () => {
    const temp = (await s.api("POST", "/api/members", { name: "temp", kind: "agent" })).body.token;
    const { cookie } = await login(s, temp);
    expect((await as(s, { cookie }, "GET", "/api/me")).status).toBe(200);
    await s.api("DELETE", "/api/members/temp");
    expect((await as(s, { bearer: temp }, "GET", "/api/me")).status).toBe(401);
    expect((await as(s, { cookie }, "GET", "/api/me")).status).toBe(401);
    expect(await ws(s, { Authorization: `Bearer ${temp}` })).not.toBe("open");
    const mcpPost = await fetch(new URL("/mcp", s.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${temp}` },
      body: "{}",
    });
    expect(mcpPost.status).toBe(401);
    expect((await login(s, temp)).status).toBe(401);
  });
  test("names that look the same after NFKC can't coexist", async () => {
    // Fullwidth "Ａｎａ" folds to "ana", so it can't sit next to Ana and share her comments.
    expect((await s.api("POST", "/api/members", { name: "Ａｎａ", kind: "human" })).status).toBe(409);
  });

  test("revoking closes a cookie-authenticated socket too", async () => {
    await s.api("POST", "/api/members", { name: "browser", kind: "human" });
    const token = (await s.api("POST", "/api/members/browser/token")).body.token;
    const { cookie } = await login(s, token);
    const socket = new WebSocket(new URL("/ws", s.url.replace(/^http/, "ws")), { headers: { Cookie: cookie! } } as never);
    await new Promise((resolve, reject) => ((socket.onopen = resolve), (socket.onerror = reject)));
    const closed = new Promise<number>((resolve) => (socket.onclose = (e) => resolve(e.code)));
    await s.api("DELETE", "/api/members/browser");
    expect(await closed).toBe(4401);
  });
});

describe("login rate limit", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({ env: { DOCKET_TOKEN: ROOT } });
  });
  afterAll(() => s.stop());

  test("covers member tokens too: after 10 failures even a valid one waits", async () => {
    const member = (await s.api("POST", "/api/members", { name: "late", kind: "human" })).body.token;
    for (let i = 0; i < 10; i++) expect((await login(s, `wrong-${i}`)).status).toBe(401);
    expect((await login(s, member)).status).toBe(429);
    expect((await login(s, ROOT)).status).toBe(429);
  });
});

describe("open mode", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(() => s.stop());

  test("with no members it behaves as it always did", async () => {
    expect((await as(s, {}, "GET", "/api/me")).body).toEqual({ member: null, admin: true, open: true });
    // Clients left with a bearer from an old DOCKET_TOKEN setup keep working.
    expect((await as(s, { bearer: "stale" }, "GET", "/api/me")).body.admin).toBe(true);
    await s.api("POST", "/api/workspaces", { key: "o", name: "O" });
    await s.api("POST", "/api/projects", { key: "OPN", workspace: "o", name: "Open" });
    await s.api("POST", "/api/issues", { project: "OPN", title: "x" });
    const c = await as(s, {}, "POST", "/api/issues/OPN-1/comments", { body: "hi", author: "someone" });
    expect(c.body.comments.at(-1).author).toBe("someone");
    expect((await login(s, "anything")).status).toBe(200);
    expect(await ws(s, {})).toBe("open");
  });

  test("once members exist, a bad or revoked bearer is refused, not root", async () => {
    const token = (await s.api("POST", "/api/members", { name: "agent", kind: "agent" })).body.token;
    expect((await as(s, { bearer: token }, "GET", "/api/me")).body.member.name).toBe("agent");
    const { cookie } = await login(s, token);
    expect((await as(s, { bearer: "stale" }, "GET", "/api/me")).status).toBe(401);
    await s.api("DELETE", "/api/members/agent");
    expect((await as(s, { bearer: token }, "GET", "/api/me")).status).toBe(401);
    expect(await ws(s, { Authorization: `Bearer ${token}` })).not.toBe("open");
    // Nor can the revoked member's browser cookie open a socket.
    expect(await ws(s, { Cookie: cookie! })).not.toBe("open");
    // No credentials at all is still root.
    expect((await as(s, {}, "GET", "/api/me")).body.admin).toBe(true);
  });
});

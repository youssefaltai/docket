// Hardening checks for identity: forged or stale credentials, author spoofing, credential leaks,
// cross-site sockets, and what MCP exposes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { startServer, type TestServer } from "./server.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "SEC", workspace: s.workspace, name: "Sec" });
  await s.api("POST", "/api/issues", { team: "SEC", title: "Target" });
  await s.api("POST", "/api/documents", { team: "SEC", title: "Spec" });
  await s.user("ana");
  await s.agent("bot");
});
afterAll(() => s.stop());

test("malformed or forged credentials are a clean 401", async () => {
  const cookie = s.as("ana", "cookie").cookie!;
  const value = cookie.split("=")[1]!;
  const forged = [
    "",
    "x",
    value.slice(0, -1),
    value.slice(0, -1) + (value.endsWith("0") ? "1" : "0"),
    value.toUpperCase(),
    `${value}.${value}`,
    "%E0%A4%A",
    sha256(value),
  ];
  for (const v of forged) expect([v, (await s.with({ cookie: `docket_session=${v}` }, "cookie").api("GET", "/api/me")).status]).toEqual([v, 401]);

  const token = s.as("ana").token!;
  for (const t of [token.slice(0, -1), token.replace("dk_", ""), "dk_" + sha256(token), sha256(token), "Bearer"])
    expect([t, (await s.with({ token: t }).api("GET", "/api/me")).status]).toEqual([t, 401]);
});

test("junk codes are a clean 401, never a 500", async () => {
  // Few on purpose: bad codes count toward the per-IP sign-in limit.
  for (const code of ["%E0", "", "x".repeat(10_000)])
    expect([code.slice(0, 8), (await s.anon.api("POST", "/api/auth/peek", { code })).status]).toEqual([code.slice(0, 8), 401]);
});

test("a signed-out cookie stays dead", async () => {
  const code = (await s.as("ana").api("POST", "/api/sign-in-links")).body.code;
  const cookie = (await s.anon.api("POST", "/api/auth/redeem", { code })).headers.getSetCookie()[0]!.split(";")[0]!;
  const browser = s.with({ cookie }, "cookie");
  expect((await browser.api("GET", "/api/me")).status).toBe(200);
  await browser.api("POST", "/api/logout");
  expect((await browser.api("GET", "/api/me")).status).toBe(401);
  expect(await browser.ws().opened).toBeFalse();
});

test("everyone writes as themselves over REST, whatever author they claim", async () => {
  for (const who of ["ana", "bot"]) {
    const me = s.as(who);
    await me.api("POST", "/api/issues/SEC-1/comments", { body: `by ${who}`, author: "admin" });
    await me.api("POST", "/api/documents", { team: "SEC", title: `Doc by ${who}`, author: "admin" });
    await me.api("PATCH", "/api/documents/spec", { content: who, author: "admin" });
    await me.api("POST", "/api/documents/spec/comments", { body: `by ${who}`, author: "admin", updatedBy: "admin" });
  }
  const issue = (await s.api("GET", "/api/issues/SEC-1")).body;
  const spec = (await s.api("GET", "/api/documents/spec")).body;
  const authored = [...issue.comments, ...spec.comments].map((c: any) => [c.body, c.author.username]);
  // A body with "author" may be refused or have it ignored; it's never taken as someone else's.
  for (const [body, author] of authored) if (String(body).startsWith("by ")) expect(author).toBe(body.slice(3));
  expect(authored.some(([, a]) => a === "admin")).toBeFalse();
  expect(["ana", "bot"]).toContain(spec.updatedBy.username);
});

test("everyone writes as themselves over MCP, whatever author they claim", async () => {
  const bot = s.as("bot");
  const attempt = (name: string, args: Record<string, unknown>) => bot.tool(name, { ...args, author: "admin" }).catch(() => "");
  await attempt("comment_issue", { id: "SEC-1", body: "mcp by bot" });
  await attempt("create_document", { team: "SEC", title: "MCP doc", content: "" });
  await attempt("comment_document", { slug: "spec", body: "mcp by bot" });
  const issue = (await s.api("GET", "/api/issues/SEC-1")).body;
  const spec = (await s.api("GET", "/api/documents/spec")).body;
  for (const c of [...issue.comments, ...spec.comments].filter((c: any) => c.body === "mcp by bot")) expect(c.author.username).toBe("bot");
  const doc = await s.api("GET", "/api/documents/mcp-doc");
  if (doc.status === 200) expect(doc.body.updatedBy.username).toBe("bot");
});

test("MCP never mints credentials or manages members", async () => {
  const text = await s.as("bot").tool("list_members");
  expect(text).toContain("@ana");
  // Tool names come back in tools/list; any credential or admin verb there is a leak.
  const names = (await s.as("bot").api("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).body;
  const listed = typeof names === "string" ? names : JSON.stringify(names);
  expect(listed).not.toMatch(/invite|api_key|sign_in|token|suspend|create_agent|session/i);
});

test("no response carries a token, session or their hashes", async () => {
  const ana = s.as("ana");
  const secrets = [ana.token!, s.admin.token!, s.as("bot").token!, ana.cookie!.split("=")[1]!];
  const all = [...secrets, ...secrets.map(sha256)];
  const texts = [
    (await ana.api("GET", "/api/me")).body,
    (await ana.api("GET", "/api/sessions")).body,
    (await ana.api("GET", "/api/api-keys")).body,
    (await ana.api("GET", `/api/workspaces/${s.workspace}/members`)).body,
    (await s.api("GET", `/api/workspaces/${s.workspace}/members`)).body,
    (await s.api("PATCH", `/api/workspaces/${s.workspace}/members/ana`, { role: "member" })).body,
    await s.as("bot").tool("list_members"),
  ].map((b) => (typeof b === "string" ? b : JSON.stringify(b)));
  for (const text of texts) {
    expect(text).not.toMatch(/token_?hash|key_?hash|session_?hash/i);
    for (const secret of all) expect(text).not.toContain(secret);
  }
});

test("/ws: a cookie only from our own origin; a bearer from anywhere", async () => {
  const cookie = s.as("ana", "cookie").cookie!;
  const open = (headers: Record<string, string>) =>
    new Promise<boolean>((resolve) => {
      // Raw socket: the harness always sends our Origin, and this test is about other ones.
      const ws = new WebSocket(new URL("/ws", s.url.replace(/^http/, "ws")), { headers } as never);
      ws.onopen = () => (ws.close(), resolve(true));
      ws.onclose = () => resolve(false);
    });
  expect(await open({ Cookie: cookie, Origin: new URL(s.url).origin })).toBeTrue();
  expect(await open({ Cookie: cookie, Origin: "https://evil.example" })).toBeFalse();
  expect(await open({ Cookie: cookie })).toBeFalse();
  expect(await open({ Authorization: `Bearer ${s.as("bot").token}` })).toBeTrue();
  expect(await open({ Authorization: "Bearer nope" })).toBeFalse();
});

test("/mcp takes a bearer, not a cookie", async () => {
  expect((await s.as("ana", "cookie").api("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
});

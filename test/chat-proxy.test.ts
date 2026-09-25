// The chat proxy (/api/chat/* → CHAT_URL) and the short-lived, per-session read keys it hands the chat service.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { request } from "node:http";
import { startServer, type TestServer } from "./server.ts";

// A stand-in chat service: /echo says what it received; /stream sends one event, waits to be released, sends another.
let release = () => {};
let upstreamAborted = false;
const escaped: string[] = []; // anything that reached the service outside /chat
const upstream = Bun.serve({
  port: 0,
  fetch: (req) => {
    escaped.push(new URL(req.url).pathname);
    return Response.json({ escaped: true });
  },
  routes: {
    "/chat/*": (req) => Response.json({ path: new URL(req.url).pathname }),
    "/chat/echo": async (req) =>
      Response.json({
        method: req.method,
        path: new URL(req.url).pathname,
        search: new URL(req.url).search,
        headers: Object.fromEntries(req.headers),
        body: await req.text(),
      }),
    "/chat": () => Response.json({ root: true }),
    "/chat/html": () => new Response("<script>alert(1)</script>", { headers: { "Content-Type": "text/html" } }),
    // Holds its answer back (a model that's slow to start) until the client goes away.
    "/chat/slow": async (req) => {
      upstreamAborted = false;
      await new Promise((resolve) => req.signal.addEventListener("abort", resolve));
      upstreamAborted = true;
      return new Response("late");
    },
    // Streams pings until the client goes away, and notes that it did.
    "/chat/hang": (req) => {
      upstreamAborted = false;
      const body = new ReadableStream({
        async start(c) {
          req.signal.addEventListener("abort", () => (upstreamAborted = true));
          while (!req.signal.aborted) {
            c.enqueue(new TextEncoder().encode(": ping\n\n"));
            await Bun.sleep(50);
          }
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    },
    "/chat/stream": () => {
      const held = new Promise<void>((resolve) => (release = resolve));
      const body = new ReadableStream({
        async start(c) {
          c.enqueue(new TextEncoder().encode("data: first\n\n"));
          await held;
          c.enqueue(new TextEncoder().encode("data: second\n\n"));
          c.close();
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream", "Content-Encoding": "identity", "Set-Cookie": "x=1", "X-Accel-Buffering": "no" },
      });
    },
  },
});
afterAll(() => upstream.stop(true));

/** The chat key the service would receive for this caller's session. */
const chatToken = async (s: TestServer, username = "admin") =>
  ((await s.as(username).api("POST", "/api/chat/echo", {})).body.headers.authorization as string).replace("Bearer ", "");

describe("with CHAT_URL", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({ env: { CHAT_URL: `${upstream.url.origin}/` } });
    await s.api("POST", "/api/teams", { key: "CHT", workspace: s.workspace, name: "Chat" });
  });
  afterAll(() => s.stop());

  test("/api/me says the assistant is there", async () => {
    expect((await s.api("GET", "/api/me")).body.chat).toBeTrue();
  });

  test("passes method, path, query and body; the service sees a chat key, never the person's credentials", async () => {
    const res = await s.api("POST", "/api/chat/echo?thread=7", { q: "what's new?" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ method: "POST", path: "/chat/echo", search: "?thread=7", body: JSON.stringify({ q: "what's new?" }) });
    expect((await s.api("POST", "/api/chat", { message: "hi" })).body).toEqual({ root: true });
    const seen = res.body.headers as Record<string, string>;
    expect(seen.cookie).toBeUndefined();
    expect(seen["x-docket-user"]).toBeUndefined();
    expect(seen.origin).toBeUndefined();
    expect(seen.authorization).toMatch(/^Bearer dk_[0-9a-f]{64}$/);
    expect(seen.authorization).not.toContain(s.admin.token!);
    expect(JSON.stringify(seen)).not.toContain(s.admin.cookie!.split("=")[1]!);
  });

  test("the chat key reads as the person, can't write or manage access, and isn't in their key list", async () => {
    const key = s.with({ token: await chatToken(s) });
    expect((await key.api("GET", "/api/me")).body).toMatchObject({ user: { username: "admin" }, credential: "chat" });
    expect((await s.api("GET", "/api/me")).body.credential).toBe("session");
    expect((await s.as("admin", "bearer").api("GET", "/api/me")).body.credential).toBe("key");
    expect((await key.api("GET", "/api/issues")).status).toBe(200);
    expect(await key.tool("list_teams")).toContain("CHT");
    expect((await key.api("POST", "/api/issues", { team: "CHT", title: "no" })).status).toBe(403);
    await expect(key.tool("create_issue", { team: "CHT", title: "no" })).rejects.toThrow();
    expect((await key.api("GET", "/api/api-keys")).status).toBe(403);
    // The assistant can't chain itself: its own key can't open the proxy.
    expect((await key.api("POST", "/api/chat/echo", {})).status).toBe(403);
    const listed = (await s.api("GET", "/api/api-keys")).body as { name: string }[];
    expect(listed.map((k) => k.name)).not.toContain("Chat (automatic)");
  });

  test("the same session reuses its key; another session gets its own", async () => {
    const first = await chatToken(s);
    expect(await chatToken(s)).toBe(first);
    await s.user("ana");
    expect(await chatToken(s, "ana")).not.toBe(first);
  });

  test("streams server-sent events as they come, without buffering", async () => {
    // Raw fetch: reading the body chunk by chunk is the point.
    const res = await fetch(new URL("/api/chat/stream", s.url), { headers: { Cookie: s.admin.cookie!, Accept: "text/event-stream" } });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("first")) text += decoder.decode((await reader.read()).value);
    expect(text).not.toContain("second"); // the upstream is still holding it back
    release();
    for (let r = await reader.read(); !r.done; r = await reader.read()) text += decoder.decode(r.value);
    expect(text).toBe("data: first\n\ndata: second\n\n");
  });

  test("Stop: the browser aborting cancels the upstream request", async () => {
    const stop = new AbortController();
    const res = await fetch(new URL("/api/chat/hang", s.url), { headers: { Cookie: s.admin.cookie! }, signal: stop.signal });
    await res.body!.getReader().read();
    stop.abort();
    for (let i = 0; i < 100 && !upstreamAborted; i++) await Bun.sleep(20);
    expect(upstreamAborted).toBeTrue();

    // Before the first byte too: Stop while the service is still waiting on its model.
    const early = new AbortController();
    const pending = fetch(new URL("/api/chat/slow", s.url), { headers: { Cookie: s.admin.cookie! }, signal: early.signal }).catch(() => null);
    await Bun.sleep(200);
    early.abort();
    await pending;
    for (let i = 0; i < 100 && !upstreamAborted; i++) await Bun.sleep(20);
    expect(upstreamAborted).toBeTrue();
  });

  test("only a signed-in browser gets through", async () => {
    expect((await s.anon.api("POST", "/api/chat/echo", {})).status).toBe(401);
    expect((await s.as("admin", "bearer").api("POST", "/api/chat/echo", {})).status).toBe(403);
    await s.agent("helper");
    expect((await s.as("helper").api("POST", "/api/chat/echo", {})).status).toBe(403);
    // Cross-site writes are refused before anything reaches the service.
    const cross = await fetch(new URL("/api/chat/echo", s.url), {
      method: "POST",
      headers: { Cookie: s.admin.cookie!, Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(cross.status).toBe(403);
  });

  test("the key dies with its session: sign-out, revoke, suspension", async () => {
    await s.user("lo");
    const loggedOut = await chatToken(s, "lo");
    await s.as("lo").api("POST", "/api/logout");
    expect((await s.with({ token: loggedOut }).api("GET", "/api/me")).status).toBe(401);

    await s.user("rv");
    const oldSession = s.as("rv");
    const revoked = await chatToken(s, "rv");
    const fresh = await s.signIn("rv");
    const old = (await oldSession.api("GET", "/api/sessions")).body.find((x: any) => x.current).id;
    expect((await fresh.api("DELETE", `/api/sessions/${old}`)).status).toBeLessThan(300);
    expect((await s.with({ token: revoked }).api("GET", "/api/me")).status).toBe(401);

    await s.user("sus");
    const suspended = await chatToken(s, "sus");
    await s.api("PATCH", `/api/workspaces/${s.workspace}/members/sus`, { suspended: true });
    expect((await s.with({ token: suspended }).api("GET", "/api/me")).status).toBe(401);
  });

  test("no path, however encoded, reaches the service outside /chat", async () => {
    // Raw requests: fetch would resolve the dots before sending, and the server must not rely on that.
    const raw = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const u = new URL(s.url);
        const r = request({ host: u.hostname, port: u.port, path, headers: { Cookie: s.admin.cookie! } }, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        });
        r.on("error", reject);
        r.end();
      });
    const attempts = [
      "/api/chat/%2e%2e/x",
      "/api/chat/%2E%2E/x",
      "/api/chat/%2e%2e",
      "/api/chat/.%2e/x",
      "/api/chat/../../health",
      "/api/chat/./../ask",
      "/api/chat/..%2fx",
      "/api/chat/..%2Fx",
      "/api/chat/..\\x",
      "/api/chat/..%5cx",
      "/api/chat/%252e%252e/x",
      "/api/chat/%2e%2e%2f%2e%2e/x",
    ];
    for (const path of attempts) {
      const res = await raw(path);
      expect([path, res.body.includes('"escaped"')]).toEqual([path, false]);
      if (res.status === 200) expect([path, JSON.parse(res.body).path]).toEqual([path, expect.stringMatching(/^\/chat(\/|$)/)]);
    }
    expect(escaped).toEqual([]);
  });

  test("the service may only answer JSON or an event stream", async () => {
    expect((await s.api("GET", "/api/chat/html")).status).toBe(502);
  });

  test("chunked bodies are capped at 16 KB too", async () => {
    const big = new ReadableStream({
      start(c) {
        for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode("x".repeat(1000)));
        c.close();
      },
    });
    const res = await fetch(new URL("/api/chat/echo", s.url), {
      method: "POST",
      headers: { Cookie: s.admin.cookie!, Origin: new URL(s.url).origin, "Content-Type": "application/json" },
      body: big,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  test("bodies over 16 KB are refused before reaching the service", async () => {
    expect((await s.api("POST", "/api/chat/echo", { message: "x".repeat(17_000) })).status).toBe(413);
  });
});

describe("rotation and expiry", () => {
  let s: TestServer;
  const TTL = 4000;
  beforeAll(async () => {
    s = await startServer({ env: { CHAT_URL: upstream.url.origin, DOCKET_CHAT_KEY_TTL_MS: String(TTL) } });
  });
  afterAll(() => s.stop());

  test("a key is replaced once a third of its life is gone, and 401s everywhere once expired", async () => {
    const first = await chatToken(s);
    await Bun.sleep(TTL / 3 + 300);
    const second = await chatToken(s);
    expect(second).not.toBe(first);
    // The old one still works until it expires, so an answer in flight isn't cut off.
    expect((await s.with({ token: first }).api("GET", "/api/me")).status).toBe(200);
    await Bun.sleep(TTL);
    expect((await s.with({ token: first }).api("GET", "/api/me")).status).toBe(401);
    await expect(s.with({ token: first }).tool("list_teams")).rejects.toThrow();
  }, 20_000);
});

describe("without CHAT_URL", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(() => s.stop());

  test("the assistant is off: hidden in /api/me, and the proxy is a 404", async () => {
    expect((await s.api("GET", "/api/me")).body.chat).toBeFalse();
    expect((await s.api("POST", "/api/chat/echo", {})).status).toBe(404);
    expect((await s.anon.api("POST", "/api/chat/echo", {})).status).toBe(401);
  });
});

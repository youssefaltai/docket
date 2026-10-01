// The HTTP layer: security headers on every response, capped bodies and texts, and a rate limit per credential.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, WORKER, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "HTTP", workspace: s.workspace, name: "Http" });
  await s.api("POST", "/api/issues", { team: "HTTP", title: "Target" });
});
afterAll(() => s.stop());

const get = (path: string, headers: Record<string, string> = {}) => fetch(new URL(path, s.url), { headers });

function expectSecure(res: Response, path: string) {
  const h = res.headers;
  const csp = h.get("content-security-policy") ?? "";
  expect([path, csp]).toEqual([path, expect.stringContaining("frame-ancestors 'none'")]);
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).not.toContain("unsafe-inline");
  expect(h.get("x-content-type-options")).toBe("nosniff");
  expect(h.get("x-frame-options")).toBe("DENY");
  expect(h.get("referrer-policy")).toBe("no-referrer");
}

test("every response carries the security headers", async () => {
  const page = await get("/");
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);
  expect(assets.some((a) => a.endsWith(".js"))).toBeTrue();
  const paths = ["/", "/login", "/issue/HTTP-1", "/sw.js", "/manifest.webmanifest", "/nope", "/api/setup", ...assets];
  for (const path of paths) expectSecure(await get(path), path);
  expectSecure((await s.anon.api("GET", "/api/me")) as never as Response, "/api/me 401");
  expectSecure((await s.api("GET", "/api/me")) as never as Response, "/api/me");
  expectSecure((await s.anon.api("POST", "/api/auth/peek", { code: "x" })) as never as Response, "/api/auth/peek");
});

test("the page runs no inline script, so the policy needs no exception", async () => {
  const html = await (await get("/")).text();
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
});

test("API answers are never cached; HSTS only over https", async () => {
  expect((await s.api("GET", "/api/issues")).headers.get("cache-control")).toBe("no-store");
  expect((await get("/api/setup")).headers.get("cache-control")).toBe("no-store");
  if (!WORKER) expect((await get("/")).headers.get("strict-transport-security")).toBeNull(); // Workers: assets always send it (https only)
  expect((await get("/", { "X-Forwarded-Proto": "https" })).headers.get("strict-transport-security")).toContain("max-age=");
});

test("request bodies over 1 MB are refused with a clear 413", async () => {
  const res = await s.api("POST", "/api/issues", { team: "HTTP", title: "Big", description: "x".repeat(2 * 1024 * 1024) });
  expect(res.status).toBe(413);
  expect(res.body.error).toContain("too large");
  expect((await s.api("GET", "/api/issues?team=HTTP")).body).toHaveLength(1);
});

test("long texts are refused, field by field", async () => {
  const tooLong = async (path: string, body: object, method = "POST") => {
    const res = await s.api(method, path, body);
    return [res.status, String(res.body.error).includes("too long")];
  };
  expect(await tooLong("/api/issues", { team: "HTTP", title: "t".repeat(501) })).toEqual([400, true]);
  expect(await tooLong("/api/issues", { team: "HTTP", title: "ok", description: "d".repeat(100_001) })).toEqual([400, true]);
  expect(await tooLong("/api/issues/HTTP-1/comments", { body: "c".repeat(100_001) })).toEqual([400, true]);
  expect(await tooLong("/api/issues/HTTP-1", { title: "t".repeat(501) }, "PATCH")).toEqual([400, true]);
  // Right at the limit is fine.
  expect((await s.api("POST", "/api/issues/HTTP-1/comments", { body: "c".repeat(100_000) })).status).toBe(201);

  expect((await s.api("POST", "/api/documents", { team: "HTTP", title: "Doc", content: `START ${"a".repeat(400_000)}` })).status).toBe(201);
  expect(await tooLong("/api/documents", { team: "HTTP", title: "Huge", content: "a".repeat(500_001) })).toEqual([400, true]);
  // Edits can't grow a doc past the limit either.
  const grow = { edits: [{ oldText: "START", newText: "b".repeat(200_000) }] };
  expect(await tooLong("/api/documents/doc", grow, "PATCH")).toEqual([400, true]);
  // And MCP goes through the same checks.
  await s.agent("writer");
  await expect(s.as("writer").tool("comment_issue", { id: "HTTP-1", body: "c".repeat(100_001) })).rejects.toThrow("too long");
});

test("each credential has its own rate limit: a burst, then 429 with Retry-After", async () => {
  const noisy = await s.agent("noisy");
  const quiet = await s.agent("quiet");
  const statuses: number[] = [];
  let retryAfter: string | null = null;
  // Small batches: enough to outrun the refill (20/s), without opening hundreds of sockets on a busy machine.
  for (let round = 0; round < 60 && !statuses.includes(429); round++) {
    const batch = await Promise.all(Array.from({ length: 20 }, () => noisy.api("GET", "/api/me")));
    for (const r of batch) {
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers.get("retry-after");
    }
  }
  expect(statuses).toContain(429);
  expect(statuses.every((x) => x === 200 || x === 429)).toBeTrue();
  expect(statuses.filter((x) => x === 200).length).toBeGreaterThanOrEqual(500); // a generous burst
  expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  // Someone else isn't slowed down.
  expect((await quiet.api("GET", "/api/me")).status).toBe(200);
});

test("a workspace name is capped at creation, as on rename (DKT-43)", async () => {
  const wes = await s.user("wes");
  const long = await wes.api("POST", "/api/workspaces", { name: "w".repeat(201), key: "wes" });
  expect([long.status, long.body.error]).toEqual([400, "name is too long: at most 200 characters"]);
  expect((await wes.api("POST", "/api/workspaces", { name: "w".repeat(200), key: "wes" })).status).toBe(201);
  const rename = await wes.api("PATCH", "/api/workspaces/wes", { name: "w".repeat(201) });
  expect([rename.status, rename.body.error]).toEqual([400, "name is too long: at most 200 characters"]);
});

// On its own server: the limit is in memory, and draining the IP's bucket would slow the other tests.
test("made-up credentials, however written, share the client IP's limit; one that signs in never waits on it (DKT-40)", async () => {
  const t = await startServer();
  try {
    const known = await t.agent("known"); // never used yet: its first request comes while the IP's bucket is empty
    const secret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const forms: (() => Record<string, string>)[] = [
      () => ({ Authorization: `Bearer dk_${secret()}` }),
      () => ({ Authorization: `bearer dk_${secret()}` }),
      () => ({ Authorization: `BEARER   dk_${secret()}  ` }),
      () => ({ Authorization: `Basic ${secret()}` }),
      () => ({ Cookie: `docket_session=${secret()}` }),
      () => ({ Authorization: `Bearer dk_${secret()}`, Cookie: t.admin.cookie! }), // a stray key beside a real cookie
    ];
    let n = 0;
    const guess = () => get(new URL("/api/me", t.url).href, forms[n++ % forms.length]!()).then((r) => r.status);
    const statuses: number[] = [];
    for (let round = 0; round < 60 && !statuses.includes(429); round++) statuses.push(...(await Promise.all(Array.from({ length: 20 }, guess))));
    expect(statuses).toContain(429);
    expect(statuses.every((x) => x === 401 || x === 429)).toBeTrue();
    // While it's empty, guesses and the public code routes wait; credentials that sign in don't, even brand-new ones.
    // (A few at once: on a slow server a token may refill between two requests.)
    expect(await Promise.all(Array.from({ length: 5 }, guess))).toContain(429);
    expect((await t.anon.api("POST", "/api/auth/peek", { code: "AAAAA-AAAAA" })).status).toBe(429);
    expect((await known.api("GET", "/api/me")).status).toBe(200);
    expect(await known.tools()).toContain("get_issue");
    expect((await t.api("GET", "/api/me")).status).toBe(200);
    const fresh = await t.api("POST", "/api/api-keys", { name: "fresh", workspace: t.workspace });
    expect(fresh.status).toBe(201);
    expect((await t.with({ token: fresh.body.token }).api("GET", "/api/me")).status).toBe(200);
  } finally {
    await t.stop();
  }
});

// The HTTP layer: security headers on every response, capped bodies and texts, and a rate limit per credential.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

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
  expect((await get("/")).headers.get("strict-transport-security")).toBeNull();
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
  for (let round = 0; round < 8 && !statuses.includes(429); round++) {
    const batch = await Promise.all(Array.from({ length: 150 }, () => noisy.api("GET", "/api/me")));
    for (const r of batch) {
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers.get("retry-after");
    }
  }
  expect(statuses).toContain(429);
  expect(statuses.filter((x) => x === 200).length).toBeGreaterThanOrEqual(500); // a generous burst
  expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  // Someone else isn't slowed down.
  expect((await quiet.api("GET", "/api/me")).status).toBe(200);
});

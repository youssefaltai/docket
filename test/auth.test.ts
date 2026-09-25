import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

const TOKEN = "test-token";
let s: TestServer;
beforeAll(async () => {
  s = await startServer({ env: { DOCKET_TOKEN: TOKEN } });
});
afterAll(() => s.stop());

const get = (path: string, headers: Record<string, string> = {}) => fetch(new URL(path, s.url), { headers });

test("the token guards /api and /mcp", async () => {
  expect((await get("/api/projects")).status).toBe(401);
  expect((await get("/api/projects", { Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await get("/api/projects", { Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  const mcp = await fetch(new URL("/mcp", s.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  expect(mcp.status).toBe(401);
  // The harness's MCP client sends the token, so this works.
  expect(await s.tool("list_workspaces")).toBeString();
});

test("login sets a cookie that works for /api", async () => {
  const bad = await fetch(new URL("/api/login", s.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "wrong" }),
  });
  expect(bad.status).toBe(401);

  const ok = await fetch(new URL("/api/login", s.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  expect(cookie).not.toContain(TOKEN);
  expect((await get("/api/projects", { Cookie: cookie })).status).toBe(200);
});

test("unknown Host headers are refused", async () => {
  const res = await fetch(new URL("/api/projects", s.url), {
    headers: { Host: "evil.example", Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(403);
});

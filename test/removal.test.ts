// Deleting a team or a workspace for good: admins in the web app, after typing the key; everything inside goes too.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  await s.user("ana");
  await s.agent("claude");
});
afterAll(() => s.stop());

const count = (table: string, where = "1") => s.sql(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0].n as number;
const broken = () => s.sql("PRAGMA foreign_key_check");

async function populate(ws: string) {
  const w = s.as("admin", "cookie", ws);
  await w.api("POST", "/api/teams", { key: "AAA", name: "A" });
  await w.api("POST", "/api/teams", { key: "BBB", name: "B" });
  const a = (await w.api("POST", "/api/issues", { team: "AAA", title: "Parent" })).body.id;
  const b = (await w.api("POST", "/api/issues", { team: "BBB", title: "Child", parent: a })).body.id;
  await w.api("POST", "/api/issues", { team: "AAA", title: "Blocked by child", blockedBy: [b] });
  await w.api("POST", `/api/issues/${a}/comments`, { body: "hi" });
  await w.api("POST", "/api/documents", { team: "AAA", title: "Doc", content: `see ${a}` });
  await w.api("POST", "/api/labels", { name: "Own", team: "AAA" });
  await w.api("POST", "/api/templates", { team: "AAA", name: "T" });
  await w.api("PATCH", "/api/teams/AAA", { cycleWeeks: 2 });
  await w.api("POST", "/api/projects", { teams: ["AAA", "BBB"], name: "Proj" });
  await w.api("POST", "/api/views", { name: "V", filter: {} });
  return { w, a, b };
}

test("deleting a team takes its content, frees the key, and orphans other teams' sub-issues", async () => {
  const { w, a, b } = await populate("acme");
  const bad = (caller: any, confirm = "AAA") => caller.api("DELETE", `/api/teams/AAA?confirm=${confirm}`);
  expect((await bad(w, "")).status).toBe(400);
  expect((await bad(s.as("ana"))).status).toBe(403); // not an admin
  expect((await bad(s.as("claude"))).status).toBe(403);
  expect((await bad(s.with({ token: (await s.api("POST", "/api/api-keys", { name: "k", scope: "write" })).body.token }))).status).toBe(403); // a key
  expect((await bad(w)).status).toBe(200);
  expect(broken()).toEqual([]);
  expect((await w.api("GET", `/api/issues/${a}`)).status).toBe(404);
  expect((await w.api("GET", `/api/issues/${b}`)).body.parent).toBeNull();
  expect(count("teams", "key = 'AAA'")).toBe(0);
  expect((await w.api("POST", "/api/teams", { key: "AAA", name: "Again" })).status).toBe(201);
});

test("deleting a workspace takes everything in it and nothing of another", async () => {
  await s.api("POST", "/api/workspaces", { name: "Side", key: "side" });
  await s.agent("sidebot", { workspace: "side" });
  const { w } = await populate("side");
  await w.api("POST", "/api/workspaces/side/webhooks", { url: "http://127.0.0.1:9/x" });
  const before = count("issues");
  const sideIssues = count("issues", "team_id IN (SELECT id FROM teams WHERE workspace = 'side')");
  expect(sideIssues).toBeGreaterThan(0);

  expect((await w.api("DELETE", "/api/workspaces/side?confirm=nope")).status).toBe(400);
  expect((await s.as("ana").api("DELETE", "/api/workspaces/acme?confirm=acme")).status).toBe(403);
  expect((await w.api("DELETE", "/api/workspaces/side?confirm=side")).status).toBe(200);
  expect(broken()).toEqual([]);
  expect(count("issues")).toBe(before - sideIssues);
  for (const t of ["teams", "documents", "labels", "projects", "workspace_members", "webhooks", "custom_views"]) {
    expect(count(t, "workspace = 'side'")).toBe(0);
  }
  expect(count("users", "id IN (SELECT user_id FROM api_keys WHERE workspace = 'side')")).toBe(0);
  expect((await s.api("GET", "/api/teams")).status).toBe(200); // acme untouched
});

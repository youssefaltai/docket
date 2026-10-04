// Delete forever: a trashed issue or doc can be removed for good, by a person in the web app only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "PUR", name: "Purge" });
  await s.agent("claude");
});
afterAll(() => s.stop());

test("a trashed issue is deleted for good from the web app; keys and agents can't, nor can a live one", async () => {
  const parent = (await s.api("POST", "/api/issues", { team: "PUR", title: "Parent" })).body.id;
  const child = (await s.api("POST", "/api/issues", { team: "PUR", title: "Child", parent })).body.id;
  const key = s.with({ token: (await s.api("POST", "/api/api-keys", { name: "k", scope: "write" })).body.token });
  const claude = s.as("claude");

  expect((await s.api("POST", `/api/issues/${parent}/purge`)).status).toBe(409); // not in the trash yet
  await s.api("DELETE", `/api/issues/${parent}`);
  expect((await key.api("POST", `/api/issues/${parent}/purge`)).status).toBe(403);
  expect((await claude.api("POST", `/api/issues/${parent}/purge`)).status).toBe(403);
  expect((await s.api("GET", `/api/issues/${parent}`)).status).toBe(200);

  expect((await s.api("POST", `/api/issues/${parent}/purge`)).status).toBe(200);
  expect((await s.api("GET", `/api/issues/${parent}`)).status).toBe(404);
  expect((await s.api("GET", "/api/teams/PUR/trash")).body.issues).toEqual([]);
  expect((await s.api("GET", `/api/issues/${child}`)).body.parent).toBeNull(); // sub-issues stay, orphaned
});

test("a trashed doc is deleted for good from the web app; no MCP tool does it", async () => {
  const slug = (await s.api("POST", "/api/documents", { team: "PUR", title: "Notes", content: "x" })).body.slug;
  const claude = s.as("claude");
  expect((await s.api("POST", `/api/documents/${slug}/purge`)).status).toBe(409);
  await s.api("DELETE", `/api/documents/${slug}`);
  expect((await claude.api("POST", `/api/documents/${slug}/purge`)).status).toBe(403);
  expect((await s.api("POST", `/api/documents/${slug}/purge`)).status).toBe(200);
  expect((await s.api("GET", `/api/documents/${slug}`)).status).toBe(404);
  expect((await s.admin.tools()).filter((t: string) => /purge|forever/.test(t))).toEqual([]);
});

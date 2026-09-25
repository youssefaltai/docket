import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
});
afterAll(() => s.stop());

test("an agent can work through an issue", async () => {
  await s.tool("create_workspace", { name: "Acme", key: "acme" });
  await s.tool("create_project", { key: "MCP", workspace: "acme", name: "Agents" });
  expect(await s.tool("list_projects")).toContain("MCP");

  expect(await s.tool("create_issue", { project: "MCP", title: "Wire it up", priority: 2 })).toContain("MCP-1");
  await s.tool("update_issue", { id: "MCP-1", status: "in_progress" });
  await s.tool("comment_issue", { id: "MCP-1", body: "Halfway there" });

  const issue = await s.tool("get_issue", { id: "mcp-1" });
  expect(issue).toContain("in_progress");
  expect(issue).toContain("**claude**");
  expect(issue).toContain("Halfway there");

  expect(await s.tool("list_issues", { workspace: "acme" })).toContain("MCP-1 · in_progress · high · Wire it up");
});

test("an agent can write and edit a doc", async () => {
  await s.tool("create_document", { project: "MCP", title: "Plan", content: "Do MCP-1 first." });
  await s.tool("update_document", { slug: "plan", edits: [{ oldText: "first", newText: "now" }] });
  const doc = await s.tool("get_document", { slug: "plan" });
  expect(doc).toContain("Do MCP-1 now.");
  expect(await s.tool("list_documents", { project: "MCP" })).toContain("plan");
});

test("MCP writes show up over REST", async () => {
  const { body } = await s.api("GET", "/api/issues/MCP-1");
  expect(body).toMatchObject({ status: "in_progress", priority: 2 });
  expect(body.docs.map((d: any) => d.slug)).toEqual(["plan"]);
});

test("tool errors come back as errors", async () => {
  await expect(s.tool("get_issue", { id: "MCP-999" })).rejects.toThrow();
});

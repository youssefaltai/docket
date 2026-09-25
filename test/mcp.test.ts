import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let claude: Caller;
beforeAll(async () => {
  s = await startServer();
  // /mcp is bearer-only, so MCP tests run as an agent, the real way it's used.
  claude = await s.agent("claude");
});
afterAll(() => s.stop());

test("an agent can work through an issue", async () => {
  await claude.tool("create_team", { key: "MCP", workspace: s.workspace, name: "Agents" });
  expect(await claude.tool("list_teams")).toContain("MCP");

  expect(await claude.tool("create_issue", { team: "MCP", title: "Wire it up", priority: 2 })).toContain("MCP-1");
  await claude.tool("update_issue", { id: "MCP-1", status: "in_progress" });
  await claude.tool("comment_issue", { id: "MCP-1", body: "Halfway there" });

  const issue = await claude.tool("get_issue", { id: "mcp-1" });
  expect(issue).toContain("in_progress");
  expect(issue).toContain("**@claude**");
  expect(issue).toContain("Halfway there");

  expect(await claude.tool("list_issues", { workspace: s.workspace })).toContain("MCP-1 · in_progress · high · Wire it up");
});

test("an agent can write and edit a doc", async () => {
  await claude.tool("create_document", { team: "MCP", title: "Plan", content: "Do MCP-1 first." });
  await claude.tool("update_document", { slug: "plan", edits: [{ oldText: "first", newText: "now" }] });
  const doc = await claude.tool("get_document", { slug: "plan" });
  expect(doc).toContain("Do MCP-1 now.");
  expect(await claude.tool("list_documents", { team: "MCP" })).toContain("plan");
});

test("MCP writes show up over REST", async () => {
  const { body } = await s.api("GET", "/api/issues/MCP-1");
  expect(body).toMatchObject({ status: "in_progress", priority: 2 });
  expect(body.docs.map((d: any) => d.slug)).toEqual(["plan"]);
});

test("tool errors come back as errors", async () => {
  await expect(claude.tool("get_issue", { id: "MCP-999" })).rejects.toThrow();
});

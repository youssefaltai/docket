import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let claude: Caller;
beforeAll(async () => {
  s = await startServer();
  // /mcp is bearer-only, so MCP tests run as an agent, the real way it's used.
  claude = await s.agent("claude");
  await s.api("POST", "/api/teams", { key: "MCP", workspace: s.workspace, name: "Agents" });
});
afterAll(() => s.stop());

test("an agent can work through an issue", async () => {
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

test("agents can't create or change teams", async () => {
  await expect(claude.tool("create_team", { key: "BOT", name: "Bot" })).rejects.toThrow();
  expect((await claude.api("POST", "/api/teams", { key: "BOT", workspace: s.workspace, name: "Bot" })).status).toBe(403);
  expect((await claude.api("PATCH", "/api/teams/MCP", { name: "x" })).status).toBe(403);
  const teams = (await s.api("GET", "/api/teams")).body;
  expect(teams.map((t: any) => t.key)).not.toContain("BOT");
  expect(teams.find((t: any) => t.key === "MCP").name).toBe("Agents");
});

test("tools/list shows each caller only what it can use", async () => {
  const ana = await s.user("ana");
  const ro = s.with({ token: (await ana.api("POST", "/api/api-keys", { name: "ro", scope: "read" })).body.token });
  const reads = ["get_document", "get_issue", "list_documents", "list_issues", "list_labels", "list_members", "list_teams", "list_workspaces"];
  const writes = ["claim_issue", "comment_document", "comment_issue", "create_document", "create_issue"];
  writes.push("delete_comment", "delete_document", "update_comment", "update_document", "update_issue");
  const agent = [...reads, ...writes].sort();
  const member = [...agent, "create_team", "create_workspace", "update_team"].sort();
  expect(await ro.tools()).toEqual(reads);
  expect(await claude.tools()).toEqual(agent);
  expect(await ana.tools()).toEqual(member);
  expect(await s.admin.tools()).toEqual([...member, "update_workspace"].sort());

  // A hidden tool can't be called either, and nothing changes.
  await expect(claude.tool("create_team", { key: "HID", name: "Hidden" })).rejects.toThrow(/not found/);
  await expect(ro.tool("create_issue", { team: "MCP", title: "Read-only" })).rejects.toThrow(/not found/);
  await expect(ana.tool("update_workspace", { key: s.workspace, name: "Ana's" })).rejects.toThrow(/not found/);
  expect((await s.api("GET", "/api/teams")).body.map((t: any) => t.key)).not.toContain("HID");
  expect((await s.api("GET", "/api/issues?team=MCP")).body.map((i: any) => i.title)).not.toContain("Read-only");
  expect((await s.api("GET", "/api/workspaces")).body.find((w: any) => w.key === s.workspace).name).toBe("Acme");

  const instructions = await ro.instructions();
  expect(instructions).toContain("This key is read-only");
  expect(instructions).not.toContain("claim_issue");
  expect(await claude.instructions()).toContain("claim_issue");
});

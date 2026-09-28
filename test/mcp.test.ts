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
  const reads = ["get_attachment", "get_document", "get_issue", "get_project", "list_cycles", "list_documents", "list_issues", "list_labels", "list_members", "list_notifications", "list_projects", "list_teams"];
  const writes = ["attach_file", "claim_issue", "comment_document", "comment_issue", "create_document", "create_issue", "create_milestone", "create_project"];
  writes.push("delete_comment", "delete_document", "mark_notifications_read", "react", "resolve_thread", "subscribe", "update_comment", "update_document", "update_issue", "update_milestone", "update_project");
  const agent = [...reads, ...writes].sort();
  const member = [...agent, "create_team", "update_team"].sort();
  expect(await ro.tools()).toEqual(reads);
  expect(await claude.tools()).toEqual(agent);
  expect(await ana.tools()).toEqual(member);
  expect(await s.admin.tools()).toEqual([...member, "update_workspace"].sort());
  expect([reads.length, agent.length, member.length]).toEqual([12, 31, 33]);

  // A hidden tool can't be called either, and nothing changes.
  await expect(claude.tool("create_team", { key: "HID", name: "Hidden" })).rejects.toThrow(/not found/);
  await expect(ro.tool("create_issue", { team: "MCP", title: "Read-only" })).rejects.toThrow(/not found/);
  await expect(ana.tool("update_workspace", { name: "Ana's" })).rejects.toThrow(/not found/);
  expect((await s.api("GET", "/api/teams")).body.map((t: any) => t.key)).not.toContain("HID");
  expect((await s.api("GET", "/api/issues?team=MCP")).body.map((i: any) => i.title)).not.toContain("Read-only");
  expect((await s.api("GET", "/api/workspaces")).body.find((w: any) => w.key === s.workspace).name).toBe("Acme");

  const instructions = await ro.instructions();
  expect(instructions).toContain("This key is read-only");
  expect(instructions).not.toContain("claim_issue");
  expect(await claude.instructions()).toContain("claim_issue");
});

test("the server says which Docket and workspace it is", async () => {
  const server = await claude.server();
  expect([server.name, server.title, server.websiteUrl]).toEqual(["docket-acme", "Docket · Acme", s.url.replace(/\/+$/, "")]);
  expect(server.instructions).toStartWith(`You're connected to Docket at ${s.url.replace(/\/+$/, "")}, `);
  expect(server.instructions).toContain('workspace "Acme" (acme), as @claude (agent). Every tool acts there.\nDocket is an issue tracker');
  // A person's key names them as they're known there.
  expect((await s.admin.server()).instructions).toContain('workspace "Acme" (acme), as @admin (person)');
  // A read key keeps its read-only line (DKT-2), after this one.
  const read = (await s.api("POST", "/api/api-keys", { name: "reader", scope: "read" })).body.token;
  const lines = (await s.with({ token: read }).server()).instructions!.split("\n");
  expect(lines[0]).toStartWith("You're connected to Docket at");
  expect(lines).toContain("- This key is read-only: you can list and read everything here, but not change anything.");
});

test("the origin is DOCKET_URL when set, else the one the client used (honouring a proxy's)", async () => {
  const other = await startServer({ env: { DOCKET_URL: "https://docket.example.com/" } });
  try {
    const server = await other.admin.server();
    expect(server.websiteUrl).toBe("https://docket.example.com");
    expect(server.instructions).toStartWith("You're connected to Docket at https://docket.example.com, ");
  } finally {
    await other.stop();
  }
  // Behind a proxy, without DOCKET_URL: the forwarded host and protocol.
  const res = await fetch(new URL("/mcp", s.url), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${claude.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Forwarded-Host": "tracker.example.org",
      "X-Forwarded-Proto": "https",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  const { result } = (await res.json()) as any;
  expect([result.serverInfo.websiteUrl, result.instructions.split(",")[0]]).toEqual([
    "https://tracker.example.org",
    "You're connected to Docket at https://tracker.example.org",
  ]);
});

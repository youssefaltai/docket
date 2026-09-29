// Per-team issue templates (DKT-33): a team's named prefills (title, description, status, priority, labels) for
// new issues, applied by id (REST POST /api/issues and MCP create_issue: template first, then explicit fields,
// then the usual defaults). Labels are a join table (issue_template_labels), like an issue's own; status is
// checked against the team's workflow when set but not a foreign key, so a status deleted later falls back to
// the team's default at use time. Hard-deleted: issues already made from a template are never touched.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let bot: Caller;
beforeAll(async () => {
  s = await startServer();
  expect((await s.api("POST", "/api/teams", { key: "WEB", name: "Web" })).status).toBe(201);
  expect((await s.api("POST", "/api/teams", { key: "API", name: "Api" })).status).toBe(201);
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  expect((await s.as("admin", "cookie", "side").api("POST", "/api/teams", { key: "SID", name: "Side" })).status).toBe(201);
  await s.user("ana");
  bot = await s.agent("bot");
});
afterAll(() => s.stop());

const templates = async (query = "") => (await s.api("GET", `/api/templates${query}`)).body as any[];
const template = async (name: string) => (await templates()).find((t) => t.name === name);
const newTemplate = (body: Record<string, unknown>, caller = s.admin) => caller.api("POST", "/api/templates", body);
const patchTemplate = (id: number, body: Record<string, unknown>, caller = s.admin) => caller.api("PATCH", `/api/templates/${id}`, body);

test("creating a template: all fields set, labels as a join table like an issue's", async () => {
  // A label named for the first time is created (and published) exactly as it would be from an issue.
  const ws = s.admin.ws();
  expect(await ws.opened).toBe(true);
  const res = await newTemplate({ team: "WEB", name: "Bug report", title: "Bug: ", description: "Steps to reproduce:", status: "todo", priority: 2, labels: ["Bug"] });
  expect(res.status).toBe(201);
  await ws.until((e) => e.entity === "label" && e.workspace === "acme");
  await ws.until((e) => e.entity === "team" && e.workspace === "acme");
  ws.close();
  expect(res.body).toMatchObject({
    team: "WEB",
    name: "Bug report",
    title: "Bug:", // trimmed, like an issue's title
    description: "Steps to reproduce:",
    status: "todo",
    priority: 2,
    labels: ["Bug"],
  });
  expect(res.body.id).toBeNumber();
  expect(res.body.createdAt).toBeString();
  // It shows up in the team's list, and in the workspace's.
  expect((await templates("?team=WEB")).map((t: any) => t.name)).toEqual(["Bug report"]);
  expect((await templates()).map((t: any) => t.name)).toEqual(["Bug report"]);
  expect(await templates("?team=API")).toEqual([]);
  // Bare minimum: just a name, everything else defaults.
  const bare = await newTemplate({ team: "WEB", name: "Blank" });
  expect(bare.body).toMatchObject({ title: "", description: "", status: null, priority: null, labels: [] });
});

test("labels resolve and stay consistent like an issue's: renaming or deleting a label updates the template", async () => {
  const t = (await newTemplate({ team: "WEB", name: "Feature", labels: ["Feature", "Type/Chore"] })).body;
  expect(t.labels).toEqual(["Feature", "Type/Chore"]);
  const feature = (await s.api("GET", "/api/labels")).body.find((l: any) => l.path === "Feature");
  await s.api("PATCH", `/api/labels/${feature.id}`, { name: "Enhancement" });
  expect((await template("Feature")).labels).toEqual(["Enhancement", "Type/Chore"]);
  await s.api("DELETE", `/api/labels/${feature.id}`);
  expect((await template("Feature")).labels).toEqual(["Type/Chore"]);
});

test("updating a template: name, title, description, status, priority and labels; team never changes", async () => {
  const t = await template("Blank");
  const res = await patchTemplate(t.id, { name: "Blank issue", title: "TBD", status: "in_progress", priority: 1, labels: ["urgent"] });
  expect(res.body).toMatchObject({ name: "Blank issue", title: "TBD", status: "in_progress", priority: 1, labels: ["urgent"] });
  // Unknown fields (team, workspace) are refused like any PATCH.
  expect((await patchTemplate(t.id, { team: "API" })).status).toBe(400);
  // A status outside the team's own workflow is refused, like an issue's.
  const bad = await patchTemplate(t.id, { status: "nope" });
  expect([bad.status, bad.body.error]).toEqual([400, 'Invalid status "nope" for WEB. Use one of: backlog, todo, in_progress, in_review, done, canceled, duplicate']);
  // Clearing status/priority back to "leave unset".
  expect((await patchTemplate(t.id, { status: null, priority: null })).body).toMatchObject({ status: null, priority: null });
  // Setting labels replaces the whole list, like an issue's: the old one is gone, not kept alongside the new one.
  expect((await patchTemplate(t.id, { labels: ["standalone"] })).body.labels).toEqual(["standalone"]);
});

test("a status deleted from the workflow later falls back to the team's default at use time", async () => {
  expect((await s.api("POST", "/api/teams/API/statuses", { name: "In QA", category: "started" })).status).toBe(201);
  const t = (await newTemplate({ team: "API", name: "QA pass", status: "in_qa" })).body;
  expect((await s.api("DELETE", "/api/teams/API/statuses/in_qa?moveTo=todo")).status).toBe(200);
  // The template still names the deleted key: applying it falls back to the team's default, not a 400.
  expect(await template("QA pass")).toMatchObject({ status: "in_qa" });
  const issue = await bot.tool("create_issue", { team: "API", template: t.id, title: "Check the fix" });
  expect(issue).toContain("· backlog ·"); // API's default status
});

test("deleting a template is for good, but never touches issues already made from it", async () => {
  const t = (await newTemplate({ team: "WEB", name: "Throwaway", title: "Kept title" })).body;
  const created = await s.api("POST", "/api/issues", { team: "WEB", template: t.id });
  expect(created.body.title).toBe("Kept title");
  const del = await s.api("DELETE", `/api/templates/${t.id}`);
  expect(del.body).toMatchObject({ name: "Throwaway" });
  expect(await template("Throwaway")).toBeUndefined();
  expect((await s.api("GET", `/api/issues/${created.body.id}`)).body.title).toBe("Kept title");
  // Using a deleted template's id is 404, like any other reference.
  expect((await s.api("POST", "/api/issues", { team: "WEB", template: t.id })).status).toBe(404);
});

test("a template applies only within its own team: another team's id is 404", async () => {
  const webOnly = (await newTemplate({ team: "WEB", name: "Web-only" })).body;
  const cross = await s.api("POST", "/api/issues", { team: "API", template: webOnly.id, title: "x" });
  expect(cross.status).toBe(404);
});

test("create_issue (MCP): template alone matches it exactly; explicit fields win", async () => {
  const t = (await newTemplate({ team: "WEB", name: "Chore", title: "Chore: ", description: "Routine.", status: "todo", priority: 3, labels: ["polish"] })).body;
  const plain = await bot.toolResult("create_issue", { team: "WEB", template: t.id });
  const plainIssue = plain.structuredContent!.issue;
  expect(plainIssue).toMatchObject({ title: "Chore:", description: "Routine.", status: "todo", priority: 3, labels: ["polish"] });
  // Title need not be passed at all once a template supplies one (MCP's title is optional).
  const overridden = await bot.toolResult("create_issue", { team: "WEB", template: t.id, priority: 1, title: "Chore: fix it" });
  const overriddenIssue = overridden.structuredContent!.issue;
  expect(overriddenIssue).toMatchObject({ title: "Chore: fix it", description: "Routine.", status: "todo", priority: 1, labels: ["polish"] });
  // No title anywhere (blank template, none passed) is still 400.
  const blank = (await newTemplate({ team: "WEB", name: "No title" })).body;
  await expect(bot.tool("create_issue", { team: "WEB", template: blank.id })).rejects.toThrow(/title is required/);
});

test("list_templates (MCP): one line per template, id · name · team", async () => {
  const list = await bot.tool("list_templates", { team: "WEB" });
  expect(list).toContain("· Bug report · WEB");
  expect(list).toContain("· Chore · WEB");
  expect(await bot.tool("list_templates", { team: "API" })).not.toContain("Bug report");
  await expect(bot.tool("list_templates", { team: "SID" })).rejects.toThrow(/not found/); // another workspace's team
});

test("only people manage templates; a template naming another workspace's team is 404", async () => {
  expect((await bot.api("POST", "/api/templates", { team: "WEB", name: "Bot's" })).status).toBe(403);
  const t = await template("Bug report");
  expect((await bot.api("PATCH", `/api/templates/${t.id}`, { name: "x" })).status).toBe(403);
  expect((await bot.api("DELETE", `/api/templates/${t.id}`)).status).toBe(403);
  // Another workspace's team, or a template of it, is 404: templates never cross workspaces.
  expect((await s.api("POST", "/api/templates", { team: "SID", name: "x" })).status).toBe(404);
  const sideTemplate = await s.as("admin", "cookie", "side").api("POST", "/api/templates", { team: "SID", name: "Side" });
  expect(sideTemplate.status).toBe(201);
  expect((await s.api("PATCH", `/api/templates/${sideTemplate.body.id}`, { name: "x" })).status).toBe(404);
  expect((await s.api("DELETE", `/api/templates/${sideTemplate.body.id}`)).status).toBe(404);
  expect(await templates()).not.toContainEqual(expect.objectContaining({ name: "Side" }));
});

test("any person manages templates, not just the workspace admin", async () => {
  const hers = await newTemplate({ team: "WEB", name: "Ana's" }, s.as("ana"));
  expect(hers.status).toBe(201);
  expect((await s.api("GET", "/api/templates?team=WEB")).body.map((t: any) => t.name)).toContain("Ana's");
});

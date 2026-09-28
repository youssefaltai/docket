// Projects (DKT-26): a body of work in one workspace spanning its teams, with milestones. Issues from any of its
// workspace's teams can join (their team joins too); an issue is in at most one project and one of its milestones;
// sub-issues inherit both; progress follows status categories; docs attach; everything stays inside the workspace.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let ana: Caller;
let bot: Caller;
let side: Caller; // the admin, acting in workspace "side"
beforeAll(async () => {
  s = await startServer();
  for (const key of ["WEB", "APP", "DSN"]) expect((await s.api("POST", "/api/teams", { key, name: key })).status).toBe(201);
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  side = s.as("admin", "cookie", "side");
  expect((await side.api("POST", "/api/teams", { key: "SID", name: "Side" })).status).toBe(201);
  ana = await s.user("ana");
  bot = await s.agent("bot");
  const launch = await s.api("POST", "/api/projects", { teams: ["WEB"], name: "Launch", lead: "ana", targetDate: "2026-12-01" });
  expect(launch.status).toBe(201);
});
afterAll(() => s.stop());

const issue = async (team: string, extra: object = {}, caller = s.admin) => {
  const res = await caller.api("POST", "/api/issues", { team, title: `In ${team}`, ...extra });
  expect(res.status).toBe(201);
  return res.body;
};
const project = async (slug: string) => (await s.api("GET", `/api/projects/${slug}`)).body;

test("creating a project: its slug, lead, date and team; bad input is refused", async () => {
  expect(await project("launch")).toMatchObject({
    slug: "launch",
    workspace: "acme",
    name: "Launch",
    status: "backlog",
    lead: { username: "ana", kind: "person" },
    teams: ["WEB"],
    targetDate: "2026-12-01",
    progress: 0,
    issueCount: 0,
    description: "",
    creator: { username: "admin" },
    milestones: [],
    docs: [],
  });
  const bad = async (body: object) => (await s.api("POST", "/api/projects", { name: "X", teams: ["WEB"], ...body })).status;
  expect(await bad({ teams: [] })).toBe(400);
  expect(await bad({ teams: ["WEB", "SID"] })).toBe(400); // SID is another workspace's: unknown here
  expect(await bad({ lead: "bot" })).toBe(400);
  expect(await bad({ targetDate: "2026-13-01" })).toBe(400);
  expect(await bad({ status: "done" })).toBe(400);
  expect(await bad({ name: " " })).toBe(400);
  expect(await bad({ slug: "launch" })).toBe(409);
  // A derived slug is deduped; another workspace can have its own "launch".
  expect((await s.api("POST", "/api/projects", { teams: ["APP"], name: "Launch" })).body.slug).toBe("launch-2");
  expect((await side.api("POST", "/api/projects", { teams: ["SID"], name: "Launch" })).body).toMatchObject({ slug: "launch", workspace: "side" });
});

test("projects stay in their workspace: others' are 404 and never listed; lists filter by team and status", async () => {
  expect((await side.api("POST", "/api/projects", { teams: ["SID"], name: "Side plan" })).status).toBe(201);
  expect((await ana.api("GET", "/api/projects/side-plan")).status).toBe(404);
  expect((await ana.api("GET", "/api/projects/side-plan", undefined, { "X-Docket-Workspace": "side" })).status).toBe(404);
  expect((await ana.api("PATCH", "/api/projects/side-plan", { name: "Mine" })).status).toBe(404);
  const listed = (await ana.api("GET", "/api/projects")).body.map((p: any) => p.slug);
  expect(listed).toContain("launch");
  expect(listed).not.toContain("side-plan");
  expect((await side.api("GET", "/api/projects")).body.every((p: any) => p.workspace === "side")).toBe(true);

  await s.api("POST", "/api/projects", { teams: ["DSN"], name: "Zeta", status: "in_progress" });
  await s.api("POST", "/api/projects", { teams: ["DSN"], name: "Alpha", status: "in_progress", targetDate: "2027-01-01" });
  await s.api("POST", "/api/projects", { teams: ["DSN"], name: "Beta", status: "planned" });
  // By lifecycle, then the nearest target date (none last), then name.
  expect((await s.api("GET", "/api/projects?team=DSN")).body.map((p: any) => p.name)).toEqual(["Beta", "Alpha", "Zeta"]);
  expect((await s.api("GET", "/api/projects?status=planned,paused")).body.map((p: any) => p.name)).toEqual(["Beta"]);
  expect((await s.api("GET", "/api/projects?team=SID")).status).toBe(400);
  expect((await s.api("GET", "/api/projects?status=done")).status).toBe(400);
});

test("an issue from any team of the workspace can join, adding its team; another workspace's can't", async () => {
  const socket = s.admin.ws();
  expect(await socket.opened).toBe(true);
  const app = await issue("APP", { project: "launch" });
  expect(app.project).toBe("launch");
  expect((await project("launch")).teams).toEqual(["APP", "WEB"]);
  await socket.until((e) => e.entity === "project" && e.id === "launch" && e.workspace === "acme");
  socket.close();
  // History records it; the list filter finds it.
  expect(app.activity.map((x: any) => x.kind)).toEqual(["created"]);
  const out = (await s.api("PATCH", `/api/issues/${app.id}`, { project: null })).body;
  expect(out.activity.at(-1)).toMatchObject({ kind: "project", from: "launch", to: null });
  const back = (await s.api("PATCH", `/api/issues/${app.id}`, { project: "LAUNCH" })).body;
  expect(back.activity.at(-1)).toMatchObject({ kind: "project", from: null, to: "launch" });
  expect((await s.api("GET", "/api/issues?project=launch")).body.map((i: any) => i.id)).toEqual([app.id]);
  expect((await s.api("GET", "/api/issues?project=nope")).status).toBe(400);

  const sid = await side.api("POST", "/api/issues", { team: "SID", title: "Elsewhere", project: "side-plan" });
  expect(sid.status).toBe(201);
  expect((await side.api("PATCH", `/api/issues/${sid.body.id}`, { project: "launch-2" })).body.error).toBe('Unknown project "launch-2"');
  expect((await s.api("POST", "/api/issues", { team: "WEB", title: "x", project: "side-plan" })).status).toBe(400);
});

test("milestones belong to one project: named there, cleared by a new project, and cleared from issues when deleted", async () => {
  const beta = await s.api("POST", "/api/projects/launch/milestones", { name: "Beta", targetDate: "2026-11-01" });
  expect(beta.status).toBe(201);
  expect(beta.body.milestones).toMatchObject([{ name: "Beta", targetDate: "2026-11-01", position: 1, progress: 0, issueCount: 0 }]);
  expect((await s.api("POST", "/api/projects/launch/milestones", { name: "beta" })).status).toBe(409);
  const ga = (await s.api("POST", "/api/projects/launch/milestones", { name: "GA" })).body.milestones;
  expect(ga.map((m: any) => [m.name, m.position])).toEqual([
    ["Beta", 1],
    ["GA", 2],
  ]);

  expect((await s.api("POST", "/api/issues", { team: "WEB", title: "x", milestone: "Beta" })).body.error).toMatch(/Set a project first/);
  expect((await s.api("POST", "/api/issues", { team: "WEB", title: "x", project: "launch", milestone: "Nope" })).body.error).toBe(
    'Unknown milestone "Nope" in launch',
  );
  const web = await issue("WEB", { project: "launch", milestone: "beta" });
  expect(web).toMatchObject({ project: "launch", milestone: "Beta" });

  // Another project clears it, unless the same patch names one of the new project's.
  const moved = (await s.api("PATCH", `/api/issues/${web.id}`, { project: "launch-2" })).body;
  expect(moved).toMatchObject({ project: "launch-2", milestone: null });
  expect(moved.activity.slice(-2)).toMatchObject([
    { kind: "project", from: "launch", to: "launch-2" },
    { kind: "milestone", from: "Beta", to: null },
  ]);
  expect((await s.api("PATCH", `/api/issues/${web.id}`, { project: "launch", milestone: "GA" })).body).toMatchObject({ project: "launch", milestone: "GA" });
  // The same project again keeps it; null clears both.
  expect((await s.api("PATCH", `/api/issues/${web.id}`, { project: "launch" })).body.milestone).toBe("GA");
  expect((await s.api("PATCH", `/api/issues/${web.id}`, { milestone: null })).body.milestone).toBeNull();
  await s.api("PATCH", `/api/issues/${web.id}`, { milestone: "Beta" });

  // Renaming shows on the issue; deleting clears it, logs it and publishes the issue.
  const betaId = beta.body.milestones[0].id;
  expect((await s.api("PATCH", `/api/projects/launch/milestones/${betaId}`, { name: "Public beta" })).status).toBe(200);
  expect((await s.api("GET", `/api/issues/${web.id}`)).body.milestone).toBe("Public beta");
  expect((await s.api("PATCH", `/api/projects/launch/milestones/${betaId}`, { name: "ga" })).status).toBe(409);
  const socket = s.admin.ws();
  expect(await socket.opened).toBe(true);
  const after = await s.api("DELETE", `/api/projects/launch/milestones/${betaId}`);
  expect(after.body.milestones.map((m: any) => m.name)).toEqual(["GA"]);
  await socket.until((e) => e.entity === "issue" && e.id === web.id);
  socket.close();
  const cleared = (await s.api("GET", `/api/issues/${web.id}`)).body;
  expect(cleared).toMatchObject({ project: "launch", milestone: null });
  expect(cleared.activity.at(-1)).toMatchObject({ kind: "milestone", from: "Public beta", to: null, actor: { username: "admin" } });
  expect((await s.api("DELETE", `/api/projects/launch/milestones/${betaId}`)).status).toBe(404);
  // A milestone id of another project is 404 there.
  const other = (await s.api("POST", "/api/projects/launch-2/milestones", { name: "M" })).body.milestones[0].id;
  expect((await s.api("PATCH", `/api/projects/launch/milestones/${other}`, { name: "x" })).status).toBe(404);
});

test("a sub-issue joins its parent's project and milestone unless told otherwise", async () => {
  await s.api("POST", "/api/projects/launch/milestones", { name: "RC" });
  const parent = await issue("WEB", { project: "launch", milestone: "RC" });
  expect(await issue("APP", { parent: parent.id })).toMatchObject({ project: "launch", milestone: "RC" });
  expect(await issue("APP", { parent: parent.id, milestone: "GA" })).toMatchObject({ project: "launch", milestone: "GA" });
  expect(await issue("APP", { parent: parent.id, project: null })).toMatchObject({ project: null, milestone: null });
  expect(await issue("APP", { parent: parent.id, project: "launch-2" })).toMatchObject({ project: "launch-2", milestone: null });
});

test("a moved issue keeps its project and milestone, and its new team joins the project", async () => {
  const web = await issue("WEB", { project: "launch", milestone: "GA" });
  expect((await project("launch")).teams).not.toContain("DSN");
  const moved = (await s.api("PATCH", `/api/issues/${web.id}`, { team: "DSN" })).body;
  expect(moved).toMatchObject({ team: "DSN", project: "launch", milestone: "GA" });
  expect((await project("launch")).teams).toContain("DSN");
});

test("progress counts completed 1 and started ½, leaves canceled out, and ignores the trash", async () => {
  await s.api("POST", "/api/projects", { teams: ["WEB"], name: "Progress" });
  await s.api("POST", "/api/projects/progress/milestones", { name: "One" });
  const ids: string[] = [];
  for (const status of ["done", "in_progress", "todo", "canceled"]) ids.push((await issue("WEB", { project: "progress", milestone: "One", status })).id);
  const counted = await project("progress");
  expect(counted).toMatchObject({ progress: 0.5, issueCount: 4, milestones: [{ progress: 0.5, issueCount: 4 }] });
  expect((await s.api("GET", "/api/projects?team=WEB")).body.find((p: any) => p.slug === "progress").progress).toBe(0.5);
  // In review is started too; a trashed issue leaves the count.
  await s.api("PATCH", `/api/issues/${ids[2]}`, { status: "in_review" });
  expect((await project("progress")).progress).toBeCloseTo(2 / 3);
  await s.api("DELETE", `/api/issues/${ids[0]}`);
  expect(await project("progress")).toMatchObject({ progress: 0.5, issueCount: 3 });
  // All canceled: nothing to count.
  for (const id of ids.slice(1, 3)) await s.api("PATCH", `/api/issues/${id}`, { status: "canceled" });
  expect(await project("progress")).toMatchObject({ progress: 0, issueCount: 3 });
});

test("teams: a team with issues in the project stays; an empty list is refused", async () => {
  const res = await s.api("PATCH", "/api/projects/launch", { teams: ["WEB"] });
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/^\d+ APP issues? (is|are) in this project$/);
  expect((await s.api("PATCH", "/api/projects/launch", { teams: [] })).status).toBe(400);
  // A team with none can come and go.
  expect((await s.api("PATCH", "/api/projects/launch-2", { teams: ["APP", "DSN"] })).body.teams).toEqual(["APP", "DSN"]);
  expect((await s.api("PATCH", "/api/projects/launch-2", { teams: ["APP"] })).body.teams).toEqual(["APP"]);
});

test("the description saves with baseUpdatedAt: a stale save is 409 and changes nothing", async () => {
  const read = await project("launch");
  const saved = await s.api("PATCH", "/api/projects/launch", { description: "Ship it", baseUpdatedAt: read.updatedAt });
  expect(saved.status).toBe(200);
  expect(saved.body.updatedAt > read.updatedAt).toBe(true);
  const stale = await ana.api("PATCH", "/api/projects/launch", { description: "Mine", baseUpdatedAt: read.updatedAt });
  expect(stale).toMatchObject({ status: 409, body: { error: "Project changed since you read it" } });
  expect((await project("launch")).description).toBe("Ship it");
  expect((await ana.api("PATCH", "/api/projects/launch", { status: "in_progress", lead: null, targetDate: null })).body).toMatchObject({
    status: "in_progress",
    lead: null,
    targetDate: null,
  });
});

test("PATCH bodies are strict", async () => {
  expect((await s.api("PATCH", "/api/projects/launch", { slug: "x" })).body.error).toBe("A project's slug never changes");
  expect((await s.api("PATCH", "/api/projects/launch", { foo: 1 })).body.error).toMatch(/"foo"/);
  const id = (await project("launch")).milestones[0].id;
  expect((await s.api("PATCH", `/api/projects/launch/milestones/${id}`, { foo: 1 })).status).toBe(400);
  expect((await s.api("PATCH", `/api/projects/launch/milestones/${id}`, { targetDate: "soon" })).status).toBe(400);
});

test("docs attach to a project of their workspace, show on it, and keep it when they move team", async () => {
  const doc = await s.api("POST", "/api/documents", { team: "APP", title: "Launch plan", project: "launch" });
  expect(doc.body).toMatchObject({ slug: "launch-plan", team: "APP", project: "launch" });
  expect((await project("launch")).docs.map((d: any) => d.slug)).toEqual(["launch-plan"]);
  expect((await s.api("GET", "/api/documents?project=launch")).body.map((d: any) => d.slug)).toEqual(["launch-plan"]);
  expect((await s.api("GET", "/api/documents?project=nope")).status).toBe(400);
  expect((await s.api("PATCH", "/api/documents/launch-plan", { team: "WEB" })).body).toMatchObject({ team: "WEB", project: "launch" });
  expect((await s.api("PATCH", "/api/documents/launch-plan", { project: null })).body.project).toBeNull();
  expect((await project("launch")).docs).toEqual([]);
  expect((await s.api("POST", "/api/documents", { team: "WEB", title: "x", project: "side-plan" })).status).toBe(400);
  expect((await side.api("POST", "/api/documents", { team: "SID", title: "Side doc", project: "launch-2" })).status).toBe(400);
  expect((await side.api("POST", "/api/documents", { team: "SID", title: "Side doc", project: "side-plan" })).body.project).toBe("side-plan");
});

test("MCP: agents create projects and milestones, put issues in them and read them back; a read key can't write", async () => {
  expect(await bot.tool("create_project", { teams: ["WEB", "APP"], name: "Agent work", lead: "ana", targetDate: "2027-02-01" })).toMatch(
    /^Created project agent-work\nagent-work · Agent work · backlog · 0% · @ana · target 2027-02-01 · teams APP, WEB$/,
  );
  expect(await bot.tool("create_milestone", { project: "agent-work", name: "Alpha" })).toMatch(/Alpha/);
  const created = await bot.tool("create_issue", { team: "WEB", title: "Wire it", status: "in_progress" });
  const id = created.match(/^Created (\S+)/)![1]!;
  await bot.tool("update_issue", { id, project: "agent-work", milestone: "Alpha" });
  expect(await bot.tool("get_issue", { id })).toMatch(/project agent-work · milestone Alpha/);
  expect(await bot.tool("list_issues", { project: "agent-work" })).toMatch(new RegExp(`^${id} · in_progress`));
  const got = await bot.tool("get_project", { slug: "agent-work" });
  expect(got).toMatch(/50%/);
  expect(got).toMatch(/## Milestones\nAlpha · 50% of 1 issue/);
  expect(await bot.tool("list_projects", { team: "APP" })).toMatch(/agent-work · Agent work/);
  await bot.tool("update_milestone", { project: "agent-work", milestone: "alpha", name: "Alpha 1" });
  expect((await bot.tool("update_project", { slug: "agent-work", status: "in_progress" }))).toMatch(/in_progress/);
  expect(await bot.tool("get_issue", { id })).toMatch(/milestone Alpha 1/);
  await expect(bot.tool("update_project", { slug: "agent-work", teams: ["APP"] })).rejects.toThrow(/WEB issue is in this project/);
  await bot.tool("create_document", { team: "WEB", title: "Agent notes", content: "x", project: "agent-work" });
  expect((await project("agent-work")).docs.map((d: any) => d.slug)).toEqual(["agent-notes"]);

  const ro = s.with({ token: (await ana.api("POST", "/api/api-keys", { name: "ro", scope: "read" })).body.token });
  await expect(ro.tool("create_project", { teams: ["WEB"], name: "Nope" })).rejects.toThrow(/not found/);
  expect(await ro.tool("list_projects")).toMatch(/agent-work/);
  expect((await ro.api("POST", "/api/projects", { teams: ["WEB"], name: "Nope" })).status).toBe(403);
});

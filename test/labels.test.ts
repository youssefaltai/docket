// Labels as entities (DKT-19): a workspace's or one team's own, with a color, optionally in a group where an issue
// takes one. Issues still name them by path ("Bug", "Type/Bug"); unknown names create workspace labels; renames
// show on every issue; only people manage them, only in their workspace.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

const LABEL_COLORS = ["#357fd4", "#35d48a", "#d48a35", "#7f35d4", "#d43550", "#35c4d4", "#d4b435", "#354ad4", "#d45535", "#d435d4"];

let s: TestServer;
let ana: Caller;
let bot: Caller;
beforeAll(async () => {
  s = await startServer();
  for (const key of ["WEB", "API"]) expect((await s.api("POST", "/api/teams", { key, name: key })).status).toBe(201);
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  expect((await s.as("admin", "cookie", "side").api("POST", "/api/teams", { key: "SID", name: "Side" })).status).toBe(201);
  ana = await s.user("ana");
  bot = await s.agent("bot");
});
afterAll(() => s.stop());

const create = async (team: string, labels: string[], caller = s.admin) => {
  const res = await caller.api("POST", "/api/issues", { team, title: "An issue", labels });
  expect(res.status).toBe(201);
  return res.body;
};
const labels = async (query = "", caller = s.admin) => (await caller.api("GET", `/api/labels${query}`)).body as any[];
const label = async (path: string) => (await labels()).find((l) => l.path === path);
const issue = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body;
const newLabel = (body: Record<string, unknown>, caller = s.admin) => caller.api("POST", "/api/labels", body);
const patchLabel = async (path: string, body: Record<string, unknown>, caller = s.admin) =>
  caller.api("PATCH", `/api/labels/${(await label(path)).id}`, body);

test("naming labels creates them: a workspace label, and Group/Label its group and label", async () => {
  const ws = s.admin.ws();
  expect(await ws.opened).toBe(true);
  const created = await create("WEB", ["Bug", "Type/Feature"]);
  expect(created.labels).toEqual(["Bug", "Type/Feature"]);
  expect(await label("Bug")).toMatchObject({ workspace: "acme", team: null, name: "Bug", group: null, isGroup: false, open: 1 });
  expect(LABEL_COLORS).toContain((await label("Bug")).color);
  expect(await label("Type")).toMatchObject({ name: "Type", group: null, isGroup: true, open: 1 });
  expect(await label("Type/Feature")).toMatchObject({ name: "Feature", group: "Type", isGroup: false, team: null });
  await ws.until((e) => e.entity === "label" && e.workspace === "acme");
  ws.close();
  // Names match case-insensitively: nothing new.
  const count = (await labels()).length;
  expect((await create("API", ["bug", "type/feature"])).labels).toEqual(["Bug", "Type/Feature"]);
  expect((await labels()).length).toBe(count);
  // Paths list sorted case-insensitively.
  expect((await create("API", ["zeta", "Alpha", "bug"])).labels).toEqual(["Alpha", "Bug", "zeta"]);
});

test("groups: never applied themselves, one label per group, and a bare name finds its grouped label", async () => {
  expect((await s.api("POST", "/api/issues", { team: "WEB", title: "x", labels: ["Type"] })).body.error).toBe(
    "Type is a label group: pick one of its labels, e.g. Type/Feature",
  );
  const two = await s.api("POST", "/api/issues", { team: "WEB", title: "x", labels: ["Type/Feature", "Type/Chore"] });
  expect([two.status, two.body.error]).toEqual([400, "Only one label per group: Type/Feature, Type/Chore"]);
  expect(await label("Type/Chore")).toBeUndefined(); // the refused write created nothing
  expect((await create("WEB", ["Feature"])).labels).toEqual(["Type/Feature"]);
  await create("WEB", ["Effort/High"]);
  await create("WEB", ["Impact/High"]);
  const ambiguous = await s.api("POST", "/api/issues", { team: "WEB", title: "x", labels: ["High"] });
  expect([ambiguous.status, ambiguous.body.error]).toEqual([400, '"High" is ambiguous: Effort/High or Impact/High']);
  expect((await s.api("POST", "/api/issues", { team: "WEB", title: "x", labels: ["Bug/Big"] })).body.error).toBe("Bug is a label, not a group");
});

test("a team's own labels go only on its issues; rescoping never strands an issue", async () => {
  expect((await newLabel({ name: "design", team: "WEB" })).body).toMatchObject({ path: "design", team: "WEB", open: 0 });
  const other = await s.api("POST", "/api/issues", { team: "API", title: "x", labels: ["design"] });
  expect([other.status, other.body.error]).toEqual([400, 'Label "design" belongs to team WEB']);
  expect((await create("WEB", ["design"])).labels).toEqual(["design"]);
  // Only workspace labels and WEB's own are usable on WEB's issues.
  expect((await labels("?team=API")).map((l) => l.path)).not.toContain("design");
  expect((await labels("?team=WEB")).map((l) => l.path)).toContain("design");
  expect((await s.api("GET", "/api/labels?team=NOPE")).status).toBe(400);
  // Bug is on API issues: it can't become WEB's.
  const stranded = await patchLabel("Bug", { team: "WEB" });
  expect([stranded.status, stranded.body.error]).toEqual([409, "Used on 2 issues outside WEB"]);
  // A group moves with its labels.
  await create("WEB", ["Area/Front"]);
  expect((await patchLabel("Area", { team: "WEB" })).body.team).toBe("WEB");
  expect(await label("Area/Front")).toMatchObject({ team: "WEB" });
  expect((await s.api("POST", "/api/issues", { team: "API", title: "x", labels: ["Area/Back"] })).body.error).toBe("Label group Area belongs to team WEB");
  expect((await patchLabel("Area", { team: null })).body.team).toBeNull();
});

test("managing labels: names, groups, scopes, colors and paths are checked", async () => {
  const rules: [Record<string, unknown>, number, string][] = [
    [{ name: "x", group: "Type", team: "WEB" }, 400, "A label's scope is its group's: Type is a workspace group"],
    [{ name: "Sub", group: "Type", isGroup: true }, 400, "A group can't be in a group"],
    [{ name: "a/b" }, 400, "Use a group for Group/Label: a label's name can't contain /"],
    [{ name: "feature", group: "Type" }, 409, 'Label "Type/feature" already exists'],
    [{ name: "bug" }, 409, 'Label "bug" already exists'],
    [{ name: "Red", color: "red" }, 400, 'Invalid color "red": use #rrggbb, e.g. #5e6ad2'],
    [{ name: "x", group: "Nope" }, 400, 'Unknown label group "Nope"'],
    [{ name: "x", workspace: "side" }, 400, "Labels are created in the workspace you're in"],
  ];
  for (const [body, status, error] of rules) {
    const res = await newLabel(body);
    expect([res.status, res.body.error]).toEqual([status, error]);
  }
  const chore = await newLabel({ name: "Chore", group: "Type", color: "#123abc" });
  expect(chore.body).toMatchObject({ path: "Type/Chore", color: "#123abc", team: null });
  expect((await newLabel({ name: "Priority", isGroup: true })).body).toMatchObject({ isGroup: true, path: "Priority" });
  expect((await patchLabel("Type/Chore", { isGroup: true })).status).toBe(400);
  expect((await patchLabel("Type/Chore", { color: "#00ff00" })).body.color).toBe("#00ff00");
  expect((await patchLabel("Type/Chore", { name: "x/y" })).status).toBe(400);
  expect((await patchLabel("Type", { group: "Priority" })).body.error).toBe("A group can't be in a group");
});

test("renaming or regrouping shows on every issue and bumps it; a stale write is refused", async () => {
  const one = await create("WEB", ["Defectless", "Type/Feature"]);
  const ws = s.admin.ws();
  expect(await ws.opened).toBe(true);
  await Bun.sleep(5);
  expect((await patchLabel("Defectless", { name: "Defect" })).body.path).toBe("Defect");
  const renamed = await issue(one.id);
  expect(renamed.labels).toEqual(["Defect", "Type/Feature"]);
  expect(renamed.updatedAt > one.updatedAt).toBe(true);
  await ws.until((e) => e.entity === "label");
  await ws.until((e) => e.entity === "issue" && e.id === one.id);
  ws.close();
  // History keeps the names as they were.
  expect(renamed.activity.filter((r: any) => r.kind === "labels")).toEqual([]);
  const stale = await s.api("PATCH", `/api/issues/${one.id}`, { labels: ["Defectless"], baseUpdatedAt: one.updatedAt });
  expect(stale.status).toBe(409);
  // A group's rename shows on its labels' issues.
  expect((await patchLabel("Type", { name: "Kind" })).status).toBe(200);
  expect((await issue(one.id)).labels).toEqual(["Defect", "Kind/Feature"]);
  expect((await patchLabel("Kind", { name: "Type" })).status).toBe(200);
  // Moving a label into a group where an issue already has one is refused; out of it, the path changes.
  const clash = await patchLabel("Defect", { group: "Type" });
  expect([clash.status, clash.body.error]).toEqual([409, "1 issue already has a Type label"]);
  expect((await patchLabel("Type/Feature", { group: null })).body.path).toBe("Feature");
  expect((await issue(one.id)).labels).toEqual(["Defect", "Feature"]);
  expect((await patchLabel("Feature", { group: "Type" })).body.path).toBe("Type/Feature");
});

test("deleting a label takes it off every issue, logged; a group must be empty first", async () => {
  const one = await create("WEB", ["Doomed", "Bug"]);
  const trashed = await create("WEB", ["Doomed"]);
  await s.api("DELETE", `/api/issues/${trashed.id}`);
  const doomed = await label("Doomed");
  expect(doomed.open).toBe(1);
  const res = await s.api("DELETE", `/api/labels/${doomed.id}`);
  expect(res.body).toMatchObject({ path: "Doomed", open: 1 });
  const after = await issue(one.id);
  expect(after.labels).toEqual(["Bug"]);
  expect(after.activity.at(-1)).toMatchObject({ kind: "labels", from: ["Bug", "Doomed"], to: ["Bug"] });
  expect((await issue(trashed.id)).labels).toEqual([]);
  expect(await label("Doomed")).toBeUndefined();
  const group = await s.api("DELETE", `/api/labels/${(await label("Type")).id}`);
  expect([group.status, group.body.error]).toEqual([409, "Move or delete its labels first"]);
  const empty = await s.api("DELETE", `/api/labels/${(await label("Priority")).id}`);
  expect(empty.status).toBe(200);
});

test("filter: a label's name or path, or a group's name; one nobody uses finds nothing", async () => {
  const typed = (await s.api("GET", "/api/issues?label=type")).body.map((i: any) => i.labels);
  expect(typed.length).toBeGreaterThan(0);
  expect(typed.every((l: string[]) => l.some((p) => p.startsWith("Type/")))).toBe(true);
  expect((await s.api("GET", "/api/issues?label=feature")).body.length).toBe((await s.api("GET", "/api/issues?label=Type/Feature")).body.length);
  expect((await s.api("GET", "/api/issues?label=never-used")).body).toEqual([]);
});

test("bulk: adding Group/Label swaps the group's; removing takes a path or a grouped label's name", async () => {
  const one = await create("WEB", ["Type/Feature", "Bug"]);
  const bulk = (patch: Record<string, unknown>) => s.api("POST", "/api/issues/bulk", { ids: [one.id], patch });
  expect((await bulk({ addLabels: ["Type/Chore"] })).body.results[0].issue.labels).toEqual(["Bug", "Type/Chore"]);
  expect((await bulk({ removeLabels: ["chore", "BUG"] })).body.results[0].issue.labels).toEqual([]);
});

test("only people manage labels, in their workspace; agents still create them by naming them", async () => {
  const bug = await label("Bug");
  expect((await newLabel({ name: "Bot" }, bot)).status).toBe(403);
  expect((await bot.api("PATCH", `/api/labels/${bug.id}`, { name: "x" })).status).toBe(403);
  expect((await bot.api("DELETE", `/api/labels/${bug.id}`)).status).toBe(403);
  expect(await bot.tool("create_issue", { team: "WEB", title: "From bot", labels: ["agent-made"] })).toContain("#agent-made");
  expect(await label("agent-made")).toMatchObject({ team: null, open: 1 });
  // Members manage labels too.
  expect((await newLabel({ name: "ana-made" }, ana)).status).toBe(201);
  // Another workspace's labels: never listed, 404 by id, and its issues can't use this one's.
  const side = s.as("admin", "cookie", "side");
  const sideBug = await side.api("POST", "/api/issues", { team: "SID", title: "x", labels: ["Bug"] });
  expect(sideBug.body.labels).toEqual(["Bug"]);
  const sideLabel = (await labels("", side)).find((l) => l.path === "Bug");
  expect(sideLabel.id).not.toBe(bug.id);
  expect((await labels("", ana)).map((l) => l.id)).not.toContain(sideLabel.id);
  expect((await ana.api("PATCH", `/api/labels/${sideLabel.id}`, { name: "x" })).status).toBe(404);
  expect((await ana.api("DELETE", `/api/labels/${sideLabel.id}`)).status).toBe(404);
  expect((await newLabel({ name: "x", team: "SID" }, ana)).status).toBe(404);
});

test("MCP list_labels: path · color · team · open, without groups; team narrows it", async () => {
  const text = await s.tool("list_labels");
  const lines = text.split("\n");
  expect(lines.some((l) => /^Type\/Feature · #[0-9a-f]{6} · \d+ open$/.test(l))).toBe(true);
  expect(lines.some((l) => /^design · #[0-9a-f]{6} · team WEB · \d+ open$/.test(l))).toBe(true);
  expect(lines.some((l) => l.startsWith("Type ·"))).toBe(false);
  expect(await s.tool("list_labels", { team: "API" })).not.toContain("design");
});

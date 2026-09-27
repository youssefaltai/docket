// Team keys, identifiers and doc slugs are per workspace (DKT-6): the same BRD-1 and "plan" live in acme and
// side, each request acts in one workspace, and links made before URLs carried one still find their place.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let acme: Caller; // ana's session in acme
let side: Caller; // ana's session in side
beforeAll(async () => {
  s = await startServer();
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  await s.user("ana");
  await s.user("ana", { workspace: "side" });
  acme = s.as("ana", "cookie", "acme");
  side = s.as("ana", "cookie", "side");
  // OLD is made in side first, BRD in acme first: "oldest wins" isn't alphabetical.
  expect((await side.api("POST", "/api/teams", { key: "OLD", name: "Old in side" })).status).toBe(201);
  expect((await acme.api("POST", "/api/teams", { key: "OLD", name: "Old in acme" })).status).toBe(201);
  expect((await acme.api("POST", "/api/teams", { key: "BRD", name: "Board" })).status).toBe(201);
  expect((await side.api("POST", "/api/teams", { key: "BRD", name: "Board" })).status).toBe(201);
  expect((await side.api("POST", "/api/teams", { key: "SID", name: "Side only" })).status).toBe(201);
});
afterAll(() => s.stop());

test("the same team key, issue number and doc slug live in both workspaces, each resolving in its own", async () => {
  expect((await acme.api("POST", "/api/issues", { team: "BRD", title: "Acme one" })).body.id).toBe("BRD-1");
  expect((await side.api("POST", "/api/issues", { team: "brd", title: "Side one" })).body.id).toBe("BRD-1");
  expect((await acme.api("GET", "/api/issues/BRD-1")).body.title).toBe("Acme one");
  expect((await side.api("GET", "/api/issues/brd-1")).body.title).toBe("Side one");
  // Over MCP, a key's own workspace.
  expect(await s.as("ana", "bearer", "acme").tool("get_issue", { id: "BRD-1" })).toContain("Acme one");
  expect(await s.as("ana", "bearer", "side").tool("get_issue", { id: "BRD-1" })).toContain("Side one");

  const acmePlan = await acme.api("POST", "/api/documents", { team: "BRD", title: "Plan", content: "Ship BRD-1. See [plan](/doc/plan)." });
  const sidePlan = await side.api("POST", "/api/documents", { team: "BRD", title: "Plan", content: "Ship BRD-1." });
  expect([acmePlan.status, acmePlan.body.slug, sidePlan.status, sidePlan.body.slug]).toEqual([201, "plan", 201, "plan"]);
  expect((await acme.api("GET", "/api/documents/plan")).body.content).toContain("[plan](/doc/plan)");
  expect((await side.api("GET", "/api/documents/plan")).body.content).toBe("Ship BRD-1.");
  // Refs resolve in the doc's workspace, both ways.
  expect((await acme.api("GET", "/api/documents/plan")).body.issues.map((i: any) => i.title)).toEqual(["Acme one"]);
  expect((await side.api("GET", "/api/documents/plan")).body.issues.map((i: any) => i.title)).toEqual(["Side one"]);
  expect((await acme.api("GET", "/api/issues/BRD-1")).body.docs.map((d: any) => d.slug)).toEqual(["plan"]);
  expect((await acme.api("GET", "/api/teams")).body.map((t: any) => [t.key, t.workspace, t.counts.backlog, t.docCount])).toEqual([
    ["BRD", "acme", 1, 1],
    ["OLD", "acme", 0, 0],
  ]);
  expect((await side.api("GET", "/api/issues")).body.map((i: any) => i.title)).toEqual(["Side one"]);
});

test("a doc mentioning an issue before it exists links to it only in its own workspace", async () => {
  await side.api("POST", "/api/documents", { team: "SID", title: "Later", content: "Soon: BRD-2" });
  await acme.api("POST", "/api/issues", { team: "BRD", title: "Acme two" });
  expect((await side.api("GET", "/api/documents/later")).body.issues).toEqual([]);
  await side.api("POST", "/api/issues", { team: "BRD", title: "Side two" });
  expect((await side.api("GET", "/api/documents/later")).body.issues.map((i: any) => i.title)).toEqual(["Side two"]);
});

test("a 409 for a duplicate key or slug is within one workspace and never mentions another", async () => {
  const team = await acme.api("POST", "/api/teams", { key: "BRD", name: "Again" });
  expect([team.status, team.body.error]).toEqual([409, "Team key BRD is taken in this workspace"]);
  const doc = await acme.api("POST", "/api/documents", { team: "BRD", title: "Plan", slug: "plan" });
  expect([doc.status, doc.body.error]).toEqual([409, 'Slug "plan" is already taken']);
  // A slug or key only the other workspace uses is free.
  expect((await acme.api("POST", "/api/documents", { team: "BRD", title: "Later" })).body.slug).toBe("later");
  expect((await acme.api("POST", "/api/teams", { key: "SID", name: "Acme's SID" })).status).toBe(201);
  // TeamInput.workspace is optional, and must name the request's workspace.
  const elsewhere = await acme.api("POST", "/api/teams", { key: "ELS", workspace: "side", name: "Elsewhere" });
  expect([elsewhere.status, elsewhere.body.error]).toEqual([400, "Teams are created in the workspace you're in"]);
  expect((await acme.api("POST", "/api/teams", { key: "HER", workspace: "acme", name: "Here" })).status).toBe(201);
});

test("a parent, blocker or team from the other workspace can't be named: 404", async () => {
  await side.api("POST", "/api/issues", { team: "SID", title: "Side only" }); // SID-1 in side; acme's SID has none
  for (const body of [{ parent: "SID-1" }, { blockedBy: ["SID-1"] }]) {
    expect((await acme.api("POST", "/api/issues", { team: "BRD", title: "x", ...body })).status).toBe(404);
    expect((await acme.api("PATCH", "/api/issues/BRD-1", body)).status).toBe(404);
  }
  // A doc can't move to the other workspace's team (acme has no ZZZ; side's teams aren't named here).
  await side.api("POST", "/api/teams", { key: "ZZZ", name: "Side's" });
  expect((await acme.api("PATCH", "/api/documents/plan", { team: "ZZZ" })).status).toBe(404);
  expect((await acme.api("GET", "/api/teams/ZZZ/trash")).status).toBe(404);
});

test("each workspace's trash is its own", async () => {
  await side.api("DELETE", "/api/issues/BRD-2");
  expect((await acme.api("GET", "/api/teams/BRD/trash")).body.issues).toEqual([]);
  expect((await side.api("GET", "/api/teams/BRD/trash")).body.issues.map((i: any) => i.title)).toEqual(["Side two"]);
  expect((await acme.api("GET", "/api/issues/BRD-2")).body.deletedAt).toBeNull();
  await side.api("POST", "/api/issues/BRD-2/restore");
});

test("a session in several workspaces names one; naming one you aren't in is 404; one workspace needs no header", async () => {
  const bare = s.as("ana", "cookie");
  const none = await bare.api("GET", "/api/issues/BRD-1");
  expect([none.status, none.body.error]).toEqual([400, "Pick a workspace: send X-Docket-Workspace"]);
  for (const path of ["/api/teams", "/api/issues", "/api/labels", "/api/documents", "/api/documents/plan"]) {
    expect((await bare.api("GET", path)).status).toBe(400);
  }
  expect((await bare.api("GET", "/api/issues/BRD-1", undefined, { "X-Docket-Workspace": "nope" })).status).toBe(404);
  await s.api("POST", "/api/workspaces", { name: "Hidden", key: "hidden" });
  expect((await s.as("ana", "cookie", "hidden").api("GET", "/api/teams")).status).toBe(404);
  // Account routes need no workspace.
  expect((await bare.api("GET", "/api/me")).status).toBe(200);
  expect((await bare.api("GET", "/api/workspaces")).status).toBe(200);
  // Someone in just one workspace needs no header.
  const solo = await s.user("solo");
  expect((await solo.api("GET", "/api/issues/BRD-1")).body.title).toBe("Acme one");
});

test("GET /api/locate finds which of your workspaces an old link meant: the oldest match", async () => {
  const bare = s.as("ana", "cookie");
  const locate = async (query: string, who = bare) => {
    const res = await who.api("GET", `/api/locate?${query}`);
    return res.status === 200 ? res.body.workspace : res.status;
  };
  expect(await locate("issue=brd-1")).toBe("acme"); // both have it; acme's BRD is older
  expect(await locate("team=BRD")).toBe("acme");
  expect(await locate("team=old")).toBe("side"); // side's OLD is older
  expect(await locate("doc=plan")).toBe("acme");
  expect(await locate("doc=later")).toBe("side");
  expect(await locate("issue=SID-1")).toBe("side");
  expect(await locate("team=SID")).toBe("side");
  // The header doesn't narrow it.
  expect(await locate("issue=BRD-1", side)).toBe("acme");
  // Nowhere you are: 404, as for things that don't exist.
  const hidden = s.as("admin", "cookie", "hidden");
  await hidden.api("POST", "/api/teams", { key: "HID", name: "Hidden" });
  await hidden.api("POST", "/api/documents", { team: "HID", title: "Secret" });
  await hidden.api("POST", "/api/issues", { team: "HID", title: "Secret" });
  for (const query of ["team=HID", "doc=secret", "issue=HID-1", "issue=BRD-99", "doc=nope", "issue=garbage"]) {
    expect(await locate(query)).toBe(404);
  }
  // A key searches only its own workspace.
  expect(await locate("team=BRD", s.as("ana", "bearer", "side"))).toBe("side");
  // Exactly one of issue, doc or team.
  expect(await locate("")).toBe(400);
  expect(await locate("issue=BRD-1&team=BRD")).toBe(400);
});

test("the app shell answers under /<workspace>; unknown icons and API routes stay plain 404s", async () => {
  const get = (path: string) => fetch(new URL(path, s.url));
  for (const path of ["/acme", "/acme/issue/BRD-1", "/acme/doc/plan", "/acme/t/BRD/docs", "/acme/settings/account", "/issue/BRD-1", "/t/BRD", "/docs"]) {
    const res = await get(path);
    expect([path, res.status, res.headers.get("content-type")]).toEqual([path, 200, "text/html;charset=utf-8"]);
  }
  const icon = await get("/icons/nope");
  expect([icon.status, await icon.text()]).toEqual([404, "Not found"]);
  expect((await get("/icons/icon-192.png")).headers.get("content-type")).toBe("image/png");
  expect((await get("/sw.js")).headers.get("content-type")).toStartWith("text/javascript");
  const api = await get("/api/nope");
  expect(api.headers.get("content-type")).toStartWith("application/json");
  expect((await s.api("GET", "/api/nope")).status).toBe(404);
});

test("workspace keys can't be the app's own paths", async () => {
  const explicit = await s.api("POST", "/api/workspaces", { name: "Docs", key: "docs" });
  expect([explicit.status, explicit.body.error]).toEqual([400, 'Workspace key "docs" is reserved']);
  expect((await s.api("POST", "/api/workspaces", { name: "Settings", key: "SETTINGS" })).status).toBe(400);
  expect((await s.api("POST", "/api/workspaces", { name: "Docs" })).body.key).toBe("docs-2");
  expect((await s.api("POST", "/api/workspaces", { name: "T" })).body.key).toBe("t-2");
});

test("API answers vary by workspace, so no cache mixes them", async () => {
  expect((await acme.api("GET", "/api/issues")).headers.get("vary")).toContain("X-Docket-Workspace");
  expect((await s.anon.api("GET", "/api/me")).headers.get("vary")).toContain("X-Docket-Workspace");
});

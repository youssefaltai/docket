// Estimates (DKT-32): opt-in per team with a scale; an issue holds a 1-5 position in it. Off hides estimates without
// clearing them, a move keeps the position, and MCP matches REST.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  for (const key of ["EST", "OFF", "MCP"]) await s.api("POST", "/api/teams", { key, name: key });
});
afterAll(() => s.stop());

const create = async (team: string, extra: object = {}) => {
  const res = await s.api("POST", "/api/issues", { team, title: "Sized", ...extra });
  expect(res.status).toBe(201);
  return res.body;
};
const patch = (id: string, body: object) => s.api("PATCH", `/api/issues/${id}`, body);
const scale = (key: string, estimateScale: string | null) => s.api("PATCH", `/api/teams/${key}`, { estimateScale });
const get = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body;

test("estimates are off by default: a team without a scale refuses them; turning them on allows 1-5", async () => {
  const team = (await s.api("GET", "/api/teams")).body.find((t: any) => t.key === "OFF");
  expect(team.estimateScale).toBeNull();
  const issue = await create("OFF");
  expect(issue.estimate).toBeNull();
  for (const estimate of [3, null]) {
    const res = await patch(issue.id, { estimate });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Turn on estimates for this team first");
  }
  expect((await s.api("POST", "/api/issues", { team: "OFF", title: "x", estimate: 1 })).body.error).toBe("Turn on estimates for this team first");

  for (const bad of ["story-points", "", 3, true]) expect((await scale("OFF", bad as never)).status).toBe(400);
  expect((await scale("OFF", "linear")).body.estimateScale).toBe("linear");
  expect((await patch(issue.id, { estimate: 5 })).body.estimate).toBe(5);
  expect((await s.api("POST", "/api/teams", { key: "NEW", name: "New", estimateScale: "tshirt" })).body.estimateScale).toBe("tshirt");
});

test("an estimate round-trips through create, update and lists; null clears it; each change is history", async () => {
  expect((await scale("EST", "fibonacci")).body.estimateScale).toBe("fibonacci");
  const a = await create("EST", { estimate: 3 }); // shown as "3" on the fibonacci scale, "5" at position 4
  expect(a.estimate).toBe(3);
  expect((await get(a.id)).estimate).toBe(3);
  expect((await patch(a.id, { estimate: 4 })).body.estimate).toBe(4);
  expect((await patch(a.id, { title: "Renamed" })).body.estimate).toBe(4); // untouched by other edits
  expect((await s.api("GET", "/api/issues?team=EST")).body.find((i: any) => i.id === a.id).estimate).toBe(4);
  const cleared = (await patch(a.id, { estimate: null })).body;
  expect(cleared.estimate).toBeNull();
  await patch(a.id, { estimate: null }); // no change, no history
  expect((await get(a.id)).activity.filter((x: any) => x.kind === "estimate").map((x: any) => [x.from, x.to])).toEqual([
    [3, 4],
    [4, null],
  ]);
  expect(a.activity.map((x: any) => x.kind)).toEqual(["created"]); // setting one on creation is part of it
});

test("an estimate must be a whole position 1 to 5; a bad one is 400 and changes nothing", async () => {
  const a = await create("EST", { estimate: 2 });
  for (const estimate of [0, 6, -1, 2.5, "3", true, [1]]) {
    const res = await patch(a.id, { estimate });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("estimate must be a position in the team's scale, 1 to 5, or null");
    expect((await s.api("POST", "/api/issues", { team: "EST", title: "x", estimate })).status).toBe(400);
  }
  expect((await get(a.id)).estimate).toBe(2);
});

test("turning estimates off hides them without clearing; back on (any scale) shows them again", async () => {
  await scale("EST", "fibonacci");
  const a = await create("EST", { estimate: 4 });
  expect((await scale("EST", null)).body.estimateScale).toBeNull();
  expect((await get(a.id)).estimate).toBeNull();
  expect((await s.api("GET", "/api/issues?team=EST")).body.every((i: any) => i.estimate === null)).toBe(true);
  expect((await patch(a.id, { estimate: 1 })).status).toBe(400); // hidden values can't be changed either
  expect((await patch(a.id, { title: "Still editable" })).status).toBe(200);
  expect((await scale("EST", "tshirt")).body.estimateScale).toBe("tshirt");
  expect((await get(a.id)).estimate).toBe(4); // the same position: "L" now
  expect((await get(a.id)).activity.filter((x: any) => x.kind === "estimate")).toEqual([]); // hiding logs nothing
});

test("a moved issue keeps its position: hidden in a team without estimates, shown where they're on", async () => {
  await scale("EST", "linear");
  await s.api("POST", "/api/teams", { key: "BARE", name: "Bare" });
  const a = await create("EST", { estimate: 2 });
  const moved = (await patch(a.id, { team: "BARE" })).body;
  expect(moved.estimate).toBeNull();
  expect((await patch(moved.id, { team: "EST" })).body.estimate).toBe(2);
  // An estimate sent with a move is checked against the new team.
  expect((await patch(a.id, { team: "BARE", estimate: 3 })).body.error).toBe("Turn on estimates for this team first");
  await scale("BARE", "exponential");
  expect((await patch(a.id, { team: "BARE", estimate: 5 })).body).toMatchObject({ team: "BARE", estimate: 5 });
});

test("MCP: update_team sets the scale, issues take an estimate, get_issue shows the scale's value", async () => {
  expect(await s.tool("update_team", { key: "MCP", estimateScale: "fibonacci" })).toContain("Updated team MCP");
  expect(await s.tool("list_teams")).toContain("MCP · MCP · workspace");
  expect(await s.tool("list_teams")).toContain("estimates: fibonacci (1, 2, 3, 5, 8)");
  const id = /Created (MCP-\d+)/.exec(await s.tool("create_issue", { team: "MCP", title: "Agent sized", estimate: 4 }))![1]!;
  expect((await get(id)).estimate).toBe(4);
  const details = await s.tool("get_issue", { id });
  expect(details).toContain("· estimate 5 ·");
  await s.tool("update_issue", { id, estimate: 5 });
  expect((await get(id)).estimate).toBe(5);
  expect(await s.tool("get_issue", { id })).toContain("estimate 5 → 8");
  await s.tool("update_issue", { id, estimate: null });
  expect((await get(id)).estimate).toBeNull();
  expect(await s.tool("get_issue", { id })).toContain("team MCP · created by");
  // Out of range is refused by the schema; a team without estimates by the server, as over REST.
  await expect(s.tool("update_issue", { id, estimate: 6 })).rejects.toThrow();
  await expect(s.tool("create_issue", { team: "OFF", title: "x", estimate: 1 })).resolves.toBeString(); // OFF was turned on above
  await s.tool("update_team", { key: "MCP", estimateScale: null });
  await expect(s.tool("update_issue", { id, estimate: 2 })).rejects.toThrow("Turn on estimates for this team first");
  expect(await s.tool("list_teams")).not.toContain("estimates: fibonacci");
});

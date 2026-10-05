// The web app's permission checks (src/web/auth.ts can(), useCan): what /api/me says this session may do, in the
// workspace and in a team where they have a role of their own; and the role editor's groups cover the catalog once.
// Imports src/ on happy-dom, like new-issue.test.ts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { PERMISSIONS } from "../src/shared/types.ts";
import { startServer, type TestServer } from "./server.ts";

const dom = new Window({ url: "http://localhost/acme" });
const added = Object.getOwnPropertyNames(dom).filter((key) => !(key in globalThis));
for (const key of added) (globalThis as any)[key] = (dom as any)[key];
(globalThis as any).window = dom;
added.push("window");

const { can, loadMe, managesWorkspace } = await import("../src/web/auth.ts");
const { setCurrentWorkspace } = await import("../src/web/api.ts");
const { PERMISSION_GROUPS } = await import("../src/web/settings.tsx");

let s: TestServer;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "WEB", name: "Web" });
  await s.user("cal", { role: "guest", teams: ["WEB"] });
  await s.api("POST", "/api/roles", { key: "lead", name: "Lead", permissions: ["team.settings", "team.roles", "issues.write"] });
  await s.api("PATCH", "/api/teams/WEB/members/cal", { role: "lead" });
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await s.stop();
  await Bun.sleep(50);
  for (const key of added) delete (globalThis as any)[key];
  await dom.happyDOM.close();
});

/** Signs the web app in as `username`: getMe() is what /api/me tells their session. */
async function signIn(username: string) {
  globalThis.fetch = realFetch;
  const me = (await s.as(username, "cookie", "acme").api("GET", "/api/me")).body;
  globalThis.fetch = (async () => new Response(JSON.stringify(me), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  await loadMe();
  setCurrentWorkspace("acme");
}

test("a guest with a role of their own in a team: its permissions there, the guest's elsewhere", async () => {
  await signIn("cal");
  expect(can("workspace.browse")).toBeFalse();
  expect(can("team.settings")).toBeFalse();
  expect(can("team.settings", "WEB")).toBeTrue();
  expect(can("team.roles", "WEB")).toBeTrue();
  expect(can("labels.team", "WEB")).toBeFalse(); // the guest role has it; the team's role replaces it there
  expect(can("labels.team", "OPS")).toBeTrue();
  expect(managesWorkspace()).toBeFalse();
  setCurrentWorkspace("other");
  expect(can("issues.write")).toBeFalse(); // not a member there
});

test("an admin may do everything and manages the workspace", async () => {
  await signIn("admin");
  expect(PERMISSIONS.filter((p) => !can(p) || !can(p, "WEB"))).toEqual([]);
  expect(managesWorkspace()).toBeTrue();
});

test("the role editor lists every permission once", () => {
  expect(PERMISSION_GROUPS.flatMap(([, ps]) => ps).sort()).toEqual([...PERMISSIONS].sort());
});

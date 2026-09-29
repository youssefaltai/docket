// The new-issue form's request (src/web/modals.tsx): an untouched estimate is left out, because the server refuses
// `estimate: null` on a team with estimates off (SPEC.md, Estimates). Imports src/ on happy-dom, like markdown.test.ts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { startServer, type TestServer } from "./server.ts";

const dom = new Window({ url: "http://localhost/acme" });
const added = Object.getOwnPropertyNames(dom).filter((key) => !(key in globalThis));
for (const key of added) (globalThis as any)[key] = (dom as any)[key];
(globalThis as any).window = dom;
added.push("window");

const { newIssueInput } = await import("../src/web/modals.tsx");

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "OFF", name: "Off" });
  await s.api("POST", "/api/teams", { key: "EST", name: "Est", estimateScale: "fibonacci" });
});
afterAll(async () => {
  await s.stop();
  await Bun.sleep(50);
  for (const key of added) delete (globalThis as any)[key];
  await dom.happyDOM.close();
});

/** A draft as the modal starts out: nothing chosen. */
const draft = (team: string, estimate: number | null = null) => ({
  team,
  title: " Sized ",
  description: "",
  status: "backlog",
  priority: 0 as const,
  estimate,
  labels: [],
  assignee: null,
  parent: null,
  project: null,
  cycle: null,
});

// Sent as the browser does: JSON, where undefined fields vanish.
const send = (team: string, estimate: number | null = null) =>
  s.api("POST", "/api/issues", JSON.parse(JSON.stringify(newIssueInput(draft(team, estimate)))));

test("an issue with no estimate is created in a team with estimates off, and on", async () => {
  for (const team of ["OFF", "EST"]) {
    const res = await send(team);
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Sized");
    expect(res.body.estimate).toBeNull();
  }
});

test("a chosen estimate is still sent", async () => {
  expect((await send("EST", 3)).body.estimate).toBe(3);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer, type TestServer } from "./server.ts";

const script = join(import.meta.dir, "..", "scripts", "seed.ts");
let s: TestServer;
beforeAll(async () => {
  s = await startServer();
});
afterAll(() => s.stop());

// Not s.cli: that runs with the server's own env. Seeding is what's under test, so it
// gets its credentials the way a real caller would, over DOCKET_URL / DOCKET_API_KEY.
const seed = async () => {
  const proc = Bun.spawn(["bun", script], {
    env: { PATH: process.env.PATH!, DOCKET_URL: s.url, DOCKET_API_KEY: s.admin.token! },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, err };
};

test("seeds an empty Docket", async () => {
  expect(await seed()).toEqual({ code: 0, err: "" });
  const { body: issues } = await s.api("GET", `/api/issues?workspace=${s.workspace}`);
  expect(issues).toHaveLength(9);
  const { body: docs } = await s.api("GET", `/api/documents?workspace=${s.workspace}`);
  expect(docs).toHaveLength(2);
});

test("refuses a Docket that has data", async () => {
  const { code, err } = await seed();
  expect(code).toBe(1);
  expect(err).toContain("seed only runs against an empty Docket");
  expect((await s.api("GET", "/api/issues")).body).toHaveLength(9);
});

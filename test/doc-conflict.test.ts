// A doc's updatedAt is its version token: saves in the same millisecond must still get distinct ones.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "DOC", workspace: s.workspace, name: "Docs" });
});
afterAll(() => s.stop());

// A burst of concurrent saves lands many of them in the same millisecond.
const burst = (slug: string, n: number, base?: string) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      s.api("PATCH", `/api/documents/${slug}`, { content: `edit ${i}`, baseUpdatedAt: base }),
    ),
  );

test("every save moves updatedAt forward", async () => {
  await s.api("POST", "/api/documents", { team: "DOC", title: "Burst" });
  const saves = await burst("burst", 30);
  const stamps = saves.map((r) => r.body.updatedAt as string).sort();
  expect(new Set(stamps).size).toBe(stamps.length);
});

test("only one of many writers from the same base wins", async () => {
  const { body: doc } = await s.api("POST", "/api/documents", { team: "DOC", title: "Race" });
  const saves = await burst("race", 30, doc.updatedAt);
  expect(saves.filter((r) => r.status === 200)).toHaveLength(1);
  expect(saves.filter((r) => r.status === 409)).toHaveLength(29);
});

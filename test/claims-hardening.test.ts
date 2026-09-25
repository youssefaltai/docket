// Claims and issue versions under pressure: two server processes on one database (so the races go through
// SQLite's locks, not just one JS thread), every issue bump path, and each slot taking only its kind of member.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

const N = 20;

describe("two server processes on one database", () => {
  let a: TestServer;
  let b: TestServer;
  beforeAll(async () => {
    a = await startServer();
    b = await startServer({ sharing: a });
    await a.agent("alpha");
    await a.agent("beta");
    await a.user("ana");
    await a.user("bo");
    await a.api("POST", "/api/teams", { key: "RACE", workspace: "acme", name: "Race" });
    for (let i = 0; i < N + 1; i++) await a.api("POST", "/api/issues", { team: "RACE", title: `Issue ${i + 1}` });
  });
  afterAll(async () => {
    await b.stop();
    await a.stop();
  });

  test("of two claims racing across processes for each slot, exactly one wins it on every issue", async () => {
    const ids = Array.from({ length: N }, (_, i) => `RACE-${i + 1}`);
    const claim = (s: TestServer, who: string, slot: string, id: string) =>
      s.as(who).api("POST", `/api/issues/${id}/claim`, {}).then((r) => ({ id, who, slot, ...r }));
    const results = await Promise.all(
      ids.flatMap((id) => [
        claim(a, "alpha", "delegate", id),
        claim(b, "beta", "delegate", id),
        claim(a, "ana", "assignee", id),
        claim(b, "bo", "assignee", id),
      ]),
    );
    for (const id of ids) {
      const { body } = await b.api("GET", `/api/issues/${id}`);
      expect(body.status).toBe("in_progress");
      for (const slot of ["delegate", "assignee"]) {
        const pair = results.filter((r) => r.id === id && r.slot === slot);
        const won = pair.filter((r) => r.status === 200);
        const lost = pair.filter((r) => r.status === 409);
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect(lost[0]!.body.error).toBe(`${id} is claimed by ${won[0]!.who}`);
        expect(body[slot].username).toBe(won[0]!.who);
      }
    }
  });

  test("of many writers from one base across processes, exactly one wins", async () => {
    const id = `RACE-${N + 1}`;
    const base = (await a.api("GET", `/api/issues/${id}`)).body.updatedAt;
    const saves = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).api("PATCH", `/api/issues/${id}`, { title: `edit ${i}`, baseUpdatedAt: base }),
      ),
    );
    expect(saves.filter((r) => r.status === 200)).toHaveLength(1);
    expect(saves.filter((r) => r.status === 409)).toHaveLength(19);
  });
});

describe("every issue bump path moves the version", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer();
    await s.api("POST", "/api/teams", { key: "VER", workspace: "acme", name: "Ver" });
    await s.api("POST", "/api/issues", { team: "VER", title: "Parent" }); // VER-1
    await s.api("POST", "/api/issues", { team: "VER", title: "Blocker" }); // VER-2
  });
  afterAll(() => s.stop());

  const version = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body.updatedAt as string;

  /** Runs `change`, then checks each issue's version moved and a patch from the old version is refused. */
  async function bumps(ids: string[], change: () => Promise<unknown>) {
    const before = await Promise.all(ids.map(version));
    await change();
    for (const [i, id] of ids.entries()) {
      expect((await version(id)) > before[i]!).toBeTrue();
      expect((await s.api("PATCH", `/api/issues/${id}`, { title: "stale", baseUpdatedAt: before[i] })).status).toBe(409);
    }
  }

  test("setting a parent and a blocker bumps them", async () => {
    await s.api("POST", "/api/issues", { team: "VER", title: "Child" }); // VER-3
    await bumps(["VER-1", "VER-2"], () => s.api("PATCH", "/api/issues/VER-3", { parent: "VER-1", blockedBy: ["VER-2"] }));
  });

  test("comment added, edited and deleted each bump the issue", async () => {
    let cid = 0;
    await bumps(["VER-3"], async () => {
      const { body } = await s.api("POST", "/api/issues/VER-3/comments", { body: "a" });
      cid = body.comments.at(-1).id;
    });
    await bumps(["VER-3"], () => s.api("PATCH", `/api/issues/VER-3/comments/${cid}`, { body: "b" }));
    await bumps(["VER-3"], () => s.api("DELETE", `/api/issues/VER-3/comments/${cid}`));
  });

  test("deleting an issue bumps its parent and its blocker", async () => {
    await bumps(["VER-1", "VER-2"], () => s.api("DELETE", "/api/issues/VER-3"));
  });
});

describe("the assignee is a person and the delegate an agent", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer();
    await s.user("ana");
    await s.agent("bot");
    await s.api("POST", "/api/teams", { key: "SLT", workspace: "acme", name: "Slots" });
    await s.api("POST", "/api/issues", { team: "SLT", title: "One" }); // SLT-1
  });
  afterAll(() => s.stop());

  const refused = (r: { status: number; body: any }) => {
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(typeof r.body.error).toBe("string");
  };

  test("REST refuses the wrong kind, a non-member, and a mismatched \"me\", and nothing changes", async () => {
    refused(await s.api("POST", "/api/issues", { team: "SLT", title: "x", assignee: "bot" }));
    refused(await s.api("POST", "/api/issues", { team: "SLT", title: "x", delegate: "ana" }));
    refused(await s.api("POST", "/api/issues", { team: "SLT", title: "x", assignee: "nobody" }));
    refused(await s.api("PATCH", "/api/issues/SLT-1", { assignee: "bot" }));
    refused(await s.api("PATCH", "/api/issues/SLT-1", { delegate: "ana" }));
    refused(await s.api("PATCH", "/api/issues/SLT-1", { delegate: "nobody" }));
    refused(await s.as("ana").api("POST", "/api/issues", { team: "SLT", title: "x", delegate: "me" }));
    refused(await s.as("ana").api("PATCH", "/api/issues/SLT-1", { delegate: "me" }));
    refused(await s.as("bot").api("POST", "/api/issues", { team: "SLT", title: "x", assignee: "me" }));
    refused(await s.as("bot").api("PATCH", "/api/issues/SLT-1", { assignee: "me" }));
    const { body } = await s.api("GET", "/api/issues?team=SLT");
    expect(body.map((i: any) => [i.id, i.assignee, i.delegate])).toEqual([["SLT-1", null, null]]);
  });

  test("MCP refuses the same, and the right kind of \"me\" works", async () => {
    for (const [caller, name, args] of [
      ["admin", "create_issue", { team: "SLT", title: "x", assignee: "bot" }],
      ["admin", "update_issue", { id: "SLT-1", delegate: "ana" }],
      ["ana", "create_issue", { team: "SLT", title: "x", delegate: "me" }],
      ["ana", "update_issue", { id: "SLT-1", delegate: "me" }],
      ["bot", "create_issue", { team: "SLT", title: "x", assignee: "me" }],
      ["bot", "update_issue", { id: "SLT-1", assignee: "me" }],
    ] as const) {
      await expect(s.as(caller).tool(name, args)).rejects.toThrow();
    }
    expect(await s.as("ana").tool("create_issue", { team: "SLT", title: "mine", assignee: "me" })).toContain("@ana");
    expect(await s.as("bot").tool("create_issue", { team: "SLT", title: "mine", delegate: "me" })).toContain("→@bot");
  });
});

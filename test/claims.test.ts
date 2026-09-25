import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;

beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "CLM", workspace: "acme", name: "Claims" });
  for (const title of ["Agents race", "Done already", "People race", "Versioned", "Mine"]) {
    await s.api("POST", "/api/issues", { team: "CLM", title });
  }
  await s.api("PATCH", "/api/issues/CLM-2", { status: "done" });
  await s.agent("alpha");
  await s.agent("beta");
  await s.user("ana");
  await s.user("bo");
});
afterAll(() => s.stop());

test("two agents racing for one issue: exactly one gets the delegate slot", async () => {
  const results = await Promise.allSettled([
    s.as("alpha").tool("claim_issue", { id: "CLM-1" }),
    s.as("beta").tool("claim_issue", { id: "CLM-1" }),
  ]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  const { body } = await s.api("GET", "/api/issues/CLM-1");
  expect(body).toMatchObject({ status: "in_progress", assignee: null });
  expect(lost[0]!.reason.message).toBe(`CLM-1 is claimed by ${body.delegate.username}`);
});

test("two people racing for one issue: exactly one gets the assignee slot", async () => {
  const results = await Promise.all(
    ["ana", "bo"].map((who) => s.as(who).api("POST", "/api/issues/CLM-3/claim", {}).then((r) => ({ who, ...r }))),
  );
  const won = results.filter((r) => r.status === 200);
  const lost = results.filter((r) => r.status === 409);
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect(lost[0]!.body.error).toBe(`CLM-3 is claimed by ${won[0]!.who}`);
  const { body } = await s.api("GET", "/api/issues/CLM-3");
  expect(body).toMatchObject({ status: "in_progress", assignee: { username: won[0]!.who }, delegate: null });
});

test("an agent and a person each hold their own slot on one issue", async () => {
  // An agent claiming an assigned issue takes the delegate slot and leaves the assignee alone.
  const person = (await s.api("GET", "/api/issues/CLM-3")).body.assignee.username;
  const delegated = await s.as("alpha").api("POST", "/api/issues/CLM-3/claim", {});
  expect(delegated).toMatchObject({ status: 200, body: { assignee: { username: person }, delegate: { username: "alpha" } } });

  // A person claiming a delegated issue takes the assignee slot and leaves the delegate alone.
  const agent = (await s.api("GET", "/api/issues/CLM-1")).body.delegate.username;
  const assigned = await s.as("ana").api("POST", "/api/issues/CLM-1/claim", {});
  expect(assigned).toMatchObject({ status: 200, body: { assignee: { username: "ana" }, delegate: { username: agent } } });
  expect(await s.as("bo").api("POST", "/api/issues/CLM-1/claim", {})).toMatchObject({
    status: 409,
    body: { error: "CLM-1 is claimed by ana" },
  });
});

test("claiming your own again is fine; a closed issue can't be claimed", async () => {
  const holder = (await s.api("GET", "/api/issues/CLM-1")).body.delegate.username;
  const before = (await s.api("GET", "/api/issues/CLM-1")).body.updatedAt;
  expect(await s.as(holder).tool("claim_issue", { id: "clm-1" })).toStartWith("Claimed CLM-1");
  expect((await s.api("GET", "/api/issues/CLM-1")).body.updatedAt).toBe(before); // a no-op, not a bump

  expect(await s.as("alpha").api("POST", "/api/issues/CLM-2/claim", {})).toMatchObject({ status: 409, body: { error: "CLM-2 is done" } });
  expect(await s.as("ana").api("POST", "/api/issues/CLM-2/claim", {})).toMatchObject({ status: 409, body: { error: "CLM-2 is done" } });
});

test('"me" means the caller in filters and assignments', async () => {
  const alpha = s.as("alpha");
  expect((await alpha.api("PATCH", "/api/issues/CLM-5", { delegate: "me" })).body.delegate.username).toBe("alpha");
  const delegated = await alpha.api("GET", "/api/issues?delegate=me");
  expect(delegated.body.map((i: any) => i.id)).toContain("CLM-5");
  expect(delegated.body.every((i: any) => i.delegate?.username === "alpha")).toBeTrue();
  expect(await alpha.tool("list_issues", { delegate: "me" })).toContain("CLM-5");

  const ana = s.as("ana");
  expect((await ana.api("PATCH", "/api/issues/CLM-5", { assignee: "me" })).body.assignee.username).toBe("ana");
  const assigned = await ana.api("GET", "/api/issues?assignee=me");
  expect(assigned.body.map((i: any) => i.id)).toContain("CLM-5");
  expect(assigned.body.every((i: any) => i.assignee?.username === "ana")).toBeTrue();
  expect(await ana.tool("list_issues", { assignee: "me" })).toContain("CLM-5");

  // "me" is whoever asks: the admin holds nothing here, and a username finds the same issue.
  expect((await s.api("GET", "/api/issues?assignee=me")).body.map((i: any) => i.id)).not.toContain("CLM-5");
  expect((await s.api("GET", "/api/issues?assignee=ana")).body.map((i: any) => i.id)).toContain("CLM-5");
  expect((await s.api("GET", "/api/issues?delegate=alpha")).body.map((i: any) => i.id)).toContain("CLM-5");
});

test("baseUpdatedAt refuses a patch when the issue changed since it was read", async () => {
  const alpha = s.as("alpha");
  const read = (await s.api("GET", "/api/issues/CLM-4")).body;
  // Someone else comments in the meantime, which bumps the issue.
  await s.as("beta").api("POST", "/api/issues/CLM-4/comments", { body: "note" });
  const stale = await alpha.api("PATCH", "/api/issues/CLM-4", { labels: ["x"], baseUpdatedAt: read.updatedAt });
  expect(stale).toMatchObject({ status: 409, body: { error: "Issue changed since you read it" } });
  expect((await s.api("GET", "/api/issues/CLM-4")).body.labels).toEqual([]);

  const fresh = (await s.api("GET", "/api/issues/CLM-4")).body.updatedAt;
  expect((await alpha.api("PATCH", "/api/issues/CLM-4", { labels: ["x"], baseUpdatedAt: fresh })).body.labels).toEqual(["x"]);
  await expect(alpha.tool("update_issue", { id: "CLM-4", title: "t", baseUpdatedAt: fresh })).rejects.toThrow("changed since");
});

test("updated_at strictly increases, even for writes within a millisecond", async () => {
  const seen: string[] = [];
  for (let i = 0; i < 15; i++) seen.push((await s.api("PATCH", "/api/issues/CLM-4", { priority: (i % 4) + 1 })).body.updatedAt);
  for (let i = 0; i < 5; i++) seen.push((await s.api("POST", "/api/issues/CLM-4/comments", { body: `c${i}` })).body.updatedAt);
  expect([...seen].sort()).toEqual(seen);
  expect(new Set(seen).size).toBe(seen.length);
});

test("creating an issue bumps and publishes its parent and blockers", async () => {
  const parent = (await s.api("POST", "/api/issues", { team: "CLM", title: "Parent" })).body;
  const blocker = (await s.api("POST", "/api/issues", { team: "CLM", title: "Blocker" })).body;
  const sock = s.admin.ws();
  expect(await sock.opened).toBeTrue();
  const child = (await s.api("POST", "/api/issues", { team: "CLM", title: "Child", parent: parent.id, blockedBy: [blocker.id] })).body;
  // Wait for the events rather than a fixed time, so a busy machine can't make this flaky.
  for (const id of [child.id, parent.id, blocker.id]) {
    expect(await sock.until((e) => e.id === id)).toMatchObject({ workspace: "acme" });
  }
  sock.close();
  expect((await s.api("GET", `/api/issues/${parent.id}`)).body.updatedAt > parent.updatedAt).toBeTrue();
  expect((await s.api("GET", `/api/issues/${blocker.id}`)).body.updatedAt > blocker.updatedAt).toBeTrue();
});

test("a slot held by a suspended member can be claimed", async () => {
  const gamma = await s.agent("gamma");
  const held = (await s.api("POST", "/api/issues", { team: "CLM", title: "Held" })).body;
  await gamma.tool("claim_issue", { id: held.id });
  await expect(s.as("alpha").tool("claim_issue", { id: held.id })).rejects.toThrow("claimed by gamma");
  expect((await s.api("PATCH", "/api/workspaces/acme/members/gamma", { suspended: true })).status).toBe(200);
  expect(await s.as("alpha").tool("claim_issue", { id: held.id })).toStartWith(`Claimed ${held.id}`);
});

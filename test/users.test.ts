// Workspaces, members, roles and agents: who can manage whom, suspension, and never locking out the last admin.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type TestServer } from "./server.ts";

let s: TestServer;
let ws: string;
beforeAll(async () => {
  s = await startServer();
  ws = s.workspace!;
  await s.api("POST", "/api/teams", { key: "USR", workspace: ws, name: "Users" });
  await s.user("ana");
  await s.agent("bot", { name: "Bot" });
});
afterAll(() => s.stop());

const members = async () => (await s.api("GET", `/api/workspaces/${ws}/members`)).body as any[];
const role = async (username: string) => (await members()).find((m) => m.user.username === username)?.role;
const patch = (username: string, body: object, by = s.admin) => by.api("PATCH", `/api/workspaces/${ws}/members/${username}`, body);

test("/api/me says who you are and where you belong", async () => {
  const me = (await s.api("GET", "/api/me")).body;
  expect(me.user).toMatchObject({ username: "admin", name: "Admin", kind: "person", email: "admin@example.com" });
  expect(me.workspaces).toEqual([{ key: ws, name: "Acme", role: "admin", you: { username: "admin", name: "Admin", kind: "person" } }]);
  expect((await s.as("bot").api("GET", "/api/me")).body.user).toMatchObject({ username: "bot", name: "Bot", kind: "agent" });
});

test("members lists people and agents with their roles", async () => {
  const list = await members();
  expect(list.map((m) => [m.user.username, m.role])).toEqual(
    expect.arrayContaining([["admin", "admin"], ["ana", "member"], ["bot", "agent"]]),
  );
  expect(list.every((m) => m.suspendedAt === null)).toBeTrue();
});

test("only admins manage the workspace", async () => {
  const ana = s.as("ana");
  expect((await ana.api("GET", `/api/workspaces/${ws}/members`)).status).toBe(200);
  expect((await ana.api("POST", `/api/workspaces/${ws}/invites`, { role: "member" })).status).toBe(403);
  expect((await ana.api("POST", `/api/workspaces/${ws}/agents`, { name: "Rogue", username: "rogue" })).status).toBe(403);
  expect((await patch("admin", { suspended: true }, ana)).status).toBe(403);
  expect((await patch("ana", { role: "admin" }, ana)).status).toBe(403);
  expect((await ana.api("PATCH", `/api/workspaces/${ws}`, { name: "Mine" })).status).toBe(403);
  expect((await ana.api("POST", `/api/workspaces/${ws}/agents/bot/token`)).status).toBe(403);
  // Teams are the exception: any person in the workspace makes and edits them, as in Linear.
  expect((await ana.api("POST", "/api/teams", { key: "ANA", workspace: ws, name: "Ana's" })).status).toBe(201);
  expect((await ana.api("PATCH", "/api/teams/ANA", { name: "Ana's team" })).status).toBe(200);
  // Agents can't manage anything either, even with their own key.
  expect((await s.as("bot").api("POST", `/api/workspaces/${ws}/invites`, { role: "admin" })).status).toBe(403);
});

test("usernames are validated and unique per workspace", async () => {
  await s.api("POST", "/api/workspaces", { name: "Other", key: "other" });
  const redeem = async (username: string, workspace = ws) => {
    const { code } = (await s.api("POST", `/api/workspaces/${workspace}/invites`, { role: "member" })).body;
    return s.anon.api("POST", "/api/auth/redeem", { code, name: "N", username });
  };
  for (const bad of ["A", "has space", "x", "a".repeat(33), "ümlaut", "me"]) expect([bad, (await redeem(bad)).status]).toEqual([bad, 400]);
  const clash = await redeem("ana");
  expect([clash.status, clash.body.error]).toEqual([409, 'Username "ana" is taken in Acme']);
  expect((await redeem("ANA")).status).toBe(409); // usernames fold to lowercase
  expect((await redeem("bot")).status).toBe(409); // people and agents share them
  expect((await s.api("POST", `/api/workspaces/${ws}/agents`, { name: "Dup", username: "ana" })).status).toBe(409);
  // Another workspace has its own: a new person and an agent can both be called what acme's are.
  const other = await redeem("ana", "other");
  expect([other.status, other.body.user.username]).toEqual([200, "ana"]);
  const agent = await s.api("POST", "/api/workspaces/other/agents", { name: "Other bot", username: "bot" });
  expect([agent.status, agent.body.agent.username]).toEqual([201, "bot"]);
  // A clash there never names another workspace.
  const again = await s.api("POST", "/api/workspaces/other/agents", { name: "Dup", username: "bot" });
  expect([again.status, again.body.error]).toEqual([409, 'Username "bot" is taken in Other']);
  // Joining while signed in: your usual handle clashing there is 409 too, naming only there.
  const { code } = (await s.api("POST", "/api/workspaces/other/invites", { role: "member" })).body;
  const join = await s.as("ana").api("POST", "/api/auth/redeem", { code });
  expect([join.status, join.body.error]).toEqual([409, 'Username "ana" is taken in Other']);
});

test("the same agent username in two workspaces: separate agents, each acting on its own", async () => {
  await s.api("POST", "/api/workspaces", { name: "Twin", key: "twin" });
  await s.api("POST", "/api/teams", { key: "TWN", workspace: "twin", name: "Twin" });
  const acme = await s.agent("claude", { name: "Claude Acme" });
  const twin = await s.agent("claude", { workspace: "twin", name: "Claude Twin", as: "claude@twin" });
  for (const [agent, key, name] of [[acme, ws, "Claude Acme"], [twin, "twin", "Claude Twin"]] as const) {
    const me = (await agent.api("GET", "/api/me")).body;
    expect(me.user).toMatchObject({ username: "claude", name, kind: "agent" });
    expect(me.workspaces).toEqual([expect.objectContaining({ key, you: { username: "claude", name, kind: "agent" } })]);
    expect(await agent.tool("list_members")).toContain(`@claude · ${name} · agent · you`);
  }
  const acmeIssue = (await s.api("POST", "/api/issues", { team: "USR", title: "Acme work" })).body.id;
  const twinIssue = (await s.api("POST", "/api/issues", { team: "TWN", title: "Twin work" })).body.id;
  await acme.tool("comment_issue", { id: acmeIssue, body: "from acme" });
  await twin.tool("comment_issue", { id: twinIssue, body: "from twin" });
  const author = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body.comments[0].author;
  expect(await author(acmeIssue)).toEqual({ username: "claude", name: "Claude Acme", kind: "agent" });
  expect(await author(twinIssue)).toEqual({ username: "claude", name: "Claude Twin", kind: "agent" });
  // Each claims for itself: one being the delegate doesn't make the other one.
  await acme.tool("claim_issue", { id: acmeIssue });
  await expect(twin.tool("claim_issue", { id: acmeIssue })).rejects.toThrow(/not found/);
  expect((await s.api("GET", `/api/issues/${twinIssue}`)).body.delegate).toBeNull();
});

test("?assignee= and ?delegate= find whoever holds the username in each workspace searched", async () => {
  await s.api("POST", "/api/workspaces", { name: "Filters", key: "filt" });
  await s.api("POST", "/api/teams", { key: "FLT", workspace: "filt", name: "Filters" });
  await s.user("fay"); // two different people called fay, one in each workspace
  await s.user("fay", { workspace: "filt", as: "fay@filt" });
  await s.user("zed", { workspace: "filt", username: "sam-f" });
  await s.agent("helper", { workspace: "filt" });
  await s.agent("helper", { as: "helper@acme" });
  const inAcme = (await s.api("POST", "/api/issues", { team: "USR", title: "Acme fay", assignee: "fay", delegate: "helper" })).body.id;
  const inFilt = (await s.api("POST", "/api/issues", { team: "FLT", title: "Filt fay", assignee: "fay", delegate: "helper" })).body.id;
  const byZed = (await s.api("POST", "/api/issues", { team: "FLT", title: "Filt zed", assignee: "sam-f" })).body.id;
  await s.user("zed", { username: "zed" }); // zed is sam-f in filt only: acme's issue for zed isn't sam-f's
  await s.api("POST", "/api/issues", { team: "USR", title: "Acme zed", assignee: "zed" });
  const ids = async (query: string) => ((await s.api("GET", `/api/issues?${query}`)).body as any[]).map((i) => i.id).sort();
  const id = async (label: string) => (await s.as(label).api("GET", "/api/me")).body.user.id;
  expect(await id("fay")).not.toBe(await id("fay@filt"));
  expect(await ids("assignee=fay")).toEqual([inAcme, inFilt].sort());
  expect(await ids("assignee=fay&workspace=filt")).toEqual([inFilt]);
  expect(await ids("delegate=helper")).toEqual([inAcme, inFilt].sort());
  expect(await ids("assignee=sam-f")).toEqual([byZed]);
  // Unknown in every workspace searched stays a 400.
  expect((await s.api("GET", "/api/issues?assignee=sam-f&workspace=acme")).status).toBe(400);
  expect((await s.as("zed").api("GET", "/api/issues?assignee=me&workspace=filt")).body.map((i: any) => i.id)).toEqual([byZed]);
});

test("an invite to a second workspace adds it to the same user", async () => {
  await s.api("POST", "/api/workspaces", { name: "Side", key: "side" });
  await s.user("ana", { workspace: "side" });
  const keys = (await s.as("ana").api("GET", "/api/me")).body.workspaces.map((w: any) => w.key).sort();
  expect(keys).toEqual([ws, "side"]);
});

test("a workspace you're not in is invisible: 404, and absent from lists", async () => {
  await s.api("POST", "/api/workspaces", { name: "Hidden", key: "hidden" });
  await s.api("POST", "/api/teams", { key: "HID", workspace: "hidden", name: "Hidden" });
  const issue = (await s.api("POST", "/api/issues", { team: "HID", title: "Secret" })).body;
  await s.api("POST", "/api/documents", { team: "HID", title: "Secret plan" });

  for (const who of [s.as("ana"), s.as("bot")]) {
    expect((await who.api("GET", `/api/issues/${issue.id}`)).status).toBe(404);
    expect((await who.api("GET", "/api/documents/secret-plan")).status).toBe(404);
    expect((await who.api("GET", "/api/workspaces/hidden/members")).status).toBe(404);
    expect((await who.api("POST", "/api/issues", { team: "HID", title: "In" })).status).toBe(404);
    expect((await who.api("POST", `/api/issues/${issue.id}/comments`, { body: "hi" })).status).toBe(404);
    const everything = JSON.stringify([
      (await who.api("GET", "/api/workspaces")).body,
      (await who.api("GET", "/api/teams")).body,
      (await who.api("GET", "/api/issues")).body,
      (await who.api("GET", "/api/documents")).body,
    ]);
    expect(everything).not.toContain("HID");
    expect(everything).not.toContain("hidden");
    expect(await who.tool("list_teams")).not.toContain("HID");
  }
  // And people outside it can't be assigned there.
  expect((await s.api("PATCH", `/api/issues/${issue.id}`, { assignee: "ana" })).status).toBeGreaterThanOrEqual(400);
});

test("events only reach members of the event's workspace", async () => {
  const ana = s.as("ana").ws();
  const admin = s.admin.ws();
  expect(await ana.opened).toBeTrue();
  expect(await admin.opened).toBeTrue();
  const secret = (await s.api("POST", "/api/issues", { team: "HID", title: "Quiet" })).body;
  const open = (await s.api("POST", "/api/issues", { team: "USR", title: "Loud" })).body;
  expect((await admin.until((e) => e.id === secret.id)).workspace).toBe("hidden");
  expect((await ana.until((e) => e.id === open.id)).workspace).toBe(ws);
  expect(ana.events.some((e) => e.workspace === "hidden")).toBeFalse();
  ana.close();
  admin.close();
});

test("suspending from your last workspace signs you out everywhere; reinstating lets you sign in again", async () => {
  const sam = await s.user("sam");
  const cookie = s.as("sam", "cookie");
  const socket = sam.ws();
  expect(await socket.opened).toBeTrue();
  const other = s.as("ana").ws();
  expect(await other.opened).toBeTrue();

  expect((await patch("sam", { suspended: true })).status).toBe(200);
  expect(await socket.closed).toBe(4401);
  expect((await sam.api("GET", "/api/me")).status).toBe(401);
  expect((await cookie.api("GET", "/api/me")).status).toBe(401);
  await expect(sam.tool("list_teams")).rejects.toThrow();
  expect(await sam.ws().opened).toBeFalse();
  expect((await role("sam"))).toBe("member");
  expect((await members()).find((m) => m.user.username === "sam").suspendedAt).toBeString();
  // Others stay connected.
  await Bun.sleep(50);
  const stillOpen = await Promise.race([other.closed.then(() => false), Bun.sleep(50).then(() => true)]);
  expect(stillOpen).toBeTrue();
  other.close();

  expect((await patch("sam", { suspended: false })).status).toBe(200);
  expect((await sam.api("GET", "/api/me")).status).toBe(401);
  expect((await (await s.signIn("sam")).api("GET", "/api/me")).status).toBe(200);
});

test("an agent's token rotates and its sockets close; deleting suspends it and kills its keys", async () => {
  await s.agent("temp-bot");
  const old = s.as("temp-bot");
  const socket = old.ws();
  expect(await socket.opened).toBeTrue();
  const rotated = await s.api("POST", `/api/workspaces/${ws}/agents/temp-bot/token`);
  expect(rotated.body.token).toMatch(/^dk_/);
  expect(await socket.closed).toBe(4401);
  expect((await old.api("GET", "/api/me")).status).toBe(401);
  const fresh = s.with({ token: rotated.body.token });
  expect((await fresh.api("GET", "/api/me")).body.user.username).toBe("temp-bot");

  expect((await s.api("DELETE", `/api/workspaces/${ws}/agents/temp-bot`)).status).toBeLessThan(300);
  expect((await fresh.api("GET", "/api/me")).status).toBe(401);
  expect((await members()).find((m) => m.user.username === "temp-bot").suspendedAt).toBeString();
  // Agents have no sessions, so the recovery CLI refuses them too.
  expect((await s.cli("sign-in-link", "temp-bot")).exitCode).not.toBe(0);
});

test("the last active admin can't be suspended or demoted", async () => {
  expect((await patch("admin", { suspended: true })).status).toBe(409);
  expect((await patch("admin", { role: "member" })).status).toBe(409);
  // A suspended admin doesn't count.
  await s.user("eve", { role: "admin" });
  await patch("eve", { suspended: true });
  expect((await patch("admin", { role: "member" })).status).toBe(409);
  // With a second active admin it's allowed, and the new last admin is then protected.
  await patch("eve", { suspended: false });
  await s.signIn("eve");
  expect((await patch("admin", { role: "member" })).status).toBe(200);
  expect((await patch("eve", { role: "member" }, s.as("eve"))).status).toBe(409);
  expect((await patch("eve", { suspended: true }, s.as("eve"))).status).toBe(409);
  expect((await patch("admin", { role: "admin" }, s.as("eve"))).status).toBe(200);
});

test("your profile is per workspace: renaming in one leaves the others, and your key, alone", async () => {
  // ana is in acme and side (above), as "ana" in both.
  const ana = s.as("ana");
  const profile = (body: object, who = ana, key = "side") => who.api("PATCH", `/api/workspaces/${key}/profile`, body);
  const socket = s.admin.ws();
  expect(await socket.opened).toBeTrue();
  const renamed = await profile({ name: "Ana S", username: "ana-s" });
  expect([renamed.status, renamed.body.user]).toEqual([200, { username: "ana-s", name: "Ana S", kind: "person" }]);
  await socket.until((e) => e.entity === "member" && e.workspace === "side" && e.id === "ana-s");
  socket.close();
  const sideMembers = (await s.api("GET", "/api/workspaces/side/members")).body.map((m: any) => m.user.username);
  expect(sideMembers).toContain("ana-s");
  expect((await members()).find((m) => m.user.username === "ana").user.name).toBe("ana");
  const inSide = (await s.as("ana", "bearer", "side").api("GET", "/api/me")).body.user;
  expect(inSide).toMatchObject({ username: "ana-s", name: "Ana S" });
  expect((await s.as("ana", "bearer", ws).api("GET", "/api/me")).body.user).toMatchObject({ username: "ana", name: "ana" });
  // An issue in side shows her there as ana-s.
  await s.api("POST", "/api/teams", { key: "SDE", workspace: "side", name: "Side" });
  const issue = (await s.api("POST", "/api/issues", { team: "SDE", title: "Hers", assignee: "ana-s" })).body;
  expect(issue.assignee).toEqual({ username: "ana-s", name: "Ana S", kind: "person" });
  const inSideKey = s.as("ana", "bearer", "side");
  const commented = (await inSideKey.api("POST", `/api/issues/${issue.id}/comments`, { body: "mine" })).body;
  expect(commented.comments[0].author.username).toBe("ana-s");
  const doc = (await inSideKey.api("POST", "/api/documents", { team: "SDE", title: "Ana's doc" })).body;
  expect(doc.updatedBy.username).toBe("ana-s");
  expect((await inSideKey.api("GET", `/api/documents/${doc.slug}/versions`)).body[0].author.name).toBe("Ana S");

  expect((await profile({ username: "admin" })).status).toBe(409);
  expect((await profile({ username: "Bad Name" })).status).toBe(400);
  expect((await profile({ role: "admin" })).status).toBe(400);
  expect((await profile({ name: "X" }, ana, "hidden")).status).toBe(404);
  expect((await profile({ name: "X" }, s.as("ana", "bearer", "side"))).status).toBe(403);
  const old = await ana.api("PATCH", "/api/me", { username: "anna" });
  expect([old.status, old.body.error]).toEqual([400, "Your name and username are per workspace: PATCH /api/workspaces/:key/profile"]);
  expect((await ana.api("PATCH", "/api/me", { email: "ana@example.com" })).body.user.email).toBe("ana@example.com");
  expect((await profile({ username: "ana" })).status).toBe(200);
});

test("sign-in-link CLI: a shell on the server can always get a person back in", async () => {
  const out = await s.cli("sign-in-link", "admin");
  expect(out.exitCode).toBe(0);
  const code = out.stdout.match(/\/login#([A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5})/)?.[1];
  expect(code).toBeString();
  const res = await s.anon.api("POST", "/api/auth/redeem", { code });
  expect(res.status).toBe(200);
  expect(res.body.user.username).toBe("admin");

  expect((await s.cli("sign-in-link", "nobody")).exitCode).not.toBe(0);
  expect((await s.cli("sign-in-link", "bot")).exitCode).not.toBe(0);

  // Two people called "twin", in acme and side: the CLI asks which, then takes the workspace.
  await s.user("twin", { name: "Twin Acme" });
  await s.user("twin", { workspace: "side", name: "Twin Side", as: "twin@side" });
  const ambiguous = await s.cli("sign-in-link", "twin");
  expect(ambiguous.exitCode).toBe(1);
  expect(ambiguous.stderr).toContain(`${ws} · Twin Acme`);
  expect(ambiguous.stderr).toContain("side · Twin Side");
  expect(ambiguous.stderr).toContain("Run: bun run sign-in-link twin <workspace>");
  const picked = await s.cli("sign-in-link", "twin", "side");
  expect(picked.exitCode).toBe(0);
  const twin = await s.anon.api("POST", "/api/auth/redeem", { code: picked.stdout.match(/\/login#(\S+)/)![1] });
  expect(twin.body.user).toMatchObject({ username: "twin", name: "Twin Side" });
  expect((await s.anon.api("POST", "/api/auth/peek", { code: (await s.cli("sign-in-link", "twin", ws)).stdout.match(/\/login#(\S+)/)![1] })).body)
    .toMatchObject({ kind: "sign-in", username: "twin", workspace: "Acme" });
  // Nothing over HTTP mints a link without being signed in.
  for (const path of ["/api/sign-in-links", `/api/workspaces/${ws}/members/admin/sign-in-links`, "/api/sign-in-link/admin"])
    expect((await s.anon.api("POST", path, { username: "admin" })).status).toBeGreaterThanOrEqual(400);
});

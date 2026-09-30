// Team membership, private teams and guests (DKT-27): one visibility rule. A private team is seen only by its members
// (admins too, once they join), a guest sees only the teams they're in, and anything outside what you see is 404, like
// another workspace's: over REST, MCP and /ws, in lists, counts, relations, history, the inbox and attachments.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let ana: Caller; // member, in SEC (she made it)
let bob: Caller; // member, not in SEC
let gus: Caller; // guest, in WEB only
let bot: Caller; // agent
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

const ok = async (reply: Promise<{ status: number; body: any }>, status = 200) => {
  const r = await reply;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const create = (who: Caller, body: Record<string, unknown>) => ok(who.api("POST", "/api/issues", body), 201);
const ids = (list: { id: string }[]) => list.map((i) => i.id).sort();
const keys = (list: { key: string }[]) => list.map((t) => t.key).sort();

beforeAll(async () => {
  s = await startServer();
  ana = await s.user("ana");
  bob = await s.user("bob");
  bot = await s.agent("bot");
  await ok(s.api("POST", "/api/teams", { key: "WEB", name: "Web" }), 201);
  await ok(s.api("POST", "/api/teams", { key: "OPS", name: "Ops" }), 201);
  expect(await ok(ana.api("POST", "/api/teams", { key: "SEC", name: "Security", private: true }), 201)).toMatchObject({ private: true, member: true });
  gus = await s.user("gus", { role: "guest", teams: ["WEB"] });
});
afterAll(() => s.stop());

describe("who sees which team", () => {
  test("a public team is seen by every member; a private one only by its members, not admins who haven't joined", async () => {
    expect(keys(await ok(ana.api("GET", "/api/teams")))).toEqual(["OPS", "SEC", "WEB"]);
    expect(keys(await ok(bob.api("GET", "/api/teams")))).toEqual(["OPS", "WEB"]);
    expect(keys(await ok(s.api("GET", "/api/teams")))).toEqual(["OPS", "WEB"]);
    expect(keys(await ok(bot.api("GET", "/api/teams")))).toEqual(["OPS", "WEB"]);
    // A new team's only member is its creator: bob sees the public ones without being in them.
    expect((await ok(bob.api("GET", "/api/teams"))).map((t: any) => [t.key, t.private, t.member])).toEqual([
      ["OPS", false, false],
      ["WEB", false, false],
    ]);
    for (const who of [bob, s.admin]) {
      expect((await who.api("GET", "/api/issues?team=SEC")).status).toBe(400);
      expect((await who.api("GET", "/api/teams/SEC/trash")).status).toBe(404);
      expect((await who.api("GET", "/api/teams/SEC/cycles")).status).toBe(404);
      expect((await who.api("PATCH", "/api/teams/SEC", { name: "Mine" })).status).toBe(404);
      expect((await who.api("POST", "/api/teams/SEC/statuses", { name: "Hidden", category: "started" })).status).toBe(404);
      expect((await who.api("GET", "/api/locate?team=SEC")).status).toBe(404);
    }
  });

  test("a guest sees only the teams they were invited to, can work in them like a member, and nothing workspace-wide", async () => {
    expect(keys(await ok(gus.api("GET", "/api/teams")))).toEqual(["WEB"]);
    expect((await gus.api("GET", "/api/issues?team=OPS")).status).toBe(400);
    const own = await create(gus, { team: "WEB", title: "From the contractor" });
    expect((await gus.api("POST", `/api/issues/${own.id}/comments`, { body: "Done on my side" })).status).toBe(201);
    const ops = await create(s.admin, { team: "OPS", title: "Ops only" });
    expect((await gus.api("GET", `/api/issues/${ops.id}`)).status).toBe(404);
    expect(ids(await ok(gus.api("GET", "/api/issues"))).every((id: string) => id.startsWith("WEB-"))).toBeTrue();
    expect((await gus.api("POST", "/api/teams", { key: "GST", name: "Guests" })).status).toBe(403);
    expect((await gus.api("POST", "/api/teams/OPS/members", { username: "me" })).status).toBe(404);
    expect((await gus.api("POST", "/api/teams/WEB/members", { username: "me" })).status).toBe(403);
    await ok(s.api("POST", "/api/views", { name: "Everything" }), 201);
    expect(await ok(gus.api("GET", "/api/views"))).toEqual([]);
    expect((await gus.api("POST", "/api/views", { name: "Mine" })).status).toBe(403);
    expect((await gus.api("POST", "/api/labels", { name: "guestly" })).status).toBe(403);
    // Only people who share a team with them, themselves included.
    const people = (await ok(gus.api("GET", "/api/workspaces/acme/members"))).map((m: any) => m.user.username).sort();
    expect(people).toEqual(["admin", "ana", "bob", "bot", "gus"]); // everyone who isn't a guest sees the public WEB
    await s.user("gia", { role: "guest", teams: ["OPS"] });
    expect((await ok(gus.api("GET", "/api/workspaces/acme/members"))).map((m: any) => m.user.username)).not.toContain("gia");
    expect((await ok(bob.api("GET", "/api/workspaces/acme/members"))).find((m: any) => m.user.username === "gia")).toMatchObject({
      role: "guest",
      teams: ["OPS"],
    });
    expect((await s.api("POST", "/api/workspaces/acme/invites", { role: "guest" })).body.error).toBe("Pick at least one team for a guest");
  });

  test("members see a member's teams among those they see; admins list every team to find one to join", async () => {
    const anaRow = (list: any[]) => list.find((m) => m.user.username === "ana").teams;
    expect(anaRow(await ok(ana.api("GET", "/api/workspaces/acme/members")))).toEqual(["SEC"]);
    expect(anaRow(await ok(bob.api("GET", "/api/workspaces/acme/members")))).toEqual([]);
    const listing = await ok(s.api("GET", "/api/workspaces/acme/teams"));
    expect(listing.find((t: any) => t.key === "SEC")).toEqual({ key: "SEC", name: "Security", private: true, member: false, memberCount: 1 });
    expect((await bob.api("GET", "/api/workspaces/acme/teams")).status).toBe(403);
    expect(await ok(s.api("GET", "/api/teams/SEC/members"))).toEqual([{ username: "ana", name: "ana", kind: "person" }]);
    expect((await bob.api("GET", "/api/teams/SEC/members")).status).toBe(404);
  });
});

describe("issues, docs and everything else in a private team", () => {
  let web1: any, web2: any, web3: any, sec1: any, sec2: any, sec3: any, moved: any;
  beforeAll(async () => {
    web1 = await create(ana, { team: "WEB", title: "Public parent" });
    sec1 = await create(ana, { team: "SEC", title: "Secret child", parent: web1.id, description: "secretword" });
    web2 = await create(ana, { team: "WEB", title: "Public child of a secret", parent: sec1.id });
    web3 = await create(ana, { team: "WEB", title: "Public blocker" });
    sec2 = await create(ana, { team: "SEC", title: "Secret blocked", blockedBy: [web3.id] });
    sec3 = await create(ana, { team: "SEC", title: "Secret duplicate", duplicateOf: web1.id });
    await ok(ana.api("PATCH", `/api/issues/${web1.id}`, { blockedBy: [sec2.id], relatedTo: [sec1.id] }));
    await ok(ana.api("PATCH", `/api/issues/${web2.id}`, { duplicateOf: sec2.id }));
    const leaving = await create(ana, { team: "SEC", title: "Moves out" });
    moved = await ok(ana.api("PATCH", `/api/issues/${leaving.id}`, { team: "WEB" }));
  });

  test("the issue itself is 404 everywhere: read, change, comment, react, claim, subscribe, restore", async () => {
    for (const who of [bob, s.admin, gus]) {
      expect((await who.api("GET", `/api/issues/${sec1.id}`)).status).toBe(404);
      expect((await who.api("PATCH", `/api/issues/${sec1.id}`, { title: "x" })).status).toBe(404);
      expect((await who.api("POST", `/api/issues/${sec1.id}/comments`, { body: "hi" })).status).toBe(404);
      expect((await who.api("PUT", `/api/issues/${sec1.id}/reactions/👍`)).status).toBe(404);
      expect((await who.api("POST", `/api/issues/${sec1.id}/claim`)).status).toBe(404);
      expect((await who.api("PUT", `/api/issues/${sec1.id}/subscription`)).status).toBe(404);
      expect((await who.api("DELETE", `/api/issues/${sec1.id}`)).status).toBe(404);
      expect((await who.api("GET", `/api/locate?issue=${sec1.id}`)).status).toBe(404);
    }
    expect((await ana.api("GET", `/api/issues/${sec1.id}`)).status).toBe(200);
  });

  test("lists, search, filters and the bulk edit leave it out", async () => {
    expect(ids(await ok(bob.api("GET", "/api/issues"))).some((id: string) => id.startsWith("SEC"))).toBeFalse();
    expect(await ok(bob.api("GET", "/api/issues?q=secretword"))).toEqual([]);
    expect((await ok(ana.api("GET", "/api/issues?q=secretword"))).map((i: any) => i.id)).toEqual([sec1.id]);
    expect((await bob.api("GET", `/api/issues?parent=${sec1.id}`)).status).toBe(400);
    expect((await bob.api("GET", "/api/issues?status=secret_stage")).status).toBe(400);
    await ok(ana.api("POST", "/api/teams/SEC/statuses", { name: "Secret stage", category: "started" }), 201);
    expect((await ana.api("GET", "/api/issues?status=secret_stage")).status).toBe(200);
    expect((await bob.api("GET", "/api/issues?status=secret_stage")).status).toBe(400);
    const page = await ok(bob.api("GET", "/api/issues?first=500"));
    expect(page.issues.some((i: any) => i.team === "SEC")).toBeFalse();
    const bulk = await ok(bob.api("POST", "/api/issues/bulk", { ids: [web3.id, sec1.id], patch: { priority: 2 } }));
    expect(bulk.results.map((r: any) => [r.id, r.status ?? 200])).toEqual([
      [web3.id, 200],
      [sec1.id, 404],
    ]);
    expect((await ok(ana.api("GET", `/api/issues/${sec1.id}`))).priority).toBe(0);
  });

  test("relations to it are hidden per viewer, and kept when someone who can't see them replaces the list", async () => {
    const asBob = await ok(bob.api("GET", `/api/issues/${web1.id}`));
    expect(asBob).toMatchObject({ blockedBy: [], relatedTo: [], duplicates: [], children: [] });
    const asAna = await ok(ana.api("GET", `/api/issues/${web1.id}`));
    expect(asAna).toMatchObject({ blockedBy: [sec2.id], relatedTo: [sec1.id], duplicates: [sec3.id] });
    expect(asAna.children.map((c: any) => c.id)).toEqual([sec1.id]);
    expect(await ok(bob.api("GET", `/api/issues/${web2.id}`))).toMatchObject({ parent: null, duplicateOf: null });
    expect(await ok(ana.api("GET", `/api/issues/${web2.id}`))).toMatchObject({ parent: sec1.id, duplicateOf: sec2.id });
    expect((await ok(bob.api("GET", `/api/issues/${web3.id}`))).blocks).toEqual([]);
    expect((await ok(ana.api("GET", `/api/issues/${web3.id}`))).blocks).toEqual([sec2.id]);
    // In a list too.
    expect((await ok(bob.api("GET", "/api/issues?team=WEB"))).find((i: any) => i.id === web1.id)).toMatchObject({ blockedBy: [], relatedTo: [] });
    // History names only what you see.
    const history = (issue: any) => issue.activity.filter((x: any) => x.kind === "blockedBy" || x.kind === "relatedTo");
    expect(history(asAna).map((x: any) => x.to)).toEqual([[sec2.id], [sec1.id]]);
    expect(history(asBob)).toEqual([]);
    // Bob replaces the lists he sees: the ones he doesn't stay.
    await ok(bob.api("PATCH", `/api/issues/${web1.id}`, { blockedBy: [web3.id], relatedTo: [] }));
    expect(await ok(ana.api("GET", `/api/issues/${web1.id}`))).toMatchObject({ blockedBy: [sec2.id, web3.id].sort(), relatedTo: [sec1.id] });
    // New relations to it are 404.
    for (const patch of [{ blockedBy: [sec1.id] }, { relatedTo: [sec1.id] }, { parent: sec1.id }, { duplicateOf: sec1.id }]) {
      expect((await bob.api("PATCH", `/api/issues/${web3.id}`, patch)).status).toBe(404);
    }
    expect((await bob.api("POST", "/api/issues", { team: "WEB", title: "x", parent: sec1.id })).status).toBe(404);
    // In the trash too.
    await ok(ana.api("DELETE", `/api/issues/${web2.id}`));
    const trashed = async (who: Caller) => (await ok(who.api("GET", "/api/teams/WEB/trash"))).issues.find((i: any) => i.id === web2.id);
    expect(await trashed(ana)).toMatchObject({ parent: sec1.id });
    expect(await trashed(bob)).toMatchObject({ parent: null });
    await ok(ana.api("POST", `/api/issues/${web2.id}/restore`));
  });

  test("an issue that moved out of a private team: its old identifier resolves, and shows, only to those who see that team", async () => {
    expect(moved.previousIdentifiers).toHaveLength(1);
    const old = moved.previousIdentifiers[0];
    expect((await ok(bob.api("GET", `/api/issues/${moved.id}`))).previousIdentifiers).toEqual([]);
    expect((await ok(bob.api("GET", `/api/issues/${moved.id}`))).activity.some((x: any) => x.kind === "team")).toBeFalse();
    expect((await ok(ana.api("GET", `/api/issues/${moved.id}`))).activity.some((x: any) => x.kind === "team")).toBeTrue();
    expect((await bob.api("GET", `/api/issues/${old}`)).status).toBe(404);
    expect((await bob.api("GET", `/api/locate?issue=${old}`)).status).toBe(404);
    expect((await ok(ana.api("GET", `/api/issues/${old}`))).id).toBe(moved.id);
    // And moving into a team you don't see is refused like an unknown team.
    expect((await bob.api("PATCH", `/api/issues/${web3.id}`, { team: "SEC" })).status).toBe(400);
  });

  test("assignees and delegates must see the team", async () => {
    expect((await ana.api("PATCH", `/api/issues/${sec1.id}`, { assignee: "bob" })).body.error).toBe("@bob isn't in team SEC");
    expect((await ana.api("PATCH", `/api/issues/${sec1.id}`, { delegate: "bot" })).body.error).toBe("@bot isn't in team SEC");
    expect((await ana.api("POST", "/api/issues", { team: "SEC", title: "x", assignee: "bob" })).status).toBe(400);
    expect((await s.api("PATCH", `/api/issues/${web3.id}`, { assignee: "gus" })).status).toBe(200);
    const opsIssue = await create(s.admin, { team: "OPS", title: "Not for gus" });
    expect((await s.api("PATCH", `/api/issues/${opsIssue.id}`, { assignee: "gus" })).body.error).toBe("@gus isn't in team OPS");
    // Moving an issue into a team its assignee can't see is refused too.
    const bobs = await create(ana, { team: "WEB", title: "Bob's", assignee: "bob" });
    expect((await ana.api("PATCH", `/api/issues/${bobs.id}`, { team: "SEC" })).body.error).toBe("@bob isn't in team SEC");
    const inSec = await ok(ana.api("PATCH", `/api/issues/${bobs.id}`, { team: "SEC", assignee: null }));
    // Its old identifier no longer opens it for those who don't see where it went.
    expect((await bob.api("GET", `/api/issues/${bobs.id}`)).status).toBe(404);
    expect((await bob.api("GET", `/api/locate?issue=${bobs.id}`)).status).toBe(404);
    expect((await ok(ana.api("GET", `/api/issues/${bobs.id}`))).id).toBe(inSec.id);
  });

  test("docs: a private team's docs are 404, and doc refs to its issues are hidden per viewer", async () => {
    const secDoc = await ok(ana.api("POST", "/api/documents", { team: "SEC", title: "Threat model", content: `Covers ${web1.id}` }), 201);
    const webDoc = await ok(ana.api("POST", "/api/documents", { team: "WEB", title: "Plan", content: `See ${sec1.id} and ${web1.id}` }), 201);
    expect(webDoc.issues.map((i: any) => i.id)).toEqual([sec1.id, web1.id]);
    expect((await ok(bob.api("GET", `/api/documents/${webDoc.slug}`))).issues.map((i: any) => i.id)).toEqual([web1.id]);
    expect((await ok(bob.api("GET", `/api/issues/${web1.id}`))).docs.map((d: any) => d.slug)).toEqual([webDoc.slug]);
    expect((await ok(ana.api("GET", `/api/issues/${web1.id}`))).docs.map((d: any) => d.slug).sort()).toEqual([secDoc.slug, webDoc.slug].sort());
    for (const path of [`/api/documents/${secDoc.slug}`, `/api/documents/${secDoc.slug}/versions`, `/api/documents/${secDoc.slug}/raw`, `/api/locate?doc=${secDoc.slug}`]) {
      expect((await bob.api("GET", path)).status).toBe(404);
    }
    expect((await bob.api("POST", `/api/documents/${secDoc.slug}/comments`, { body: "hi" })).status).toBe(404);
    expect((await ok(bob.api("GET", "/api/documents"))).map((d: any) => d.slug)).not.toContain(secDoc.slug);
    expect(await ok(bob.api("GET", "/api/documents?q=Threat"))).toEqual([]);
    expect((await bob.api("POST", "/api/documents", { team: "SEC", title: "x" })).status).toBe(404);
    expect((await bob.api("PATCH", `/api/documents/${webDoc.slug}`, { team: "SEC" })).status).toBe(404);
  });

  test("labels: a private team's own labels are hidden, and open counts count only what you see", async () => {
    const secret = await ok(ana.api("POST", "/api/labels", { name: "exploit", team: "SEC" }), 201);
    await ok(ana.api("PATCH", `/api/issues/${sec2.id}`, { labels: ["exploit", "shared"] }));
    await ok(ana.api("PATCH", `/api/issues/${web3.id}`, { labels: ["shared"] }));
    const find = (list: any[], name: string) => list.find((l) => l.name === name);
    expect(find(await ok(bob.api("GET", "/api/labels")), "exploit")).toBeUndefined();
    expect(find(await ok(bob.api("GET", "/api/labels")), "shared").open).toBe(1);
    expect(find(await ok(ana.api("GET", "/api/labels")), "shared").open).toBe(2);
    expect((await bob.api("PATCH", `/api/labels/${secret.id}`, { name: "x" })).status).toBe(404);
    expect((await bob.api("GET", "/api/labels?team=SEC")).status).toBe(400);
    // Its name doesn't name the team, either.
    expect((await bob.api("PATCH", `/api/issues/${web3.id}`, { labels: ["exploit"] })).body.error).toBe('Label "exploit" belongs to another team');
    expect((await ok(bob.api("GET", `/api/issues/${web3.id}`))).labels).toEqual(["shared"]);
  });

  test("templates, projects and milestones", async () => {
    const tpl = await ok(ana.api("POST", "/api/templates", { team: "SEC", name: "Incident" }), 201);
    expect((await bob.api("PATCH", `/api/templates/${tpl.id}`, { name: "x" })).status).toBe(404);
    expect((await ok(bob.api("GET", "/api/templates"))).map((t: any) => t.id)).not.toContain(tpl.id);
    expect((await bob.api("GET", "/api/templates?team=SEC")).status).toBe(400);
    expect((await bob.api("POST", "/api/issues", { team: "SEC", title: "x", template: tpl.id })).status).toBe(404);

    const both = await ok(ana.api("POST", "/api/projects", { name: "Hardening", teams: ["WEB", "SEC"] }), 201);
    const only = await ok(ana.api("POST", "/api/projects", { name: "Pentest", teams: ["SEC"] }), 201);
    const m = (await ok(ana.api("POST", `/api/projects/${both.slug}/milestones`, { name: "Alpha" }), 201)).milestones[0];
    await ok(ana.api("PATCH", `/api/issues/${sec1.id}`, { project: both.slug, milestone: "Alpha" }));
    await ok(ana.api("PATCH", `/api/issues/${web3.id}`, { project: both.slug, milestone: "Alpha" }));
    expect(await ok(ana.api("GET", `/api/projects/${both.slug}`))).toMatchObject({ teams: ["SEC", "WEB"], issueCount: 2 });
    const asBob = await ok(bob.api("GET", `/api/projects/${both.slug}`));
    expect(asBob).toMatchObject({ teams: ["WEB"], issueCount: 1 });
    expect(asBob.milestones.find((x: any) => x.id === m.id).issueCount).toBe(1);
    expect((await ok(bob.api("GET", `/api/issues?project=${both.slug}`))).map((i: any) => i.id)).toEqual([web3.id]);
    const secPlan = await ok(ana.api("POST", "/api/documents", { team: "SEC", title: "Pentest plan", project: both.slug }), 201);
    expect((await ok(ana.api("GET", `/api/projects/${both.slug}`))).docs.map((d: any) => d.slug)).toEqual([secPlan.slug]);
    expect((await ok(bob.api("GET", `/api/projects/${both.slug}`))).docs).toEqual([]);
    expect((await bob.api("GET", `/api/projects/${only.slug}`)).status).toBe(404);
    expect((await ok(bob.api("GET", "/api/projects"))).map((p: any) => p.slug)).toEqual([both.slug]);
    expect((await bob.api("PATCH", `/api/issues/${web3.id}`, { project: only.slug })).status).toBe(400);
    expect((await bob.api("POST", "/api/projects", { name: "x", teams: ["SEC"] })).status).toBe(400);
    // Bob sets the teams he sees: SEC stays.
    await ok(bob.api("PATCH", `/api/projects/${both.slug}`, { teams: ["WEB", "OPS"] }));
    expect((await ok(ana.api("GET", `/api/projects/${both.slug}`))).teams).toEqual(["OPS", "SEC", "WEB"]);
  });

  test("views naming a team you don't see find nothing: 400, like an unknown team", async () => {
    const view = await ok(ana.api("POST", "/api/views", { name: "Secrets", filter: { team: "SEC" } }), 201);
    expect((await bob.api("POST", "/api/views", { name: "Peek", filter: { team: "SEC" } })).status).toBe(400);
    expect((await bob.api("GET", `/api/issues?team=${view.filter.team}`)).status).toBe(400);
  });

  test("attachments uploaded in a private team are 404 to everyone else", async () => {
    const up = (who: Caller, team?: string) =>
      who.raw("POST", `/api/attachments?name=shot.png${team ? `&team=${team}` : ""}`, { body: PNG, headers: { "Content-Type": "application/octet-stream" } });
    const secret = await up(ana, "SEC");
    expect(secret.status).toBe(201);
    expect(secret.body.team).toBe("SEC");
    expect((await ana.raw("GET", secret.body.url)).status).toBe(200);
    expect((await bob.raw("GET", secret.body.url)).status).toBe(404);
    expect((await s.admin.raw("GET", secret.body.url)).status).toBe(404);
    expect((await up(bob, "SEC")).status).toBe(404);
    expect((await gus.raw("GET", (await up(bob, "WEB")).body.url)).status).toBe(200);
    expect((await gus.raw("GET", (await up(bob, "OPS")).body.url)).status).toBe(404);
    expect((await gus.raw("GET", (await up(bob)).body.url)).status).toBe(200); // the workspace's own
    expect((await bot.toolResult("get_attachment", { url: secret.body.url })).isError).toBeTrue();
  });

  test("MCP: list_teams marks private teams and yours; get_issue and list_issues per caller", async () => {
    expect(await ana.tool("list_teams")).toMatch(/^SEC · Security · workspace acme · private · member · \d+ open/m);
    expect(await bob.tool("list_teams")).not.toContain("SEC");
    expect(await bob.tool("list_teams")).toMatch(/^WEB · Web · workspace acme · \d+ open/m);
    await expect(bot.tool("get_issue", { id: sec1.id })).rejects.toThrow();
    expect(await bot.tool("list_issues", { query: "secretword" })).not.toContain(sec1.id);
    expect(await ana.tool("get_issue", { id: sec1.id })).toContain("Secret child");
  });
});

describe("mentions, the inbox and live events", () => {
  test("you can't @mention someone who doesn't see the team, and they aren't told", async () => {
    const issue = await create(ana, { team: "SEC", title: "Mentions" });
    await ok(ana.api("POST", `/api/issues/${issue.id}/comments`, { body: "@bob @admin have a look" }), 201);
    expect(s.sql("SELECT * FROM mentions m JOIN issues i ON i.id = m.issue_id WHERE i.title = 'Mentions'")).toEqual([]);
    for (const who of [bob, s.admin]) {
      const inbox = await ok(who.api("GET", "/api/notifications"));
      expect(inbox.notifications.some((n: any) => n.issue?.id === issue.id)).toBeFalse();
    }
  });

  test("losing a team hides its notifications and their unread count", async () => {
    await ok(ana.api("POST", "/api/teams/SEC/members", { username: "bob" }));
    const issue = await create(ana, { team: "SEC", title: "For bob", assignee: "bob" });
    const before = await ok(bob.api("GET", "/api/notifications"));
    expect(before.notifications.some((n: any) => n.issue?.id === issue.id)).toBeTrue();
    const [{ id: nid }] = s.sql("SELECT n.id FROM notifications n JOIN issues i ON i.id = n.issue_id WHERE i.title = 'For bob'");
    await ok(ana.api("PATCH", `/api/issues/${issue.id}`, { assignee: null }));
    await ok(ana.api("DELETE", "/api/teams/SEC/members/bob"));
    const after = await ok(bob.api("GET", "/api/notifications"));
    expect(after.notifications.some((n: any) => n.issue?.id === issue.id)).toBeFalse();
    // Everything about SEC goes, from the list and the count (an issue that moved into it since, too).
    expect(after.notifications.some((n: any) => n.issue?.id.startsWith("SEC-"))).toBeFalse();
    expect(after.unread).toBe(before.unread - new Set(before.notifications.filter((n: any) => n.issue?.id.startsWith("SEC-")).map((n: any) => n.issue.id)).size);
    expect((await bob.api("PATCH", "/api/notifications", { ids: [nid], read: true })).status).toBe(404);
    expect((await bob.api("GET", `/api/issues/${issue.id}`)).status).toBe(404);
    // He still follows it, but isn't told of anything new there.
    const told = () => s.sql("SELECT COUNT(*) AS n FROM notifications n JOIN issues i ON i.id = n.issue_id WHERE i.title = 'For bob'")[0].n;
    const count = told();
    await ok(ana.api("POST", `/api/issues/${issue.id}/comments`, { body: "An update" }), 201);
    await ok(ana.api("PATCH", `/api/issues/${issue.id}`, { status: "done" }));
    expect(told()).toBe(count);
  });

  test("/ws: a private team's events reach its members only; a guest hears only their teams", async () => {
    const anaSocket = ana.ws();
    const bobSocket = bob.ws();
    const gusSocket = gus.ws();
    expect([await anaSocket.opened, await bobSocket.opened, await gusSocket.opened]).toEqual([true, true, true]);
    const secret = await create(ana, { team: "SEC", title: "Live secret" });
    const ops = await create(s.admin, { team: "OPS", title: "Live ops" });
    const web = await create(ana, { team: "WEB", title: "Live web" });
    await anaSocket.until((e) => e.id === secret.id);
    await bobSocket.until((e) => e.id === web.id);
    await gusSocket.until((e) => e.id === web.id);
    expect(bobSocket.events.some((e) => e.id === secret.id || e.id === "SEC")).toBeFalse();
    expect(gusSocket.events.some((e) => e.id === secret.id || e.id === ops.id)).toBeFalse();
    expect(bobSocket.events.some((e) => e.id === ops.id)).toBeTrue();
    for (const socket of [anaSocket, bobSocket, gusSocket]) socket.close();
  });

  test("/ws: deleting a private team's label reaches its members only; a workspace label's, everyone (DKT-44)", async () => {
    const anaSocket = ana.ws();
    const bobSocket = bob.ws();
    expect([await anaSocket.opened, await bobSocket.opened]).toEqual([true, true]);
    const secret = await ok(ana.api("POST", "/api/labels", { name: "zero-day", team: "SEC" }), 201);
    const shared = await ok(s.api("POST", "/api/labels", { name: "everyone" }), 201);
    const label = (id: number) => (e: any) => e.entity === "label" && e.id === String(id);
    await ok(ana.api("DELETE", `/api/labels/${secret.id}`));
    await anaSocket.until(label(secret.id));
    await ok(s.api("DELETE", `/api/labels/${shared.id}`));
    await bobSocket.until(label(shared.id)); // sent after the first: by now bob would have heard it
    expect(bobSocket.events.some(label(secret.id))).toBeFalse();
    for (const socket of [anaSocket, bobSocket]) socket.close();
  });

  test("/ws: a guest hears about members who share a team with them, not the rest (DKT-42)", async () => {
    const bobSocket = bob.ws();
    const gusSocket = gus.ws();
    expect([await bobSocket.opened, await gusSocket.opened]).toEqual([true, true]);
    const member = (username: string) => (e: any) => e.entity === "member" && e.id === username;
    await ok(bob.api("PATCH", "/api/workspaces/acme/profile", { name: "Bob B" })); // shares no team with gus
    await ok(s.api("PATCH", "/api/workspaces/acme/profile", { name: "Admin A" })); // in WEB, with gus
    await gusSocket.until(member("admin"));
    await bobSocket.until(member("admin"));
    expect(bobSocket.events.some(member("bob"))).toBeTrue();
    expect(gusSocket.events.some(member("bob"))).toBeFalse();
    for (const socket of [bobSocket, gusSocket]) socket.close();
    await ok(bob.api("PATCH", "/api/workspaces/acme/profile", { name: "bob" }));
    await ok(s.api("PATCH", "/api/workspaces/acme/profile", { name: "Admin" }));
  });
  test("/ws: a guest hears nothing of saved views, which they can't use (DKT-52)", async () => {
    const bobSocket = bob.ws();
    const gusSocket = gus.ws();
    expect([await bobSocket.opened, await gusSocket.opened]).toEqual([true, true]);
    const view = await ok(s.api("POST", "/api/views", { name: "Live view" }), 201);
    await ok(s.api("PATCH", `/api/views/${view.id}`, { name: "Renamed view" }));
    await ok(s.api("DELETE", `/api/views/${view.id}`));
    const seen = (e: any) => e.entity === "view" && e.id === String(view.id);
    await bobSocket.until((e) => seen(e) && bobSocket.events.filter(seen).length === 3);
    await create(s.admin, { team: "WEB", title: "After the views" }).then((i) => gusSocket.until((e) => e.id === i.id)); // gus has heard everything sent before it
    expect(gusSocket.events.some((e) => e.entity === "view")).toBeFalse();
    for (const socket of [bobSocket, gusSocket]) socket.close();
  });

  test("/ws: a guest hears that someone left their team (DKT-54)", async () => {
    await ok(bob.api("POST", "/api/teams/WEB/members", { username: "me" }));
    const gusSocket = gus.ws();
    expect(await gusSocket.opened).toBeTrue();
    await ok(bob.api("DELETE", "/api/teams/WEB/members/bob"));
    await gusSocket.until((e) => e.entity === "member" && e.id === "bob");
    gusSocket.close();
  });
});

describe("joining, leaving and making a team private", () => {
  test("join a public team yourself; leave any; the last member of a private team stays", async () => {
    expect(await ok(bob.api("POST", "/api/teams/OPS/members", { username: "me" }))).toMatchObject({ key: "OPS", member: true });
    expect(await ok(bob.api("DELETE", "/api/teams/OPS/members/bob"))).toMatchObject({ member: false });
    expect((await bob.api("POST", "/api/teams/SEC/members", { username: "me" })).status).toBe(404);
    expect((await ana.api("DELETE", "/api/teams/SEC/members/ana")).body.error).toBe("Add someone else first");
    // Only the team's members and admins add others; an API key can't touch membership.
    expect((await bob.api("POST", "/api/teams/OPS/members", { username: "ana" })).status).toBe(403);
    expect((await s.admin.api("POST", "/api/teams/OPS/members", { username: "ana" })).status).toBe(200);
    expect((await s.as("ana", "bearer", "acme").api("POST", "/api/teams/SEC/members", { username: "bob" })).status).toBe(403);
    // An agent gets into a private team by being added, and then sees it.
    await ok(ana.api("POST", "/api/teams/SEC/members", { username: "bot" }));
    expect(keys(await ok(bot.api("GET", "/api/teams")))).toContain("SEC");
    await ok(ana.api("DELETE", "/api/teams/SEC/members/bot"));
  });

  test("an admin joins a private team through its members, then sees it", async () => {
    expect((await s.api("GET", "/api/issues?team=SEC")).status).toBe(400);
    expect(await ok(s.api("POST", "/api/teams/SEC/members", { username: "me" }))).toMatchObject({ key: "SEC", member: true, private: true });
    expect((await s.api("GET", "/api/issues?team=SEC")).status).toBe(200);
    expect((await ana.api("DELETE", "/api/teams/SEC/members/admin")).status).toBe(200);
  });

  test("only admins make a team private or public, and everyone's sockets reconnect", async () => {
    expect((await ana.api("PATCH", "/api/teams/OPS", { private: true })).status).toBe(403);
    expect((await s.as("admin", "bearer", "acme").api("PATCH", "/api/teams/OPS", { private: true })).status).toBe(403);
    const socket = bob.ws();
    expect(await socket.opened).toBeTrue();
    expect(await ok(s.api("PATCH", "/api/teams/OPS", { private: true }))).toMatchObject({ private: true, member: true });
    expect(await socket.closed).toBe(4401);
    expect(keys(await ok(bob.api("GET", "/api/teams")))).toEqual(["WEB"]);
    await ok(s.api("PATCH", "/api/teams/OPS", { private: false }));
    expect(keys(await ok(bob.api("GET", "/api/teams")))).toEqual(["OPS", "WEB"]);
  });

  test("a new member joins every public team; a new team starts with its creator", async () => {
    const cal = await s.user("cal");
    expect((await ok(cal.api("GET", "/api/teams"))).filter((t: any) => t.member).map((t: any) => t.key)).toEqual(["OPS", "WEB"]);
    const team = await ok(cal.api("POST", "/api/teams", { key: "CAL", name: "Cal's" }), 201);
    expect(team).toMatchObject({ private: false, member: true });
    expect(await ok(cal.api("GET", "/api/teams/CAL/members"))).toEqual([{ username: "cal", name: "cal", kind: "person" }]);
  });
});

describe("guests work in their teams but set nothing up", () => {
  test("no membership changes, team settings, cycles, workflows or templates; only admins add a guest to a team", async () => {
    const gil = await s.user("gil", { role: "guest", teams: ["WEB"] });
    expect((await gus.api("POST", "/api/teams/WEB/members", { username: "gil" })).status).toBe(403);
    expect((await gus.api("POST", "/api/teams/WEB/members", { username: "bot" })).status).toBe(403);
    expect((await gus.api("DELETE", "/api/teams/WEB/members/admin")).status).toBe(403);
    expect((await gus.api("PATCH", "/api/teams/WEB", { name: "Mine now" })).status).toBe(403);
    expect((await gus.api("PATCH", "/api/teams/WEB", { cycleWeeks: 1 })).status).toBe(403);
    expect((await gus.api("POST", "/api/teams/WEB/statuses", { name: "Guest stage", category: "started" })).status).toBe(403);
    expect((await gus.api("POST", "/api/templates", { team: "WEB", name: "Guest template" })).status).toBe(403);
    const tpl = await ok(s.api("POST", "/api/templates", { team: "WEB", name: "Bug" }), 201);
    expect((await gus.api("PATCH", `/api/templates/${tpl.id}`, { name: "x" })).status).toBe(403);
    // What they don't see stays 404, not 403.
    expect((await gus.api("POST", "/api/teams/OPS/statuses", { name: "x", category: "started" })).status).toBe(404);
    // Their own team's labels are still theirs to manage.
    expect((await gus.api("POST", "/api/labels", { name: "contractor", team: "WEB" })).status).toBe(201);
    // A member adds people and agents, never a guest: an admin does.
    await ok(bob.api("POST", "/api/teams/WEB/members", { username: "me" }));
    expect((await bob.api("POST", "/api/teams/WEB/members", { username: "gia" })).body.error).toBe("Only workspace admins can add a guest to a team");
    expect((await s.api("POST", "/api/teams/WEB/members", { username: "gia" })).status).toBe(200);
    expect(keys(await ok(gil.api("GET", "/api/teams")))).toEqual(["WEB"]);
    // A guest can still leave.
    expect((await gil.api("DELETE", "/api/teams/WEB/members/gil")).status).toBe(200);
    expect(await ok(gil.api("GET", "/api/teams"))).toEqual([]);
  });

  test("naming an unknown label on an issue doesn't make a workspace label for a guest (DKT-41)", async () => {
    const labels = () => s.sql("SELECT COUNT(*) AS n FROM labels")[0].n;
    const before = labels();
    const made = await gus.api("POST", "/api/issues", { team: "WEB", title: "Guest labelled", labels: ["guest-made"] });
    expect([made.status, made.body.error]).toEqual([403, "Guests can't create workspace labels"]);
    expect(s.sql("SELECT COUNT(*) AS n FROM issues WHERE title = 'Guest labelled'")[0].n).toBe(0);
    expect((await gus.api("POST", "/api/issues", { team: "WEB", title: "Guest grouped", labels: ["Guestgroup/x"] })).status).toBe(403);
    const issue = await create(gus, { team: "WEB", title: "Guest issue" });
    expect((await gus.api("PATCH", `/api/issues/${issue.id}`, { labels: ["guest-made"] })).status).toBe(403);
    await expect(s.as("gus", "bearer").tool("update_issue", { id: issue.id, labels: ["guest-mcp"] })).rejects.toThrow("Guests can't create workspace labels");
    expect(labels()).toBe(before);
    // Labels that exist are theirs to use, and naming one in their team's own group makes it there.
    await ok(s.api("POST", "/api/labels", { name: "known" }), 201);
    await ok(s.api("POST", "/api/labels", { name: "Area", isGroup: true, team: "WEB" }), 201);
    expect((await ok(gus.api("PATCH", `/api/issues/${issue.id}`, { labels: ["known", "Area/frontend"] }))).labels.sort()).toEqual(["Area/frontend", "known"]);
  });

  test("/ws: a guest in no team still hears about themselves (DKT-42)", async () => {
    const gil = s.as("gil"); // left WEB above: in no team now
    expect(await ok(gil.api("GET", "/api/teams"))).toEqual([]);
    const socket = gil.ws();
    expect(await socket.opened).toBeTrue();
    await ok(gil.api("PATCH", "/api/workspaces/acme/profile", { name: "Gil G" }));
    await socket.until((e) => e.entity === "member" && e.id === "gil");
    socket.close();
  });
});

describe("what moves with an issue or doc out of a private team", () => {
  const up = async (team: string) =>
    (await ana.raw("POST", `/api/attachments?name=shot.png&team=${team}`, { body: PNG, headers: { "Content-Type": "application/octet-stream" } })).body.url as string;

  test("the files it links move with it, so its new team's readers open them; other teams' stay theirs", async () => {
    const [inText, inComment, fromOps] = [await up("SEC"), await up("SEC"), await up("OPS")];
    const issue = await create(ana, { team: "SEC", title: "Screenshots", description: `![a](${inText}) ![c](${fromOps})` });
    await ok(ana.api("POST", `/api/issues/${issue.id}/comments`, { body: `[log](${inComment})` }), 201);
    expect((await bob.raw("GET", inText)).status).toBe(404);
    await ok(ana.api("PATCH", `/api/issues/${issue.id}`, { team: "WEB" }));
    expect((await bob.raw("GET", inText)).status).toBe(200);
    expect((await bob.raw("GET", inComment)).status).toBe(200);
    expect((await gus.raw("GET", fromOps)).status).toBe(404); // still OPS's, which gus doesn't see

    const inDoc = await up("SEC");
    const doc = await ok(ana.api("POST", "/api/documents", { team: "SEC", title: "Findings", content: `![shot](${inDoc})` }), 201);
    expect((await bob.raw("GET", inDoc)).status).toBe(404);
    await ok(ana.api("PATCH", `/api/documents/${doc.slug}`, { team: "WEB" }));
    expect((await bob.raw("GET", inDoc)).status).toBe(200);
  });

  test("its history leaves out the private team's labels for those who don't see it", async () => {
    await ok(ana.api("POST", "/api/labels", { name: "zeroday-acme", team: "SEC" }), 201);
    const issue = await create(ana, { team: "SEC", title: "Labelled", labels: ["zeroday-acme"] });
    const moved = await ok(ana.api("PATCH", `/api/issues/${issue.id}`, { team: "WEB" }));
    const labels = async (who: Caller) => JSON.stringify((await ok(who.api("GET", `/api/issues/${moved.id}`))).activity.filter((x: any) => x.kind === "labels"));
    expect(await labels(ana)).toContain("zeroday-acme");
    expect(await labels(bob)).not.toContain("zeroday-acme");
  });
});

describe("views naming what you don't see", () => {
  test("are left out of the list and 404, for a team, a project or a parent issue you don't see", async () => {
    const secret = await create(ana, { team: "SEC", title: "Parent" });
    const pentest = (await ok(ana.api("GET", "/api/projects"))).find((p: any) => p.teams.length === 1 && p.teams[0] === "SEC");
    const views = [
      await ok(ana.api("POST", "/api/views", { name: "On SEC", filter: { team: "SEC" } }), 201),
      await ok(ana.api("POST", "/api/views", { name: "On the pentest", filter: { project: pentest.slug } }), 201),
      await ok(ana.api("POST", "/api/views", { name: "Under a secret", filter: { parent: secret.id } }), 201),
    ];
    const names = async (who: Caller) => (await ok(who.api("GET", "/api/views"))).map((v: any) => v.name);
    for (const v of views) {
      expect(await names(ana)).toContain(v.name);
      expect(await names(bob)).not.toContain(v.name);
      expect((await bob.api("GET", `/api/views/${v.id}`)).status).toBe(404);
    }
    expect(await names(bob)).toContain("Everything");
  });
});

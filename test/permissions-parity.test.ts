// The access matrix: every REST route and MCP tool, for each role (admin, member, guest, agent) and credential (session,
// write key, read key; an agent has its token), on a team they're in (OWN), a public one they aren't (PUB) and a private
// one they don't see (PRIV), plus what their sockets hear. What happens is checked in as fixtures/permissions-golden.json:
// the definition of "the same access". After a deliberate change: UPDATE_GOLDEN=1 bun test test/permissions-parity.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, type Caller, type Reply, type TestServer } from "./server.ts";

const GOLDEN = join(import.meta.dir, "fixtures", "permissions-golden.json");
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const golden: Record<string, Record<string, string>> = UPDATE ? {} : JSON.parse(readFileSync(GOLDEN, "utf8"));
const TEAMS = ["OWN", "PUB", "PRIV"];
const ROLES = [["admin", "admin"], ["member", "mem"], ["guest", "gst"]];

let s: TestServer;
let boss: Caller; // another admin, who sets everything up: in their session what needs one, else with one of their keys
const bossKeys: Caller[] = [];
let turn = 0;
const bossFor = (path: string) => (/^\/api\/(workspaces\/|teams\/[A-Z]+(\/members.*)?$)/.test(path) ? boss : bossKeys[turn++ % bossKeys.length]!);
const callers: { label: string; username: string; caller: Caller; key: boolean }[] = [];

/** A request by the boss that must work (429s wait). `strict: false` for resets that may find nothing to do. */
async function b(method: string, path: string, body?: unknown, strict = true): Promise<any> {
  for (;;) {
    const res = await bossFor(path).api(method, path, body);
    if (res.status === 429) await Bun.sleep(1000);
    else if (strict && res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    else return res.body;
  }
}

beforeAll(async () => {
  s = await startServer({ env: { DOCKET_WEBHOOK_ALLOW_PRIVATE: "true" } });
  await s.api("POST", "/api/teams", { key: "OWN", name: "Own" });
  boss = await s.user("boss", { role: "admin" });
  for (let i = 0; i < 4; i++) bossKeys.push(s.with({ token: (await boss.api("POST", "/api/api-keys", { name: `boss ${i}`, workspace: "acme" })).body.token }));
  await s.user("mem");
  await s.user("gst", { role: "guest", teams: ["OWN"] });
  await s.user("gx", { role: "guest", teams: ["OWN"] }); // a guest others try to add to a team
  await s.user("tm"); // in every team: others try to remove them
  await s.user("tn"); // in none: others try to add them
  await s.agent("bot");
  await b("POST", "/api/teams", { key: "PUB", name: "Public" });
  await b("POST", "/api/teams", { key: "PRIV", name: "Private", private: true });
  for (const [role, username] of ROLES) {
    const read = await s.as(username!, "cookie", "acme").api("POST", "/api/api-keys", { name: "read", scope: "read", workspace: "acme" });
    callers.push(
      { label: `${role} session`, username: username!, caller: s.as(username!, "cookie", "acme"), key: false },
      { label: `${role} write key`, username: username!, caller: s.as(username!, "bearer", "acme"), key: true },
      { label: `${role} read key`, username: username!, caller: s.with({ token: read.body.token }), key: true },
    );
  }
  callers.push({ label: "agent token", username: "bot", caller: s.as("bot"), key: true });
}, 60_000);

afterAll(async () => {
  if (UPDATE) writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 1)}\n`);
  await s.stop();
});

/** Status, then the error for a failure or what `pick` shows of a success. */
function show(res: Reply, pick?: (body: any) => unknown): string {
  if (res.status === 429) throw new Error("rate limited: the matrix would record a 429");
  const extra = res.status >= 400 ? res.body?.error : pick?.(res.body);
  return extra === undefined ? String(res.status) : `${res.status} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
}

/** Puts the teams and memberships back as they started: `username` in OWN only, tm in every team, tn and gx in no other. */
async function reset(username: string) {
  for (const [key, isPrivate] of [["OWN", false], ["PUB", false], ["PRIV", true]] as const) await b("PATCH", `/api/teams/${key}`, { private: isPrivate });
  await b("POST", "/api/teams/OWN/members", { username });
  for (const key of TEAMS) {
    if (key !== "OWN") await b("DELETE", `/api/teams/${key}/members/${username}`, undefined, false);
    await b("POST", `/api/teams/${key}/members`, { username: "tm" });
    await b("DELETE", `/api/teams/${key}/members/tn`, undefined, false);
    if (key !== "OWN") await b("DELETE", `/api/teams/${key}/members/gx`, undefined, false);
  }
}

/** A file the boss uploads in team `T`: its URL. */
async function upload(T: string): Promise<string> {
  const res = await bossFor("").raw("POST", `/api/attachments?name=f.txt&team=${T}`, { body: "hi", headers: { "Content-Type": "application/octet-stream" } });
  if (res.status !== 201) throw new Error(`upload: ${res.status}`);
  return res.body.url;
}

/** Fresh things to act on, made by the boss: per team and workspace-wide, tagged `n`. */
async function fixtures(n: string) {
  const teams: Record<string, Record<string, any>> = {};
  for (const T of TEAMS) {
    const issue = async (title: string, trash = false) => {
      const id = (await b("POST", "/api/issues", { team: T, title })).id as string;
      if (trash) await b("DELETE", `/api/issues/${id}`);
      return id;
    };
    const doc = async (title: string, trash = false) => {
      const slug = (await b("POST", "/api/documents", { team: T, title: `${title} ${n} ${T}`, content: "x" })).slug as string;
      if (trash) await b("DELETE", `/api/documents/${slug}`);
      return slug;
    };
    const I = await issue("I");
    const D = await doc("D");
    teams[T] = {
      I,
      C: (await b("POST", `/api/issues/${I}/comments`, { body: "boss" })).comments.at(-1).id,
      J: await issue("J", true),
      J2: await issue("J2", true),
      K: await issue("K"),
      D,
      DC: (await b("POST", `/api/documents/${D}/comments`, { body: "boss" })).comments.at(-1).id,
      DJ: await doc("DJ", true),
      DJ2: await doc("DJ2", true),
      DK: await doc("DK"),
      TP: (await b("POST", "/api/templates", { team: T, name: `tp ${n}` })).id,
      TL: (await b("POST", "/api/labels", { team: T, name: `tl-${n}-${T}` })).id,
      ST: (await b("POST", `/api/teams/${T}/statuses`, { key: `st${n}`, name: `St ${n}`, category: "unstarted" }), `st${n}`),
      F: await upload(T),
    };
  }
  const P = (await b("POST", "/api/projects", { teams: ["OWN"], name: `P ${n}` })).slug as string;
  return {
    teams,
    P,
    M: (await b("POST", `/api/projects/${P}/milestones`, { name: "M" })).milestones[0].id,
    WL: (await b("POST", "/api/labels", { name: `wl-${n}` })).id,
    V: (await b("POST", "/api/views", { name: `V ${n}`, filter: {} })).id,
    W: (await b("POST", "/api/workspaces/acme/webhooks", { url: "http://127.0.0.1:9/hook", resourceTypes: ["Notification"] })).webhook.id,
    A: (await b("POST", "/api/workspaces/acme/agents", { name: `T ${n}`, username: `tbot${n}` })).agent.username,
  };
}

const sorted = (list: string[]) => [...list].sort().join(",");
const emoji = encodeURIComponent("👍");

/** Every REST route, as `c`; tag `n` keeps what it creates apart. */
async function rest(c: Caller, n: string, row: Record<string, string>) {
  const fx = await fixtures(`${n}r`);
  const r = async (name: string, method: string, path: string, body?: unknown, pick?: (body: any) => unknown) => {
    if (name in row) throw new Error(`two probes named ${name}`);
    const res = await c.api(method, path, body);
    row[name] = show(res, pick);
    return res;
  };
  // You
  await r("GET me", "GET", "/api/me", undefined, (m) => `${m.credential} ${m.workspaces.map((w: any) => `${w.key}:${w.role}`).join(",")}`);
  await r("PATCH me", "PATCH", "/api/me", {});
  await r("GET sessions", "GET", "/api/sessions");
  await r("DELETE sessions", "DELETE", "/api/sessions");
  await r("DELETE session", "DELETE", "/api/sessions/999999");
  await r("POST sign-in-link", "POST", "/api/sign-in-links");
  await r("GET api-keys", "GET", "/api/api-keys");
  await r("POST api-key", "POST", "/api/api-keys", { name: "probe" });
  await r("DELETE api-key", "DELETE", "/api/api-keys/999999");
  await r("GET locate", "GET", "/api/locate?team=OWN");
  await r("GET workspaces", "GET", "/api/workspaces");
  await r("POST workspace", "POST", "/api/workspaces", { name: `W ${n}`, key: `wsp${n}` });
  await r("PATCH workspace", "PATCH", "/api/workspaces/acme", { name: "Acme" });
  await r("DELETE workspace", "DELETE", "/api/workspaces/acme?confirm=nope");
  await r("PATCH profile", "PATCH", "/api/workspaces/acme/profile", {});
  await r("GET members", "GET", "/api/workspaces/acme/members", undefined, (l) => sorted(l.map((m: any) => m.user.username)));
  await r("PATCH member role", "PATCH", "/api/workspaces/acme/members/tm", { role: "member" });
  await r("PATCH member suspended", "PATCH", "/api/workspaces/acme/members/tm", { suspended: false });
  await r("GET team listings", "GET", "/api/workspaces/acme/teams", undefined, (l) => sorted(l.map((t: any) => t.key)));
  await r("POST invite", "POST", "/api/workspaces/acme/invites", { role: "member" });
  await r("POST guest invite", "POST", "/api/workspaces/acme/invites", { role: "guest", teams: ["OWN"] });
  await r("POST agent", "POST", "/api/workspaces/acme/agents", { name: `Ag ${n}`, username: `ag${n}` });
  await r("POST agent token", "POST", `/api/workspaces/acme/agents/${fx.A}/token`);
  await r("DELETE agent", "DELETE", `/api/workspaces/acme/agents/${fx.A}`);
  await r("GET github", "GET", "/api/workspaces/acme/github");
  await r("POST github", "POST", "/api/workspaces/acme/github");
  await r("DELETE github", "DELETE", "/api/workspaces/acme/github");
  await r("GET webhooks", "GET", "/api/workspaces/acme/webhooks");
  await r("POST webhook", "POST", "/api/workspaces/acme/webhooks", { url: "http://127.0.0.1:9/hook", resourceTypes: ["Notification"] });
  await r("PATCH webhook", "PATCH", `/api/workspaces/acme/webhooks/${fx.W}`, { label: "x" });
  await r("POST webhook secret", "POST", `/api/workspaces/acme/webhooks/${fx.W}/secret`);
  await r("GET webhook deliveries", "GET", `/api/workspaces/acme/webhooks/${fx.W}/deliveries`);
  await r("DELETE webhook", "DELETE", `/api/workspaces/acme/webhooks/${fx.W}`);
  await r("GET teams", "GET", "/api/teams", undefined, (l) => sorted(l.map((t: any) => t.key)));
  await r("POST team", "POST", "/api/teams", { key: `Z${n.replace(/\d/g, (d) => "ABCDEFGHIJ"[Number(d)]!).toUpperCase()}`, name: `Z ${n}` });
  await r("GET labels", "GET", "/api/labels");
  await r("POST workspace label", "POST", "/api/labels", { name: `nl-${n}` });
  await r("PATCH workspace label", "PATCH", `/api/labels/${fx.WL}`, { color: "#112233" });
  await r("DELETE workspace label", "DELETE", `/api/labels/${fx.WL}`);
  await r("GET templates", "GET", "/api/templates");
  await r("GET projects", "GET", "/api/projects");
  await r("GET project", "GET", `/api/projects/${fx.P}`);
  await r("POST project", "POST", "/api/projects", { teams: ["OWN"], name: `CP ${n}` });
  await r("PATCH project", "PATCH", `/api/projects/${fx.P}`, { description: "x" });
  await r("POST milestone", "POST", `/api/projects/${fx.P}/milestones`, { name: "M2" });
  await r("PATCH milestone", "PATCH", `/api/projects/${fx.P}/milestones/${fx.M}`, { description: "x" });
  await r("DELETE milestone", "DELETE", `/api/projects/${fx.P}/milestones/${fx.M}`);
  await r("GET views", "GET", "/api/views", undefined, (l) => l.length);
  await r("GET view", "GET", `/api/views/${fx.V}`);
  const own = await r("POST view", "POST", "/api/views", { name: `CV ${n}`, filter: {} });
  await r("PATCH view", "PATCH", `/api/views/${fx.V}`, { name: `V ${n}` });
  await r("PATCH own view", "PATCH", `/api/views/${own.body.id ?? fx.V}`, { name: `CV ${n}` });
  await r("PUT view favorite", "PUT", `/api/views/${fx.V}/favorite`);
  await r("DELETE view favorite", "DELETE", `/api/views/${fx.V}/favorite`);
  await r("DELETE own view", "DELETE", `/api/views/${own.body.id ?? fx.V}`);
  await r("DELETE view", "DELETE", `/api/views/${fx.V}`);
  await r("GET notifications", "GET", "/api/notifications");
  await r("PATCH notifications", "PATCH", "/api/notifications", { read: true });
  await r("DELETE notifications", "DELETE", "/api/notifications?read=true");
  await r("GET push", "GET", "/api/push");
  await r("PUT push", "PUT", "/api/push", { endpoint: "x" });
  await r("DELETE push", "DELETE", "/api/push", { endpoint: "x" });
  await r("POST push test", "POST", "/api/push/test");
  await r("GET issues", "GET", "/api/issues", undefined, (l) => l.length);
  await r("GET issues page", "GET", "/api/issues?first=1");
  await r("POST bulk", "POST", "/api/issues/bulk", { ids: TEAMS.map((T) => fx.teams[T]!.I), patch: { priority: 2 } }, (res) => res.results.map((x: any) => x.error ?? "ok"));

  for (const T of TEAMS) {
    const t = fx.teams[T]!;
    const tr = (name: string, ...rest: [string, string, unknown?, ((body: any) => unknown)?]) => r(`${T} ${name}`, ...rest);
    // Issues
    await tr("GET issues", "GET", `/api/issues?team=${T}`, undefined, (l) => l.length);
    await tr("POST issue", "POST", "/api/issues", { team: T, title: "new" });
    await tr("POST issue with new label", "POST", "/api/issues", { team: T, title: "labeled", labels: [`inl-${n}-${T}`] });
    await tr("GET issue", "GET", `/api/issues/${t.I}`);
    await tr("PATCH issue", "PATCH", `/api/issues/${t.I}`, { title: "edited" });
    const commented = await tr("POST comment", "POST", `/api/issues/${t.I}/comments`, { body: "mine" });
    const mine = commented.body.comments?.at(-1).id ?? t.C;
    await tr("PATCH own comment", "PATCH", `/api/issues/${t.I}/comments/${mine}`, { body: "edited" });
    await tr("PATCH boss comment", "PATCH", `/api/issues/${t.I}/comments/${t.C}`, { body: "edited" });
    await tr("PUT resolved", "PUT", `/api/issues/${t.I}/comments/${t.C}/resolved`);
    await tr("DELETE resolved", "DELETE", `/api/issues/${t.I}/comments/${t.C}/resolved`);
    await tr("PUT reaction", "PUT", `/api/issues/${t.I}/reactions/${emoji}`);
    await tr("DELETE reaction", "DELETE", `/api/issues/${t.I}/reactions/${emoji}`);
    await tr("PUT comment reaction", "PUT", `/api/issues/${t.I}/comments/${t.C}/reactions/${emoji}`);
    await tr("DELETE comment reaction", "DELETE", `/api/issues/${t.I}/comments/${t.C}/reactions/${emoji}`);
    await tr("PUT subscription", "PUT", `/api/issues/${t.I}/subscription`);
    await tr("DELETE subscription", "DELETE", `/api/issues/${t.I}/subscription`);
    await tr("POST claim", "POST", `/api/issues/${t.I}/claim`);
    await tr("POST archive", "POST", `/api/issues/${t.I}/archive`);
    await tr("POST unarchive", "POST", `/api/issues/${t.I}/unarchive`);
    await tr("DELETE own comment", "DELETE", `/api/issues/${t.I}/comments/${mine}`);
    await tr("DELETE boss comment", "DELETE", `/api/issues/${t.I}/comments/${t.C}`);
    await tr("DELETE issue", "DELETE", `/api/issues/${t.K}`);
    await tr("POST restore issue", "POST", `/api/issues/${t.J}/restore`);
    await tr("POST purge issue", "POST", `/api/issues/${t.J2}/purge`);
    // Documents
    await tr("GET documents", "GET", `/api/documents?team=${T}`, undefined, (l) => l.length);
    await tr("POST document", "POST", "/api/documents", { team: T, title: `New ${n} ${T}`, content: "x" });
    await tr("GET document", "GET", `/api/documents/${t.D}`);
    await tr("GET document raw", "GET", `/api/documents/${t.D}/raw`);
    await tr("PATCH document", "PATCH", `/api/documents/${t.D}`, { title: "edited" });
    const docCommented = await tr("POST doc comment", "POST", `/api/documents/${t.D}/comments`, { body: "mine" });
    const myDoc = docCommented.body.comments?.at(-1).id ?? t.DC;
    await tr("PATCH own doc comment", "PATCH", `/api/documents/${t.D}/comments/${myDoc}`, { body: "edited" });
    await tr("PUT doc resolved", "PUT", `/api/documents/${t.D}/comments/${t.DC}/resolved`);
    await tr("DELETE doc resolved", "DELETE", `/api/documents/${t.D}/comments/${t.DC}/resolved`);
    await tr("PUT doc comment reaction", "PUT", `/api/documents/${t.D}/comments/${t.DC}/reactions/${emoji}`);
    await tr("DELETE doc comment reaction", "DELETE", `/api/documents/${t.D}/comments/${t.DC}/reactions/${emoji}`);
    await tr("PUT doc subscription", "PUT", `/api/documents/${t.D}/subscription`);
    await tr("DELETE doc subscription", "DELETE", `/api/documents/${t.D}/subscription`);
    await tr("GET doc versions", "GET", `/api/documents/${t.D}/versions`);
    await tr("GET doc version", "GET", `/api/documents/${t.D}/versions/999999`);
    await tr("DELETE own doc comment", "DELETE", `/api/documents/${t.D}/comments/${myDoc}`);
    await tr("DELETE boss doc comment", "DELETE", `/api/documents/${t.D}/comments/${t.DC}`);
    await tr("DELETE document", "DELETE", `/api/documents/${t.DK}`);
    await tr("POST restore document", "POST", `/api/documents/${t.DJ}/restore`);
    await tr("POST purge document", "POST", `/api/documents/${t.DJ2}/purge`);
    // The team: settings, workflow, templates, labels, members
    await tr("PATCH team", "PATCH", `/api/teams/${T}`, { description: "edited" });
    await tr("GET cycles", "GET", `/api/teams/${T}/cycles`);
    await tr("GET trash", "GET", `/api/teams/${T}/trash`);
    await tr("DELETE team", "DELETE", `/api/teams/${T}?confirm=nope`);
    await tr("POST status", "POST", `/api/teams/${T}/statuses`, { key: `ns${n}`, name: `Ns ${n}`, category: "unstarted" });
    await tr("PATCH status", "PATCH", `/api/teams/${T}/statuses/${t.ST}`, { color: "#123456" });
    await tr("DELETE status", "DELETE", `/api/teams/${T}/statuses/${t.ST}`);
    await tr("GET templates", "GET", `/api/templates?team=${T}`);
    await tr("POST template", "POST", "/api/templates", { team: T, name: `ntp ${n}` });
    await tr("PATCH template", "PATCH", `/api/templates/${t.TP}`, { title: "x" });
    await tr("DELETE template", "DELETE", `/api/templates/${t.TP}`);
    await tr("GET labels", "GET", `/api/labels?team=${T}`);
    await tr("POST team label", "POST", "/api/labels", { team: T, name: `ntl-${n}-${T}` });
    await tr("PATCH team label", "PATCH", `/api/labels/${t.TL}`, { color: "#112233" });
    await tr("DELETE team label", "DELETE", `/api/labels/${t.TL}`);
    row[`${T} upload`] = show(await c.raw("POST", `/api/attachments?name=a.txt&team=${T}`, { body: "hi", headers: { "Content-Type": "application/octet-stream" } }));
    row[`${T} GET attachment`] = show(await c.raw("GET", t.F));
    await tr("GET members", "GET", `/api/teams/${T}/members`, undefined, (l) => sorted(l.map((u: any) => u.username)));
    await tr("POST member", "POST", `/api/teams/${T}/members`, { username: "tn" });
    await tr("POST guest member", "POST", `/api/teams/${T}/members`, { username: "gx" });
    await tr("DELETE member", "DELETE", `/api/teams/${T}/members/tm`);
  }
  // Last, as they change what the caller sees: privacy, then joining and leaving.
  for (const T of TEAMS) {
    await r(`${T} PATCH private`, "PATCH", `/api/teams/${T}`, { private: T !== "PRIV" });
    await r(`${T} PATCH private back`, "PATCH", `/api/teams/${T}`, { private: T === "PRIV" });
  }
  for (const T of TEAMS) {
    await r(`${T} join`, "POST", `/api/teams/${T}/members`, { username: "me" });
    await r(`${T} leave`, "DELETE", `/api/teams/${T}/members/me`);
  }
}

/** Every MCP tool, as `c` (keys only): tools/list, then each tool on each team. */
async function mcp(c: Caller, n: string, row: Record<string, string>) {
  const fx = await fixtures(`${n}m`);
  row["tools/list"] = (await c.tools()).join(",");
  const call = async (name: string, tool: string, args: Record<string, unknown>) => {
    if (name in row) throw new Error(`two probes named ${name}`);
    try {
      const res = await c.toolResult(tool, args);
      row[name] = res.isError ? `error ${res.content.map((x) => x.text).join("\n")}` : "ok";
      return res;
    } catch (err) {
      row[name] = `throws ${(err as Error).message}`;
      return null;
    }
  };
  await call("update_workspace", "update_workspace", { name: "Acme" });
  await call("list_members", "list_members", {});
  await call("list_teams", "list_teams", {});
  await call("create_team", "create_team", { key: `Y${n.replace(/\d/g, (d) => "ABCDEFGHIJ"[Number(d)]!).toUpperCase()}`, name: `Y ${n}` });
  await call("list_labels", "list_labels", {});
  await call("list_projects", "list_projects", {});
  await call("get_project", "get_project", { slug: fx.P });
  await call("create_project", "create_project", { teams: ["OWN"], name: `MP ${n}` });
  await call("update_project", "update_project", { slug: fx.P, description: "x" });
  await call("create_milestone", "create_milestone", { project: fx.P, name: "M2" });
  await call("update_milestone", "update_milestone", { project: fx.P, milestone: "M", description: "x" });
  await call("list_notifications", "list_notifications", {});
  await call("mark_notifications_read", "mark_notifications_read", { all: true });
  await call("bulk_update_issues", "bulk_update_issues", { ids: TEAMS.map((T) => fx.teams[T]!.I), patch: { priority: 1 } });
  for (const T of TEAMS) {
    const t = fx.teams[T]!;
    const tc = (tool: string, args: Record<string, unknown>, name = tool) => call(`${T} ${name}`, tool, args);
    await tc("update_team", { key: T, description: "m" });
    await tc("list_cycles", { team: T });
    await tc("list_templates", { team: T });
    await tc("list_issues", { team: T });
    await tc("get_issue", { id: t.I });
    await tc("create_issue", { team: T, title: "new" });
    await tc("create_issue", { team: T, title: "labeled", labels: [`minl-${n}-${T}`] }, "create_issue with new label");
    await tc("update_issue", { id: t.I, title: "edited" });
    await tc("comment_issue", { id: t.I, body: "mine" });
    await tc("update_comment", { issue: t.I, comment: t.C, body: "edited" });
    await tc("resolve_thread", { issue: t.I, comment: t.C });
    await tc("react", { issue: t.I, emoji: "👍" });
    await tc("subscribe", { issue: t.I });
    await tc("claim_issue", { id: t.I });
    await tc("archive_issue", { id: t.I });
    await tc("restore", { issue: t.J });
    await tc("list_documents", { team: T });
    await tc("get_document", { slug: t.D });
    await tc("create_document", { team: T, title: `M ${n} ${T}`, content: "x" });
    await tc("update_document", { slug: t.D, title: "edited" });
    await tc("comment_document", { slug: t.D, body: "mine" });
    await tc("document_versions", { slug: t.D });
    await tc("delete_comment", { document: t.D, comment: t.DC });
    await tc("delete_document", { slug: t.DK });
    await tc("attach_file", { name: "a.txt", text: "x", team: T });
    await tc("get_attachment", { url: t.F });
  }
}

test("what each caller's socket hears", async () => {
  const sockets = callers.map((c) => ({ label: c.label, ws: c.caller.ws() }));
  for (const { ws } of sockets) expect(await ws.opened).toBe(true);
  for (const T of TEAMS) await b("POST", "/api/issues", { team: T, title: "heard?" });
  await b("POST", "/api/views", { name: "Heard?", filter: {} });
  await b("PATCH", "/api/workspaces/acme/members/tm", { role: "member" });
  const sentinel = String((await b("POST", "/api/labels", { name: "sentinel" })).id);
  const row: Record<string, string> = {};
  for (const { label, ws } of sockets) {
    await ws.until((e) => e.entity === "label" && e.id === sentinel, 5000);
    row[label] = sorted([...new Set(ws.events.map((e) => `${e.entity}:${e.id}`))]);
    ws.close();
  }
  if (UPDATE) golden.sockets = row;
  else expect(row).toEqual(golden.sockets!);
}, 30_000);

for (const [i, label] of ["admin session", "admin write key", "admin read key", "member session", "member write key", "member read key", "guest session", "guest write key", "guest read key", "agent token"].entries()) {
  test(`access matrix: ${label}`, async () => {
    const c = callers.find((x) => x.label === label)!;
    const row: Record<string, string> = {};
    await reset(c.username);
    await rest(c.caller, String(i), row);
    if (c.key) {
      await reset(c.username);
      await mcp(c.caller, String(i), row);
    }
    if (UPDATE) golden[label] = row;
    else expect(row).toEqual(golden[label]!);
  }, 120_000);
}

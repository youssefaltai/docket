// @mentions (DKT-10): `@username` in descriptions, comments and docs is stored per text for active members of the
// text's own workspace, recomputed on every save. Mentions aren't in the API, so these read the table directly.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let ana: Caller;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "MEN", name: "Mentions" });
  ana = await s.user("ana");
  await s.user("kim");
  await s.user("sue");
  await s.agent("claude", { name: "Claude" });
  expect((await s.api("PATCH", "/api/workspaces/acme/members/sue", { suspended: true })).status).toBe(200);
  // Another workspace: zed is only there, and its kim is someone else.
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  await s.user("zed", { workspace: "side" });
  await s.user("kim", { workspace: "side", as: "kim-side" });
});
afterAll(() => s.stop());

/** Who a text mentions, as acme knows them (anyone else shows as `outsider`), with the author. */
function mentioned(source: string): string[] {
  return s
    .sql(
      `SELECT COALESCE(m.username, 'outsider') || ' by ' || a.username AS who FROM mentions x
       LEFT JOIN workspace_members m ON m.user_id = x.user_id AND m.workspace = 'acme'
       JOIN workspace_members a ON a.user_id = x.author_id AND a.workspace = 'acme'
       WHERE x.source = ? ORDER BY who`,
      source,
    )
    .map((r) => r.who);
}
const rowId = (sql: string, ...params: (string | number)[]) => s.sql(sql, ...params)[0].id as number;
const issueSource = (number: number) =>
  `issue:${rowId("SELECT i.id FROM issues i JOIN teams t ON t.id = i.team_id WHERE t.workspace = 'acme' AND t.key = 'MEN' AND i.number = ?", number)}`;
const docSource = (slug: string) => `document:${rowId("SELECT id FROM documents WHERE workspace = 'acme' AND slug = ?", slug)}`;
const createdAt = (source: string) => s.sql("SELECT user_id, created_at FROM mentions WHERE source = ? ORDER BY user_id", source);

const issue = async (title: string, description?: string) => (await s.api("POST", "/api/issues", { team: "MEN", title, description })).body;
const comment = async (by: Caller, id: string, body: string) => {
  const res = await by.api("POST", `/api/issues/${id}/comments`, { body });
  expect(res.status).toBe(201);
  return `comment:${res.body.comments.at(-1).id}`;
};

test("people and agents are mentioned in prose; code, link text, emails and URLs don't count", async () => {
  const { id } = await issue("Prose");
  const source = await comment(
    s.admin,
    id,
    "hey @ana and @Claude, cc bob@kim, `@kim`, [@kim](https://example.com), https://x.com/@kim\n\n```\n@kim\n```",
  );
  expect(mentioned(source)).toEqual(["ana by admin", "claude by admin"]);
});

test("only active members of the text's own workspace, never the author; trailing punctuation drops", async () => {
  const { id } = await issue("Who");
  expect(mentioned(await comment(s.admin, id, "Thanks @ana."))).toEqual(["ana by admin"]);
  expect(mentioned(await comment(s.admin, id, "@nobody @admin @sue @zed"))).toEqual([]);
  // kim in side is someone else: @kim here is acme's kim.
  expect(mentioned(await comment(s.admin, id, "@kim-side? no: @kim"))).toEqual(["kim by admin"]);
  // In side, @zed and side's kim count, and acme's people don't.
  const side = s.as("admin", "cookie", "side");
  await side.api("POST", "/api/teams", { key: "SID", name: "Side" });
  await side.api("POST", "/api/issues", { team: "SID", title: "Over there" });
  const there = (await side.api("POST", "/api/issues/SID-1/comments", { body: "@zed @kim @ana @claude" })).body.comments.at(-1).id;
  const rows = s.sql("SELECT m.username FROM mentions x JOIN workspace_members m ON m.user_id = x.user_id AND m.workspace = 'side' WHERE x.source = ? ORDER BY 1", `comment:${there}`);
  const [total] = s.sql("SELECT COUNT(*) AS n FROM mentions WHERE source = ?", `comment:${there}`);
  expect(rows).toEqual([{ username: "kim" }, { username: "zed" }]);
  expect(total).toEqual({ n: 2 });
});

test("editing a comment keeps, adds and drops mentions; deleting it drops them all", async () => {
  const { id } = await issue("Edits");
  const source = await comment(ana, id, "ping @kim and @claude");
  const kept = createdAt(source).find((r: any) => r.user_id === rowId("SELECT user_id AS id FROM workspace_members WHERE workspace = 'acme' AND username = 'claude'"));
  await Bun.sleep(5);
  const cid = source.split(":")[1];
  expect((await ana.api("PATCH", `/api/issues/${id}/comments/${cid}`, { body: "ping @admin and @claude" })).status).toBe(200);
  expect(mentioned(source)).toEqual(["admin by ana", "claude by ana"]);
  // Kept mentions aren't new: they keep the time they were first made.
  expect(createdAt(source)).toContainEqual(kept);
  expect((await ana.api("DELETE", `/api/issues/${id}/comments/${cid}`)).status).toBe(200);
  expect(mentioned(source)).toEqual([]);
});

test("issue descriptions: on create and on PATCH, and only when the description changes", async () => {
  const created = await issue("Described", "For @ana");
  const source = issueSource(created.number);
  expect(mentioned(source)).toEqual(["ana by admin"]);
  await ana.api("PATCH", `/api/issues/${created.id}`, { title: "Renamed" });
  expect(mentioned(source)).toEqual(["ana by admin"]);
  await ana.api("PATCH", `/api/issues/${created.id}`, { description: "For @ana and @kim" });
  expect(mentioned(source)).toEqual(["ana by admin", "kim by ana"]);
  await s.api("PATCH", `/api/issues/${created.id}`, { description: "For @kim" });
  expect(mentioned(source)).toEqual(["kim by ana"]);
});

test("a doc doesn't mention a name still being typed at its very end", async () => {
  const doc = (await s.api("POST", "/api/documents", { team: "MEN", title: "Typing", content: "Owner: @ana" })).body;
  const source = docSource(doc.slug);
  expect(mentioned(source)).toEqual([]);
  await s.api("PATCH", `/api/documents/${doc.slug}`, { content: "Owner: @ana " });
  expect(mentioned(source)).toEqual(["ana by admin"]);
  await s.api("PATCH", `/api/documents/${doc.slug}`, { edits: [{ oldText: "@ana ", newText: "@ana, reviewer: @ki" }] });
  expect(mentioned(source)).toEqual(["ana by admin"]);
  await s.api("PATCH", `/api/documents/${doc.slug}`, { edits: [{ oldText: "@ki", newText: "@kim done" }] });
  expect(mentioned(source)).toEqual(["ana by admin", "kim by admin"]);
  // Doc comments aren't typed live: a mention at the end counts.
  const posted = (await ana.api("POST", `/api/documents/${doc.slug}/comments`, { body: "cc @kim" })).body.comments.at(-1).id;
  expect(mentioned(`document_comment:${posted}`)).toEqual(["kim by ana"]);
  await ana.api("PATCH", `/api/documents/${doc.slug}/comments/${posted}`, { body: "cc @claude" });
  expect(mentioned(`document_comment:${posted}`)).toEqual(["claude by ana"]);
  await ana.api("DELETE", `/api/documents/${doc.slug}/comments/${posted}`);
  expect(mentioned(`document_comment:${posted}`)).toEqual([]);
});

test("over MCP, the agent is the author", async () => {
  const { id } = await issue("Agent");
  await s.as("claude").tool("comment_issue", { id, body: "Done, @ana: please review." });
  const cid = (await s.api("GET", `/api/issues/${id}`)).body.comments.at(-1).id;
  expect(mentioned(`comment:${cid}`)).toEqual(["ana by claude"]);
  expect(await s.as("claude").instructions()).toContain("Mention people or agents as @username");
});

test("a mention someone else made stays when the mentioned person edits the text", async () => {
  const created = await issue("Kept", "Over to @ana");
  await ana.api("PATCH", `/api/issues/${created.id}`, { description: "Over to @ana: on it" });
  expect(mentioned(issueSource(created.number))).toEqual(["ana by admin"]);
});

test("purging an issue from the trash takes its mentions with it", async () => {
  const gone = await issue("Gone", "@ana");
  const cid = (await comment(s.admin, gone.id, "@kim")).split(":")[1];
  const source = issueSource(gone.number);
  await s.api("DELETE", `/api/issues/${gone.id}`);
  s.sql("UPDATE issues SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE deleted_at IS NOT NULL");
  await s.api("GET", "/api/teams/MEN/trash");
  expect([mentioned(source), mentioned(`comment:${cid}`)]).toEqual([[], []]);
});

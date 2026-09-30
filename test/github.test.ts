// The GitHub integration (DKT-34): admins connect it and get a payload URL and secret once; signed pull_request and push
// deliveries link PRs and commits to issues by identifier and move them along as @github; anything unsigned is refused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { request } from "node:http";
import { startServer, type Caller, type TestServer } from "./server.ts";

let s: TestServer;
let ana: Caller;
let secret: string;
beforeAll(async () => {
  s = await startServer();
  await s.api("POST", "/api/teams", { key: "GH", name: "Code" });
  await s.api("POST", "/api/teams", { key: "WEB", name: "Web" });
  ana = await s.user("ana");
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  expect((await s.as("admin", "cookie", "side").api("POST", "/api/teams", { key: "OTH", name: "Other" })).status).toBe(201);
  expect((await s.as("admin", "cookie", "side").api("POST", "/api/issues", { team: "OTH", title: "Elsewhere" })).status).toBe(201);
  const connected = await s.api("POST", "/api/workspaces/acme/github");
  expect(connected.status).toBe(201);
  secret = connected.body.secret;
});
afterAll(() => s.stop());

const sign = (body: string, key = secret) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

/** A delivery as GitHub sends it: signed over the exact bytes, no credentials. */
async function deliver(
  event: string,
  payload: unknown,
  { workspace = "acme", key = secret, signature, type = "application/json" }: { workspace?: string; key?: string; signature?: string | null; type?: string } = {},
) {
  const body = JSON.stringify(payload);
  const sig = signature === undefined ? sign(body, key) : signature;
  const res = await fetch(new URL(`/api/github/${workspace}`, s.url), {
    method: "POST",
    headers: { "Content-Type": type, "X-GitHub-Event": event, ...(sig === null ? {} : { "X-Hub-Signature-256": sig }) },
    body,
  });
  return { status: res.status, body: await res.json() };
}

type PR = { action?: string; branch?: string; title?: string; body?: string; draft?: boolean; state?: string; merged?: boolean; url?: string };
const pr = (n: number, o: PR = {}) => ({
  action: o.action ?? "opened",
  number: n,
  pull_request: {
    number: n,
    html_url: o.url ?? `https://github.com/acme/app/pull/${n}`,
    title: o.title ?? `Change ${n}`,
    body: o.body ?? null,
    draft: o.draft ?? false,
    state: o.state ?? "open",
    merged: o.merged ?? false,
    head: { ref: o.branch ?? `feature-${n}` },
  },
  repository: { default_branch: "main" },
});
const merged = (n: number, o: PR = {}) => pr(n, { ...o, action: "closed", state: "closed", merged: true });
const push = (ref: string, ...messages: string[]) => ({
  ref,
  repository: { default_branch: "main" },
  commits: messages.map((message, i) => ({ id: `c${i}`, message, url: `https://github.com/acme/app/commit/${ref.length}${i}${messages.length}${message.length}` })),
});

async function issue(title: string, status?: string): Promise<string> {
  const res = await s.api("POST", "/api/issues", { team: "GH", title, ...(status && { status }) });
  expect(res.status).toBe(201);
  return res.body.id;
}
const get = async (id: string) => (await s.api("GET", `/api/issues/${id}`)).body;

describe("connecting", () => {
  test("an admin connects in a browser session and gets the payload URL and a secret once; keys and members get 403", async () => {
    const again = await s.api("POST", "/api/workspaces/acme/github");
    expect(again.status).toBe(201);
    expect(again.body.url).toBe(`${new URL(s.url).origin}/api/github/acme`);
    expect(again.body.secret).toMatch(/^dkgh_[0-9a-f]{64}$/);
    // A new secret replaces the old one at once.
    expect((await deliver("ping", {}, { key: secret })).status).toBe(401);
    secret = again.body.secret;
    expect((await deliver("ping", {})).body).toEqual({ ok: true });

    const shown = await s.api("GET", "/api/workspaces/acme/github");
    expect(shown.body).toEqual({ connected: true, url: again.body.url, account: { username: "github", name: "GitHub", kind: "agent" } });
    expect(JSON.stringify(shown.body)).not.toContain(secret);
    for (const caller of [s.as("admin", "bearer"), ana]) {
      expect((await caller.api("GET", "/api/workspaces/acme/github")).status).toBe(403);
      expect((await caller.api("POST", "/api/workspaces/acme/github")).status).toBe(403);
      expect((await caller.api("DELETE", "/api/workspaces/acme/github")).status).toBe(403);
    }
    expect((await s.api("GET", "/api/workspaces/side/github")).body).toMatchObject({ connected: false, account: null });
  });

  test("its account is an integration: listed, but never delegated to, given a token, removed or suspended as a member", async () => {
    const members = (await s.api("GET", "/api/workspaces/acme/members")).body;
    expect(members.find((m: any) => m.user.username === "github")).toMatchObject({ role: "agent", integration: true, suspendedAt: null });
    expect(members.find((m: any) => m.user.username === "ana")).toMatchObject({ integration: false });
    const id = await issue("Delegate me");
    const delegated = await s.api("PATCH", `/api/issues/${id}`, { delegate: "github" });
    expect(delegated.status).toBe(400);
    expect(delegated.body.error).toBe("delegate: github is an integration");
    expect((await s.api("POST", "/api/issues", { team: "GH", title: "x", delegate: "github" })).status).toBe(400);
    expect((await s.api("POST", "/api/workspaces/acme/agents/github/token")).status).toBe(400);
    expect((await s.api("DELETE", "/api/workspaces/acme/agents/github")).status).toBe(400);
    expect((await s.api("PATCH", "/api/workspaces/acme/members/github", { suspended: true })).status).toBe(400);
    expect(await s.tool("list_members")).toContain("@github · GitHub · agent · integration");
  });
});

describe("the webhook refuses anything unsigned", () => {
  test("ping answers; a wrong, missing or other workspace's signature, an unknown or unconnected workspace are all the same 401", async () => {
    expect(await deliver("ping", { zen: "hi" })).toEqual({ status: 200, body: { ok: true } });
    const id = await issue("Untouched");
    const payload = pr(900, { branch: `ana/${id.toLowerCase()}-x` });
    const refused = [
      await deliver("pull_request", payload, { signature: null }),
      await deliver("pull_request", payload, { key: "wrong" }),
      await deliver("pull_request", payload, { signature: sign(JSON.stringify(payload)).toUpperCase() }),
      await deliver("pull_request", payload, { signature: `${sign(JSON.stringify(payload))}00` }),
      await deliver("pull_request", payload, { signature: sign(JSON.stringify(payload)).slice(7) }),
      await deliver("pull_request", payload, { signature: "sha256=é".padEnd(71, "0") }), // as long, but not ASCII
      await deliver("pull_request", payload, { workspace: "nope" }),
      await deliver("pull_request", payload, { workspace: "side" }),
    ];
    for (const r of refused) expect(r).toEqual({ status: 401, body: { error: "Invalid signature" } });
    expect(await get(id)).toMatchObject({ status: "backlog", links: [] });
  });

  test("the signature covers the exact bytes: the same JSON re-serialized, or one byte changed, is refused", async () => {
    const id = await issue("Bytes");
    const body = JSON.stringify(pr(901, { branch: `ana/${id.toLowerCase()}` }));
    const send = (bytes: string, sig: string) =>
      fetch(new URL("/api/github/acme", s.url), { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "pull_request", "X-Hub-Signature-256": sig }, body: bytes });
    expect((await send(JSON.stringify(JSON.parse(body), null, 2), sign(body))).status).toBe(401);
    expect((await send(body.replace("901", "902"), sign(body))).status).toBe(401);
    expect((await get(id)).links).toEqual([]);
    expect((await send(body, sign(body))).status).toBe(200);
    expect((await get(id)).links).toHaveLength(1);
  });

  test("415 for anything but JSON; other events are ignored; bad JSON is 400 only once signed", async () => {
    expect((await deliver("ping", {}, { type: "application/x-www-form-urlencoded" })).status).toBe(415);
    expect(await deliver("issues", { action: "opened" })).toEqual({ status: 200, body: { ignored: "issues" } });
    expect(await deliver("pull_request", { ...pr(1), action: "labeled" })).toEqual({ status: 200, body: { ignored: "pull_request labeled" } });
    const res = await fetch(new URL("/api/github/acme", s.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "ping", "X-Hub-Signature-256": sign("{nope") },
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });

  // fetch normalizes paths; Bun routes on the raw one. Nothing reaches the handler (or anything else) unsigned.
  test("raw path variants never get past the signature", async () => {
    const id = await issue("Raw");
    const body = JSON.stringify(pr(903, { branch: `ana/${id.toLowerCase()}` }));
    const u = new URL(s.url);
    const post = (path: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve, reject) => {
        const r = request(
          { host: u.hostname, port: u.port, path, method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "pull_request", ...headers } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode!));
          },
        );
        r.on("error", reject);
        r.end(body);
      });
    const paths = [
      "/api/github/acme",
      "/api/github/ACME",
      "/api/github/%61cme",
      "/api/github/acme/",
      "/api/github//acme",
      "/api/github/acme/..",
      "/api/github/x/../acme",
      "/api/github/..%2facme",
      "/api/github/%2e%2e/github/acme",
      "/api/github/acme%00",
      "/api/github/acme?workspace=acme",
      "/api/github/acme#x",
      "/api//github/acme",
    ];
    for (const path of paths) {
      for (const headers of [{}, { "X-Hub-Signature-256": sign(body, "wrong") }] as Record<string, string>[]) {
        const status = await post(path, headers);
        expect({ path, refused: status === 401 || status === 404 }).toEqual({ path, refused: true });
      }
    }
    expect((await get(id)).links).toEqual([]);
    // Host check (DNS rebinding), before anything else.
    expect(await post("/api/github/acme", { Host: "evil.example", "X-Hub-Signature-256": sign(body) })).toBe(403);
    expect(await post("/api/github/acme", { "X-Hub-Signature-256": sign(body) })).toBe(200);
  });

  test("bodies over 1 MB are refused, with or without a Content-Length", async () => {
    const big = JSON.stringify({ zen: "x".repeat(1024 * 1024) });
    const sized = await fetch(new URL("/api/github/acme", s.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "ping", "X-Hub-Signature-256": sign(big) },
      body: big,
    });
    expect(sized.status).toBe(413);
    const u = new URL(s.url);
    const chunked = await new Promise<number>((resolve, reject) => {
      const r = request(
        {
          host: u.hostname,
          port: u.port,
          path: "/api/github/acme",
          method: "POST",
          headers: { "Content-Type": "application/json", "X-GitHub-Event": "ping", "X-Hub-Signature-256": sign(big), "Transfer-Encoding": "chunked" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      r.on("error", reject);
      for (let i = 0; i < big.length; i += 64 * 1024) r.write(big.slice(i, i + 64 * 1024));
      r.end();
    });
    expect(chunked).toBe(413);
  });
});

describe("pull requests", () => {
  test("a branch with the identifier links it and moves it to in_review as @github; merging moves it to done", async () => {
    const id = await issue("Fix login");
    const opened = await deliver("pull_request", pr(1, { branch: `ana/${id.toLowerCase()}-fix-login`, title: "Fix the login" }));
    expect(opened).toEqual({ status: 200, body: { linked: [id], moved: { [id]: "in_review" } } });
    const after = await get(id);
    expect(after).toMatchObject({ status: "in_review", links: [{ kind: "pull_request", number: 1, state: "open", title: "Fix the login", closes: true, url: "https://github.com/acme/app/pull/1" }] });
    expect(after.activity.at(-1)).toMatchObject({ kind: "status", from: "backlog", to: "in_review", actor: { username: "github", name: "GitHub", kind: "agent" } });
    // The creator follows it: told of the move, by GitHub.
    const inbox = (await s.api("GET", "/api/notifications")).body.notifications;
    expect(inbox.find((n: any) => n.issue?.id === id)).toMatchObject({ kind: "status", status: "in_review", actor: { username: "github" } });

    // An edit or a new push to the same PR doesn't move it again (someone moved it back by hand).
    await s.api("PATCH", `/api/issues/${id}`, { status: "in_progress" });
    expect((await deliver("pull_request", pr(1, { action: "synchronize", branch: `ana/${id.toLowerCase()}-fix-login`, title: "Fix the login" }))).body).toEqual({ linked: [id], moved: {} });
    expect((await get(id)).status).toBe("in_progress");
    // A title edit changes the link but is no state change either.
    expect((await deliver("pull_request", pr(1, { action: "edited", branch: `ana/${id.toLowerCase()}-fix-login`, title: "Fix the login page" }))).body).toEqual({ linked: [id], moved: {} });
    expect(await get(id)).toMatchObject({ status: "in_progress", links: [{ title: "Fix the login page" }] });

    expect((await deliver("pull_request", merged(1, { branch: `ana/${id.toLowerCase()}-fix-login`, title: "Fix the login" }))).body).toEqual({ linked: [id], moved: { [id]: "done" } });
    expect(await get(id)).toMatchObject({ status: "done", links: [{ state: "merged" }] });
  });

  test("an edit that adds a closing reference moves that issue; a replay after the merge doesn't re-close a reopened one", async () => {
    const [first, added] = [await issue("Already referenced"), await issue("Added by edit")];
    await deliver("pull_request", pr(3, { body: `Fixes ${first}` }));
    expect((await deliver("pull_request", pr(3, { action: "edited", body: `Fixes ${first} and ${added}` }))).body).toEqual({ linked: [first, added], moved: { [added]: "in_review" } });
    await deliver("pull_request", merged(3, { body: `Fixes ${first}` }));
    await s.api("PATCH", `/api/issues/${first}`, { status: "in_progress" });
    await deliver("pull_request", pr(3, { body: `Fixes ${first}` }));
    expect((await deliver("pull_request", merged(3, { body: `Fixes ${first}` }))).body).toEqual({ linked: [first], moved: {} });
    expect(await get(first)).toMatchObject({ status: "in_progress", links: [{ state: "merged" }] });
  });

  test("a draft moves an unstarted issue to in_progress but never an in_review one back; ready for review moves it on", async () => {
    const todo = await issue("Draft me", "todo");
    const review = await issue("Already in review", "in_review");
    const body = `Fixes ${todo} and ${review}`;
    expect((await deliver("pull_request", pr(2, { draft: true, body }))).body).toEqual({ linked: [todo, review], moved: { [todo]: "in_progress" } });
    expect((await get(review)).status).toBe("in_review");
    expect((await get(todo)).links[0]).toMatchObject({ state: "draft" });
    expect((await deliver("pull_request", pr(2, { action: "ready_for_review", body }))).body).toEqual({ linked: [todo, review], moved: { [todo]: "in_review" } });
  });

  test("magic words: several identifiers link and close; a contributing word links without moving, and wins", async () => {
    const [a, b, c, d, e] = [await issue("A"), await issue("B"), await issue("C"), await issue("D"), await issue("E")];
    const res = await deliver("pull_request", pr(3, { body: `Some text.\n\nFixes ${a}, ${b.toLowerCase()} and ${c}\nPart of: ${d}\nresolves ${e}\nrelated to ${e}` }));
    expect(res.body.linked.sort()).toEqual([a, b, c, d, e].sort());
    expect(res.body.moved).toEqual({ [a]: "in_review", [b]: "in_review", [c]: "in_review" });
    expect(await get(d)).toMatchObject({ status: "backlog", links: [{ closes: false }] });
    expect(await get(e)).toMatchObject({ status: "backlog", links: [{ closes: false }] });
    // A bare mention in the body doesn't link; one in the title does (uppercase), and "part of" there too.
    const [f, g] = [await issue("F"), await issue("G")];
    expect((await deliver("pull_request", pr(4, { title: `${f}: tidy, part of ${g}`, body: `See ${g}` }))).body).toEqual({ linked: [f, g], moved: { [f]: "in_review" } });
    const h = await issue("H");
    expect((await deliver("pull_request", pr(5, { title: `tidy ${h.toLowerCase()}`, body: `mentions ${h}` }))).body).toEqual({ linked: [], moved: {} });
  });

  test("a second open closing PR keeps the issue open when the first merges; closed unmerged changes nothing", async () => {
    const id = await issue("Two PRs");
    const body = `Closes ${id}`;
    await deliver("pull_request", pr(6, { body }));
    await deliver("pull_request", pr(7, { body }));
    expect((await deliver("pull_request", merged(6, { body }))).body).toEqual({ linked: [id], moved: {} });
    expect((await get(id)).status).toBe("in_review");
    expect((await deliver("pull_request", merged(7, { body }))).body).toEqual({ linked: [id], moved: { [id]: "done" } });

    const closed = await issue("Closed unmerged");
    await deliver("pull_request", pr(8, { body: `Fixes ${closed}` }));
    expect((await deliver("pull_request", pr(8, { action: "closed", state: "closed", body: `Fixes ${closed}` }))).body).toEqual({ linked: [closed], moved: {} });
    expect(await get(closed)).toMatchObject({ status: "in_review", links: [{ state: "closed" }] });
  });

  test("done and canceled issues never move", async () => {
    const done = await issue("Done", "done");
    const canceled = await issue("Canceled", "canceled");
    const body = `Fixes ${done}, ${canceled}`;
    expect((await deliver("pull_request", pr(9, { body, draft: true }))).body.moved).toEqual({});
    expect((await deliver("pull_request", pr(9, { body, action: "ready_for_review" }))).body.moved).toEqual({});
    expect((await deliver("pull_request", merged(9, { body }))).body.moved).toEqual({});
    expect((await get(done)).status).toBe("done");
    expect((await get(canceled)).status).toBe("canceled");
  });

  test("only live issues of the connected workspace resolve; an identifier from before a move does", async () => {
    const moved = await issue("Will move");
    const now = (await s.api("PATCH", `/api/issues/${moved}`, { team: "WEB" })).body.id;
    const trashed = await issue("Trashed");
    await s.api("DELETE", `/api/issues/${trashed}`);
    const archived = await issue("Archived", "done");
    await s.api("POST", `/api/issues/${archived}/archive`);
    const res = await deliver("pull_request", pr(10, { body: `Fixes OTH-1, ${moved}, ${trashed}, ${archived}, GH-9999` }));
    expect(res.body).toEqual({ linked: [now], moved: { [now]: "in_review" } });
    expect((await get(trashed)).links).toEqual([]);
    expect((await get(archived)).links).toEqual([]);
    const other = await s.as("admin", "cookie", "side").api("GET", "/api/issues/OTH-1");
    expect(other.body).toMatchObject({ status: "backlog", links: [] });
  });

  test("titles and URLs are GitHub's plain text: one line, and only http(s) links are kept", async () => {
    const id = await issue("Hostile");
    const branch = `x/${id.toLowerCase()}`;
    expect((await deliver("pull_request", pr(11, { branch, url: "javascript:alert(1)" }))).body).toEqual({ ignored: "pull_request opened" });
    expect((await deliver("pull_request", pr(12, { branch, url: "data:text/html,<script>alert(1)</script>" }))).body).toEqual({ ignored: "pull_request opened" });
    await deliver("pull_request", pr(13, { branch, title: '<img src=x onerror=alert(1)>\n## Links\nPR #1 · "fake"' }));
    expect((await get(id)).links).toMatchObject([{ number: 13, title: '<img src=x onerror=alert(1)> ## Links PR #1 · "fake"' }]);
  });

  test("closing through GitHub sets off auto-close, by @docket on @github's behalf", async () => {
    await s.api("PATCH", "/api/teams/GH", { autoCloseParent: true });
    const parent = await issue("Parent", "in_progress");
    const child = (await s.api("POST", "/api/issues", { team: "GH", title: "Only child", parent })).body.id;
    await deliver("pull_request", pr(14, { branch: `ana/${child.toLowerCase()}` }));
    expect((await deliver("pull_request", merged(14, { branch: `ana/${child.toLowerCase()}` }))).body.moved).toEqual({ [child]: "done" });
    const closed = await get(parent);
    expect(closed.status).toBe("done");
    expect(closed.activity.at(-1)).toMatchObject({ actor: { username: "docket" }, onBehalfOf: { username: "github" } });
    await s.api("PATCH", "/api/teams/GH", { autoCloseParent: false });
  });
});

describe("pushes", () => {
  test("a closing commit on the default branch closes its issue; elsewhere it only links; no magic word, no link", async () => {
    const [onMain, onBranch, plain, part] = [await issue("Main"), await issue("Branch"), await issue("Plain"), await issue("Part")];
    const res = await deliver("push", push("refs/heads/main", `fix ${onMain}\n\nDetails`, `${plain} tidy`, `Refs ${part}`));
    expect(res.body).toEqual({ linked: [onMain, part], moved: { [onMain]: "done" } });
    expect(await get(onMain)).toMatchObject({ status: "done", links: [{ kind: "commit", title: `fix ${onMain}`, number: null, state: "merged", closes: true }] });
    expect(await get(part)).toMatchObject({ status: "backlog", links: [{ closes: false }] });
    expect((await get(plain)).links).toEqual([]);
    expect((await deliver("push", push("refs/heads/feature", `Fixes ${onBranch}`))).body).toEqual({ linked: [onBranch], moved: {} });
    expect((await get(onBranch)).status).toBe("backlog");
  });

  test("a replayed push doesn't close an issue again after it was reopened; a commit first pushed elsewhere still closes on main", async () => {
    const [id, later] = [await issue("Replayed"), await issue("Merged later")];
    const closing = push("refs/heads/main", `fixes ${id}`);
    expect((await deliver("push", closing)).body).toEqual({ linked: [id], moved: { [id]: "done" } });
    await s.api("PATCH", `/api/issues/${id}`, { status: "in_progress" });
    expect((await deliver("push", closing)).body).toEqual({ linked: [id], moved: {} });
    expect((await get(id)).status).toBe("in_progress");
    // Merging main into a feature branch pushes the same commit there: it stays merged, so a replay still moves nothing.
    await deliver("push", { ...closing, ref: "refs/heads/feature" });
    expect((await deliver("push", closing)).body).toEqual({ linked: [id], moved: {} });
    expect((await get(id)).status).toBe("in_progress");

    const commit = push("refs/heads/feature", `fixes ${later}`); // the same commit, then merged to main
    await deliver("push", commit);
    expect((await deliver("push", { ...commit, ref: "refs/heads/main" })).body).toEqual({ linked: [later], moved: { [later]: "done" } });
  });

  test("a closing commit on main doesn't close an issue whose other closing PR is still open", async () => {
    const id = await issue("Held open");
    await deliver("pull_request", pr(20, { body: `Fixes ${id}` }));
    expect((await deliver("push", push("refs/heads/main", `closes ${id}`))).body).toEqual({ linked: [id], moved: {} });
    expect((await get(id)).status).toBe("in_review");
  });
});

describe("branch names and where links show", () => {
  test("each caller gets their own branch name; a title with nothing Latin gets none; MCP shows branch and links", async () => {
    const id = await issue("Fix the login page when the session cookie expires overnight");
    expect((await ana.api("GET", `/api/issues/${id}`)).body.branchName).toBe(`ana/${id.toLowerCase()}-fix-the-login-page-when-the-session`);
    expect((await get(id)).branchName).toBe(`admin/${id.toLowerCase()}-fix-the-login-page-when-the-session`);
    const arabic = await issue("إصلاح تسجيل الدخول");
    expect((await ana.api("GET", `/api/issues/${arabic}`)).body.branchName).toBe(`ana/${arabic.toLowerCase()}`);

    await deliver("pull_request", pr(30, { branch: `ana/${id.toLowerCase()}`, title: "Fix login" }));
    await deliver("push", push("refs/heads/feature", `Part of ${id}: typo`));
    const text = await s.tool("get_issue", { id });
    expect(text).toContain(`branch admin/${id.toLowerCase()}-fix-the-login-page-when-the-session`);
    expect(text).toContain(`## Links\nPR #30 · open · Fix login · https://github.com/acme/app/pull/30\ncommit · Part of ${id}: typo · https://github.com/acme/app/commit/`);
  });

  test("usernames are made ref-safe", async () => {
    const odd = await s.user("odd", { username: "a..b.lock" });
    const id = await issue("Refs");
    expect((await odd.api("GET", `/api/issues/${id}`)).body.branchName).toBe(`a.b-lock/${id.toLowerCase()}-refs`);
  });
});

describe("private teams", () => {
  test("the integration acts for the workspace: public teams, and private ones only once it's added to them", async () => {
    expect((await s.api("POST", "/api/teams", { key: "PRV", name: "Private", private: true })).status).toBe(201);
    const id = (await s.api("POST", "/api/issues", { team: "PRV", title: "Hidden fix" })).body.id;
    expect((await deliver("pull_request", pr(50, { title: `Fixes ${id}` }))).body).toEqual({ linked: [], moved: {} });
    expect((await get(id)).links).toEqual([]);
    expect((await s.api("POST", "/api/teams/PRV/members", { username: "github" })).status).toBe(200);
    expect((await deliver("pull_request", pr(50, { title: `Fixes ${id}` }))).body).toEqual({ linked: [id], moved: { [id]: "in_review" } });
    expect((await s.api("DELETE", "/api/teams/PRV/members/github")).status).toBe(200);
  });
});

describe("disconnecting", () => {
  test("deliveries stop, the account is suspended (history keeps it); reconnecting reinstates it with a new secret", async () => {
    const id = await issue("Before disconnect");
    await deliver("pull_request", pr(40, { branch: `ana/${id.toLowerCase()}` }));
    expect((await s.api("DELETE", "/api/workspaces/acme/github")).status).toBe(200);
    expect((await s.api("DELETE", "/api/workspaces/acme/github")).status).toBe(409);
    expect((await deliver("ping", {})).status).toBe(401);
    expect((await s.api("GET", "/api/workspaces/acme/github")).body).toMatchObject({ connected: false, account: { username: "github" } });
    const members = (await s.api("GET", "/api/workspaces/acme/members")).body;
    expect(members.find((m: any) => m.user.username === "github")).toMatchObject({ integration: true, suspendedAt: expect.any(String) });
    expect((await get(id)).activity.at(-1).actor).toEqual({ username: "github", name: "GitHub", kind: "agent" });

    const again = await s.api("POST", "/api/workspaces/acme/github");
    expect((await deliver("ping", {}, { key: secret })).status).toBe(401);
    secret = again.body.secret;
    expect((await deliver("ping", {})).status).toBe(200);
    const after = (await s.api("GET", "/api/workspaces/acme/members")).body.filter((m: any) => m.integration);
    expect(after).toMatchObject([{ user: { username: "github" }, suspendedAt: null }]);
  });

  test("a workspace whose own member is @github gets @github-2", async () => {
    await s.user("gh-person", { workspace: "side", username: "github", by: "admin" });
    const side = s.as("admin", "cookie", "side");
    expect((await side.api("POST", "/api/workspaces/side/github")).status).toBe(201);
    expect((await side.api("GET", "/api/workspaces/side/github")).body.account).toEqual({ username: "github-2", name: "GitHub", kind: "agent" });
  });
});

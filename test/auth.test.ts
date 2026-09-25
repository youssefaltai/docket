// Signing in: setup, one-time codes, sessions, API keys, and what anonymous callers can reach.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SETUP_CODE, sessionCookie, startServer, type TestServer } from "./server.ts";

describe("setup", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer({ setup: false });
  });
  afterAll(() => s.stop());

  const setup = (code: string) =>
    s.anon.api("POST", "/api/setup", {
      code,
      email: "owner@example.com",
      name: "Owner",
      username: "owner",
      workspace: { name: "Home", key: "home" },
    });

  test("runs once, with the right code, and signs the creator in as admin", async () => {
    expect((await s.anon.api("GET", "/api/setup")).body).toEqual({ needed: true });
    expect((await s.anon.api("GET", "/api/me")).status).toBe(401);
    expect((await setup("WRNGX-CDEXX")).status).toBe(403);

    const done = await setup(SETUP_CODE);
    expect(done.status).toBe(201);
    const me = await s.with({ cookie: sessionCookie(done.headers) }, "cookie").api("GET", "/api/me");
    expect(me.body.user).toMatchObject({ username: "owner", kind: "person" });
    expect(me.body.workspaces).toEqual([expect.objectContaining({ key: "home", role: "admin" })]);

    expect((await s.anon.api("GET", "/api/setup")).body).toEqual({ needed: false });
    expect((await setup(SETUP_CODE)).status).toBe(409);
  });
});

describe("signed in", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer();
    await s.api("POST", "/api/teams", { key: "AUT", workspace: s.workspace, name: "Auth" });
    await s.user("ana");
    await s.user("sid");
  });
  afterAll(() => s.stop());

  test("nothing but the web UI and setup status answers without credentials", async () => {
    expect((await fetch(s.url)).status).toBe(200);
    expect((await s.anon.api("GET", "/api/setup")).status).toBe(200);
    for (const path of ["/api/me", "/api/workspaces", "/api/teams", "/api/issues", "/api/documents", "/api/sessions", "/api/api-keys"])
      expect([path, (await s.anon.api("GET", path)).status]).toEqual([path, 401]);
    expect((await s.anon.api("POST", "/api/issues", { team: "AUT", title: "x" })).status).toBe(401);
    expect((await s.anon.api("POST", "/mcp", {})).status).toBe(401);
    expect(await s.anon.ws().opened).toBeFalse();
    expect((await s.with({ token: "dk_" + "0".repeat(64) }).api("GET", "/api/me")).status).toBe(401);
    expect((await s.with({ cookie: "docket_session=" + "0".repeat(64) }, "cookie").api("GET", "/api/me")).status).toBe(401);
  });

  test("a sign-in link peeks without being used up, then works once", async () => {
    const link = await s.as("ana").api("POST", "/api/sign-in-links");
    expect(link.status).toBe(201);
    expect(link.body.url).toBe(`${new URL(s.url).origin}/login#${link.body.code}`);
    expect(link.body.code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);

    for (let i = 0; i < 2; i++)
      expect((await s.anon.api("POST", "/api/auth/peek", { code: link.body.code })).body).toMatchObject({ kind: "sign-in", needsProfile: false });
    const first = await s.anon.api("POST", "/api/auth/redeem", { code: link.body.code });
    expect(first.status).toBe(200);
    expect(first.body.user.username).toBe("ana");
    expect((await s.with({ cookie: sessionCookie(first.headers) }, "cookie").api("GET", "/api/me")).body.user.username).toBe("ana");
    expect((await s.anon.api("POST", "/api/auth/redeem", { code: link.body.code })).status).toBe(401);
    expect((await s.anon.api("POST", "/api/auth/peek", { code: link.body.code })).status).toBe(401);
  });

  test("an invite makes a new account when signed out, and joins you when signed in", async () => {
    const invite = async () => (await s.api("POST", `/api/workspaces/${s.workspace}/invites`, { role: "member" })).body.code;
    const code = await invite();
    expect((await s.anon.api("POST", "/api/auth/peek", { code })).body).toMatchObject({ kind: "invite", workspace: "Acme", needsProfile: true });
    expect((await s.anon.api("POST", "/api/auth/redeem", { code })).status).toBeGreaterThanOrEqual(400);
    const joined = await s.anon.api("POST", "/api/auth/redeem", { code, name: "New", username: "newbie" });
    expect(joined.status).toBe(200);
    const newbie = s.with({ cookie: sessionCookie(joined.headers) }, "cookie");
    expect((await newbie.api("GET", "/api/me")).body.workspaces).toEqual([expect.objectContaining({ key: s.workspace, role: "member" })]);

    // Signed in, an invite to another workspace joins you; any profile sent along is ignored.
    await s.api("POST", "/api/workspaces", { name: "Other", key: "other" });
    const other = (await s.api("POST", "/api/workspaces/other/invites", { role: "member" })).body.code;
    expect((await newbie.api("POST", "/api/auth/peek", { code: other })).body).toMatchObject({ needsProfile: false });
    const accepted = await newbie.api("POST", "/api/auth/redeem", { code: other, name: "X", username: "someone-else" });
    expect(accepted.body.user.username).toBe("newbie");
    expect((await newbie.api("GET", "/api/me")).body.workspaces.map((w: any) => w.key).sort()).toEqual(["acme", "other"]);
  });

  test("the session cookie is opaque, HttpOnly and Lax", async () => {
    const link = (await s.as("ana").api("POST", "/api/sign-in-links")).body;
    const res = await s.anon.api("POST", "/api/auth/redeem", { code: link.code });
    const header = res.headers.getSetCookie().find((c) => c.startsWith("docket_session="))!;
    expect(header).toMatch(/^docket_session=[0-9a-f]{64};/);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).not.toMatch(/Secure/i); // plain http in tests
  });

  test("sessions can be listed and signed out, one or all but this one", async () => {
    const sessions = [];
    for (let i = 0; i < 3; i++) {
      const code = (await s.as("sid").api("POST", "/api/sign-in-links")).body.code;
      sessions.push(s.with({ cookie: sessionCookie((await s.anon.api("POST", "/api/auth/redeem", { code })).headers) }, "cookie"));
    }
    const [mine, other, third] = sessions as [typeof sessions[0], typeof sessions[0], typeof sessions[0]];
    const list = (await mine.api("GET", "/api/sessions")).body;
    expect(list.filter((x: any) => x.current)).toHaveLength(1);

    const otherId = (await other.api("GET", "/api/sessions")).body.find((x: any) => x.current).id;
    expect((await mine.api("DELETE", `/api/sessions/${otherId}`)).status).toBeLessThan(300);
    expect((await other.api("GET", "/api/me")).status).toBe(401);

    expect((await mine.api("DELETE", "/api/sessions")).status).toBeLessThan(300);
    expect((await third.api("GET", "/api/me")).status).toBe(401);
    expect((await mine.api("GET", "/api/me")).status).toBe(200);
    // Signing out of every session leaves API keys alone.
    expect((await s.as("sid", "bearer").api("GET", "/api/me")).status).toBe(200);

    expect((await mine.api("POST", "/api/logout")).status).toBeLessThan(300);
    expect((await mine.api("GET", "/api/me")).status).toBe(401);
  });

  test("an API key is shown once, works as a bearer, and dies when deleted", async () => {
    const made = await s.as("ana").api("POST", "/api/api-keys", { name: "laptop" });
    expect(made.status).toBe(201);
    expect(made.body.token).toMatch(/^dk_[0-9a-f]{64}$/);
    const key = s.with({ token: made.body.token });
    expect((await key.api("GET", "/api/me")).body.user.username).toBe("ana");
    expect(await key.tool("list_teams")).toContain("AUT");

    const listed = (await s.as("ana").api("GET", "/api/api-keys")).body;
    expect(JSON.stringify(listed)).not.toContain(made.body.token);
    expect(listed.map((k: any) => k.name)).toContain("laptop");

    expect((await s.as("ana").api("DELETE", `/api/api-keys/${made.body.apiKey.id}`)).status).toBeLessThan(300);
    expect((await key.api("GET", "/api/me")).status).toBe(401);
    expect(await key.ws().opened).toBeFalse();
  });

  test("a read-only key reads but can't write, over REST or MCP", async () => {
    const token = (await s.as("ana").api("POST", "/api/api-keys", { name: "ro", scope: "read" })).body.token;
    const ro = s.with({ token });
    expect((await ro.api("GET", "/api/issues")).status).toBe(200);
    expect((await ro.api("POST", "/api/issues", { team: "AUT", title: "nope" })).status).toBe(403);
    expect((await ro.api("POST", "/api/api-keys", { name: "escalate" })).status).toBe(403);
    expect(await ro.tool("list_issues")).toBeString();
    await expect(ro.tool("create_issue", { team: "AUT", title: "nope" })).rejects.toThrow();
    expect((await s.api("GET", "/api/issues?team=AUT")).body).toEqual([]);
  });

  test("a session made by one process works on another over the same database", async () => {
    const b = await startServer({ sharing: s });
    try {
      expect((await b.as("ana", "cookie").api("GET", "/api/me")).body.user.username).toBe("ana");
      expect((await b.as("ana").api("GET", "/api/me")).body.user.username).toBe("ana");
    } finally {
      await b.stop();
    }
  });

  test("JSON only, and unknown Host headers are refused", async () => {
    // Raw fetch: these checks are about headers the harness always sets.
    const bearer = { Authorization: `Bearer ${s.admin.token}` };
    const form = await fetch(new URL("/api/issues", s.url), {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...bearer },
      body: JSON.stringify({ team: "AUT", title: "x" }),
    });
    expect(form.status).toBe(415);
    expect((await fetch(new URL("/api/me", s.url), { headers: { Host: "evil.example", ...bearer } })).status).toBe(403);
  });
});

describe("rate limit", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer();
    await s.user("ana");
  });
  afterAll(() => s.stop());

  test("after 10 bad codes even a good one waits", async () => {
    const good = (await s.as("ana").api("POST", "/api/sign-in-links")).body.code;
    for (let i = 0; i < 10; i++) expect((await s.anon.api("POST", "/api/auth/redeem", { code: `BADXX-BADX${"ABCDEFGHJK"[i]}` })).status).toBe(401);
    expect((await s.anon.api("POST", "/api/auth/redeem", { code: good })).status).toBe(429);
    // Signed-in callers aren't affected.
    expect((await s.as("ana").api("GET", "/api/me")).status).toBe(200);
  });
});

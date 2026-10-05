// Content permissions (issues.write, comments.write, docs.write, files.upload, projects.write, inbox.manage): a role lacking
// one is refused that write (403) while reads and the other writes go on; the team ones follow a role of one's own in a
// team; a key's cap narrows them too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Caller, type Reply, type TestServer } from "./server.ts";

let s: TestServer;
let u: Caller; // a member of WEB and OPS whose role the tests change
let member: string[]; // the built-in member role's permissions
const role: Record<string, string> = {}; // content permission → a role with the member's permissions but that one
let issueComment: number;
let docComment: number;
let milestone: number;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

const ok = async (reply: Promise<Reply>, status = 200) => {
  const r = await reply;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const upload = (who: Caller, team?: string) =>
  who.raw("POST", `/api/attachments?name=a.png${team ? `&team=${team}` : ""}`, { body: PNG, headers: { "Content-Type": "application/octet-stream" } });
// A bulk edit reports each issue's error in its results.
const bulk = async (who: Caller, id: string): Promise<Reply> => {
  const r = await who.api("POST", "/api/issues/bulk", { ids: [id], patch: { priority: 1 } });
  return { ...r, status: r.body.results[0].status, body: r.body.results[0] };
};
const setRole = (key: string) => ok(s.api("PATCH", "/api/workspaces/acme/members/uma", { role: key }));
const setTeamRole = (team: string, key: string | null) => ok(s.api("PATCH", `/api/teams/${team}/members/uma`, { role: key }));

const CONTENT = ["issues.write", "comments.write", "docs.write", "files.upload", "projects.write", "inbox.manage"] as const;
type Content = (typeof CONTENT)[number];

/** Every write a permission gates (in WEB, for the team ones), and what a role lacking it is told. */
const WRITES: Record<Content, { message: string; calls: (who: Caller) => Promise<Reply>[] }> = {
  "issues.write": {
    message: "Your role can't change issues in WEB",
    calls: (who) => [
      who.api("POST", "/api/issues", { team: "WEB", title: "New" }),
      who.api("PATCH", "/api/issues/WEB-1", { title: "Renamed", relatedTo: ["OPS-1"] }),
      who.api("DELETE", "/api/issues/WEB-1"),
      who.api("POST", "/api/issues/WEB-1/restore"),
      who.api("POST", "/api/issues/WEB-1/archive"),
      who.api("POST", "/api/issues/WEB-1/unarchive"),
      who.api("POST", "/api/issues/WEB-1/claim"),
      bulk(who, "WEB-1"),
    ],
  },
  "comments.write": {
    message: "Your role can't comment in WEB",
    calls: (who) => [
      who.api("POST", "/api/issues/WEB-1/comments", { body: "Hi" }),
      who.api("PATCH", `/api/issues/WEB-1/comments/${issueComment}`, { body: "Edited" }),
      who.api("DELETE", `/api/issues/WEB-1/comments/${issueComment}`),
      who.api("PUT", `/api/issues/WEB-1/comments/${issueComment}/resolved`),
      who.api("DELETE", `/api/issues/WEB-1/comments/${issueComment}/resolved`),
      who.api("PUT", "/api/issues/WEB-1/reactions/👍"),
      who.api("DELETE", "/api/issues/WEB-1/reactions/👍"),
      who.api("PUT", `/api/issues/WEB-1/comments/${issueComment}/reactions/👍`),
      who.api("POST", "/api/documents/spec/comments", { body: "Hi" }),
      who.api("PATCH", `/api/documents/spec/comments/${docComment}`, { body: "Edited" }),
      who.api("DELETE", `/api/documents/spec/comments/${docComment}`),
      who.api("PUT", `/api/documents/spec/comments/${docComment}/resolved`),
      who.api("PUT", `/api/documents/spec/comments/${docComment}/reactions/👍`),
    ],
  },
  "docs.write": {
    message: "Your role can't change documents in WEB",
    calls: (who) => [
      who.api("POST", "/api/documents", { team: "WEB", title: "New" }),
      who.api("PATCH", "/api/documents/spec", { title: "Renamed" }),
      who.api("DELETE", "/api/documents/spec"),
      who.api("POST", "/api/documents/spec/restore"),
    ],
  },
  "files.upload": { message: "Your role can't upload files in WEB", calls: (who) => [upload(who, "WEB")] },
  "projects.write": {
    message: "Your role can't change projects",
    calls: (who) => [
      who.api("POST", "/api/projects", { name: "New", teams: ["WEB"] }),
      who.api("PATCH", "/api/projects/launch", { description: "Changed" }),
      who.api("POST", "/api/projects/launch/milestones", { name: "New" }),
      who.api("PATCH", `/api/projects/launch/milestones/${milestone}`, { name: "Renamed" }),
      who.api("DELETE", `/api/projects/launch/milestones/${milestone}`),
    ],
  },
  "inbox.manage": {
    message: "Your role can't manage your inbox",
    calls: (who) => [who.api("PATCH", "/api/notifications", { read: true }), who.api("DELETE", "/api/notifications?read=true")],
  },
};

let n = 0;
/** One write each permission allows, that works again and again. */
const ALLOWED: Record<Content, (who: Caller) => Promise<unknown>> = {
  "issues.write": (who) => ok(who.api("POST", "/api/issues", { team: "WEB", title: "Fine" }), 201),
  "comments.write": (who) => ok(who.api("POST", "/api/issues/WEB-1/comments", { body: "Fine" }), 201),
  "docs.write": (who) => ok(who.api("POST", "/api/documents", { team: "WEB", title: "Fine" }), 201),
  "files.upload": (who) => ok(upload(who, "WEB"), 201),
  "projects.write": (who) => ok(who.api("POST", "/api/projects/launch/milestones", { name: `Fine ${++n}` }), 201),
  "inbox.manage": (who) => ok(who.api("PATCH", "/api/notifications", { read: true })),
};

const refused = async (calls: Promise<Reply>[], message: string) => {
  for (const r of await Promise.all(calls)) expect([r.status, r.body.error]).toEqual([403, message]);
};

beforeAll(async () => {
  s = await startServer();
  await ok(s.api("POST", "/api/teams", { key: "WEB", name: "Web" }), 201);
  await ok(s.api("POST", "/api/teams", { key: "OPS", name: "Ops" }), 201);
  u = await s.user("uma");
  for (const team of ["WEB", "OPS"]) await ok(s.api("POST", `/api/teams/${team}/members`, { username: "uma" }));
  await ok(s.api("POST", "/api/issues", { team: "WEB", title: "Web work" }), 201);
  await ok(s.api("POST", "/api/issues", { team: "OPS", title: "Ops work" }), 201);
  issueComment = (await ok(s.api("POST", "/api/issues/WEB-1/comments", { body: "@uma look" }), 201)).comments[0].id;
  await ok(s.api("POST", "/api/documents", { team: "WEB", title: "Spec", slug: "spec" }), 201);
  docComment = (await ok(s.api("POST", "/api/documents/spec/comments", { body: "Note" }), 201)).comments[0].id;
  await ok(s.api("POST", "/api/projects", { name: "Launch", slug: "launch", teams: ["WEB"] }), 201);
  milestone = (await ok(s.api("POST", "/api/projects/launch/milestones", { name: "Beta" }), 201)).milestones[0].id;
  member = (await ok(s.api("GET", "/api/roles"))).find((r: any) => r.builtin === "member").permissions;
  for (const p of CONTENT) role[p] = (await ok(s.api("POST", "/api/roles", { name: `No ${p}`, permissions: member.filter((m) => m !== p) }), 201)).key;
});
afterAll(() => s.stop());

describe("a role without a content permission", () => {
  for (const p of CONTENT) {
    test(`lacking ${p}: those writes are 403, reads and the other writes still work`, async () => {
      await setRole(role[p]!);
      try {
        await refused(WRITES[p].calls(u), WRITES[p].message);
        await ok(u.api("GET", "/api/issues/WEB-1"));
        await ok(u.api("GET", "/api/documents/spec"));
        await ok(u.api("GET", "/api/projects/launch"));
        await ok(u.api("GET", "/api/notifications"));
        await ok(u.api("PUT", "/api/issues/WEB-1/subscription")); // following goes by seeing
        for (const q of CONTENT) if (q !== p) await ALLOWED[q](u);
      } finally {
        await setRole("member");
      }
    });
  }

  test("a file outside any team is refused at the workspace's level", async () => {
    await setRole(role["files.upload"]!);
    try {
      const r = await upload(u);
      expect([r.status, r.body.error]).toEqual([403, "Your role can't upload files here"]);
    } finally {
      await setRole("member");
    }
  });

  test("a team that isn't seen stays 404, not 403", async () => {
    await ok(s.api("POST", "/api/teams", { key: "SEC", name: "Security", private: true }), 201);
    await ok(s.api("POST", "/api/issues", { team: "SEC", title: "Secret" }), 201);
    await setRole(role["issues.write"]!);
    try {
      expect((await u.api("POST", "/api/issues", { team: "SEC", title: "x" })).status).toBe(404);
      expect((await u.api("PATCH", "/api/issues/SEC-1", { title: "x" })).status).toBe(404);
    } finally {
      await setRole("member");
    }
  });
});

describe("a role of one's own in a team", () => {
  test("taking a team permission away in one team leaves the others alone", async () => {
    await setTeamRole("WEB", role["issues.write"]!);
    try {
      await refused(WRITES["issues.write"].calls(u), "Your role can't change issues in WEB");
      await ok(u.api("POST", "/api/issues", { team: "OPS", title: "Fine" }), 201);
      await ok(u.api("PATCH", "/api/issues/OPS-1", { title: "Ops work, renamed" }));
      // Moving an issue takes the permission in both teams.
      const moved = await u.api("PATCH", "/api/issues/OPS-1", { team: "WEB" });
      expect([moved.status, moved.body.error]).toEqual([403, "Your role can't change issues in WEB"]);
    } finally {
      await setTeamRole("WEB", null);
    }
  });

  test("each team permission follows the team's role", async () => {
    for (const p of ["comments.write", "docs.write", "files.upload"] as const) {
      await setTeamRole("WEB", role[p]!);
      try {
        await refused(WRITES[p].calls(u), WRITES[p].message);
        const inOps: Record<typeof p, () => Promise<unknown>> = {
          "comments.write": () => ok(u.api("POST", "/api/issues/OPS-1/comments", { body: "Fine" }), 201),
          "docs.write": () => ok(u.api("POST", "/api/documents", { team: "OPS", title: "Fine" }), 201),
          "files.upload": () => ok(upload(u, "OPS"), 201),
        };
        await inOps[p]();
      } finally {
        await setTeamRole("WEB", null);
      }
    }
  });

  test("a document moves only into a team where one may change documents", async () => {
    await setTeamRole("OPS", role["docs.write"]!);
    try {
      const r = await u.api("PATCH", "/api/documents/spec", { team: "OPS" });
      expect([r.status, r.body.error]).toEqual([403, "Your role can't change documents in OPS"]);
    } finally {
      await setTeamRole("OPS", null);
    }
  });

  test("granting a team permission in one team, over a workspace role without it", async () => {
    await setRole(role["comments.write"]!);
    await setTeamRole("OPS", "member");
    try {
      await ok(u.api("POST", "/api/issues/OPS-1/comments", { body: "Fine here" }), 201);
      await refused(WRITES["comments.write"].calls(u), "Your role can't comment in WEB");
    } finally {
      await setTeamRole("OPS", null);
      await setRole("member");
    }
  });

  test("projects and the inbox are the workspace's: a team's role doesn't change them", async () => {
    await setRole(role["projects.write"]!);
    await setTeamRole("WEB", "member");
    try {
      await refused(WRITES["projects.write"].calls(u), "Your role can't change projects");
    } finally {
      await setTeamRole("WEB", null);
      await setRole("member");
    }
  });
});

test("an API key whose cap lacks issues.write is refused it, whatever its owner's role", async () => {
  const key = await ok(u.api("POST", "/api/api-keys", { name: "narrow", workspace: "acme", permissions: CONTENT.filter((p) => p !== "issues.write") }), 201);
  const bearer = s.with({ token: key.token });
  await refused(WRITES["issues.write"].calls(bearer), "This API key doesn't allow issues.write");
  await ok(bearer.api("GET", "/api/issues/WEB-1"));
  await ok(bearer.api("POST", "/api/issues/WEB-1/comments", { body: "Through the key" }), 201);
});

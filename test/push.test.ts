// Push notifications: a device subscribes from a signed-in session; a person's new notifications reach it,
// encrypted to it (VAPID-signed), after the change commits. Only known push services, and never an agent's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
// @ts-expect-error: no types; a reference implementation of the encryption, here to decrypt what the fake push service gets
import ece from "http_ece";
import { startServer, type Caller, type TestServer } from "./server.ts";

/** A fake push service: records each push, answers with `answer` (201 by default). */
const received: { path: string; headers: Headers; body: Buffer }[] = [];
let answer = 201;
const service = Bun.serve({
  port: 0,
  async fetch(req) {
    received.push({ path: new URL(req.url).pathname, headers: req.headers, body: Buffer.from(await req.arrayBuffer()) });
    return new Response(null, { status: answer });
  },
});
const origin = `http://127.0.0.1:${service.port}`;

/** A device: its keys, as PushSubscription.toJSON() has them, and a way to read what's pushed to it. */
function device(name: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16).toString("base64url");
  const endpoint = `${origin}/push/${name}`;
  return {
    endpoint,
    json: { endpoint, expirationTime: null, keys: { p256dh: ecdh.getPublicKey("base64url"), auth } },
    pushes: () =>
      received
        .filter((r) => r.path === `/push/${name}`)
        .map((r) => JSON.parse(ece.decrypt(r.body, { version: "aes128gcm", privateKey: ecdh, authSecret: auth }).toString())),
  };
}

let s: TestServer;
let ana: Caller;
let bob: Caller;
beforeAll(async () => {
  s = await startServer({ env: { DOCKET_PUSH_TEST_ORIGIN: origin } });
  await s.api("POST", "/api/teams", { key: "PSH", name: "Push" });
  ana = await s.user("ana", { name: "Ana" });
  bob = await s.user("bob", { name: "Bob" });
  await s.agent("claude", { name: "Claude" });
});
afterAll(() => {
  s.stop();
  service.stop();
});

const settle = () => Bun.sleep(150); // pushes leave after the commit, in the background
const create = async (title: string, extra: object = {}) => (await s.api("POST", "/api/issues", { team: "PSH", title, ...extra })).body;

test("the key: a signed-in session's; an API key's is 403", async () => {
  const res = await ana.api("GET", "/api/push");
  expect(res.status).toBe(200);
  expect(Buffer.from(res.body.publicKey, "base64url").length).toBe(65);
  expect((await s.api("GET", "/api/push")).body.publicKey).toBe(res.body.publicKey); // one pair for the server
  expect((await s.as("ana", "bearer").api("GET", "/api/push")).status).toBe(403);
  expect((await s.as("claude").api("PUT", "/api/push", device("x").json)).status).toBe(403);
});

test("only a push service's https endpoint, with the subscription's keys", async () => {
  const { json } = device("check");
  const val = await s.user("val"); // never notified: its real push services' endpoints are never sent to
  const put = (body: object) => val.api("PUT", "/api/push", body).then((r) => r.status);
  for (const endpoint of [
    "https://evil.example/push",
    "http://web.push.apple.com/x",
    "https://web.push.apple.com:8443/x",
    "https://user@fcm.googleapis.com/x",
    "https://web.push.apple.com.evil.example/x",
    "http://127.0.0.1:1/push/x",
    "http://localhost/x",
    "not a url",
  ])
    expect(await put({ ...json, endpoint })).toBe(400);
  expect(await put({ ...json, keys: { ...json.keys, auth: "short" } })).toBe(400);
  expect(await put({ ...json, keys: { p256dh: json.keys.auth, auth: json.keys.auth } })).toBe(400);
  expect(await put({ ...json, extra: 1 })).toBe(400);
  expect(await put({ ...json, endpoint: "https://web.push.apple.com/QGuQyavXutnMH" })).toBe(200);
  expect(await put({ ...json, endpoint: "https://fcm.googleapis.com/fcm/send/abc" })).toBe(200);
  expect(await put({ ...json, endpoint: "https://wns2-par02p.notify.windows.com/w/?token=x" })).toBe(200);
  expect((await val.api("POST", "/api/logout")).status).toBeLessThan(300); // and they go with the session
});

test("a notification reaches the person's devices, encrypted and VAPID-signed; never the actor's", async () => {
  const phone = device("ana-phone");
  const bobs = device("bob-phone");
  expect((await ana.api("PUT", "/api/push", phone.json)).status).toBe(200);
  expect((await bob.api("PUT", "/api/push", bobs.json)).status).toBe(200);

  const issue = await create("Fix login", { assignee: "ana" });
  await settle();
  expect(phone.pushes()).toEqual([{ title: `${issue.id} Fix login`, body: "Admin assigned you", url: `/acme/issue/${issue.id}` }]);

  await bob.api("POST", `/api/issues/${issue.id}/comments`, { body: "**Found** it: [the PR](https://x.y/1)" });
  await settle();
  expect(phone.pushes().at(-1)).toEqual({ title: `${issue.id} Fix login`, body: "Bob commented: Found it: the PR", url: `/acme/issue/${issue.id}` });
  expect(bobs.pushes()).toEqual([]); // bob wrote it

  await s.api("PATCH", `/api/issues/${issue.id}`, { status: "done" });
  await settle();
  expect(phone.pushes().at(-1)!.body).toBe("Admin moved to Done");

  const push = received.findLast((r) => r.path === "/push/ana-phone")!;
  expect(push.headers.get("content-encoding")).toBe("aes128gcm");
  const [, jwt, k] = push.headers.get("authorization")!.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/)!;
  expect(k).toBe((await ana.api("GET", "/api/push")).body.publicKey);
  // The JWT: for the push service's origin, signed with the key the device subscribed with.
  const [header, claims, signature] = jwt!.split(".") as [string, string, string];
  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({ aud: origin, sub: expect.stringMatching(/^https?:/) });
  const key = await crypto.subtle.importKey("raw", Buffer.from(k!, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${header}.${claims}`);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(signature, "base64url"), signed)).toBe(true);
  expect(Number(push.headers.get("ttl"))).toBeGreaterThan(0);
});

test("docs push too, to the doc", async () => {
  const phone = device("ana-docs");
  await ana.api("PUT", "/api/push", phone.json);
  await s.api("POST", "/api/documents", { team: "PSH", title: "Plan", content: "@ana, over to you." });
  await settle();
  expect(phone.pushes()).toEqual([{ title: "Plan", body: "Admin mentioned you", url: "/acme/doc/plan" }]);
});

test("a device the push service says is gone is dropped; turning it off stops it", async () => {
  const phone = device("ana-gone");
  await ana.api("PUT", "/api/push", phone.json);
  answer = 410;
  const issue = await create("Gone", { assignee: "ana" });
  await settle();
  answer = 201;
  expect(phone.pushes()).toHaveLength(1);
  await s.api("PATCH", `/api/issues/${issue.id}`, { status: "done" });
  await settle();
  expect(phone.pushes()).toHaveLength(1);

  const other = device("ana-off");
  await ana.api("PUT", "/api/push", other.json);
  expect((await ana.api("DELETE", "/api/push", { endpoint: other.endpoint })).status).toBe(200);
  await create("Off", { assignee: "ana" });
  await settle();
  expect(other.pushes()).toEqual([]);
});

test("a device goes with its session, and moves to whoever signs in on it next", async () => {
  const carl = await s.user("carl", { name: "Carl" });
  const phone = device("carl-phone");
  await carl.api("PUT", "/api/push", phone.json);
  expect((await carl.api("POST", "/api/push/test")).status).toBe(200);
  expect(phone.pushes()).toEqual([{ title: "Docket", body: "Notifications are on for this device.", url: "/inbox" }]);

  expect((await carl.api("POST", "/api/logout")).status).toBeLessThan(300);
  await create("After sign-out", { assignee: "carl" });
  await settle();
  expect(phone.pushes()).toHaveLength(1);

  // Someone else signs in on that phone: it's theirs now.
  const dana = await s.user("dana", { name: "Dana" });
  await dana.api("PUT", "/api/push", phone.json);
  await create("For dana", { assignee: "dana" });
  await settle();
  expect(phone.pushes().at(-1)!.body).toBe("Admin assigned you");
  expect(phone.pushes().at(-1)!.title).toEndWith("For dana");
});

test("a test push with no device here is 409; an unreachable push service is 502", async () => {
  const erin = await s.user("erin");
  expect((await erin.api("POST", "/api/push/test")).status).toBe(409);
  await erin.api("PUT", "/api/push", device("erin").json);
  answer = 500;
  expect((await erin.api("POST", "/api/push/test")).status).toBe(502);
  answer = 201;
});

test("a device goes when its session idles out, even if that session is never used again (DKT-45)", async () => {
  const dex = await s.user("dex", { name: "Dex" });
  const phone = device("dex-phone");
  expect((await dex.api("PUT", "/api/push", phone.json)).status).toBe(200);
  const idle = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  s.sql("UPDATE sessions SET last_seen_at = ? WHERE id = (SELECT session_id FROM push_subscriptions WHERE endpoint = ?)", idle, phone.endpoint);
  await create("After idling", { assignee: "dex" });
  await settle();
  expect(phone.pushes()).toEqual([]);
  expect(s.sql("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?", phone.endpoint)[0].n).toBe(0);
});

// Push notifications (Linear's, through Web Push): a person's new notifications reach the devices they turned them on
// for, as a lock-screen notification that opens the issue or doc. A device subscribes from a signed-in browser session
// and goes with it (sign-out, revoke). Sent after the notification's transaction commits; people's only (an agent's
// go to webhooks). Endpoints must be a known push service's, so Docket never posts anywhere else. Encrypted and signed
// with WebCrypto (RFC 8291 and 8292), so it runs the same on Bun and Workers.
import type { Notification } from "../shared/types.ts";
import { type Actor, endIdleSessions, requireSession } from "./access.ts";
import { AppError, db, now } from "./db.ts";
import { later } from "./runtime.ts";

const TEST_ORIGIN = process.env.DOCKET_PUSH_TEST_ORIGIN; // tests only: a local fake push service, e.g. http://127.0.0.1:4000
const TIMEOUT_MS = 10_000;
const TTL_S = 24 * 60 * 60; // a device that's off for a day misses it; the inbox still has it

/** The push services browsers use: Apple's (Safari, iPhone and iPad apps on the Home Screen), Google's, Mozilla's, Microsoft's. */
const SERVICES = /^(web\.push\.apple\.com|fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

// Apple refuses a JWT whose contact isn't an https URL or a real-looking mailto (mailto:…@localhost is BadJwtToken).
let subject = "https://github.com/youssefaltai/docket";
/** Called at startup: the VAPID subject (contact) push services see, Docket's public URL when it's https. */
export function startPush(publicUrl: string) {
  if (publicUrl.startsWith("https://")) subject = publicUrl;
}

const base64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString("base64url");
const unbase64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

/** Docket's VAPID key pair (base64url: the public key's uncompressed point, the private key's d), made on first use. */
async function keys(): Promise<{ public_key: string; private_key: string }> {
  const read = () => db.query<{ public_key: string; private_key: string }, []>("SELECT public_key, private_key FROM vapid_keys").get();
  const row = read();
  if (row) return row;
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const { d, x, y } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = base64url(new Uint8Array([4, ...unbase64url(x!), ...unbase64url(y!)]));
  db.query("INSERT OR IGNORE INTO vapid_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)").run(publicKey, d!, now());
  return read()!;
}

// --- Devices ---

/** What a browser subscribes with: `applicationServerKey`. */
export async function pushKey(a: Actor) {
  requireSession(a);
  return { publicKey: (await keys()).public_key };
}

const bytes = (s: unknown) => (typeof s === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(s) ? Buffer.from(s, "base64url").length : 0);

/** Turns push on for this device (PushSubscription.toJSON()): it belongs to this session from now on. */
export function addDevice(a: Actor, input: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }) {
  requireSession(a);
  const { endpoint } = input;
  let url: URL | null = null;
  try {
    url = typeof endpoint === "string" && endpoint.length <= 2000 ? new URL(endpoint) : null;
  } catch {}
  const known = url && url.protocol === "https:" && !url.port && !url.username && !url.password && SERVICES.test(url.hostname);
  if (!url || !(known || (TEST_ORIGIN && url.origin === TEST_ORIGIN))) throw new AppError("endpoint must be a browser push service's https URL");
  const { p256dh, auth } = input.keys ?? {};
  if (bytes(p256dh) !== 65 || bytes(auth) !== 16) throw new AppError("keys must be the subscription's p256dh and auth");
  db.query(
    `INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(a.id, a.sessionId, endpoint as string, p256dh as string, auth as string, now());
}

/** Turns push off for this device. */
export function removeDevice(a: Actor, endpoint: unknown) {
  requireSession(a);
  db.query("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(String(endpoint), a.id);
}

/** A test notification to this session's devices, to see it arrive. */
export async function testPush(a: Actor) {
  requireSession(a);
  const subs = db.query<Sub, [number]>("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE session_id = ?").all(a.sessionId!);
  if (!subs.length) throw new AppError("Push notifications aren't on for this device", 409);
  const payload = { title: "Docket", body: "Notifications are on for this device.", url: "/inbox" };
  for (const status of await Promise.all(subs.map((s) => send(s, payload).catch(() => 0)))) {
    if (status < 200 || status > 299) throw new AppError(status ? `The push service answered ${status}` : "The push service couldn't be reached", 502);
  }
}

// --- Sending ---

interface Sub {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}
/** What the service worker shows: sw.js. */
interface Payload {
  title: string;
  body: string;
  url: string;
}

/** Ana commented: …, as the inbox says it (inbox.tsx). */
function describe(n: Notification): Payload {
  const who = n.actor.name;
  const excerpt = n.comment?.excerpt ? `: ${n.comment.excerpt}` : "";
  const status = () =>
    db
      .query<{ name: string }, [string, string, string]>(
        "SELECT s.name FROM workflow_statuses s JOIN teams t ON t.id = s.team_id WHERE t.workspace = ? AND t.key = ? AND s.key = ?",
      )
      .get(n.workspace, n.issue!.id.replace(/-\d+$/, ""), n.status!)?.name ?? n.status;
  const body = {
    assigned: `${who} assigned you`,
    delegated: `${who} delegated to you`,
    mentioned: `${who} mentioned you${excerpt}`,
    commented: `${who} commented${excerpt}`,
    status: n.issue && n.status ? `${who} moved to ${status()}` : `${who} changed the status`,
  }[n.kind];
  return n.issue
    ? { title: `${n.issue.id} ${n.issue.title}`, body, url: `/${n.workspace}/issue/${n.issue.id}` }
    : { title: n.document!.title, body, url: `/${n.workspace}/doc/${n.document!.slug}` };
}

const pending: { userId: number; load: () => Notification | null }[] = [];

/**
 * Pushes a new notification to its person's devices once the mutation's transaction is done (bun:sqlite is
 * synchronous, so a timer runs after the commit). `load` reads it then: null if it was rolled back or is gone.
 */
export function queuePush(userId: number, load: () => Notification | null) {
  if (!pending.length) later(flush);
  pending.push({ userId, load });
}

function flush() {
  const devices = db.query<Sub, [number]>("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?");
  for (const { userId, load } of pending.splice(0)) {
    endIdleSessions(userId); // a signed-out device gets nothing
    const subs = devices.all(userId);
    const n = subs.length ? load() : null;
    if (n) for (const s of subs) send(s, describe(n)).catch((err) => console.error(`Push to ${new URL(s.endpoint).host} failed:`, err));
  }
}

/** HKDF-SHA-256, `bits` long. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array | ArrayBuffer, info: Uint8Array, bits: number) {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, bits));
}
const text = (s: string) => new TextEncoder().encode(s);

/** The payload encrypted to the device (RFC 8291, aes128gcm): one record, with a fresh key and salt. */
async function encrypt(s: Sub, payload: string): Promise<Uint8Array<ArrayBuffer>> {
  const device = unbase64url(s.p256dh);
  const ephemeral = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const local = new Uint8Array((await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer);
  const peer = await crypto.subtle.importKey("raw", device, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, ephemeral.privateKey, 256);
  const ikm = await hkdf(unbase64url(s.auth), shared, new Uint8Array([...text("WebPush: info\0"), ...device, ...local]), 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 128), "AES-GCM", false, ["encrypt"]);
  const iv = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 96);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cek, new Uint8Array([...text(payload), 2])); // 2: the last record
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096); // record size
  header[20] = local.length;
  return new Uint8Array([...header, ...local, ...new Uint8Array(sealed)]);
}

/** The VAPID Authorization header (RFC 8292): a JWT for the push service's origin, signed with Docket's key. */
async function vapid(endpoint: string): Promise<string> {
  const k = await keys();
  const point = unbase64url(k.public_key);
  const jwk = { kty: "EC", crv: "P-256", d: k.private_key, x: base64url(point.slice(1, 33)), y: base64url(point.slice(33)) };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o: object) => base64url(text(JSON.stringify(o)));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: subject };
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, text(unsigned));
  return `vapid t=${unsigned}.${base64url(signature)}, k=${k.public_key}`;
}

/** Encrypts and posts one push; its HTTP status. A subscription the service says is gone (404, 410) is deleted. */
async function send(s: Sub, payload: Payload): Promise<number> {
  const res = await fetch(s.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapid(s.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(TTL_S),
    },
    body: await encrypt(s, JSON.stringify(payload)),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 410) db.query("DELETE FROM push_subscriptions WHERE id = ?").run(s.id);
  else if (!res.ok) console.error(`Push to ${new URL(s.endpoint).host}: ${res.status} ${await res.text().catch(() => "")}`.trim());
  return res.status;
}

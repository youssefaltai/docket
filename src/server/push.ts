// Push notifications (Linear's, through Web Push): a person's new notifications reach the devices they turned them on
// for, as a lock-screen notification that opens the issue or doc. A device subscribes from a signed-in browser session
// and goes with it (sign-out, revoke). Sent after the notification's transaction commits; people's only (an agent's
// go to webhooks). Endpoints must be a known push service's, so Docket never posts anywhere else.
import webpush from "web-push";
import type { Notification } from "../shared/types.ts";
import { type Actor, endIdleSessions, requireSession } from "./access.ts";
import { AppError, db, now } from "./db.ts";

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

/** Docket's VAPID key pair (base64url), made on first use. */
function keys(): { public_key: string; private_key: string } {
  const row = db.query<{ public_key: string; private_key: string }, []>("SELECT public_key, private_key FROM vapid_keys").get();
  if (row) return row;
  const k = webpush.generateVAPIDKeys();
  db.query("INSERT INTO vapid_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)").run(k.publicKey, k.privateKey, now());
  return { public_key: k.publicKey, private_key: k.privateKey };
}

// --- Devices ---

/** What a browser subscribes with: `applicationServerKey`. */
export function pushKey(a: Actor) {
  requireSession(a);
  return { publicKey: keys().public_key };
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
  if (!pending.length) setTimeout(flush, 0);
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

/** Encrypts and posts one push; its HTTP status. A subscription the service says is gone (404, 410) is deleted. */
async function send(s: Sub, payload: Payload): Promise<number> {
  const k = keys();
  const req = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
    vapidDetails: { subject, publicKey: k.public_key, privateKey: k.private_key },
    TTL: TTL_S,
  });
  const res = await fetch(req.endpoint, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.body as Buffer<ArrayBuffer>,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 410) db.query("DELETE FROM push_subscriptions WHERE id = ?").run(s.id);
  else if (!res.ok) console.error(`Push to ${new URL(s.endpoint).host}: ${res.status} ${await res.text().catch(() => "")}`.trim());
  return res.status;
}

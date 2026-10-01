// Webhooks, as in Linear: a workspace's issue, comment and doc changes and its agents' inbox notifications, POSTed
// signed to an endpoint. tracker.ts and inbox.ts call `enqueue` inside each mutation's transaction (the outbox); a
// background loop sends what's due, retries failures and keeps a delivery log. Admins manage webhooks in a browser
// session. Targets must be public https unless the operator allows private ones (DOCKET_WEBHOOK_ALLOW_PRIVATE).
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  WEBHOOK_RESOURCES,
  type UserRef,
  type Webhook,
  type WebhookAction,
  type WebhookDelivery,
  type WebhookInput,
  type WebhookPatch,
  type WebhookResource,
} from "../shared/types.ts";
import { type Actor, requireAdminSession } from "./access.ts";
import { AppError, changed, checkOneOf, db, knownAs, now, optionalText } from "./db.ts";
import { later, workers } from "./runtime.ts";

const ALLOW_PRIVATE = process.env.DOCKET_WEBHOOK_ALLOW_PRIVATE === "true";
const TIMEOUT_MS = Number(process.env.DOCKET_WEBHOOK_TIMEOUT_MS) || 5000; // tests only
const RETRY_MS = (process.env.DOCKET_WEBHOOK_RETRY_MS || "60000,3600000,21600000").split(",").map(Number); // tests only
const CONCURRENCY = 4;
const DISABLE_AFTER = 10; // deliveries in a row that failed for good
const HOLD_MS = 10_000; // a doc update waits this long, so autosaves merge into one delivery
const KEEP_MS = 7 * 24 * 60 * 60 * 1000; // the delivery log

// --- Targets ---

const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const v4 = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
const privateV4 = (n: number) => PRIVATE_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4(base) / 2 ** (32 - bits)));

/** An IPv6 address as its 8 groups (a trailing dotted IPv4 becomes the last two). */
function v6(ip: string): number[] {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1];
  if (dotted) s = `${s.slice(0, -dotted.length)}${(v4(dotted) >>> 16).toString(16)}:${(v4(dotted) & 0xffff).toString(16)}`;
  const [head, tail] = s.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  return (tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t]).map((g) => parseInt(g, 16));
}

/** Loopback, private, link-local (cloud metadata), shared, reserved or multicast; IPv4 inside IPv6 counts as IPv4. */
function isPrivate(address: string, family: number): boolean {
  if (family === 4) return privateV4(v4(address));
  const g = v6(address);
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const embedded = () => privateV4(g[6]! * 65536 + g[7]!);
  if (zero(0, 5) && g[5] === 0xffff) return embedded(); // ::ffff:0:0/96, IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return embedded(); // 64:ff9b::/96, NAT64
  if (zero(0, 6)) return true; // ::/96: ::, ::1 and IPv4-compatible
  return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00; // fc00::/7, fe80::/10, ff00::/8
}

/**
 * Why Docket won't send to `raw`, or null if it will: https only, no credentials in it, and every address its host
 * resolves to public (all unless DOCKET_WEBHOOK_ALLOW_PRIVATE=true, which also allows http). Checked on save and before
 * every attempt; redirects are never followed. Known limit: DNS can answer differently between this check and the connect.
 */
async function checkTarget(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "https:" && !(ALLOW_PRIVATE && url.protocol === "http:")) return ALLOW_PRIVATE ? "use http or https" : "only https URLs are allowed";
  if (url.username || url.password) return "no user or password in the URL";
  if (ALLOW_PRIVATE) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = /^[\d.]+$/.test(host) ? 4 : host.includes(":") ? 6 : 0;
  // Workers can't look up DNS, and their fetch reaches only the public internet: there, only a literal address is checked.
  if (workers && !literal) return /(^|\.)localhost$/i.test(host) ? `${host} is private` : null;
  const addresses = literal ? [{ address: host, family: literal }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) return `can't resolve ${host}`;
  const hit = addresses.find((a) => isPrivate(a.address, a.family));
  return hit ? `${hit.address} is private` : null;
}

// --- The outbox ---

let base = "http://localhost"; // the public origin, set by startWebhooks
let started = false;

function pathOf(type: WebhookResource, data: any): string {
  if (type === "Issue") return `/issue/${data.id}`;
  if (type === "Document") return `/doc/${data.slug}`;
  const issue = type === "Comment" ? data.issue : data.issue?.id;
  return issue ? `/issue/${issue}` : `/doc/${type === "Comment" ? data.document : data.document.slug}`;
}

/** How someone is known in `workspace` (Docket's own account: as itself). */
function refOf(userId: number, workspace: string): UserRef {
  return db
    .query<UserRef, [string, number]>(
      `SELECT ${knownAs("m", "u", "username")} AS username, ${knownAs("m", "u", "name")} AS name, u.kind
       FROM users u LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace = ? WHERE u.id = ?`,
    )
    .get(workspace, userId)!;
}

export interface Change {
  workspace: string;
  type: WebhookResource;
  action: WebhookAction;
  entity: string; // identifier, slug, comment id or notification id
  actorId: number;
  time: string;
  data: () => object; // read only if some webhook wants it
  updatedFrom?: Record<string, unknown>;
}

const HELD = "type = 'Document' AND action = 'update' AND entity = ? AND status = 'pending' AND attempts = 0";

/**
 * Queues a delivery of this change for each enabled webhook of its workspace that takes its type. Call it inside the
 * mutation's transaction, so a rolled-back change sends nothing. A doc update waits 10 s and merges into a queued,
 * unattempted update of the same doc (newer data, older updatedFrom); any other doc event sends those at once, first.
 */
export function enqueue(c: Change) {
  const hooks = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM webhooks WHERE workspace = ? AND enabled = 1 AND EXISTS (SELECT 1 FROM json_each(resource_types) WHERE value = ?)",
    )
    .all(c.workspace, c.type);
  const hold = c.type === "Document" && c.action === "update" && !(c.updatedFrom && "deletedAt" in c.updatedFrom); // not a restore
  if (c.type === "Document" && !hold) {
    db.query(`UPDATE webhook_deliveries SET next_attempt_at = ? WHERE ${HELD} AND webhook_id IN (SELECT id FROM webhooks WHERE workspace = ?)`).run(
      c.time,
      c.entity,
      c.workspace,
    );
  }
  if (!hooks.length) return;
  const data = c.data();
  const payload = {
    action: c.action,
    type: c.type,
    workspace: c.workspace,
    actor: refOf(c.actorId, c.workspace),
    createdAt: c.time,
    data,
    ...(c.updatedFrom && { updatedFrom: c.updatedFrom }),
    url: `${base}/${c.workspace}${pathOf(c.type, data)}`,
  };
  const due = hold ? new Date(Date.parse(c.time) + HOLD_MS).toISOString() : c.time;
  const insert = db.query(
    "INSERT INTO webhook_deliveries (webhook_id, uuid, type, action, entity, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const { id } of hooks) {
    const held = hold
      ? db.query<{ id: number; payload: string }, [number, string]>(`SELECT id, payload FROM webhook_deliveries WHERE webhook_id = ? AND ${HELD}`).get(id, c.entity)
      : null;
    if (held && !sending.has(held.id)) {
      const old = JSON.parse(held.payload);
      const merged = { ...old, actor: payload.actor, createdAt: payload.createdAt, data, updatedFrom: { ...c.updatedFrom, ...old.updatedFrom } };
      db.query("UPDATE webhook_deliveries SET payload = ? WHERE id = ?").run(JSON.stringify(merged), held.id);
    } else {
      insert.run(id, randomUUID(), c.type, c.action, c.entity, JSON.stringify({ ...payload, webhookId: id }), due, c.time);
    }
  }
  if (started) later(pass); // after this tick: the transaction has committed (or rolled back) by then
}

// --- Sending ---

const sending = new Set<number>(); // deliveries in flight
const busy = new Set<number>(); // webhooks with one in flight: a webhook's deliveries go one at a time, in order

/** Starts what's due, up to 4 at a time, one per webhook, oldest first. */
export function pass() {
  if (sending.size >= CONCURRENCY) return;
  const due = db
    .query<{ id: number; webhook_id: number }, [string]>(
      `SELECT d.id, d.webhook_id FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.status = 'pending' AND w.enabled = 1 AND d.next_attempt_at <= ? ORDER BY d.next_attempt_at, d.id LIMIT 100`,
    )
    .all(now());
  for (const d of due) {
    if (sending.size >= CONCURRENCY) break;
    if (sending.has(d.id) || busy.has(d.webhook_id)) continue;
    sending.add(d.id);
    busy.add(d.webhook_id);
    attempt(d.id)
      .catch((err) => console.error("webhook delivery", d.id, err))
      .finally(() => {
        sending.delete(d.id);
        busy.delete(d.webhook_id);
        pass();
      });
  }
}

/** One attempt: 2xx is delivered; anything else (a redirect, a timeout, a blocked target) is retried, then failed. */
async function attempt(id: number) {
  const row = db
    .query<{ uuid: string; type: string; payload: string; attempts: number; webhook_id: number; url: string; secret: string }, [number]>(
      `SELECT d.uuid, d.type, d.payload, d.attempts, d.webhook_id, w.url, w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.id = ? AND d.status = 'pending' AND w.enabled = 1`,
    )
    .get(id);
  if (!row) return;
  let status: number | null = null;
  let error: string | null = null;
  const blocked = await checkTarget(row.url);
  if (blocked) error = `blocked: ${blocked}`;
  else {
    const timestamp = Date.now();
    const body = JSON.stringify({ ...JSON.parse(row.payload), webhookTimestamp: timestamp });
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const res = await fetch(row.url, {
        method: "POST",
        redirect: "manual",
        signal,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Docket-Webhook",
          "Docket-Delivery": row.uuid,
          "Docket-Event": row.type,
          "Docket-Timestamp": String(timestamp),
          "Docket-Signature": createHmac("sha256", row.secret).update(body).digest("hex"),
        },
        body,
      });
      status = res.status;
      await res.body?.cancel().catch(() => {}); // never read or kept
      if (status < 200 || status > 299) error = `HTTP ${status}`;
    } catch (err) {
      error = signal.aborted ? `timeout after ${TIMEOUT_MS / 1000} s` : `network error: ${(err as { code?: string }).code ?? String(err)}`.slice(0, 200);
    }
  }
  record(id, row.webhook_id, row.attempts + 1, status, error);
}

function record(id: number, webhookId: number, attempts: number, status: number | null, error: string | null) {
  const time = now();
  const retry = error ? RETRY_MS[attempts - 1] : undefined;
  const set = db.query(
    "UPDATE webhook_deliveries SET status = ?, attempts = ?, response_status = ?, error = ?, last_attempt_at = ?, next_attempt_at = ? WHERE id = ? AND status = 'pending'",
  );
  const disabled = db.transaction(() => {
    if (!error) {
      set.run("delivered", attempts, status, null, time, null, id);
      db.query("UPDATE webhooks SET failures = 0 WHERE id = ?").run(webhookId);
    } else if (retry !== undefined) {
      set.run("pending", attempts, status, error, time, new Date(Date.now() + retry).toISOString(), id);
    } else {
      set.run("failed", attempts, status, error, time, null, id);
      const hook = db
        .query<{ workspace: string; failures: number }, [number]>("UPDATE webhooks SET failures = failures + 1 WHERE id = ? RETURNING workspace, failures")
        .get(webhookId);
      if (hook && hook.failures >= DISABLE_AFTER) {
        disable(webhookId, time);
        return hook.workspace;
      }
    }
  })();
  if (retry !== undefined) later(pass, retry);
  if (disabled) changed("workspace", disabled, disabled);
}

/** Turns a webhook off: its queued deliveries fail. */
function disable(webhookId: number, time: string) {
  db.query("UPDATE webhooks SET enabled = 0, updated_at = ? WHERE id = ?").run(time, webhookId);
  db.query("UPDATE webhook_deliveries SET status = 'failed', error = 'webhook disabled', next_attempt_at = NULL WHERE webhook_id = ? AND status = 'pending'").run(
    webhookId,
  );
}

/** Drops deliveries older than a week from the log. */
export const purgeDeliveries = () => db.query("DELETE FROM webhook_deliveries WHERE created_at < ?").run(new Date(Date.now() - KEEP_MS).toISOString());

/** When the next queued delivery is due (null: none): a Durable Object sets its alarm by it. */
export const nextDelivery = () =>
  db.query<{ at: string | null }, []>("SELECT MIN(next_attempt_at) AS at FROM webhook_deliveries WHERE status = 'pending'").get()?.at ?? null;

/** Starts sending (index.ts, src/worker): `origin` is where people open Docket, for payload URLs. `timers`: Bun's, checking every second. */
export function startWebhooks(origin: string, timers = true) {
  base = origin;
  started = true;
  purgeDeliveries();
  if (timers) {
    setInterval(purgeDeliveries, 60 * 60 * 1000);
    setInterval(pass, 1000); // anything left, e.g. after a restart
  }
  pass();
}

// --- Managing webhooks (admins, browser session) ---

interface WebhookRow {
  id: number;
  workspace: string;
  url: string;
  label: string;
  resource_types: string;
  enabled: number;
  failures: number;
  created_at: string;
  updated_at: string;
}

const SELECT = "SELECT w.* FROM webhooks w";

const toWebhook = (r: WebhookRow): Webhook => ({
  id: r.id,
  url: r.url,
  label: r.label,
  resourceTypes: JSON.parse(r.resource_types),
  enabled: r.enabled === 1,
  failures: r.failures,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function webhookRow(workspace: string, id: unknown): WebhookRow {
  const row = db.query<WebhookRow, [string, number]>(`${SELECT} WHERE w.workspace = ? AND w.id = ?`).get(workspace, Number(id));
  if (!row) throw new AppError(`Webhook ${id} not found`, 404);
  return row;
}

async function checkUrl(value: unknown): Promise<string> {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url) throw new AppError("url is required");
  if (url.length > 2000) throw new AppError("url is too long: at most 2,000 characters");
  const refused = await checkTarget(url);
  if (refused) throw new AppError(`Webhook URL refused: ${refused}`);
  return url;
}

function checkResources(value: unknown): WebhookResource[] {
  if (!Array.isArray(value) || !value.length) throw new AppError(`resourceTypes must be a non-empty array of ${WEBHOOK_RESOURCES.join(", ")}`);
  const given = value.map((v) => checkOneOf(v, WEBHOOK_RESOURCES, "resource type"));
  return WEBHOOK_RESOURCES.filter((r) => given.includes(r));
}

const newSecret = () => `dkwh_${randomBytes(32).toString("hex")}`;

export function listWebhooks(a: Actor, workspace: unknown): Webhook[] {
  const key = requireAdminSession(a, workspace);
  return db.query<WebhookRow, [string]>(`${SELECT} WHERE w.workspace = ? ORDER BY w.id`).all(key).map(toWebhook);
}

/** A new webhook, and its signing secret: shown this once. */
export async function createWebhook(a: Actor, workspace: unknown, input: WebhookInput): Promise<{ webhook: Webhook; secret: string }> {
  const key = requireAdminSession(a, workspace);
  const label = optionalText(input.label, "label");
  const types = input.resourceTypes === undefined ? [...WEBHOOK_RESOURCES] : checkResources(input.resourceTypes);
  const url = await checkUrl(input.url);
  const secret = newSecret();
  const time = now();
  const { id } = db
    .query<{ id: number }, [string, string, string, string, string, number, string, string]>(
      `INSERT INTO webhooks (workspace, url, label, resource_types, secret, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(key, url, label, JSON.stringify(types), secret, a.id, time, time)!;
  changed("workspace", key, key);
  return { webhook: toWebhook(webhookRow(key, id)), secret };
}

/** Enabling resets its failures; disabling fails what's queued. */
export async function updateWebhook(a: Actor, workspace: unknown, id: unknown, patch: WebhookPatch): Promise<Webhook> {
  const key = requireAdminSession(a, workspace);
  const row = webhookRow(key, id);
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new AppError("enabled must be true or false");
  const label = patch.label === undefined ? row.label : optionalText(patch.label, "label");
  const types = patch.resourceTypes === undefined ? row.resource_types : JSON.stringify(checkResources(patch.resourceTypes));
  const url = patch.url === undefined ? row.url : await checkUrl(patch.url);
  const time = now();
  db.transaction(() => {
    db.query("UPDATE webhooks SET url = ?, label = ?, resource_types = ?, updated_at = ? WHERE id = ?").run(url, label, types, time, row.id);
    if (patch.enabled === true) db.query("UPDATE webhooks SET enabled = 1, failures = 0 WHERE id = ?").run(row.id);
    if (patch.enabled === false && row.enabled) disable(row.id, time);
  })();
  changed("workspace", key, key);
  return toWebhook(webhookRow(key, row.id));
}

export function deleteWebhook(a: Actor, workspace: unknown, id: unknown) {
  const key = requireAdminSession(a, workspace);
  db.query("DELETE FROM webhooks WHERE id = ?").run(webhookRow(key, id).id);
  changed("workspace", key, key);
}

/** A new signing secret: the old one stops at once. */
export function rotateWebhookSecret(a: Actor, workspace: unknown, id: unknown): { secret: string } {
  const key = requireAdminSession(a, workspace);
  const secret = newSecret();
  db.query("UPDATE webhooks SET secret = ?, updated_at = ? WHERE id = ?").run(secret, now(), webhookRow(key, id).id);
  changed("workspace", key, key);
  return { secret };
}

/** The newest 50 deliveries. */
export function listDeliveries(a: Actor, workspace: unknown, id: unknown): WebhookDelivery[] {
  const key = requireAdminSession(a, workspace);
  return db
    .query<Record<string, any>, [number]>("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 50")
    .all(webhookRow(key, id).id)
    .map((r) => ({
      id: r.id,
      uuid: r.uuid,
      type: r.type,
      action: r.action,
      entity: r.entity,
      status: r.status,
      attempts: r.attempts,
      responseStatus: r.response_status,
      error: r.error,
      createdAt: r.created_at,
      lastAttemptAt: r.last_attempt_at,
      nextAttemptAt: r.next_attempt_at,
    }));
}

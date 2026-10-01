// Docket on Cloudflare Workers: the web app is static assets (scripts/build-worker.ts), and everything else (/api, /mcp,
// /ws) goes to one SQLite-backed Durable Object that runs the same server as Bun (app.ts) on its own storage: SQL
// through the Store interface, attachments in R2, WebSockets that hibernate, and timers as one alarm.
import { DurableObject } from "cloudflare:workers";
import { createHash, timingSafeEqual } from "node:crypto";
import { formatCode, needsSetup, onRevoke, setupCode } from "../server/access.ts";
import { eventTopics, revokes, route, type SocketData } from "../server/app.ts";
import { useFiles } from "../server/attachments.ts";
import { db, onChange, open } from "../server/db.ts";
import { HARD_MAX_BODY, secure, type Server } from "../server/http.ts";
import { startPush } from "../server/push.ts";
import { useScheduler } from "../server/runtime.ts";
import { durableStore } from "../server/store.ts";
import { autoArchive, catchUp, syncCycles } from "../server/tracker.ts";
import { hashes, load } from "../server/transfer.ts";
import { nextDelivery, pass, purgeDeliveries, startWebhooks } from "../server/webhooks.ts";

interface Env {
  DOCKET: DurableObjectNamespace<Docket>;
  ATTACHMENTS: R2Bucket;
  /** Set only while importing a database: turns on /api/admin/* for whoever has it. */
  IMPORT_TOKEN?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export default {
  /**
   * Only the server's paths get here (run_worker_first); x-forwarded-* are the client's own claims, so they go. The body
   * is read here (at most HARD_MAX_BODY), since the object may answer without reading it (a 401, a 413).
   */
  async fetch(req: Request, env: Env) {
    const headers = new Headers([...req.headers].filter(([name]) => !name.startsWith("x-forwarded-")));
    if (Number(req.headers.get("content-length") ?? 0) > HARD_MAX_BODY) return secure(req, Response.json({ error: "Request body too large" }, { status: 413 }), { api: true });
    const body = req.body ? await req.arrayBuffer() : null;
    return docket(env).fetch(new Request(req.url, { method: req.method, headers, body }));
  },
  /** Every 5 minutes: a safety net that makes sure the alarm is set. */
  async scheduled(_: unknown, env: Env) {
    await docket(env).tick();
  },
};

const docket = (env: Env) => env.DOCKET.get(env.DOCKET.idFromName("docket"));

export class Docket extends DurableObject<Env> {
  private hourly = Date.now(); // catchUp just ran the hourly work

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    open(durableStore(ctx.storage), true);
    useFiles({
      put: async (id, bytes) => void (await env.ATTACHMENTS.put(id, bytes)),
      get: async (id) => (await env.ATTACHMENTS.get(id))?.body ?? null,
      delete: (id) => env.ATTACHMENTS.delete(id),
    });
    // A kick runs right after this request's transaction; anything later, at the alarm.
    useScheduler((fn, ms) => ctx.waitUntil(ms ? this.schedule(Date.now() + ms) : new Promise((done) => setTimeout(done, 0)).then(fn)));
    // Sockets keep what they hear in their attachment (a socket takes at most 10 tags), so publishing goes through them all;
    // a closed one lingers in the list until it's gone.
    const live = () => ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
    onChange((event, to) => {
      const message = JSON.stringify(event);
      const topics = new Set(eventTopics(event, to));
      for (const ws of live()) if ((ws.deserializeAttachment() as SocketData).topics.some((t) => topics.has(t))) ws.send(message);
    });
    onRevoke((r) => {
      for (const ws of live()) if (revokes(r, ws.deserializeAttachment())) ws.close(4401, "Signed out");
    });
    catchUp();
    const publicUrl = (process.env.DOCKET_URL || "http://localhost").replace(/\/+$/, "");
    startWebhooks(publicUrl, false);
    startPush(publicUrl);
    if (needsSetup() && !process.env.DOCKET_SETUP_CODE) console.log(`Setup code: ${formatCode(setupCode())} (set DOCKET_SETUP_CODE to choose one)`);
    ctx.waitUntil(this.schedule());
  }

  async fetch(req: Request): Promise<Response> {
    const admin = await this.admin(req);
    if (admin) return admin;
    let upgraded: Response | undefined;
    const server: Server = {
      requestIP: (r) => ({ address: r.headers.get("cf-connecting-ip") ?? "" }),
      upgrade: (r, { data }) => {
        if (r.headers.get("upgrade")?.toLowerCase() !== "websocket") return false;
        const { 0: client, 1: socket } = new WebSocketPair();
        this.ctx.acceptWebSocket(socket);
        socket.serializeAttachment(data);
        upgraded = new Response(null, { status: 101, webSocket: client });
        return true;
      },
    };
    return (await route(req, server)) ?? upgraded!;
  }

  webSocketMessage() {} // clients only listen

  /** The background work: cycles every minute, auto-archive and the delivery log hourly, webhook deliveries when due. */
  async alarm() {
    syncCycles();
    if (Date.now() - this.hourly >= HOUR) {
      this.hourly = Date.now();
      autoArchive();
      purgeDeliveries();
    }
    pass();
    await this.schedule(undefined, true);
  }

  async tick() {
    await this.schedule();
  }

  /** Sets the alarm for the earliest of `at` (a retry), a minute from now and the next webhook delivery (at least a second away: one in flight is due too). */
  private async schedule(at = Infinity, force = false) {
    const next = Math.min(at, Math.max(Date.now() + 1000, Math.min(Date.now() + MINUTE, Date.parse(nextDelivery() ?? "") || Infinity)));
    const current = force ? null : await this.ctx.storage.getAlarm();
    if (current === null || next < current) await this.ctx.storage.setAlarm(next);
  }

  /**
   * The one-time import, only while the IMPORT_TOKEN secret is set and only with it (scripts/import.ts): POST
   * /api/admin/import takes every table's rows into an empty database; PUT /api/admin/files/:id an attachment's bytes
   * (before or after its row: files never change, so they can be copied ahead);
   * GET /api/admin/hashes what to check it against. Anything else, or without the token, is a normal request.
   */
  private async admin(req: Request): Promise<Response | null> {
    const { pathname } = new URL(req.url);
    const token = this.env.IMPORT_TOKEN;
    if (!token || !pathname.startsWith("/api/admin/")) return null;
    const sha = (s: string) => createHash("sha256").update(s).digest();
    if (!timingSafeEqual(sha(req.headers.get("authorization") ?? ""), sha(`Bearer ${token}`))) return null;
    try {
      if (pathname === "/api/admin/import" && req.method === "POST") {
        load(db, await req.json());
        return Response.json({ ok: true });
      }
      const file = /^\/api\/admin\/files\/([A-Za-z0-9_-]{22})$/.exec(pathname)?.[1];
      if (file && req.method === "PUT") {
        await this.env.ATTACHMENTS.put(file, new Uint8Array(await req.arrayBuffer()));
        return Response.json({ ok: true });
      }
      if (pathname === "/api/admin/hashes" && req.method === "GET") {
        const files: { key: string; size: number; etag: string }[] = [];
        for (let cursor: string | undefined, page; (page = await this.env.ATTACHMENTS.list({ cursor })); cursor = page.cursor) {
          files.push(...page.objects.map(({ key, size, etag }) => ({ key, size, etag })));
          if (!page.truncated) break;
        }
        return Response.json({
          tables: hashes(db),
          quickCheck: db.query("PRAGMA quick_check").all(),
          foreignKeyCheck: db.query("PRAGMA foreign_key_check").all(),
          files,
        });
      }
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 400 });
    }
    return null;
  }
}

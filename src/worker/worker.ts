// Docket on Cloudflare Workers (the free plan: 10 ms of CPU a request): the web app is static assets
// (scripts/build-worker.ts), and everything else (/api, /mcp, /ws) goes to one SQLite-backed Durable Object that runs the
// same server as Bun (app.ts) on its own storage: SQL through the Store interface, attachment bytes streamed to R2,
// WebSockets that hibernate, an hourly cron for housekeeping and an alarm only when a webhook delivery is due.
import { DurableObject } from "cloudflare:workers";
import { createHash, timingSafeEqual } from "node:crypto";
import { needsSetup, onRevoke, recoverySignInLink } from "../server/access.ts";
import { eventTopics, revokes, route, type SocketData } from "../server/app.ts";
import { useFiles } from "../server/attachments.ts";
import { AppError, db, onChange, open } from "../server/db.ts";
import { HARD_MAX_BODY, secure, type Server } from "../server/http.ts";
import { startPush } from "../server/push.ts";
import { useScheduler } from "../server/runtime.ts";
import { durableStore } from "../server/store.ts";
import { catchUp } from "../server/tracker.ts";
import { load, pageHash, schemaHash, tables } from "../server/transfer.ts";
import { nextDelivery, pass, purgeDeliveries, startWebhooks } from "../server/webhooks.ts";

interface Env {
  DOCKET: DurableObjectNamespace<Docket>;
  ASSETS: { fetch(req: Request): Promise<Response> };
  ATTACHMENTS: R2Bucket;
  /** Turns on /api/admin/* for whoever has it: the import and account recovery. Set it when needed, delete it after. */
  ADMIN_TOKEN?: string;
}

const notFound = (req: Request) => secure(req, new Response("Not found", { status: 404 }));

export default {
  /**
   * The server's paths and /icons/* get here (run_worker_first); the rest is static assets. x-forwarded-* are the client's
   * own claims, so they go. A body is read here (at most HARD_MAX_BODY), since the object may answer without reading it,
   * except an upload's, which streams on to R2 (the object reads every one: see `fetch` there).
   */
  async fetch(req: Request, env: Env) {
    // Icons are files; anything else under /icons is a plain 404, not the app shell the assets fall back to.
    if (new URL(req.url).pathname.startsWith("/icons/")) {
      const res = await env.ASSETS.fetch(req);
      return res.headers.get("content-type")?.startsWith("image/") ? res : notFound(req);
    }
    const headers = new Headers([...req.headers].filter(([name]) => !name.startsWith("x-forwarded-")));
    if (Number(req.headers.get("content-length") ?? 0) > HARD_MAX_BODY) return secure(req, Response.json({ error: "Request body too large" }, { status: 413 }), { api: true });
    const body = !req.body || streams(req) ? req.body : await req.arrayBuffer();
    return docket(env).fetch(new Request(req.url, { method: req.method, headers, body }));
  },
  /** Hourly (at :00, so a cycle ends within a minute of midnight UTC): the housekeeping. */
  async scheduled(_: unknown, env: Env) {
    await docket(env).housekeeping();
  },
};

const docket = (env: Env) => env.DOCKET.get(env.DOCKET.idFromName("docket"));

/** An upload: its body streams through to R2 instead of being held whole. */
const streams = (req: Request) => {
  const { pathname } = new URL(req.url);
  return (req.method === "POST" && pathname === "/api/attachments") || (req.method === "PUT" && pathname.startsWith("/api/admin/files/"));
};

/** A body of `length` bytes as R2 takes a stream (a known length); unknown, it's read whole. */
async function sized(body: ReadableStream | Uint8Array, length?: number) {
  if (body instanceof Uint8Array) return body;
  if (length === undefined) return new Uint8Array(await new Response(body).arrayBuffer());
  const fixed = new FixedLengthStream(length);
  body.pipeTo(fixed.writable).catch(() => {}); // a short or long body fails the put
  return fixed.readable;
}
const contentLength = (req: Request) => (req.headers.has("content-length") ? Number(req.headers.get("content-length")) : undefined);

export class Docket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    open(durableStore(ctx.storage), true);
    useFiles({
      put: async (id, body, length) => (await env.ATTACHMENTS.put(id, await sized(body, length)))!.size,
      get: async (id, bytes) => (await env.ATTACHMENTS.get(id, bytes === undefined ? undefined : { range: { offset: 0, length: bytes } }))?.body ?? null,
      delete: (id) => env.ATTACHMENTS.delete(id),
    });
    // A kick runs right after this request's transaction; a retry wakes the object with its alarm.
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
    const publicUrl = (process.env.DOCKET_URL || "http://localhost").replace(/\/+$/, "");
    startWebhooks(publicUrl, false);
    startPush(publicUrl);
    if (!process.env.DOCKET_SETUP_CODE && needsSetup()) console.error("Set the DOCKET_SETUP_CODE secret to set up Docket");
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
    const res = (await route(req, server)) ?? upgraded!;
    // An upload answered without reading it all (a 401, a 413): it's read to the end, or the Worker couldn't answer.
    if (req.body && !req.bodyUsed) await req.body.pipeTo(new WritableStream()).catch(() => {});
    return res;
  }

  webSocketMessage() {} // clients only listen

  /** What Bun does at startup and on its timers: the sweeps (trash, auto-archive, cycles), the delivery log, what's due. */
  async housekeeping() {
    catchUp();
    purgeDeliveries();
    pass();
    await this.schedule();
  }

  /** A webhook delivery is due. */
  async alarm() {
    pass();
    await this.schedule(Infinity, true);
  }

  /** Sets the alarm for a retry (`at`) or the next queued delivery (at least a second away: one in flight is due too), if any. */
  private async schedule(at = Infinity, force = false) {
    const due = Date.parse(nextDelivery() ?? "");
    const next = Math.min(at, Number.isNaN(due) ? Infinity : Math.max(Date.now() + 1000, due));
    if (next === Infinity) return;
    const current = force ? null : await this.ctx.storage.getAlarm();
    if (current === null || next < current) await this.ctx.storage.setAlarm(next);
  }

  /**
   * Operator endpoints, only while the ADMIN_TOKEN secret is set and only with it; each does a little, as Workers Free
   * allows. The import (scripts/import.ts), in any number of small requests that can be repeated:
   *   GET  /api/admin/tables                 Docket's tables with row counts, the schema's hash, quick_check
   *   POST /api/admin/rows/:table            a batch of rows `[{…}]`, inserted as they are (rows already there are skipped)
   *   GET  /api/admin/rows/:table?offset&limit the hash of a page of rows (transfer.ts pageHash), and foreign_key_check's for the table
   *   PUT  /api/admin/files/:id              an attachment's bytes, streamed to R2, which checks them against X-Docket-SHA256
   *                                          (before or after its row: files never change)
   *   GET  /api/admin/files/:id              its size and SHA-256 as R2 has them (404: missing)
   * Recovery (scripts/sign-in-link.ts): POST /api/admin/sign-in-link `{ username, workspace? }`, a one-time sign-in code.
   * Anything else, or without the token, is a normal request.
   */
  private async admin(req: Request): Promise<Response | null> {
    const { pathname, searchParams } = new URL(req.url);
    const token = this.env.ADMIN_TOKEN;
    if (!token || !pathname.startsWith("/api/admin/")) return null;
    const sha = (s: string) => createHash("sha256").update(s).digest();
    if (!timingSafeEqual(sha(req.headers.get("authorization") ?? ""), sha(`Bearer ${token}`))) return null;
    const [, , , what, a] = pathname.split("/");
    try {
      if (what === "tables" && req.method === "GET") {
        const counts = tables(db).map((t) => ({ table: t, rows: db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${t}"`).get()!.n }));
        return Response.json({ tables: counts, schema: schemaHash(db), quickCheck: db.query("PRAGMA quick_check").all() });
      }
      if (what === "rows" && a && req.method === "POST") {
        load(db, a, await req.json());
        return Response.json({ ok: true });
      }
      if (what === "rows" && a && req.method === "GET") {
        const page = pageHash(db, a, Number(searchParams.get("offset")) || 0, Number(searchParams.get("limit")) || 100);
        return Response.json({ ...page, foreignKeyCheck: db.query(`PRAGMA foreign_key_check("${a.replace(/"/g, "")}")`).all() });
      }
      const file = what === "files" && /^[A-Za-z0-9_-]{22}$/.test(a ?? "") ? a! : null;
      if (file && req.method === "PUT") {
        const object = await this.env.ATTACHMENTS.put(file, await sized(req.body ?? new Uint8Array(), contentLength(req)), {
          sha256: req.headers.get("x-docket-sha256") ?? undefined,
        });
        return Response.json({ size: object!.size });
      }
      if (file && req.method === "GET") {
        const object = await this.env.ATTACHMENTS.head(file);
        if (!object) return Response.json({ error: "No such file" }, { status: 404 });
        const { sha256 } = object.checksums;
        return Response.json({ size: object.size, sha256: sha256 && Buffer.from(sha256).toString("hex") });
      }
      if (what === "sign-in-link" && req.method === "POST") {
        const { username, workspace } = (await req.json()) as { username: string; workspace?: string };
        return Response.json(recoverySignInLink(username, workspace));
      }
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: err instanceof AppError ? err.status : 400 });
    }
    return null;
  }
}

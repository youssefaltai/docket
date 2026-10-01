// Docket on Cloudflare Workers (the free plan: 10 ms of CPU a request): the web app is static assets
// (scripts/build-worker.ts), and everything else (/api, /mcp, /ws) goes to one SQLite-backed Durable Object that runs the
// same server as Bun (app.ts) on its own storage: SQL through the Store interface, attachment bytes in chunked rows,
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
import { CHUNK_BYTES, load, pageHash, schemaHash, tables } from "../server/transfer.ts";
import { nextDelivery, pass, purgeDeliveries, startWebhooks } from "../server/webhooks.ts";

interface Env {
  DOCKET: DurableObjectNamespace<Docket>;
  ASSETS: { fetch(req: Request): Promise<Response> };
  /** Turns on /api/admin/* for whoever has it: the import and account recovery. Set it when needed, delete it after. */
  ADMIN_TOKEN?: string;
}

const notFound = (req: Request) => secure(req, new Response("Not found", { status: 404 }));

export default {
  /**
   * The server's paths and /icons/* get here (run_worker_first); the rest is static assets. x-forwarded-* are the client's
   * own claims, so they go. The body is read here (at most HARD_MAX_BODY): the object may answer without reading it.
   */
  async fetch(req: Request, env: Env) {
    // Icons are files; anything else under /icons is a plain 404, not the app shell the assets fall back to.
    if (new URL(req.url).pathname.startsWith("/icons/")) {
      const res = await env.ASSETS.fetch(req);
      return res.headers.get("content-type")?.startsWith("image/") ? res : notFound(req);
    }
    const headers = new Headers([...req.headers].filter(([name]) => !name.startsWith("x-forwarded-")));
    if (Number(req.headers.get("content-length") ?? 0) > HARD_MAX_BODY) return secure(req, Response.json({ error: "Request body too large" }, { status: 413 }), { api: true });
    const body = req.body ? await req.arrayBuffer() : null;
    return docket(env).fetch(new Request(req.url, { method: req.method, headers, body }));
  },
  /** Hourly (at :00, so a cycle ends within a minute of midnight UTC): the housekeeping. */
  async scheduled(_: unknown, env: Env) {
    await docket(env).housekeeping();
  },
};

const docket = (env: Env) => env.DOCKET.get(env.DOCKET.idFromName("docket"));

export class Docket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    open(durableStore(ctx.storage), true);
    db.run("CREATE TABLE IF NOT EXISTS attachment_chunks (id TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, seq))");
    useFiles({
      put: async (id, bytes) =>
        db.transaction(() => {
          db.query("DELETE FROM attachment_chunks WHERE id = ?").run(id);
          for (let seq = 0; seq * CHUNK_BYTES < bytes.length; seq++) {
            db.query("INSERT INTO attachment_chunks (id, seq, data) VALUES (?, ?, ?)").run(id, seq, bytes.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES));
          }
        })(),
      get: async (id) => {
        const chunks = db.query<{ data: ArrayBuffer }, [string]>("SELECT data FROM attachment_chunks WHERE id = ? ORDER BY seq").all(id);
        return chunks.length ? new Blob(chunks.map((c) => c.data)) : null;
      },
      delete: async (id) => void db.query("DELETE FROM attachment_chunks WHERE id = ?").run(id),
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
    return (await route(req, server)) ?? upgraded!;
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
   *   PUT  /api/admin/files/:id/:seq          one chunk of an attachment's bytes (before or after its row: files never change)
   *   GET  /api/admin/files/:id/:seq          a chunk's size and SHA-256 (404: missing)
   * Recovery (scripts/sign-in-link.ts): POST /api/admin/sign-in-link `{ username, workspace? }`, a one-time sign-in code.
   * Anything else, or without the token, is a normal request.
   */
  private async admin(req: Request): Promise<Response | null> {
    const { pathname, searchParams } = new URL(req.url);
    const token = this.env.ADMIN_TOKEN;
    if (!token || !pathname.startsWith("/api/admin/")) return null;
    const sha = (s: string | ArrayBuffer) => createHash("sha256").update(typeof s === "string" ? s : new Uint8Array(s)).digest();
    if (!timingSafeEqual(sha(req.headers.get("authorization") ?? ""), sha(`Bearer ${token}`))) return null;
    const [, , , what, a, b] = pathname.split("/");
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
      const chunk = /^[A-Za-z0-9_-]{22}$/.test(a ?? "") && /^\d+$/.test(b ?? "") ? ([a!, Number(b)] as const) : null;
      if (what === "files" && chunk && req.method === "PUT") {
        const data = new Uint8Array(await req.arrayBuffer());
        if (data.length > CHUNK_BYTES) throw new AppError(`A chunk is at most ${CHUNK_BYTES} bytes`);
        db.query("INSERT OR REPLACE INTO attachment_chunks (id, seq, data) VALUES (?, ?, ?)").run(...chunk, data);
        return Response.json({ ok: true });
      }
      if (what === "files" && chunk && req.method === "GET") {
        const row = db.query<{ data: ArrayBuffer }, [string, number]>("SELECT data FROM attachment_chunks WHERE id = ? AND seq = ?").get(...chunk);
        return row ? Response.json({ size: row.data.byteLength, sha256: sha(row.data).toString("hex") }) : Response.json({ error: "No such chunk" }, { status: 404 });
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

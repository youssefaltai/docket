// Access to /api, /mcp and /ws. Everyone signs in: a session cookie (the web UI) or an API key
// (`Authorization: Bearer dk_…`, for scripts, MCP clients and agents). The public routes here set up the
// first account and turn one-time codes into sessions.
import type { SetupInput } from "../shared/types.ts";
import * as access from "./access.ts";
import type { Actor, Client } from "./access.ts";
import { AppError } from "./db.ts";

const COOKIE = "docket_session";

/** Exact media type check: "text/plain;charset=application/json" is a CORS-simple request, so it must not pass. */
export const isJson = (req: Request) =>
  req.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase() === "application/json";

const json = (data: unknown, status = 200, headers?: HeadersInit) => Response.json(data, { status, headers });
const unauthorized = (headers?: HeadersInit) => json({ error: "Unauthorized" }, 401, headers);

// DNS rebinding defence: a browser tricked into resolving evil.example to us still sends Host: evil.example.
const HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  ...(process.env.DOCKET_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
]);
const hostAllowed = (req: Request) => HOSTS.has((req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, ""));
const forbiddenHost = () => json({ error: "Host not allowed (see DOCKET_HOSTS)" }, 403);

/** Cookies ride along on same-site requests, so a cookie-authed WebSocket must come from our own origin. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return !!origin && new URL(origin).host === host;
  } catch {
    return false;
  }
}

const https = (req: Request) => new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

function cookieHeader(req: Request, value: string, maxAge: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https(req) ? "; Secure" : ""}`;
}
const signedIn = (req: Request, token: string) => ({ "Set-Cookie": cookieHeader(req, token, 30 * 24 * 60 * 60) });
const signedOut = (req: Request) => ({ "Set-Cookie": cookieHeader(req, "", 0) });

const bearerOf = (req: Request) => req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
const cookieOf = (req: Request) => req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];

/** The actor behind a session cookie, if the request carries one that still signs in. */
const sessionOf = (req: Request) => {
  const cookie = cookieOf(req);
  return cookie ? access.sessionActor(cookie) : null;
};

/**
 * The request's actor; `stale` marks a cookie that no longer signs in, so the 401 can clear it.
 * Cookies ride along on same-site requests (a sibling subdomain, another localhost port), so a
 * cookie-authed WebSocket or write must carry our own Origin.
 */
function identify(req: Request, bearerOnly: boolean): { actor: Actor | null; stale?: boolean; crossSite?: boolean } {
  const bearer = bearerOf(req);
  if (bearer) return { actor: access.keyActor(bearer) };
  const cookie = cookieOf(req);
  if (bearerOnly || !cookie) return { actor: null };
  const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  if ((upgrade || req.method !== "GET") && !sameOrigin(req)) return { actor: null, crossSite: true };
  const actor = access.sessionActor(cookie);
  return actor ? { actor } : { actor: null, stale: true };
}

const actors = new WeakMap<Request, Actor>();

/** The actor `guard` resolved for this request. */
export function actorOf(req: Request): Actor {
  const actor = actors.get(req);
  if (!actor) throw new Error("actorOf called on a request that didn't pass guard");
  return actor;
}

/**
 * Wraps a route: 403 for an unknown Host, 401 without valid credentials, and 403 for a write with a
 * read-only key (for REST, anything but GET; /mcp passes `readCheck: false` and checks per tool).
 * Works on handlers and method maps.
 */
export function guard<T>(route: T, { bearerOnly = false, readCheck = true } = {}): T {
  const wrap = (fn: (req: Request, ...rest: unknown[]) => unknown) => (req: Request, ...rest: unknown[]) => {
    if (!hostAllowed(req)) return forbiddenHost();
    const { actor, stale, crossSite } = identify(req, bearerOnly);
    if (crossSite) return json({ error: "Cross-origin request refused" }, 403);
    if (!actor) return unauthorized(stale ? signedOut(req) : undefined);
    if (readCheck && actor.scope === "read" && req.method !== "GET") return json({ error: "This API key is read-only" }, 403);
    actors.set(req, actor);
    const result = fn(req, ...rest);
    if (!actor.renewCookie) return result;
    return Promise.resolve(result).then((res) => {
      if (res instanceof Response) res.headers.append("Set-Cookie", signedIn(req, cookieOf(req)!)["Set-Cookie"]);
      return res;
    });
  };
  if (typeof route === "function") return wrap(route as never) as T;
  return Object.fromEntries(Object.entries(route as object).map(([m, fn]) => [m, wrap(fn)])) as T;
}

// --- Public routes: setup, codes, sign-out ---

// Failed setup and code attempts per client IP in a fixed window; past the limit, 429 until it ends.
const WINDOW_MS = 60_000;
const MAX_FAILURES = 10;
const failures = new Map<string, { count: number; until: number }>();

function limited(ip: string) {
  const f = failures.get(ip);
  return !!f && f.until > Date.now() && f.count >= MAX_FAILURES;
}

function recordFailure(ip: string) {
  const time = Date.now();
  for (const [key, f] of failures) if (f.until <= time) failures.delete(key);
  const f = failures.get(ip);
  if (f) f.count++;
  else failures.set(ip, { count: 1, until: time + WINDOW_MS });
}

type Server = Pick<Bun.Server<unknown>, "requestIP">;

/** A public JSON POST: Host and JSON checks, the per-IP limit, and AppErrors as JSON (401s and 403s count). */
const open =
  (fn: (body: Record<string, unknown>, req: Request, client: Client) => Response) =>
  async (req: Request, server: Server): Promise<Response> => {
    if (!hostAllowed(req)) return forbiddenHost();
    if (!isJson(req)) return json({ error: "Expected Content-Type: application/json" }, 415);
    const ip = server.requestIP(req)?.address ?? "";
    if (limited(ip)) return json({ error: "Too many attempts, try again in a minute" }, 429);
    const body = await req.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "Expected a JSON object" }, 400);
    try {
      return fn(body, req, { ip, userAgent: req.headers.get("user-agent") ?? "" });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      if (err.status === 401 || err.status === 403) recordFailure(ip);
      return json({ error: err.message }, err.status);
    }
  };

export const authRoutes = {
  "/api/setup": {
    GET: (req: Request) => (hostAllowed(req) ? json({ needed: access.needsSetup() }) : forbiddenHost()),
    POST: open((body, req, client) => {
      const { user, workspace, token } = access.setup(body as unknown as SetupInput, client);
      return json({ user, workspace }, 201, signedIn(req, token));
    }),
  },
  // An invite redeemed with a session joins that user; the Origin check keeps another site from doing it for them.
  "/api/auth/peek": {
    POST: open((body, req) => json(access.peekCode(body.code, sameOrigin(req) ? (sessionOf(req)?.id ?? null) : null))),
  },
  "/api/auth/redeem": {
    POST: open((body, req, client) => {
      const signedInAs = sameOrigin(req) ? (sessionOf(req)?.id ?? null) : null;
      const { user, token } = access.redeemCode(body.code, body, client, signedInAs);
      return json({ user }, 200, signedIn(req, token));
    }),
  },
  // No credentials needed: it only ends the session in this cookie and clears it.
  "/api/logout": {
    POST: (req: Request) => {
      if (!hostAllowed(req)) return forbiddenHost();
      if (!isJson(req)) return json({ error: "Expected Content-Type: application/json" }, 415);
      const cookie = cookieOf(req);
      if (cookie) access.endSession(cookie);
      return json({ ok: true }, 200, signedOut(req));
    },
  },
};

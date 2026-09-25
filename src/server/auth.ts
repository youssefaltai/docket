// Access. With DOCKET_TOKEN set, /api, /mcp and /ws need a token as `Authorization: Bearer <token>` or the
// login cookie: DOCKET_TOKEN itself (root: an admin with no name) or a member's own token (see members in db).
// With it unset, Docket is open (put it on a private network): anyone is root, and a member token only says who you are.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Member } from "../shared/types.ts";
import * as db from "./db.ts";

const TOKEN = process.env.DOCKET_TOKEN || "";
/** No DOCKET_TOKEN: anyone who can reach the server is root. */
export const OPEN = !TOKEN;
const COOKIE = "docket_token";
// Cookies hold a value derived from a token, never the token itself (which also works as an MCP bearer).
const ROOT_SESSION = createHmac("sha256", TOKEN).update("docket session").digest("hex");
// A member's is `<id>.<HMAC>` over their token's hash, keyed by DOCKET_TOKEN so the database alone can't forge one.
// Rotating or revoking the member's token, or changing DOCKET_TOKEN, signs them out.
const memberSession = ({ id, tokenHash }: db.Credential) =>
  `${id}.${createHmac("sha256", TOKEN).update(`docket member session ${tokenHash}`).digest("hex")}`;
const digest = (s: string) => createHash("sha256").update(s).digest();
const same = (candidate: string | undefined, secret: string) =>
  !!candidate && timingSafeEqual(digest(candidate), digest(secret));

/** Who a request acts as: a member, or root (`member: null`): DOCKET_TOKEN, or anyone in open mode. */
export interface Viewer {
  member: Member | null;
}

const ROOT: Viewer = { member: null };

export const isAdmin = (viewer: Viewer) => !viewer.member || viewer.member.role === "admin";

/** Members always write as themselves; root names itself (default `fallback`), as before members existed. */
export const authorFor = (viewer: Viewer, requested: unknown, fallback: string): unknown =>
  viewer.member ? viewer.member.name : requested === undefined ? fallback : requested;

/** Cookies ride along on same-site requests, so a cookie-authed WebSocket must come from our own origin. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * The request's viewer, or null when DOCKET_TOKEN is set and it carries no valid token. Member tokens are
 * found by their SHA-256, which leaks nothing useful about a 256-bit token even if the lookup isn't constant time.
 */
function identify(req: Request): Viewer | null {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    if (TOKEN && same(bearer, TOKEN)) return ROOT;
    const credential = db.memberByToken(bearer);
    if (credential) return { member: credential.member };
    // In open mode a revoked or mistyped member token must not quietly become root. With no members yet,
    // stray bearers are ignored as they always were.
    if (!TOKEN && db.hasMembers()) return null;
  }
  const cookie = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];
  const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (cookie && (!upgrade || sameOrigin(req))) {
    if (TOKEN && same(cookie, ROOT_SESSION)) return ROOT;
    const credential = db.memberById(Number(cookie.split(".")[0]));
    if (credential && same(cookie, memberSession(credential))) return { member: credential.member };
  }
  return TOKEN ? null : ROOT;
}

const viewers = new WeakMap<Request, Viewer>();

/** The viewer `guard` resolved for this request. */
export function viewerOf(req: Request): Viewer {
  const viewer = viewers.get(req);
  if (!viewer) throw new Error("viewerOf called on a request that didn't pass guard");
  return viewer;
}

export function requireAdmin(req: Request) {
  if (!isAdmin(viewerOf(req))) throw new db.AppError("Only admins can manage members", 403);
}

/** Exact media type check: "text/plain;charset=application/json" is a CORS-simple request, so it must not pass. */
export const isJson = (req: Request) =>
  req.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase() === "application/json";

const unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });

// DNS rebinding defence: a browser tricked into resolving evil.example to us still sends Host: evil.example.
const HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  ...(process.env.DOCKET_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
]);

const hostAllowed = (req: Request) =>
  HOSTS.has((req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, ""));

const forbiddenHost = () => Response.json({ error: "Host not allowed (see DOCKET_HOSTS)" }, { status: 403 });

/**
 * Wraps a route so it answers 403 for an unknown Host and 401 without a valid token, and records the
 * request's viewer for `viewerOf`. Works on handlers and method maps.
 */
export function guard<T>(route: T): T {
  const wrap = (fn: (req: Request, ...rest: unknown[]) => unknown) => (req: Request, ...rest: unknown[]) => {
    if (!hostAllowed(req)) return forbiddenHost();
    const viewer = identify(req);
    if (!viewer) return unauthorized();
    viewers.set(req, viewer);
    return fn(req, ...rest);
  };
  if (typeof route === "function") return wrap(route as never) as T;
  return Object.fromEntries(Object.entries(route as object).map(([m, fn]) => [m, wrap(fn)])) as T;
}

// Failed logins per client IP in a fixed window; past the limit, login answers 429 until the window ends.
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 10;
const failures = new Map<string, { count: number; until: number }>();

function recordFailure(ip: string) {
  const time = Date.now();
  for (const [key, f] of failures) if (f.until <= time) failures.delete(key);
  const f = failures.get(ip);
  if (f) f.count++;
  else failures.set(ip, { count: 1, until: time + LOGIN_WINDOW_MS });
}

/**
 * POST /api/login `{ token }` (DOCKET_TOKEN or a member's token): sets an HttpOnly cookie for the web UI.
 * In open mode a non-member token still answers ok, without a cookie: there's nothing to sign in to.
 */
export async function login(req: Request, server: Bun.Server<undefined>): Promise<Response> {
  if (!hostAllowed(req)) return forbiddenHost();
  if (!isJson(req)) return Response.json({ error: "Expected Content-Type: application/json" }, { status: 415 });
  const ip = server.requestIP(req)?.address ?? "";
  const f = failures.get(ip);
  if (f && f.until > Date.now() && f.count >= LOGIN_MAX_FAILURES) {
    return Response.json({ error: "Too many attempts, try again in a minute" }, { status: 429 });
  }
  const { token } = ((await req.json().catch(() => null)) ?? {}) as { token?: unknown };
  const candidate = typeof token === "string" && token ? token : undefined;
  const root = !!TOKEN && same(candidate, TOKEN);
  const credential = !root && candidate ? db.memberByToken(candidate) : null;
  const value = root ? ROOT_SESSION : credential ? memberSession(credential) : null;
  if (!value) {
    if (!TOKEN) return Response.json({ ok: true });
    recordFailure(ip);
    return unauthorized();
  }
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie(req, value, 31536000) } });
}

/** POST /api/logout: clears the login cookie, which the page can't since it's HttpOnly. */
export function logout(req: Request): Response {
  if (!hostAllowed(req)) return forbiddenHost();
  if (!isJson(req)) return Response.json({ error: "Expected Content-Type: application/json" }, { status: 415 });
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie(req, "", 0) } });
}

function cookie(req: Request, value: string, maxAge: number): string {
  const https = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
}

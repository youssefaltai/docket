// Optional access token. With DOCKET_TOKEN unset, Docket is open (put it on a private network).
// With it set, /api, /mcp and /ws need `Authorization: Bearer <token>` or the login cookie.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TOKEN = process.env.DOCKET_TOKEN || "";
const COOKIE = "docket_token";
// The cookie holds a value derived from the token, never the token itself (which also works as an MCP bearer).
const SESSION = createHmac("sha256", TOKEN).update("docket session").digest("hex");
const digest = (s: string) => createHash("sha256").update(s).digest();
const same = (candidate: string | undefined, secret: string) =>
  !!candidate && timingSafeEqual(digest(candidate), digest(secret));

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

function authorized(req: Request): boolean {
  if (!TOKEN) return true;
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (same(bearer, TOKEN)) return true;
  const cookie = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];
  const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  return same(cookie, SESSION) && (!upgrade || sameOrigin(req));
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

/** Wraps a route so it answers 403 for an unknown Host and 401 without a valid token. Works on handlers and method maps. */
export function guard<T>(route: T): T {
  const wrap =
    (fn: (req: Request, ...rest: unknown[]) => unknown) =>
    (req: Request, ...rest: unknown[]) =>
      !hostAllowed(req) ? forbiddenHost() : authorized(req) ? fn(req, ...rest) : unauthorized();
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

/** POST /api/login `{ token }`: sets an HttpOnly cookie for the web UI. */
export async function login(req: Request, server: Bun.Server<undefined>): Promise<Response> {
  if (!hostAllowed(req)) return forbiddenHost();
  if (!isJson(req)) return Response.json({ error: "Expected Content-Type: application/json" }, { status: 415 });
  if (!TOKEN) return Response.json({ ok: true });
  const ip = server.requestIP(req)?.address ?? "";
  const f = failures.get(ip);
  if (f && f.until > Date.now() && f.count >= LOGIN_MAX_FAILURES) {
    return Response.json({ error: "Too many attempts, try again in a minute" }, { status: 429 });
  }
  const { token } = ((await req.json().catch(() => null)) ?? {}) as { token?: unknown };
  if (!same(typeof token === "string" ? token : undefined, TOKEN)) {
    recordFailure(ip);
    return unauthorized();
  }
  const https = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const cookie = `${COOKIE}=${SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${https ? "; Secure" : ""}`;
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}

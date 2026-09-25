// Optional access token. With DOCKET_TOKEN unset, Docket is open (put it on a private network).
// With it set, /api, /mcp and /ws need `Authorization: Bearer <token>` or the login cookie.
import { createHash, timingSafeEqual } from "node:crypto";

const TOKEN = process.env.DOCKET_TOKEN || "";
const COOKIE = "docket_token";
const digest = (s: string) => createHash("sha256").update(s).digest();

const matches = (candidate: string | undefined) =>
  !!candidate && timingSafeEqual(digest(candidate), digest(TOKEN));

export function authorized(req: Request): boolean {
  if (!TOKEN) return true;
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const cookie = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];
  return matches(bearer) || matches(cookie && decodeURIComponent(cookie));
}

export const unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });

/** Wraps a route so it answers 401 without a valid token. Works on handlers and method maps. */
export function guard<T>(route: T): T {
  if (!TOKEN) return route;
  const wrap =
    (fn: (req: Request, ...rest: unknown[]) => unknown) =>
    (req: Request, ...rest: unknown[]) =>
      authorized(req) ? fn(req, ...rest) : unauthorized();
  if (typeof route === "function") return wrap(route as never) as T;
  return Object.fromEntries(Object.entries(route as object).map(([m, fn]) => [m, wrap(fn)])) as T;
}

/** POST /api/login `{ token }`: sets an HttpOnly cookie for the web UI. */
export async function login(req: Request): Promise<Response> {
  const { token } = ((await req.json().catch(() => null)) ?? {}) as { token?: unknown };
  if (TOKEN && !matches(typeof token === "string" ? token : undefined)) return unauthorized();
  const https = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const cookie = `${COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${https ? "; Secure" : ""}`;
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}

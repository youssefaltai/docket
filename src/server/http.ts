// The HTTP layer every response goes through: security headers, a request body cap, and a rate limit
// per credential. The web app is bundled here at startup (in production) so its files get the headers too.
import { basename, join } from "node:path";

/** Largest request body taken, in bytes (413 with a message). Bun cuts off anything past the hard cap. */
export const MAX_BODY = 1024 * 1024;
export const HARD_MAX_BODY = 8 * MAX_BODY; // bodies without a Content-Length stop here

// Everything the app loads is its own, except Google Fonts and images linked from markdown.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'", // no other page (even one on another port of this host) can frame the app
].join("; ");

const https = (req: Request) => new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

/** Adds the security headers to a response (and no-store for API answers, which are per user). */
export function secure(req: Request, res: Response, { api = false } = {}): Response {
  const h = res.headers;
  h.set("Content-Security-Policy", CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "no-referrer");
  if (https(req)) h.set("Strict-Transport-Security", "max-age=31536000");
  if (api) h.set("Cache-Control", "no-store");
  return res;
}

// --- Rate limit: a token bucket per credential (API key or session cookie), else per client IP ---

const BURST = 600; // requests at once
const PER_SECOND = 20; // sustained
const buckets = new Map<string, { tokens: number; at: number }>();

/** Takes a token for this caller; returns the seconds to wait if there's none left. */
function take(key: string, time = Date.now()): number {
  const b = buckets.get(key) ?? { tokens: BURST, at: time };
  b.tokens = Math.min(BURST, b.tokens + ((time - b.at) / 1000) * PER_SECOND);
  b.at = time;
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.tokens >= BURST) buckets.delete(k); // forget idle callers
  buckets.set(key, b);
  if (b.tokens < 1) return Math.ceil((1 - b.tokens) / PER_SECOND);
  b.tokens -= 1;
  return 0;
}

const credentialOf = (req: Request, ip: string) =>
  req.headers.get("authorization") ?? req.headers.get("cookie")?.match(/(?:^|;\s*)docket_session=([^;]+)/)?.[1] ?? `ip:${ip}`;

type Handler = (req: Request, server: Bun.Server<any>) => Response | undefined | Promise<Response | undefined>;

/** Wraps a route (a handler or a method map) with the body cap, the rate limit and the headers. */
export function http<T>(route: T, { api = true } = {}): T {
  const wrap =
    (fn: Handler): Handler =>
    async (req, server) => {
      const json = (error: string, status: number, headers: Record<string, string> = {}) =>
        secure(req, Response.json({ error }, { status, headers }), { api });
      if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return json("Request body too large (at most 1 MB)", 413);
      const wait = take(credentialOf(req, server.requestIP(req)?.address ?? ""));
      if (wait) return json("Too many requests, slow down", 429, { "Retry-After": String(wait) });
      const res = await fn(req, server);
      return res && secure(req, res, { api }); // undefined: upgraded to a WebSocket
    };
  if (typeof route === "function") return wrap(route as Handler) as T;
  return Object.fromEntries(Object.entries(route as Record<string, Handler>).map(([method, fn]) => [method, wrap(fn)])) as T;
}

// --- The web app ---

/** The built app: the page (for every app URL) and its hashed files, all served with the headers. */
export async function webApp(entry: string) {
  const build = await Bun.build({ entrypoints: [entry], minify: true, publicPath: "/" });
  if (!build.success) throw new AggregateError(build.logs, "Building the web app failed");
  let page: Blob | undefined;
  const files: Record<string, (req: Request) => Response> = {};
  for (const output of build.outputs) {
    if (output.path.endsWith(".html")) page = output;
    else {
      const headers = { "Content-Type": output.type, "Cache-Control": "public, max-age=31536000, immutable" };
      files[`/${basename(output.path)}`] = (req) => secure(req, new Response(output, { headers }));
    }
  }
  if (!page) throw new Error(`No page in the build of ${entry}`);
  const html = page;
  return {
    page: (req: Request) => secure(req, new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache" } })),
    files,
  };
}

/** A file from public/, with the headers. */
export const publicFile = (dir: string, name: string, headers: Record<string, string>) => (req: Request) =>
  secure(req, new Response(Bun.file(join(dir, name)), { headers }));

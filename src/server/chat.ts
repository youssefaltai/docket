// /api/chat[/*] → {CHAT_URL}/chat[/*] (the docket-chat service, see its CHAT_API.md), on the same origin so
// the web app needs no CORS or new CSP.
// Only a signed-in browser gets through; the service sees a short-lived read key for that session, never
// the person's cookie. Bodies and answers stream straight through (server-sent events included).
import { chatKey } from "./access.ts";
import { actorOf, isJson } from "./auth.ts";

const HEADERS_TIMEOUT_MS = 90_000; // for the service to start answering (it may be waiting on a model)
const MAX_MS = 5 * 60 * 1000; // for a whole answer
const IDLE_S = 120; // a stream may go quiet this long between events (the service pings every 15 s)
const MAX_BODY = 16 * 1024; // a chat message is at most 4000 characters

// Only these pass, each way: no cookies, credentials, hop-by-hop or encoding headers.
const REQUEST_HEADERS = ["content-type", "accept", "last-event-id"];
const RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after"];

const pick = (from: Headers, names: string[]) => {
  const to = new Headers();
  for (const name of names) {
    const value = from.get(name);
    if (value !== null) to.set(name, value);
  }
  return to;
};

// Shaped like the service's own errors, so the UI handles both the same way.
const error = (message: string, code: string, status: number) => Response.json({ error: message, code }, { status });

export async function proxyChat(req: Request, server: Bun.Server<unknown>): Promise<Response> {
  const base = process.env.CHAT_URL;
  if (!base) return error("The assistant isn't set up", "not_configured", 404);
  const actor = actorOf(req);
  if (actor.sessionId === null) return error("The assistant works from the web app, not with an API key", "forbidden", 403);
  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE") {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return error("That message is too long", "invalid", 413);
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY) return error("That message is too long", "invalid", 413);
    if (body.byteLength && !isJson(req)) return error("Expected Content-Type: application/json", "invalid", 415);
  }
  const token = chatKey(actor);

  const url = new URL(req.url);
  const target = new URL(base);
  target.pathname = target.pathname.replace(/\/+$/, "") + url.pathname.slice("/api".length);
  target.search = url.search;

  const headers = pick(req.headers, REQUEST_HEADERS);
  headers.set("authorization", `Bearer ${token}`);
  const started = new AbortController();
  const timer = setTimeout(() => started.abort(), HEADERS_TIMEOUT_MS);
  server.timeout(req, IDLE_S);
  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
      body,
      // The browser leaving (Stop), a slow start, or an answer running past MAX_MS all cancel the upstream request.
      signal: AbortSignal.any([req.signal, started.signal, AbortSignal.timeout(MAX_MS)]),
      redirect: "manual",
    });
    return new Response(res.body, { status: res.status, headers: pick(res.headers, RESPONSE_HEADERS) });
  } catch {
    return started.signal.aborted
      ? error("The assistant took too long to answer", "timeout", 504)
      : error("Can't reach the assistant", "chat_unavailable", 502);
  } finally {
    clearTimeout(timer);
  }
}

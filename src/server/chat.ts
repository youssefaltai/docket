// /api/chat[/*] → {CHAT_URL}/chat[/*] (the docket-chat service, see its CHAT_API.md), on the same origin so
// the web app needs no CORS or new CSP.
// Only a signed-in browser gets through; the service sees a short-lived read key for that session, never
// the person's cookie. Bodies and answers stream straight through (server-sent events included).
import { chatKey, chatWriteKey } from "./access.ts";
import { actorOf, isJson } from "./auth.ts";

const HEADERS_TIMEOUT_MS = 90_000; // for the service to start answering (it may be waiting on a model)
const MAX_MS = 5 * 60 * 1000; // for a whole answer
const IDLE_S = 120; // a stream may go quiet this long between events (the service pings every 15 s)
const MAX_BODY = 16 * 1024; // a chat message is at most 4000 characters
// The one request that may change Docket: the person confirming an action the assistant proposed.
const CONFIRM = /^\/api\/chat\/actions\/[^/]+\/confirm$/;

// Only these pass, each way: no cookies, credentials, hop-by-hop or encoding headers.
const REQUEST_HEADERS = ["content-type", "accept", "last-event-id"];
const RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after", "x-accel-buffering"];
// What the service may answer with: nothing that would render as a page on Docket's origin.
const ANSWER_TYPES = ["application/json", "text/event-stream"];

const pick = (from: Headers, names: string[]) => {
  const to = new Headers();
  for (const name of names) {
    const value = from.get(name);
    if (value !== null) to.set(name, value);
  }
  return to;
};

// Shaped like the service's own errors, so the UI handles both the same way.
/** The request body, or undefined once it passes `max` bytes (stops reading there, chunked or not). */
async function readCapped(req: Request, max: number): Promise<Blob | undefined> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return undefined;
  const chunks: BlobPart[] = [];
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.byteLength;
    if (size > max) return undefined;
    chunks.push(chunk as Uint8Array<ArrayBuffer>);
  }
  return new Blob(chunks);
}

/** `body`, calling `done` once it ends, fails or is cancelled (the browser leaving). */
function whenDone(body: ReadableStream<Uint8Array>, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let ended = false;
  const end = () => {
    if (!ended) (ended = true), done();
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done: last, value } = await reader.read();
        if (last) {
          end();
          controller.close();
        } else controller.enqueue(value);
      } catch (err) {
        end();
        controller.error(err);
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  });
}

const error = (message: string, code: string, status: number) => Response.json({ error: message, code }, { status });

export async function proxyChat(req: Request, server: Bun.Server<unknown>): Promise<Response> {
  const base = process.env.CHAT_URL;
  if (!base) return error("The assistant isn't set up", "not_configured", 404);
  const actor = actorOf(req);
  if (actor.sessionId === null) return error("The assistant works from the web app, not with an API key", "forbidden", 403);
  // Bun routes on the raw path but req.url is resolved, so "/api/chat/%2e%2e/x" arrives here as "/x".
  const url = new URL(req.url);
  if (url.pathname !== "/api/chat" && !url.pathname.startsWith("/api/chat/")) return error("Not found", "not_found", 404);
  let body: Blob | undefined;
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE") {
    body = await readCapped(req, MAX_BODY);
    if (!body) return error("That message is too long", "invalid", 413);
    if (body.size && !isJson(req)) return error("Expected Content-Type: application/json", "invalid", 415);
  }
  // Every request reads with the session's chat key, except a confirm: it writes, with a key made for it alone.
  const key = req.method === "POST" && CONFIRM.test(url.pathname) ? chatWriteKey(actor) : { token: chatKey(actor), drop: () => {} };

  const target = new URL(base);
  target.pathname = target.pathname.replace(/\/+$/, "") + url.pathname.slice("/api".length);
  target.search = url.search;
  // And the result must still be the service's /chat, whatever the path held.
  const root = new URL(base).pathname.replace(/\/+$/, "") + "/chat";
  if (target.pathname !== root && !target.pathname.startsWith(`${root}/`)) return error("Not found", "not_found", 404);

  const headers = pick(req.headers, REQUEST_HEADERS);
  headers.set("authorization", `Bearer ${key.token}`);
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
    const type = res.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase();
    if (res.body && type !== undefined && !ANSWER_TYPES.includes(type)) {
      await res.body.cancel();
      key.drop();
      return error("The assistant answered with something unexpected", "chat_unavailable", 502);
    }
    if (!res.body) key.drop();
    return new Response(res.body && whenDone(res.body, key.drop), { status: res.status, headers: pick(res.headers, RESPONSE_HEADERS) });
  } catch {
    key.drop();
    return started.signal.aborted
      ? error("The assistant took too long to answer", "timeout", 504)
      : error("Can't reach the assistant", "chat_unavailable", 502);
  } finally {
    clearTimeout(timer);
  }
}

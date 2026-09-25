const CACHE = "docket-v2";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// A 401 means the session is no longer valid, and signing in or out starts another one: drop
// any /api/* responses cached under the old one, so an offline fallback can't serve its data.
async function clearApiCache(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.filter((k) => new URL(k.url).pathname.startsWith("/api/")).map((k) => cache.delete(k)));
}

// Bumped on every sign-in and sign-out. A GET that started under the old session must not
// re-cache its response after the purge, so it only caches if the generation hasn't moved.
let generation = 0;

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE);
  const started = generation;
  try {
    const response = await fetch(request);
    if (response.ok && started === generation) cache.put(fallbackUrl ?? request, response.clone());
    else if (response.status === 401 && new URL(request.url).pathname.startsWith("/api/")) await clearApiCache(cache);
    return response;
  } catch (err) {
    const cached = await cache.match(fallbackUrl ?? request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached ?? fetchPromise;
}

// Requests that start or end a session.
const SESSION_SWITCHES = ["/api/setup", "/api/auth/redeem", "/api/logout"];

/** Passes a sign-in or sign-out through, clearing the API cache once it succeeds (before the page reloads). */
async function switchSession(request) {
  const response = await fetch(request);
  if (response.ok) {
    generation++;
    await clearApiCache(await caches.open(CACHE));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && SESSION_SWITCHES.includes(path)) {
    event.respondWith(switchSession(request));
    return;
  }
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.pathname === "/mcp" || url.pathname === "/ws") return;
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/"));
  } else if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});

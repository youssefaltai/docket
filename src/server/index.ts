// The Bun server: the web app and public/ files, the routes (app.ts) and their WebSockets, and the timers.
import "./local.ts"; // first: the database
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { formatCode, needsSetup, onRevoke, setupCode } from "./access.ts";
import { eventTopics, revokes, route, SERVER_PATHS, type SocketData } from "./app.ts";
import { onChange } from "./db.ts";
import { HARD_MAX_BODY, publicFile, secure, webApp } from "./http.ts";
import { startPush } from "./push.ts";
import { autoArchive, catchUp, syncCycles } from "./tracker.ts";
import { startWebhooks } from "./webhooks.ts";

const sockets = new Map<number, Set<Bun.ServerWebSocket<SocketData>>>();

const publicDir = join(import.meta.dir, "..", "..", "public");
const iconsDir = join(publicDir, "icons");
const development = process.env.NODE_ENV !== "production";

// In development Bun serves the app itself, with hot reload; in production it's built once, so every file gets our headers.
const web = development
  ? { page: (await import("../web/index.html")).default, files: {} }
  : await webApp(join(import.meta.dir, "..", "web", "index.html"));
// App URLs carry the workspace (/acme/issue/BRD-1). The older paths stay so the app can redirect links made before.
const APP_PATHS = ["/", "/login", "/setup", "/settings/*", "/t/*", "/issue/*", "/docs", "/doc/*", "/:ws", "/:ws/*"];

const server = Bun.serve({
  port: Number(process.env.PORT ?? 7100),
  development,
  maxRequestBodySize: HARD_MAX_BODY,
  routes: {
    ...Object.fromEntries(APP_PATHS.map((path) => [path, web.page])),
    ...web.files,
    "/manifest.webmanifest": publicFile(publicDir, "manifest.webmanifest", { "Content-Type": "application/manifest+json" }),
    "/sw.js": publicFile(publicDir, "sw.js", { "Content-Type": "text/javascript", "Cache-Control": "no-cache" }),
    // One static route per file found at startup, so anything else under /icons is a plain 404.
    ...Object.fromEntries(
      readdirSync(iconsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map(({ name }) => [`/icons/${name}`, publicFile(iconsDir, name, { "Cache-Control": "public, max-age=31536000, immutable" })]),
    ),
    "/icons/*": (req: Request) => secure(req, new Response("Not found", { status: 404 })), // not the app shell of a workspace "icons"
    ...Object.fromEntries(SERVER_PATHS.map((path) => [path, route])),
  },
  fetch: route, // a plain 404, with the headers too
  websocket: {
    data: {} as SocketData,
    open(ws) {
      for (const t of ws.data.topics) ws.subscribe(t);
      sockets.set(ws.data.userId, (sockets.get(ws.data.userId) ?? new Set()).add(ws));
    },
    close(ws) {
      sockets.get(ws.data.userId)?.delete(ws);
    },
    message() {},
  },
});

catchUp();
setInterval(autoArchive, 60 * 60 * 1000);
setInterval(() => syncCycles(), 60 * 1000); // a cycle ends within a minute of midnight UTC

onChange((event, to) => {
  const message = JSON.stringify(event);
  for (const t of eventTopics(event, to)) server.publish(t, message);
});

// A socket only hears its workspaces as of when it opened, so any change to a user's access closes
// theirs (or just the one riding on a revoked session or key); clients reconnect with what's current.
onRevoke((r) => {
  for (const ws of sockets.get(r.userId) ?? []) if (revokes(r, ws.data)) ws.close(4401, "Signed out");
});

// Behind a proxy the listening address isn't where people open Docket; DOCKET_URL is (as for sign-in-link).
const publicUrl = (process.env.DOCKET_URL || server.url.href).replace(/\/+$/, "");
startWebhooks(publicUrl); // payload URLs point there too
startPush(publicUrl);
console.log(`Docket running at ${server.url}`);
if (needsSetup()) console.log(`Setup code: ${formatCode(setupCode)} (open ${publicUrl}/setup to create the first account)`);

import "./config.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type Actor, formatCode, heardTeams, needsSetup, onRevoke, purgeExpiredKeys, setupCode } from "./access.ts";
import { MAX_UPLOAD_BYTES, type ServerEvent } from "../shared/types.ts";
import { apiRoutes } from "./api.ts";
import { attachmentRoutes } from "./attachments.ts";
import { actorOf, authRoutes, guard } from "./auth.ts";
import { proxyChat } from "./chat.ts";
import { receive as receiveGitHub } from "./github.ts";
import { onChange } from "./db.ts";
import { HARD_MAX_BODY, http, publicFile, secure, webApp } from "./http.ts";
import { handleMcp } from "./mcp.ts";
import { startPush } from "./push.ts";
import { autoArchive, eventTeams, syncCycles } from "./tracker.ts";
import { startWebhooks } from "./webhooks.ts";

/** Whose credentials each socket rides on, so signing out, revoking or suspending closes it; and what it hears. */
interface SocketData {
  userId: number;
  sessionId: number | null;
  keyId: number | null;
  topics: string[];
}
const sockets = new Map<number, Set<Bun.ServerWebSocket<SocketData>>>();
// What isn't about a team (the workspace, members, views, workspace labels): everyone in the workspace.
const topic = (workspace: string) => `workspace:${workspace}`;
// Public teams' events: everyone in the workspace but guests, who hear only their teams.
const publicTopic = (workspace: string) => `public:${workspace}`;
// One team's events: a private team's members, and a public team's guests.
const teamTopic = (teamId: number) => `team:${teamId}`;
// Events for one user (their inbox, their subscriptions), per workspace: a key's socket hears only its own.
const userTopic = (userId: number, workspace: string) => `user:${userId}:${workspace}`;

/** A socket's topics as of when it opens; any change to what its user sees closes it (revokeAccess), and it reconnects. */
const topicsOf = (a: Actor) =>
  [...a.workspaces].flatMap(([workspace, role]) => [
    topic(workspace),
    userTopic(a.id, workspace),
    ...(role === "guest" ? [] : [publicTopic(workspace)]),
    ...heardTeams(a, workspace).map(teamTopic),
  ]);

/** Where a change goes: a team's to those who see it (see eventTeams), anything else to the whole workspace. */
function topicsFor(event: ServerEvent): string[] {
  const teams = eventTeams(event);
  if (teams === null) return [topic(event.workspace)];
  return [...new Set(teams.flatMap((t) => (t.private ? [teamTopic(t.id)] : [publicTopic(event.workspace), teamTopic(t.id)])))];
}

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
    ...(Object.fromEntries(Object.entries(authRoutes).map(([path, route]) => [path, http(route)])) as typeof authRoutes),
    ...(Object.fromEntries(Object.entries(apiRoutes).map(([path, route]) => [path, http(guard(route))])) as typeof apiRoutes),
    ...(Object.fromEntries(
      Object.entries(attachmentRoutes).map(([path, route]) => [path, http(guard(route), { maxBody: MAX_UPLOAD_BYTES })]),
    ) as typeof attachmentRoutes),
    // GitHub's webhook: public, signed with the workspace's secret; rate-limited per IP, since it takes no credential.
    "/api/github/:workspace": http({ POST: receiveGitHub }, { perIp: true }),
    "/mcp": http(guard(handleMcp, { mcp: true })),
    "/api/chat": http(guard(proxyChat)),
    "/api/chat/*": http(guard(proxyChat)),
    "/ws": http(
      guard((req: Request, server: Bun.Server<SocketData>) => {
        const a = actorOf(req);
        const data = { userId: a.id, sessionId: a.sessionId, keyId: a.keyId, topics: topicsOf(a) };
        return server.upgrade(req, { data }) ? undefined : new Response("Expected a WebSocket", { status: 400 });
      }),
    ),
  },
  // Anything unmatched: a plain 404, with the headers too.
  fetch: (req) => secure(req, new Response("Not found", { status: 404 })),
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

setInterval(purgeExpiredKeys, 60 * 60 * 1000);
setInterval(autoArchive, 60 * 60 * 1000);
setInterval(() => syncCycles(), 60 * 1000); // a cycle ends within a minute of midnight UTC

onChange((event, userId) => {
  const message = JSON.stringify(event);
  for (const t of userId === undefined ? topicsFor(event) : [userTopic(userId, event.workspace)]) server.publish(t, message);
});

// A socket only hears its workspaces as of when it opened, so any change to a user's access closes
// theirs (or just the one riding on a revoked session or key); clients reconnect with what's current.
onRevoke(({ userId, sessionId, keyId }) => {
  for (const ws of sockets.get(userId) ?? []) {
    const hit = sessionId !== undefined ? ws.data.sessionId === sessionId : keyId !== undefined ? ws.data.keyId === keyId : true;
    if (hit) ws.close(4401, "Signed out");
  }
});

// Behind a proxy the listening address isn't where people open Docket; DOCKET_URL is (as for sign-in-link).
const publicUrl = (process.env.DOCKET_URL || server.url.href).replace(/\/+$/, "");
startWebhooks(publicUrl); // payload URLs point there too
startPush(publicUrl);
console.log(`Docket running at ${server.url}`);
if (needsSetup()) console.log(`Setup code: ${formatCode(setupCode)} (open ${publicUrl}/setup to create the first account)`);

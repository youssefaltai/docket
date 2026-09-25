import "./config.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import index from "../web/index.html";
import { formatCode, needsSetup, onRevoke, setupCode } from "./access.ts";
import { apiRoutes } from "./api.ts";
import { actorOf, authRoutes, guard } from "./auth.ts";
import { onChange } from "./db.ts";
import { handleMcp } from "./mcp.ts";

/** Whose credentials each socket rides on, so signing out, revoking or suspending closes it. */
interface SocketData {
  userId: number;
  sessionId: number | null;
  keyId: number | null;
  workspaces: string[];
}
const sockets = new Map<number, Set<Bun.ServerWebSocket<SocketData>>>();
const topic = (workspace: string) => `workspace:${workspace}`;

const publicDir = join(import.meta.dir, "..", "..", "public");
const iconsDir = join(publicDir, "icons");

const server = Bun.serve({
  port: Number(process.env.PORT ?? 7100),
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,
    "/login": index,
    "/setup": index,
    "/settings/*": index,
    "/p/*": index,
    "/t/*": index,
    "/issue/*": index,
    "/docs": index,
    "/doc/*": index,
    "/manifest.webmanifest": () =>
      new Response(Bun.file(join(publicDir, "manifest.webmanifest")), {
        headers: { "Content-Type": "application/manifest+json" },
      }),
    "/sw.js": () =>
      new Response(Bun.file(join(publicDir, "sw.js")), {
        headers: { "Content-Type": "text/javascript", "Cache-Control": "no-cache" },
      }),
    // One static route per file found at startup, so anything else under /icons is a plain 404.
    ...Object.fromEntries(
      readdirSync(iconsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map(({ name }) => [
          `/icons/${name}`,
          () =>
            new Response(Bun.file(join(iconsDir, name)), {
              headers: { "Cache-Control": "public, max-age=31536000, immutable" },
            }),
        ]),
    ),
    ...authRoutes,
    ...(Object.fromEntries(Object.entries(apiRoutes).map(([path, route]) => [path, guard(route)])) as typeof apiRoutes),
    "/mcp": guard(handleMcp, { bearerOnly: true, readCheck: false }),
    "/ws": guard((req: Request, server: Bun.Server<SocketData>) => {
      const a = actorOf(req);
      const data = { userId: a.id, sessionId: a.sessionId, keyId: a.keyId, workspaces: [...a.workspaces.keys()] };
      return server.upgrade(req, { data }) ? undefined : new Response("Expected a WebSocket", { status: 400 });
    }),
  },
  websocket: {
    data: {} as SocketData,
    open(ws) {
      for (const workspace of ws.data.workspaces) ws.subscribe(topic(workspace));
      sockets.set(ws.data.userId, (sockets.get(ws.data.userId) ?? new Set()).add(ws));
    },
    close(ws) {
      sockets.get(ws.data.userId)?.delete(ws);
    },
    message() {},
  },
});

onChange((event) => server.publish(topic(event.workspace), JSON.stringify(event)));

// A socket only hears its workspaces as of when it opened, so any change to a user's access closes
// theirs (or just the one riding on a revoked session or key); clients reconnect with what's current.
onRevoke(({ userId, sessionId, keyId }) => {
  for (const ws of sockets.get(userId) ?? []) {
    const hit = sessionId !== undefined ? ws.data.sessionId === sessionId : keyId !== undefined ? ws.data.keyId === keyId : true;
    if (hit) ws.close(4401, "Signed out");
  }
});

console.log(`Docket running at ${server.url}`);
if (needsSetup()) console.log(`Setup code: ${formatCode(setupCode)} (open ${server.url}setup to create the first account)`);

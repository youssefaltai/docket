import "./config.ts";
import { join } from "node:path";
import index from "../web/index.html";
import { apiRoutes } from "./api.ts";
import { onChange } from "./db.ts";
import { handleMcp } from "./mcp.ts";

const TOPIC = "changes";
const publicDir = join(import.meta.dir, "..", "..", "public");
const iconsDir = join(publicDir, "icons");

const server = Bun.serve({
  port: Number(process.env.PORT ?? 7100),
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,
    "/p/*": index,
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
    "/icons/*": (req) => {
      const path = new URL(req.url).pathname.slice("/icons/".length);
      const filePath = join(iconsDir, path);
      if (!filePath.startsWith(iconsDir)) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(filePath), {
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      });
    },
    ...apiRoutes,
    "/mcp": handleMcp,
    "/ws": (req, server) => (server.upgrade(req) ? undefined : new Response("Expected a WebSocket", { status: 400 })),
  },
  websocket: {
    open(ws) {
      ws.subscribe(TOPIC);
    },
    message() {},
  },
});

onChange((event) => server.publish(TOPIC, JSON.stringify(event)));

console.log(`Docket running at ${server.url}`);

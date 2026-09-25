import "./config.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import index from "../web/index.html";
import { apiRoutes } from "./api.ts";
import { guard, login } from "./auth.ts";
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
    "/api/login": { POST: login },
    ...(Object.fromEntries(Object.entries(apiRoutes).map(([path, route]) => [path, guard(route)])) as typeof apiRoutes),
    "/mcp": guard(handleMcp),
    "/ws": guard((req: Request, server: Bun.Server<undefined>) =>
      server.upgrade(req) ? undefined : new Response("Expected a WebSocket", { status: 400 }),
    ),
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

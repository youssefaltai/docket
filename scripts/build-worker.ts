// Builds the web app for Workers Static Assets (wrangler.jsonc runs it): dist/ holds the page, its hashed files and
// public/, and a _headers file with the headers Bun's server sends (http.ts): the security headers everywhere,
// cache-forever on hashed files and icons, no-cache on the service worker.
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { secure } from "../src/server/http.ts";

if (process.env.DOCKET_SKIP_BUILD) process.exit(0); // the tests build once, then start many servers

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
const build = await Bun.build({ entrypoints: [join(root, "src/web/index.html")], outdir: dist, minify: true, splitting: true, publicPath: "/" });
if (!build.success) throw new AggregateError(build.logs, "Building the web app failed");
cpSync(join(root, "public"), dist, { recursive: true });

const rule = (path: string, headers: Iterable<[string, string]>) => `${path}\n${[...headers].map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`;
const forever = [["Cache-Control", "public, max-age=31536000, immutable"]] as [string, string][];
const hashed = build.outputs.map((o) => basename(o.path)).filter((name) => name !== "index.html");
writeFileSync(
  join(dist, "_headers"),
  [
    rule("/*", secure(new Request("https://docket/"), new Response()).headers),
    ...hashed.map((name) => rule(`/${name}`, forever)),
    rule("/icons/*", forever),
    rule("/sw.js", [["Cache-Control", "no-cache"]]),
    ...[...hashed, "manifest.webmanifest"].filter((name) => name.endsWith(".webmanifest")).map((name) => rule(`/${name}`, [["Content-Type", "application/manifest+json"]])),
  ].join(""),
);
console.log(`Built the web app into ${dist}: ${hashed.length} hashed files`);

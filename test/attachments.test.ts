// Attachments (DKT-24): uploads are private to a workspace, sniffed rather than trusted, served so nothing renders on
// Docket's origin but raster images, and reachable by agents over MCP (images as image content).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { startServer, type Caller, type TestServer } from "./server.ts";

const MB = 1024 * 1024;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3]);
const octet = { "Content-Type": "application/octet-stream" };

let s: TestServer;
let ana: Caller;
let bob: Caller; // in "side" only
beforeAll(async () => {
  s = await startServer();
  await s.user("ana");
  ana = s.as("ana", "cookie", "acme"); // she joins side later: the web app names the workspace
  expect((await s.api("POST", "/api/workspaces", { name: "Side", key: "side" })).status).toBe(201);
  bob = await s.user("bob", { workspace: "side" });
});
afterAll(() => s.stop());

const upload = (who: Caller, name: string, body: BodyInit, headers: Record<string, string> = octet) =>
  who.raw("POST", `/api/attachments?name=${encodeURIComponent(name)}`, { body, headers });

test("an uploaded PNG comes back as it went in, inline, with the security headers", async () => {
  const res = await upload(ana, "shot.png", PNG);
  expect(res.status).toBe(201);
  const a = res.body;
  expect(a).toMatchObject({ name: "shot.png", contentType: "image/png", size: PNG.length, uploader: { username: "ana", kind: "person" } });
  expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(a.url).toBe(`/api/attachments/${a.id}/shot.png`);

  const got = await ana.raw("GET", a.url);
  expect(got.status).toBe(200);
  expect(got.body).toEqual(PNG);
  const h = got.headers;
  expect(h.get("content-type")).toBe("image/png");
  expect(h.get("content-disposition")).toBe(`inline; filename="shot.png"; filename*=UTF-8''shot.png`);
  expect(h.get("x-content-type-options")).toBe("nosniff");
  expect(h.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(h.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(h.get("content-security-policy")).toContain("img-src 'self' data:;");
  expect(h.get("content-security-policy")).toContain("frame-ancestors 'none'");
  // The name in the URL is cosmetic; an agent's key in the workspace reads it too.
  expect((await ana.raw("GET", `/api/attachments/${a.id}/anything.html`)).body).toEqual(PNG);
  expect((await (await s.agent("reader")).raw("GET", a.url)).status).toBe(200);

  // Stored next to the database, under its id.
  const dir = join(dirname(s.databasePath), "attachments");
  expect(readFileSync(join(dir, a.id))).toEqual(Buffer.from(PNG));
});

test("the type is sniffed, never taken from the client: only raster images display, HTML and SVG never render", async () => {
  const cases: [string, BodyInit, string, string][] = [
    ["x.png", "<script>alert(1)</script>", "text/plain; charset=utf-8", "attachment"],
    ["logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', "text/plain; charset=utf-8", "attachment"],
    ["page.html", "<!doctype html><h1>hi</h1>", "text/plain; charset=utf-8", "attachment"],
    ["notes.txt", "héllo, مرحبا", "text/plain; charset=utf-8", "attachment"],
    ["blob.png", new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80]), "application/octet-stream", "attachment"],
    ["photo", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg", "inline"],
    ["anim.bin", "GIF89a....", "image/gif", "inline"],
    ["pic.webp", "RIFF\x04\x00\x00\x00WEBPVP8 ", "image/webp", "inline"],
    ["doc.pdf", "%PDF-1.7\n", "application/pdf", "attachment"],
  ];
  for (const [name, body, type, disposition] of cases) {
    const up = await upload(ana, name, body);
    expect([name, up.status, up.body.contentType]).toEqual([name, 201, type]);
    const got = await ana.raw("GET", up.body.url);
    expect([name, got.headers.get("content-type"), got.headers.get("content-disposition")?.split(";")[0]]).toEqual([name, type, disposition]);
  }
});

test("names are cleaned, and the URL and download name stay safe", async () => {
  const weird = await upload(ana, '../../etc/pa"ss‮gnp.exe (1)\n.txt', "x");
  expect(weird.body.name).toBe("....etcpassgnp.exe (1).txt");
  expect(weird.body.url).toBe(`/api/attachments/${weird.body.id}/....etcpassgnp.exe%20%281%29.txt`);
  expect((await upload(ana, "   ", "x")).body.name).toBe("file");
  expect((await upload(ana, "x".repeat(300), "x")).body.name).toHaveLength(200);
  const arabic = await upload(ana, "تقرير.txt", "x");
  expect((await ana.raw("GET", arabic.body.url)).headers.get("content-disposition")).toBe(
    `attachment; filename="_____.txt"; filename*=UTF-8''${encodeURIComponent("تقرير")}.txt`,
  );
});

test("uploads are refused: too big, empty, not octet-stream, cross-site, read-only, outside your workspace", async () => {
  const big = await upload(ana, "big.bin", new Uint8Array(10 * MB + 1));
  expect([big.status, big.body.error]).toEqual([413, "Request body too large (at most 10 MB)"]);
  // Without a Content-Length (streamed), the handler counts.
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 11; i++) c.enqueue(new Uint8Array(MB - 1));
      c.close();
    },
  });
  expect((await upload(ana, "big.bin", stream)).status).toBe(413);
  expect((await upload(ana, "ten.bin", new Uint8Array(10 * MB))).status).toBe(201); // right at the limit
  expect((await upload(ana, "empty.txt", new Uint8Array(0))).status).toBe(400);

  for (const type of ["application/json", "multipart/form-data; boundary=x", "text/plain", "text/plain;charset=application/octet-stream"]) {
    expect([type, (await upload(ana, "x.txt", "x", { "Content-Type": type })).status]).toEqual([type, 415]);
  }
  expect((await upload(ana, "x.txt", new Blob(["x"]), {})).status).toBe(415); // no Content-Type
  expect((await upload(ana, "x.txt", "x", { ...octet, Origin: "http://evil.example" })).status).toBe(403);
  const ro = s.with({ token: (await ana.api("POST", "/api/api-keys", { name: "ro", scope: "read" })).body.token });
  expect((await upload(ro, "x.txt", "x")).status).toBe(403);
  expect((await upload(s.anon, "x.txt", "x")).status).toBe(401);
  expect((await upload(ana, "x.txt", "x", { ...octet, "X-Docket-Workspace": "side" })).status).toBe(404);
  expect((await upload(ana, "x.txt", "x", { ...octet, "X-Docket-Workspace": "nope" })).status).toBe(404);
});

test("files are served only to active members of their workspace", async () => {
  const a = (await upload(ana, "secret.txt", "acme only")).body;
  expect((await bob.raw("GET", a.url)).status).toBe(404); // a member of another workspace
  expect((await s.as("bob", "bearer").raw("GET", a.url)).status).toBe(404);
  expect((await s.anon.raw("GET", a.url)).status).toBe(401);
  expect((await ana.raw("GET", "/api/attachments/AAAAAAAAAAAAAAAAAAAAAA/x.txt")).status).toBe(404);
  expect((await ana.raw("GET", `/api/attachments/${a.id}x/x.txt`)).status).toBe(404);

  // ana's key for side (she joins it) acts only there; bob's upload in side is not acme's.
  await s.user("ana", { workspace: "side" });
  expect((await s.as("ana", "bearer", "side").raw("GET", a.url)).status).toBe(404);
  const b = (await upload(bob, "side.txt", "side only")).body;
  expect((await s.as("ana", "bearer", "acme").raw("GET", b.url)).status).toBe(404);
  expect((await s.as("ana", "bearer", "side").raw("GET", b.url)).status).toBe(200);

  // Suspension ends access at once.
  const carl = await s.user("carl");
  expect((await carl.raw("GET", a.url)).status).toBe(200);
  await s.api("PATCH", `/api/workspaces/${s.workspace}/members/carl`, { suspended: true });
  expect((await carl.raw("GET", a.url)).status).not.toBe(200);
});

test("no path, however encoded, reaches a file outside the attachments folder", async () => {
  const raw = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(s.url);
      const r = request({ host: u.hostname, port: u.port, path, headers: { Cookie: ana.cookie! } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      r.on("error", reject);
      r.end();
    });
  const attempts = [
    "/api/attachments/%2e%2e/x",
    "/api/attachments/%2e%2e/docket.db",
    "/api/attachments/../docket.db",
    "/api/attachments/..%2fdocket.db/x",
    "/api/attachments/..%2Fdocket.db/x",
    "/api/attachments/..%5cdocket.db/x",
    "/api/attachments/%252e%252e/docket.db",
    "/api/attachments/..%2f..%2f..%2fetc%2fpasswd/x",
    "/api/attachments/docket.db/x",
    `/api/attachments/${"."}${"a".repeat(21)}/x`,
  ];
  for (const path of attempts) {
    const res = await raw(path);
    expect([path, res.status]).toEqual([path, 404]);
    expect(res.body).not.toContain("SQLite");
  }
  // And only files Docket wrote are there: one per row.
  const dir = join(dirname(s.databasePath), "attachments");
  expect(existsSync(dir)).toBeTrue();
  expect(readdirSync(dir).every((f) => /^[A-Za-z0-9_-]{22}$/.test(f))).toBeTrue();
});

test("MCP: agents attach text or base64 files and read them back, images as image content", async () => {
  const claude = await s.agent("claude");
  const md = await claude.tool("attach_file", { name: "build.log", text: "line 1\nline 2" });
  expect(md).toMatch(/^\[build\.log\]\(\/api\/attachments\/[A-Za-z0-9_-]{22}\/build\.log\)$/);
  const url = md.slice(md.indexOf("(") + 1, -1);
  const read = await claude.tool("get_attachment", { url });
  expect(read).toContain("build.log · text/plain; charset=utf-8 · 13 bytes · by @claude");
  expect(read).toEndWith("line 1\nline 2");
  expect(await claude.tool("get_attachment", { url: new URL(url, s.url).href })).toContain("line 2"); // a full URL works too

  const png = await claude.toolResult("attach_file", { name: "shot.png", base64: Buffer.from(PNG).toString("base64") });
  expect(png.content[0].text).toStartWith("![shot.png](/api/attachments/");
  expect(png.structuredContent.attachment.contentType).toBe("image/png");
  const seen = await claude.toolResult("get_attachment", { url: png.structuredContent.attachment.url });
  expect(seen.content[1]).toEqual({ type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" });

  // A long text is cut, and says so.
  const long = await claude.tool("attach_file", { name: "big.log", text: "y".repeat(150_000) });
  expect(await claude.tool("get_attachment", { url: long.slice(long.indexOf("(") + 1, -1) })).toContain("cut: showing the first 100000 of 150000");

  // A person's upload over REST reads over MCP; nothing leaks to a non-member.
  const ours = (await upload(ana, "notes.txt", "hello")).body;
  expect(await claude.tool("get_attachment", { url: ours.url })).toContain("hello");
  const outsider = await s.agent("outsider", { workspace: "side" });
  await expect(outsider.tool("get_attachment", { url: ours.url })).rejects.toThrow("Attachment not found");

  await expect(claude.tool("attach_file", { name: "x" })).rejects.toThrow("exactly one of text or base64");
  await expect(claude.tool("attach_file", { name: "x", text: "a", base64: "YQ==" })).rejects.toThrow("exactly one of text or base64");
  await expect(claude.tool("attach_file", { name: "x", base64: "not base64!" })).rejects.toThrow("isn't valid base64");
  await expect(claude.tool("attach_file", { name: "x", text: "" })).rejects.toThrow("empty");
});

test("markdown loads no remote image: the page's CSP allows only our own images", async () => {
  const csp = (await fetch(s.url)).headers.get("content-security-policy")!;
  const img = csp.split("; ").find((d) => d.startsWith("img-src"));
  expect(img).toBe("img-src 'self' data:");
});

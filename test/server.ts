// Runs a real Docket server in a subprocess against a throwaway database, so tests only see HTTP.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const entry = join(import.meta.dir, "..", "src", "server", "index.ts");

export interface TestServer {
  url: string;
  dir: string;
  /** JSON request against /api; resolves to `{ status, body }`. */
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  /** Calls an MCP tool and returns its text output. */
  tool: (name: string, args?: Record<string, unknown>) => Promise<string>;
  stop: () => Promise<void>;
}

/** Starts Docket on a free port. Pass `databasePath` to open an existing file, `env` for extra variables. */
export async function startServer(
  opts: { databasePath?: string; env?: Record<string, string> } = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "docket-test-"));
  const proc = Bun.spawn(["bun", entry], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      XDG_CONFIG_HOME: dir, // never pick up the developer's real config file
      XDG_CONFIG_DIRS: dir,
      NODE_ENV: "production",
      PORT: "0",
      DATABASE_PATH: opts.databasePath ?? join(dir, "docket.db"),
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "inherit",
  });

  const url = await readUrl(proc.stdout);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.env?.DOCKET_TOKEN) headers.Authorization = `Bearer ${opts.env.DOCKET_TOKEN}`;

  const mcp = new Client({ name: "docket-test", version: "0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers } }));

  return {
    url,
    dir,
    async api(method, path, body) {
      const res = await fetch(new URL(path, url), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
    },
    async tool(name, args = {}) {
      const result = (await mcp.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
      const text = result.content.map((c) => c.text).join("\n");
      if (result.isError) throw new Error(text);
      return text;
    },
    async stop() {
      await mcp.close();
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function readUrl(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) {
    out += decoder.decode(chunk);
    const match = out.match(/Docket running at (\S+)/);
    if (match) return match[1]!.replace("://[::]", "://localhost").replace("://0.0.0.0", "://localhost");
  }
  throw new Error(`Server exited before it was ready:\n${out}`);
}

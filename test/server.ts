// Runs a real Docket server in a subprocess against a throwaway database, so tests only see HTTP.
// Tests authenticate only through s.as / s.user / s.agent / s.anon, so an auth redesign touches this file alone.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = join(import.meta.dir, "..");
const entry = join(root, "src", "server", "index.ts");
export const SETUP_CODE = "TESTS-SETUP";

export type Via = "bearer" | "cookie";
export type Reply = { status: number; body: any; headers: Headers };

/** One caller: a signed-in user (an API key, plus a session cookie for people), or nobody. */
export interface Caller {
  username: string | null;
  token?: string;
  cookie?: string;
  /** JSON request; resolves to `{ status, body, headers }`. */
  api: (method: string, path: string, body?: unknown) => Promise<Reply>;
  /** Calls an MCP tool and returns its text output; throws on a tool error. */
  tool: (name: string, args?: Record<string, unknown>) => Promise<string>;
  /** Opens /ws with this caller's credentials. */
  ws: () => Socket;
}

/** A /ws connection: `opened` is false if it closes before opening; `events` collects parsed messages. */
export interface Socket {
  opened: Promise<boolean>;
  closed: Promise<number>;
  events: any[];
  /** Resolves once some event matches, or rejects after `ms`. */
  until: (match: (event: any) => boolean, ms?: number) => Promise<any>;
  close: () => void;
}

export interface TestServer {
  url: string;
  dir: string;
  databasePath: string;
  /** The workspace setup created ("acme"), or null with `setup: false`. */
  workspace: string | null;
  /** The setup admin; `s.api` and `s.tool` are shorthands for it. */
  admin: Caller;
  api: Caller["api"];
  tool: Caller["tool"];
  anon: Caller;
  /** Arbitrary credentials, for tests of forged, stale or revoked ones. */
  with: (creds: Creds, via?: Via) => Caller;
  /** A user made earlier by s.user or s.agent, here or on a server this one shares with. */
  as: (username: string, via?: Via) => Caller;
  /** Invites a person into a workspace (default: setup's) and signs them in. For an existing user it adds the workspace. */
  user: (username: string, opts?: { role?: "admin" | "member"; workspace?: string; name?: string }) => Promise<Caller>;
  /** Signs a person in again through an admin's sign-in link, with a fresh session and API key (e.g. after a suspension). */
  signIn: (username: string, opts?: { workspace?: string }) => Promise<Caller>;
  /** Creates an agent in a workspace (default: setup's). */
  agent: (username: string, opts?: { workspace?: string; name?: string }) => Promise<Caller>;
  /** Runs `bun run <script> ...args` with this server's environment and database. */
  cli: (script: string, ...args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  stop: () => Promise<void>;
}

export type Creds = { token?: string; cookie?: string };
type Internal = TestServer & { users: Map<string, Creds> };

/**
 * Starts Docket on a free port and runs setup as "admin" with workspace "acme".
 * `setup: false` leaves it unset; `sharing: other` opens other's database and knows other's users.
 */
export async function startServer(
  opts: { setup?: boolean; sharing?: TestServer; env?: Record<string, string> } = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "docket-test-"));
  const databasePath = opts.sharing?.databasePath ?? join(dir, "docket.db");
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: dir,
    XDG_CONFIG_HOME: dir, // never pick up the developer's real config file
    XDG_CONFIG_DIRS: dir,
    NODE_ENV: "production",
    PORT: "0",
    DATABASE_PATH: databasePath,
    DOCKET_SETUP_CODE: SETUP_CODE,
    ...opts.env,
  };
  const proc = Bun.spawn(["bun", entry], { env, stdout: "pipe", stderr: "inherit" });
  const url = await readUrl(proc.stdout);

  const users: Map<string, Creds> = (opts.sharing as Internal | undefined)?.users ?? new Map();
  const mcps: Client[] = [];

  function caller(username: string | null, creds: Creds, via: Via): Caller {
    const auth: Record<string, string> = {};
    if (via === "bearer" && creds.token) auth.Authorization = `Bearer ${creds.token}`;
    if (via === "cookie" && creds.cookie) auth.Cookie = creds.cookie;
    let mcp: Promise<Client> | undefined;
    return {
      username,
      ...creds,
      async api(method, path, body) {
        const res = await fetch(new URL(path, url), {
          method,
          headers: { "Content-Type": "application/json", ...auth },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await parse(res), headers: res.headers };
      },
      async tool(name, args = {}) {
        mcp ??= (async () => {
          const client = new Client({ name: "docket-test", version: "0" });
          const headers: Record<string, string> = creds.token ? { Authorization: `Bearer ${creds.token}` } : {};
          await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers } }));
          mcps.push(client);
          return client;
        })();
        const result = (await (await mcp).callTool({ name, arguments: args })) as {
          content: { type: string; text: string }[];
          isError?: boolean;
        };
        const text = result.content.map((c) => c.text).join("\n");
        if (result.isError) throw new Error(text);
        return text;
      },
      ws() {
        return socket(new WebSocket(new URL("/ws", url.replace(/^http/, "ws")), { headers: { Origin: url, ...auth } } as never));
      },
    };
  }

  const anon = caller(null, {}, "bearer");

  /** Records a signed-in person, minting an API key the first time. */
  async function signedIn(username: string, cookie: string, fresh = false): Promise<Caller> {
    let token = fresh ? undefined : users.get(username)?.token;
    if (!token) {
      const key = await caller(username, { cookie }, "cookie").api("POST", "/api/api-keys", { name: "tests" });
      if (key.status !== 201) throw new Error(`api key for ${username}: ${key.status} ${JSON.stringify(key.body)}`);
      token = key.body.token as string;
    }
    users.set(username, { token, cookie });
    return caller(username, { token, cookie }, "bearer");
  }

  let workspace = opts.sharing?.workspace ?? null;
  if (opts.setup !== false && !opts.sharing) {
    const res = await anon.api("POST", "/api/setup", {
      code: SETUP_CODE,
      email: "admin@example.com",
      name: "Admin",
      username: "admin",
      workspace: { name: "Acme", key: "acme" },
    });
    if (res.status !== 201) throw new Error(`setup: ${res.status} ${JSON.stringify(res.body)}`);
    await signedIn("admin", sessionCookie(res.headers));
    workspace = "acme";
  }

  const as = (username: string, via: Via = "bearer") => {
    const creds = users.get(username);
    if (!creds) throw new Error(`no test user "${username}"; make it with s.user or s.agent first`);
    return caller(username, creds, via);
  };
  const admin = users.has("admin") ? as("admin") : anon;

  const server: Internal = {
    url,
    dir,
    databasePath,
    workspace,
    users,
    admin,
    api: admin.api,
    tool: admin.tool,
    anon,
    with: (creds, via = "bearer") => caller(null, creds, via),
    as,
    async user(username, { role = "member", workspace: key = workspace!, name = username } = {}) {
      const invite = await admin.api("POST", `/api/workspaces/${key}/invites`, { email: `${username}@example.com`, role });
      if (invite.status >= 300) throw new Error(`invite ${username}: ${invite.status} ${JSON.stringify(invite.body)}`);
      const profile = users.has(username) ? {} : { name, username };
      const redeemed = await anon.api("POST", "/api/auth/redeem", { code: invite.body.code, ...profile });
      if (redeemed.status >= 300) throw new Error(`redeem ${username}: ${redeemed.status} ${JSON.stringify(redeemed.body)}`);
      return signedIn(username, sessionCookie(redeemed.headers));
    },
    async signIn(username, { workspace: key = workspace! } = {}) {
      const link = await admin.api("POST", `/api/workspaces/${key}/members/${username}/sign-in-links`);
      if (link.status !== 201) throw new Error(`sign-in link for ${username}: ${link.status} ${JSON.stringify(link.body)}`);
      const redeemed = await anon.api("POST", "/api/auth/redeem", { code: link.body.code });
      if (redeemed.status !== 200) throw new Error(`redeem ${username}: ${redeemed.status} ${JSON.stringify(redeemed.body)}`);
      return signedIn(username, sessionCookie(redeemed.headers), true);
    },
    async agent(username, { workspace: key = workspace!, name = username } = {}) {
      const res = await admin.api("POST", `/api/workspaces/${key}/agents`, { name, username });
      if (res.status !== 201) throw new Error(`agent ${username}: ${res.status} ${JSON.stringify(res.body)}`);
      users.set(username, { token: res.body.token });
      return as(username);
    },
    async cli(script, ...args) {
      const p = Bun.spawn(["bun", "run", script, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { exitCode, stdout, stderr };
    },
    async stop() {
      await Promise.all(mcps.map((c) => c.close()));
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return server;
}

function socket(ws: WebSocket): Socket {
  const events: any[] = [];
  ws.onmessage = (e) => events.push(JSON.parse(String(e.data)));
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
  const opened = Promise.race([new Promise<boolean>((resolve) => ws.addEventListener("open", () => resolve(true))), closed.then(() => false)]);
  return {
    opened,
    closed,
    events,
    async until(match, ms = 2000) {
      // Poll rather than sleep a fixed time, so a busy machine can't make a test flaky.
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) {
        const hit = events.find(match);
        if (hit) return hit;
      }
      throw new Error(`no matching event in ${ms}ms; got ${JSON.stringify(events)}`);
    },
    close: () => ws.close(),
  };
}

/** The `docket_session=…` pair from a response's Set-Cookie. */
export function sessionCookie(headers: Headers): string {
  const cookie = headers.getSetCookie().find((c) => c.startsWith("docket_session="));
  if (!cookie) throw new Error("no docket_session cookie");
  return cookie.split(";")[0]!;
}

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  return text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
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

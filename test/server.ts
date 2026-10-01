// Runs a real Docket server in a subprocess against a throwaway database, so tests only see HTTP. With DOCKET_TEST_WORKER=1
// it's the Workers build instead (wrangler dev: workerd, a local Durable Object and R2), one per server.
// Tests authenticate only through s.as / s.user / s.agent / s.anon, so an auth redesign touches this file alone.
// MCP goes through the real SDK client, bearer only: a caller's tool(), tools() (what tools/list shows), instructions() and server().
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = join(import.meta.dir, "..");
const entry = join(root, "src", "server", "index.ts");
export const SETUP_CODE = "TESTS-SETUP";
export const WORKER = process.env.DOCKET_TEST_WORKER === "1";

export type Via = "bearer" | "cookie";
export type Reply = { status: number; body: any; headers: Headers };

/** One caller: a signed-in user (an API key, plus a session cookie for people), or nobody. */
export interface Caller {
  username: string | null;
  token?: string;
  cookie?: string;
  /** JSON request, with optional extra headers (e.g. X-Docket-Workspace); resolves to `{ status, body, headers }`. */
  api: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Reply>;
  /** A request with this caller's credentials and our Origin, but no JSON: the body and headers as given (uploads). The reply's body is JSON or bytes. */
  raw: (method: string, path: string, opts?: { body?: BodyInit; headers?: Record<string, string> }) => Promise<Reply>;
  /** Calls an MCP tool and returns its text output; throws on a tool error. */
  tool: (name: string, args?: Record<string, unknown>) => Promise<string>;
  /** Calls an MCP tool and returns its whole result (content of any type, structuredContent, isError). */
  toolResult: (name: string, args?: Record<string, unknown>) => Promise<{ content: any[]; structuredContent?: any; isError?: boolean }>;
  /** The MCP tool names this caller sees in tools/list, sorted. */
  tools: () => Promise<string[]>;
  /** The MCP server's instructions for this caller. */
  instructions: () => Promise<string | undefined>;
  /** Who the MCP server says it is (its `initialize` answer): serverInfo plus instructions. */
  server: () => Promise<{ name: string; title?: string; websiteUrl?: string; instructions?: string }>;
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
  /** The setup admin (cookie for REST, key for MCP), in setup's workspace; `s.api` and `s.tool` are shorthands for it. */
  admin: Caller;
  api: Caller["api"];
  tool: Caller["tool"];
  anon: Caller;
  /** Arbitrary credentials, for tests of forged, stale or revoked ones. */
  with: (creds: Creds, via?: Via) => Caller;
  /**
   * A user made earlier by s.user or s.agent (by its label), here or on a server this one shares with. People default to their cookie,
   * agents to their key. Keys act in one workspace: `workspace` picks that one's key (default: the workspace they joined first).
   * On cookie requests, `workspace` is sent as X-Docket-Workspace, as the web app does (a session in several needs it).
   */
  as: (label: string, via?: Via, workspace?: string) => Caller;
  /**
   * Invites a person into a workspace (default: setup's, invited by `by`, default admin) as `handle` and signs them in. `as` labels
   * the test user (default: the handle), so the same handle can be a different person elsewhere. For an existing test user it adds
   * the workspace, and a key for it: they join as their usual profile unless `username` or `name` says otherwise. `teams`: the invite's (a guest's need one).
   */
  user: (
    handle: string,
    opts?: { role?: "admin" | "member" | "guest"; teams?: string[]; workspace?: string; name?: string; username?: string; by?: string; as?: string },
  ) => Promise<Caller>;
  /** Signs a person in again through the server's sign-in-link CLI (`handle [workspace]`), with a fresh session and API keys; labels them `handle`. */
  signIn: (handle: string, workspace?: string) => Promise<Caller>;
  /** Creates an agent in a workspace (default: setup's) as `handle`; `as` labels it (default: the handle). */
  agent: (handle: string, opts?: { workspace?: string; name?: string; as?: string }) => Promise<Caller>;
  /** Runs SQL on this server's database (a fresh connection each time), for what a test can't reach over HTTP: the rows. */
  sql: (query: string, ...params: (string | number)[]) => any[];
  /** Runs `bun run <script> ...args` with this server's environment and database. */
  cli: (script: string, ...args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  stop: () => Promise<void>;
}

type Creds = { token?: string; cookie?: string };
/** A test user's session cookie (people) and one API key per workspace, in the order they joined. */
type Known = { cookie?: string; keys: Map<string, string> };
type Internal = TestServer & { users: Map<string, Known> };

/**
 * Starts Docket on a free port and runs setup as "admin" with workspace "acme".
 * `setup: false` leaves it unset; `sharing: other` opens other's database and knows other's users.
 */
export async function startServer(
  opts: { setup?: boolean; sharing?: TestServer; env?: Record<string, string> } = {},
): Promise<TestServer> {
  if (WORKER && opts.sharing) return { ...opts.sharing, stop: async () => {} }; // one Durable Object: there's no second process
  const dir = mkdtempSync(join(tmpdir(), "docket-test-"));
  let databasePath = opts.sharing?.databasePath ?? join(dir, "docket.db");
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: dir,
    NODE_ENV: "production",
    PORT: "0",
    DATABASE_PATH: databasePath,
    DOCKET_SETUP_CODE: SETUP_CODE,
    ...opts.env,
  };
  const proc = WORKER ? await wranglerDev(dir, env) : Bun.spawn(["bun", entry], { env, stdout: "pipe", stderr: "inherit" });
  const url = await readUrl(proc.stdout);
  // The Durable Object's SQLite file, once its first request made it; the CLI opens it as it is.
  const db = () => {
    if (!WORKER || existsSync(databasePath)) return databasePath;
    const objects = join(dir, "state", "v3", "do", "docket-Docket");
    const file = readdirSync(objects).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
    return (databasePath = env.DATABASE_PATH = join(objects, file!));
  };

  const users: Map<string, Known> = (opts.sharing as Internal | undefined)?.users ?? new Map();
  const mcps: Client[] = [];

  function caller(username: string | null, creds: Creds, via: Via, workspace?: string): Caller {
    const auth: Record<string, string> = {};
    if (via === "bearer" && creds.token) auth.Authorization = `Bearer ${creds.token}`;
    if (via === "cookie" && creds.cookie) auth.Cookie = creds.cookie;
    if (via === "cookie" && workspace) auth["X-Docket-Workspace"] = workspace;
    let mcp: Promise<Client> | undefined;
    // One MCP client per caller, connected on first use.
    const client = () =>
      (mcp ??= (async () => {
        const client = new Client({ name: "docket-test", version: "0" });
        const headers: Record<string, string> = creds.token ? { Authorization: `Bearer ${creds.token}` } : {};
        await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers } }));
        mcps.push(client);
        return client;
      })());
    return {
      username,
      ...creds,
      async api(method, path, body, headers = {}) {
        const res = await fetch(new URL(path, url), {
          method,
          headers: { "Content-Type": "application/json", Origin: new URL(url).origin, ...auth, ...headers }, // browsers send Origin
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await parse(res), headers: res.headers };
      },
      async raw(method, path, { body, headers = {} } = {}) {
        const res = await fetch(new URL(path, url), { method, headers: { Origin: new URL(url).origin, ...auth, ...headers }, body });
        const json = res.headers.get("content-type")?.includes("json");
        return { status: res.status, body: json ? await res.json() : new Uint8Array(await res.arrayBuffer()), headers: res.headers };
      },
      async toolResult(name, args = {}) {
        return (await (await client()).callTool({ name, arguments: args })) as never;
      },
      async tool(name, args = {}) {
        const result = (await (await client()).callTool({ name, arguments: args })) as {
          content: { type: string; text: string }[];
          isError?: boolean;
        };
        const text = result.content.map((c) => c.text).join("\n");
        if (result.isError) throw new Error(text);
        return text;
      },
      async tools() {
        return (await (await client()).listTools()).tools.map((t) => t.name).sort();
      },
      async instructions() {
        return (await client()).getInstructions();
      },
      async server() {
        const c = await client();
        return { ...c.getServerVersion()!, instructions: c.getInstructions() };
      },
      ws() {
        return socket(new WebSocket(new URL("/ws", url.replace(/^http/, "ws")), { headers: { Origin: url, ...auth } } as never));
      },
    };
  }

  const anon = caller(null, {}, "bearer");

  /** Records a signed-in person, minting an API key for each of `workspaces` they have none in yet. */
  async function signedIn(username: string, cookie: string, workspaces: string[], fresh = false): Promise<Caller> {
    const keys = fresh ? new Map<string, string>() : (users.get(username)?.keys ?? new Map<string, string>());
    for (const workspace of workspaces) {
      if (keys.has(workspace)) continue;
      const key = await caller(username, { cookie }, "cookie").api("POST", "/api/api-keys", { name: "tests", workspace });
      if (key.status !== 201) throw new Error(`api key for ${username} in ${workspace}: ${key.status} ${JSON.stringify(key.body)}`);
      keys.set(workspace, key.body.token as string);
    }
    users.set(username, { cookie, keys });
    return as(username);
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
    await signedIn("admin", sessionCookie(res.headers), ["acme"]);
    workspace = "acme";
  }

  // People act through their browser session, agents through their key, as in real use.
  function as(username: string, via?: Via, workspace?: string): Caller {
    const known = users.get(username);
    if (!known) throw new Error(`no test user "${username}"; make it with s.user or s.agent first`);
    const how = via ?? (known.cookie ? "cookie" : "bearer");
    const token = workspace ? known.keys.get(workspace) : known.keys.values().next().value;
    if (workspace && !token && how === "bearer") throw new Error(`test user "${username}" has no key in ${workspace}`);
    return caller(username, { token, cookie: known.cookie }, how, workspace);
  }
  // The admin acts in setup's workspace, as the web app would there (they may join others).
  const admin = users.has("admin") ? as("admin", undefined, workspace ?? undefined) : anon;

  const server: Internal = {
    url,
    dir,
    get databasePath() {
      return db();
    },
    workspace,
    users,
    admin,
    api: admin.api,
    tool: admin.tool,
    anon,
    with: (creds, via = "bearer") => caller(null, creds, via),
    as,
    async user(handle, { role = "member", teams, workspace: key = workspace!, name, username, by = "admin", as: label = handle } = {}) {
      const invite = await as(by).api("POST", `/api/workspaces/${key}/invites`, { role, teams });
      if (invite.status >= 300) throw new Error(`invite ${label}: ${invite.status} ${JSON.stringify(invite.body)}`);
      // An existing user accepts while signed in (as their usual profile unless told otherwise); a new one creates an account.
      const known = users.get(label);
      const redeemed = known
        ? await caller(label, { cookie: known.cookie }, "cookie").api("POST", "/api/auth/redeem", { code: invite.body.code, name, username })
        : await anon.api("POST", "/api/auth/redeem", { code: invite.body.code, name: name ?? handle, username: username ?? handle });
      if (redeemed.status >= 300) throw new Error(`redeem ${label}: ${redeemed.status} ${JSON.stringify(redeemed.body)}`);
      const fresh = redeemed.headers.getSetCookie().some((c) => c.startsWith("docket_session="));
      return signedIn(label, fresh ? sessionCookie(redeemed.headers) : known!.cookie!, [key]);
    },
    // Signs someone in afresh the only way that doesn't need their own session: the server's recovery CLI.
    async signIn(handle, key) {
      const out = await server.cli("sign-in-link", handle, ...(key ? [key] : []));
      const code = out.stdout.match(/\/login#(\S+)/)?.[1];
      if (out.exitCode !== 0 || !code) throw new Error(`sign-in-link ${handle}: ${out.exitCode} ${out.stderr}`);
      const redeemed = await anon.api("POST", "/api/auth/redeem", { code });
      if (redeemed.status !== 200) throw new Error(`redeem ${handle}: ${redeemed.status} ${JSON.stringify(redeemed.body)}`);
      const cookie = sessionCookie(redeemed.headers);
      const me = await caller(handle, { cookie }, "cookie").api("GET", "/api/me");
      return signedIn(handle, cookie, me.body.workspaces.map((w: { key: string }) => w.key), true);
    },
    async agent(handle, { workspace: key = workspace!, name = handle, as: label = handle } = {}) {
      const res = await admin.api("POST", `/api/workspaces/${key}/agents`, { name, username: handle });
      if (res.status !== 201) throw new Error(`agent ${label}: ${res.status} ${JSON.stringify(res.body)}`);
      users.set(label, { keys: new Map([[key, res.body.token as string]]) });
      return as(label);
    },
    async cli(script, ...args) {
      db();
      const p = Bun.spawn(["bun", "run", script, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { exitCode, stdout, stderr };
    },
    sql(query, ...params) {
      const sqlite = new Database(db());
      sqlite.run("PRAGMA busy_timeout = 5000"); // the server may be writing in the background
      try {
        return sqlite.query(query).all(...params) as any[];
      } finally {
        sqlite.close();
      }
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

/** wrangler dev on free ports, its state in `dir`, `env` as its vars; the web app is built once per test run. */
async function wranglerDev(dir: string, env: Record<string, string | undefined>) {
  await (built ??= Bun.spawn(["bun", join(root, "scripts", "build-worker.ts")], { stdout: "ignore", stderr: "inherit" }).exited);
  const vars = Object.entries(env).flatMap(([k, v]) => (k.startsWith("DOCKET_") && v !== undefined ? ["--var", `${k}:${v}`] : []));
  const ports = [freePort(), freePort()].map(String);
  const args = ["dev", "--port", ports[0]!, "--inspector-port", ports[1]!, "--persist-to", join(dir, "state"), "--show-interactive-dev-session=false", ...vars];
  return Bun.spawn([join(root, "node_modules", ".bin", "wrangler"), ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKET_SKIP_BUILD: "1" },
    stdout: "pipe",
    stderr: "inherit",
  });
}
let built: Promise<number> | undefined;

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

async function readUrl(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) {
    out += decoder.decode(chunk);
    const match = out.match(/(?:Docket running at|Ready on) (\S+)/);
    if (match) return match[1]!.replace("://[::]", "://localhost").replace("://0.0.0.0", "://localhost");
  }
  throw new Error(`Server exited before it was ready:\n${out}`);
}

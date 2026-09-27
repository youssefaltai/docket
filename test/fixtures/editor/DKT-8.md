Blocked by DKT-4: once every key belongs to one workspace, "this connection's workspace" is well defined.

## Why

Settings shows `claude mcp add --transport http --scope user docket <origin>/mcp --header …` for every key and agent token.

- The name is always `docket` and the scope is always `user`. So connecting a second workspace's agent overwrites or clashes with the first (`docket` already exists), and every project on the machine gets whichever was added last.
- The server calls itself `docket` and its instructions don't say where it is, so an agent holding two Docket connections (this session has `docket` and `docket-ws`) can't tell which instance or workspace a tool acts on.

## Linear's behaviour

- Linear's documented command is `claude mcp add --transport http linear-server https://mcp.linear.app/mcp`, with Claude Code's default (local) scope, not `--scope user`.
- With several workspaces, "each workspace needs its own separate authentication context" ([MCP](https://linear.app/docs/mcp)).

**Deliberate difference:** Docket's credential is a per-workspace token, so each workspace is simply a separately named server. Its name comes from the workspace, not a fixed `linear-server`.

## Where things are today

- `src/web/settings.tsx:65-66`: `mcpCommand(token)` hardcodes `--scope user docket`.
- `src/web/settings.tsx:310-314`: used for new API keys (copy "MCP command").
- `src/web/settings.tsx:470-479`: used for agents (`showToken`: the lead "Connect <name> with this command.", plus the command and token copies).
- `src/server/mcp.ts:136`: `new McpServer({ name: "docket", version: "1.0.0" }, { instructions: INSTRUCTIONS })`, fixed text.
- `src/server/mcp.ts:23-29`: `INSTRUCTIONS`.
- `src/server/api.ts:63-68`: `originOf(req)`, the origin the browser used (proxy-aware). Private to `api.ts`.
- `README.md:56-57`: the same command with `--scope user docket`.
- `SPEC.md:139`: "Server name `docket`".
- `SPEC.md:172`: the Settings command.

## Design

**Connect command** (`settings.tsx`)

```ts
/** Connects an MCP client to one workspace; the server's name says which. Local scope: the project it's run in. */
const mcpCommand = (token: string, workspace: string) =>
  `claude mcp add --transport http docket-${workspace} ${location.origin}/mcp --header "Authorization: Bearer ${token}"`;
```

- Pass the workspace key: the current workspace for API keys (the key's workspace, since DKT-4), and the `workspace` prop for agents.
- The secret's note under both commands: "Run it in the project folder the agent works in. Add --scope user to use it everywhere." It replaces `TOKEN_NOTE` only where a command is shown; keep "Shown once. Treat it like a password." as the first sentence.
- Workspace keys are `a-z 0-9 -`, so `docket-acme` is a valid Claude Code server name, and tools become `mcp__docket-acme__get_issue`.

**Server identity** (`mcp.ts`)
- Move `originOf` from `api.ts` to `http.ts` and export it. Both `api.ts` and `mcp.ts` import it.
- The MCP origin is `process.env.DOCKET_URL` (trailing slashes trimmed) if set, else `originOf(req)`. `DOCKET_URL` already means "the public origin" for `sign-in-link`.
- `createServer(a, origin)` builds:
  - `serverInfo: { name: \`docket-${ws}\`, title: \`Docket · ${workspaceName}\`, version: "1.0.0", websiteUrl: origin }`. SDK 1.30.1's `Implementation` accepts `title` and `websiteUrl`.
  - `instructions`: a first line, then today's text:
    `You're connected to Docket at ${origin}, workspace "${workspaceName}" (${ws}), as @${username} (${kind}). Every tool acts there.`
- `ws` is the key's workspace (`a.workspace` from DKT-4). `workspaceName` comes from `workspaces.name`. `username` is the caller's (`a.username`, per workspace after DKT-5).
- If DKT-2 has landed, its read-only line stays; this line always comes first.

**Docs**
- `README.md:56-57` shows `claude mcp add --transport http docket-<workspace> http://localhost:7100/mcp --header "Authorization: Bearer dk_…"` with one sentence: run it in your project folder; one server per workspace.
- SPEC updated as below.

**No schema, REST route or realtime change.**

## Acceptance criteria

- [ ] Settings → API keys and Settings → Workspace → Agents both show and copy `claude mcp add --transport http docket-<workspace key> <origin>/mcp --header "Authorization: Bearer <token>"`, with no `--scope`, and the note about project folder and `--scope user`.
- [ ] Adding agents from two workspaces in one project gives `docket-acme` and `docket-side`, which don't collide.
- [ ] MCP `initialize` answers:
  - `serverInfo.name` = `docket-<ws>`;
  - `title` = `Docket · <Workspace name>`;
  - `websiteUrl` = the origin;
  - instructions start with the "You're connected to Docket at …" line, naming the host, workspace and caller.
- [ ] With `DOCKET_URL=https://docket.example.com`, that origin appears in the instructions and `websiteUrl`. Without it, the request's host does, honouring `X-Forwarded-Host` and `X-Forwarded-Proto`.

## Tests

**`test/server.ts`:** add `server: () => Promise<{ name: string; title?: string; websiteUrl?: string; instructions?: string }>` to `Caller`. It reads the lazily connected MCP client's `getServerVersion()` and `getInstructions()`.

**`test/mcp.test.ts`:** new test "the server says which Docket and workspace it is":
- `claude.server()` has name `docket-acme` and title `Docket · Acme`;
- its instructions start with `You're connected to Docket at ${s.url}` (strip any trailing slash) and contain `workspace "Acme" (acme), as @claude (agent)`.

**Same file:** a second server via `startServer({ env: { DOCKET_URL: "https://docket.example.com" } })` shows that origin in `server().instructions` and `websiteUrl`.

**UI:** no unit tests. Check by hand on `127.0.0.1` at phone width that both commands render, wrap and copy.

## SPEC.md

- **MCP**: "Server name `docket`" becomes: "Server name `docket-<workspace>`, title `Docket · <Workspace name>`, `websiteUrl` the public origin (`DOCKET_URL`, else the request's). The instructions open with the Docket origin, the workspace and who you are, so an agent with several connections can tell them apart."
- **UI → Settings** (line 172): the command becomes `claude mcp add --transport http docket-<workspace> … --header "Authorization: Bearer <token>"`, run in the project folder (local scope).
- **README** as above.

## Out of scope

- OAuth or dynamic client registration for MCP.
- A separate read-only endpoint.
- Tool visibility per caller (DKT-2).
- Scoping keys to a workspace (DKT-4).
- Renaming existing client configs: people re-run the command, and the old `docket` entry keeps working until they remove it.

**Project rules:**
- Minimal, few files; no new dependencies.
- MCP instructions explain conventions for agents.
- UI: light, Linear-like, Geist; works at phone width.
- SPEC.md and README change in the same branch.
- Branch `feature/mcp-name-per-workspace`. `bun test` and `bun run typecheck` pass. Merge and delete the branch.
## Why

Every MCP caller sees all 22 tools, including ones it can't use:

- an agent sees `create_workspace` and `update_workspace`;
- a read-only key sees every write tool;
- a member sees the admin-only `update_workspace`.

The agent only finds out when the call fails. Meanwhile each unusable tool costs context and invites the model to try it. The server is already built per request with the caller known, so it can list exactly what that caller may do.

## Linear's behaviour

- Linear's MCP server has a read-only endpoint, `https://mcp.linear.app/mcp/readonly`, "which only ever exposes read tools". The alternative there is requesting only the `read` scope ([MCP](https://linear.app/docs/mcp)).
- Agents are app users that "are not able to also request `admin` scope" ([agents](https://linear.app/developers/agents)), so admin operations aren't theirs to see.

Docket applies the same idea per key, with no separate endpoint: a read key is Docket's read-only connection.

## Where things are today

**`src/server/mcp.ts`**
- `135-561`: `createServer(a)` registers every tool unconditionally.
- `138-143`: `writes()` rejects a read key only at call time.
- Tools with `annotations: { readOnlyHint: true }`: `list_workspaces` (156), `list_members` (198), `list_teams` (215), `list_labels` (268), `list_issues` (298), `get_issue` (314), `list_documents` (410), `get_document` (424). All other tools change something.
- `create_workspace` (165-178) is refused for agents by `access.createWorkspace` → `requirePerson` (`access.ts:238-240`).
- `update_workspace` (180-190) is refused for non-admins by `requireAdmin` (`access.ts:232-236`).
- `create_team` (227-243) and `update_team` (245-260): agents lose these per DKT-7.
- `23-29`: `INSTRUCTIONS` tells every caller to claim issues and comment, even a read key.

**The SDK.** `@modelcontextprotocol/sdk` 1.30.1 answers a call to an unregistered tool with a tool error, `isError: true`, text `MCP error -32602: Tool <name> not found` (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:100-105`, caught at 135-141). That is a clean failure.

**Tests**
- `test/identity-security.test.ts:90-97` means to check that `tools/list` has no credential verbs. It posts raw JSON-RPC without `Accept: application/json, text/event-stream`, so the transport answers 406 and the assertion passes on an error body. That test is vacuous today.
- `test/server.ts:17-27`: `Caller` has no way to list tools.

## Design

**Rule.** A tool is registered only if the caller can use it:

| Tools | Shown to |
|---|---|
| Tools with `readOnlyHint: true` (the eight above) | everyone |
| Issue, doc and comment writes: `create_issue`, `update_issue`, `claim_issue`, `comment_issue`, `create_document`, `update_document`, `comment_document`, `update_comment`, `delete_comment`, `delete_document` | write keys |
| `create_team`, `update_team` | write keys of people; agents don't manage teams (DKT-7) |
| `create_workspace` (if still present; DKT-4 removes it) | write keys of people |
| `update_workspace` | write keys of admins: of the key's workspace once DKT-4 lands, of any of the caller's workspaces before that |

**Implementation** (`mcp.ts`)
- Add a small `register(name, config, handler, who?)` inside `createServer`.
- It skips the tool when `a.scope === "read" && !config.annotations?.readOnlyHint`, or when `who` is given and `who(a)` is false. Otherwise it calls `server.registerTool`.
- Two predicates, next to `writes`:
  - `const people = (a: Actor) => a.kind === "person"`;
  - `const admins = (a: Actor) => [...a.workspaces.values()].includes("admin")`.
- Keep `writes()` and every server-side check (`requirePerson`, `requireAdmin`, and DKT-7's agent check) as defence in depth. REST uses them anyway.
- A call to a hidden tool fails through the SDK's "Tool X not found" tool error. No extra code; don't register stubs.
- The server is built per request (`handleMcp`, 564-582), so a role change or new key takes effect on the next request.

**Instructions**
- Build `INSTRUCTIONS` per caller.
- For a read key, replace the "Working on an issue: …" bullet with: `"- This key is read-only: you can list and read everything here, but not change anything."`
- Other callers get the text unchanged.
- If DKT-8 has landed, its first line stays first.

**No REST, UI, schema or realtime change.**

## Acceptance criteria

- [ ] `tools/list` for each caller, on today's main (subtract `list_workspaces` and `create_workspace` if DKT-4 has landed):
  - a **read key** sees exactly the eight read tools;
  - an **agent** sees the eight read tools plus the ten issue/doc/comment writes (18); no workspace or team tools;
  - a **member's write key** sees the agent's set plus `create_team`, `update_team` and `create_workspace` (21);
  - an **admin's write key** sees all 22.
- [ ] Calling a hidden tool (an agent's `create_team`, a read key's `create_issue`, a member's `update_workspace`) returns a tool error matching `/not found/` and changes nothing.
- [ ] A read key's instructions say it's read-only and don't mention `claim_issue`.
- [ ] REST answers are unchanged: the same 403s as before.

## Tests

**`test/server.ts`:** add `tools: () => Promise<string[]>` to `Caller`. It uses the same lazily connected MCP client as `tool()` and returns `client.listTools()` names, sorted. Document it in the header comment.

**`test/mcp.test.ts`:** new test "tools/list shows each caller only what it can use":
- callers: `s.admin` (bearer), `s.user("ana")` (member write key), a read key from `ana.api("POST", "/api/api-keys", { name: "ro", scope: "read" })` via `s.with({ token })`, and the `claude` agent;
- assert the four exact sorted name lists above;
- then assert the hidden calls reject with `/not found/`: `claude.tool("create_team", …)`, `ro.tool("create_issue", …)`, `ana.tool("update_workspace", …)`;
- check with REST that nothing changed.
- Line 14 of this file has `claude` creating a team. Change it to `s.api("POST", "/api/teams", …)`, as DKT-7 does too; whichever lands first makes the change.

**`test/identity-security.test.ts:90-97`:** replace the raw `POST /mcp` with `s.as("bot").tools()`, then assert the list is non-empty and has no `/invite|api_key|sign_in|token|suspend|create_agent|session/`. This fixes the vacuous check.

**Read-key instructions:** read `client.getInstructions()` through the harness, or assert via a new optional `instructions()` on `Caller` only if it's cheap. Otherwise cover it by checking that `tools()` omits `claim_issue`.

## SPEC.md

- **MCP**: after "Needs an API key; tools act as its owner", add: "`tools/list` shows only what the key can use: a read key sees the read tools (`readOnlyHint`); agents don't see workspace or team management; only admins see `update_workspace`. A call to a hidden tool is a tool error ("not found")."
- Add a "Who sees it" column to the tool table, or a line per row.

## Out of scope

- Agents and teams (DKT-7): this issue only hides the tools; the server-side refusal is DKT-7's.
- Removing `workspace` arguments and multi-workspace tools (DKT-4).
- Server name and instructions header (DKT-8).
- A separate `/mcp/readonly` endpoint: read keys already cover it.

**Project rules:**
- Minimal, few files; no new dependencies.
- MCP tool descriptions keep explaining conventions.
- SPEC.md changes in the same branch.
- Branch `feature/mcp-tool-visibility`. `bun test` and `bun run typecheck` pass. Merge and delete the branch.
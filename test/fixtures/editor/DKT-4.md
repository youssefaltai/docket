Part of DKT-3. Design: [Workspace isolation](/doc/workspace-isolation).

## Why

An API key acts in every workspace its owner belongs to. So one leaked key exposes all of them, MCP tools need a `workspace` argument whenever the owner is in more than one, and suspension can't revoke a key for just one workspace. Today it waits until the person's last membership is suspended, then deletes everything. This issue makes every key belong to exactly one workspace.

## Linear's behaviour

- Personal API keys are created inside a workspace (Settings → Account → Security & access) and can be limited to teams "in your workspace" ([API and webhooks](https://linear.app/docs/api-and-webhooks)).
- Linear's MCP server says "each workspace needs its own separate authentication context" ([MCP](https://linear.app/docs/mcp)).
- A suspended user "lose[s] all access immediately" in that workspace ([members and roles](https://linear.app/docs/members-roles)).

**Deliberate difference:** Docket keeps its two scopes (`read`, `write`) and doesn't add Linear's finer permissions or team-limited keys.

## Where things are today

**Schema**
- `src/server/db.ts:66-76`: `api_keys` has no workspace column.
- `src/server/db.ts:185-190`: migration 3, the last one.

**Actors and keys (`src/server/access.ts`)**
- `24-34`: `Actor` has `workspaces: Map` but no notion of a request's workspace.
- `169-184`: `actorFor` loads all of the owner's active memberships for any credential.
- `209-221`: `keyActor` does the same for keys.
- `142-151`: `me()` lists memberships by user id, not by the actor, so a key would see them all.
- `627-632`: `listWorkspaces` has the same problem.
- `376-411`: API keys are created, listed and revoked with no workspace.

**Chat keys**
- `access.ts:415-474`: chat keys are cached per session (`chatKeys` Map) and minted with no workspace.
- `src/server/chat.ts:97`: the proxy mints or reuses them.

**Suspension and agents (`access.ts`)**
- `477-482`: `signOutEverywhere` deletes every session, key and sign-in code.
- `708-713`: `suspend` calls `signOutEverywhere` only if no active membership remains.
- `759-768`: `rotateAgentToken` deletes all of the agent's credentials.
- `771-778`: `removeAgent` does the same.
- `643-648`: `createWorkspace` accepts an API key.

**Routes**
- `src/server/auth.ts:89-110`: `guard` builds the actor and reads `X-Docket-User`, but no workspace header.
- `src/server/index.ts:52-58`: `/ws` subscribes to `actor.workspaces`.

**MCP (`src/server/mcp.ts`)**
- `23-29`: `INSTRUCTIONS`, whose line 24 describes the `workspace` argument.
- `144-150`: `oneWorkspace`.
- `workspace` inputs at 197 (`list_members`), 214 (`list_teams`), 234 (`create_team`), 267 (`list_labels`), 282 (`list_issues`) and 406 (`list_documents`).
- `list_workspaces` (152-163), `create_workspace` (165-178) and `update_workspace` (180-190), which takes a `key`.

**Contract and web**
- `src/shared/types.ts:91-97`: `ApiKey` has no workspace.
- `src/web/settings.tsx:303-369`: the API keys section and the new-key form.
- `src/web/api.ts:83-98`: `request()` sends `X-Docket-User` only.
- `src/web/chatApi.ts:67-70`: `stream()` builds its own headers.

**Tests**
- `test/server.ts:135-144`: `signedIn` mints one key per person, with no workspace.

## Design

**Migration.** Append the next migration to `MIGRATIONS` (other issues may land first). It is additive:

```sql
-- Keys belong to one workspace, as in Linear: an API key, agent token or chat key acts only there.
ALTER TABLE api_keys ADD COLUMN workspace TEXT REFERENCES workspaces(key) ON DELETE CASCADE;
DELETE FROM api_keys WHERE session_id IS NOT NULL; -- chat keys: short-lived, minted again per workspace
UPDATE api_keys SET workspace = (SELECT m.workspace FROM workspace_members m
  WHERE m.user_id = api_keys.user_id AND m.suspended_at IS NULL ORDER BY m.created_at, m.workspace LIMIT 1);
DELETE FROM api_keys WHERE workspace IS NULL; -- the owner has no active workspace left
CREATE INDEX api_keys_workspace ON api_keys(user_id, workspace);
```

- An agent is in exactly one workspace, so its token lands there.
- A person's existing key goes to the workspace they joined first.
- The column stays nullable in SQL (`ADD COLUMN` can't add `NOT NULL` without a default), but code always sets it.

**Contract (`types.ts`)**
- `ApiKey` gains `workspace: string // the workspace key; the key works only there`.
- `Me` keeps its shape. For a key, `workspaces` lists only that key's workspace.

**The request's workspace** (`auth.ts`, `access.ts`)
- `Actor` gains `workspace: string | null`:
  - for a key, the key's workspace;
  - for a session, the `X-Docket-Workspace` header (trimmed, lowercased) if sent, else its only active membership, else `null`.
- Add `export function requestWorkspace(a: Actor): string`. It returns `a.workspace` if `a.workspaces` has it. If `a.workspace` is set but not in `a.workspaces`, it throws 404 `Workspace <x> not found`. If it's `null`, it throws 400 `Pick a workspace: send X-Docket-Workspace`.
- A key sent with `X-Docket-Workspace` naming another workspace gets 404 from `guard`.
- In this issue only the chat proxy and `POST /api/api-keys` use `requestWorkspace`. DKT-6 extends it to every data route.

**Keys**
- `keyActor` joins `workspace_members m ON m.user_id = k.user_id AND m.workspace = k.workspace AND m.suspended_at IS NULL`. A key whose membership isn't active is 401.
- `actorFor` takes an optional workspace and loads only that membership. So a key's `workspaces` Map has one entry, and `/ws`, `requireMember` and every tracker scope follow automatically.
- `me()` and `listWorkspaces()` filter to `a.workspaces`.
- `insertApiKey(userId, workspace, name, scope)`.
- `createApiKey` takes `{ name, scope?, workspace? }`. `workspace` defaults to `requestWorkspace(a)` and must be an active membership (404 otherwise).
- `listApiKeys` returns `workspace` on each key.
- Chat keys:
  - `chatKey(a)` and `chatWriteKey(a)` mint for `requestWorkspace(a)`.
  - The in-memory cache is keyed by `` `${sessionId}:${workspace}` ``, and the "still ours" query adds `AND workspace = ?`.
  - `proxyChat` resolves the workspace before minting. A 400 answers `{ error, code: "invalid" }` and a 404 answers `{ error, code: "not_found" }`.
  - The header is not forwarded; the `REQUEST_HEADERS` allow-list already drops it.
- `createWorkspace` requires a session: 403 `Sign in to the web app to create a workspace; API keys work in one workspace`.

**Suspension, simplified** (`suspend`, `rotateAgentToken`, `removeAgent`)
- Suspending in W:
  - sets `suspended_at`;
  - deletes the person's keys in W (API keys, agent token, chat keys): `DELETE FROM api_keys WHERE user_id = ? AND workspace = ?`;
  - if no active membership remains, also deletes their sessions and unused sign-in codes;
  - then calls `revoked({ userId })` so their sockets reconnect.
- Other workspaces' keys are never touched. This replaces the "while they're still active elsewhere their credentials stay" branch.
- `rotateAgentToken` deletes the agent's keys in that workspace, reinstates it and inserts a new key there.
- `removeAgent` calls `suspend`.
- The unused invites an admin made in W still go when they lose admin there.

**REST.** No new routes.
- `POST /api/api-keys` accepts `workspace`.
- `GET /api/api-keys` returns `ApiKey[]` with `workspace`.
- `POST /api/workspaces` with a key answers 403.

**MCP** (`mcp.ts`)
- Delete `oneWorkspace`.
- Remove the `workspace` input from `list_members`, `list_teams`, `create_team`, `list_labels`, `list_issues` and `list_documents`; they use the key's workspace. Callers that still pass one are unaffected, because zod strips unknown keys.
- `tracker.createTeam` defaults a missing `workspace` to `requestWorkspace(a)`, for REST keys too.
- Remove `list_workspaces` and `create_workspace`.
- `update_workspace` takes `{ name }`. New description: `"Rename your workspace (admins only). Its key never changes. Only do this when asked to."`
- `list_teams` lines drop `· workspace X`. New description: `"List the workspace's teams with open-issue counts, one line each: key · name · open count. A team's key (e.g. BRD) prefixes its issue identifiers (BRD-12)."`
- `INSTRUCTIONS` line 24 becomes: `"- Workspace → team → issues and docs. Your key works in one workspace: everything you list, read and change is there."`
- `create_team` description: drop "workspace required…"; keep the rest.

**Web**
- `src/web/api.ts` keeps a module-level current workspace, like `setSignedInAs`. `request()` sends `x-docket-workspace` whenever it's set.
- `chatApi.ts` `stream()` sends it too.
- `main.tsx` sets it whenever `workspace` changes.
- Settings → Account → API keys:
  - lists only the current workspace's keys;
  - hint: "For scripts and MCP clients that act as you in <Workspace name>.";
  - `NewApiKey` posts `workspace: current`.
- The suspend dialog (`settings.tsx:413`) reads: "They lose access to this workspace and its API keys stop working; if it's their only workspace, they're signed out everywhere. What they wrote stays theirs."

**Realtime.** Unchanged code. A key's socket now subscribes to one workspace, and sessions still hear all of theirs.

**docket-chat (other repo, not in this issue).** It stores conversations by `Me.user.id` alone. Note in the PR that it should also key them by the chat key's workspace (`Me.workspaces[0].key`).

## Acceptance criteria

- [ ] A key made for workspace B in an account that is also in A:
  - lists only B in `GET /api/workspaces`, `GET /api/me` and `list_teams`;
  - gets 404 for A's issues, docs, members and teams, over REST and MCP;
  - its `/ws` socket never hears A's events.
- [ ] `POST /api/api-keys` makes a key for:
  - the given workspace, or 404 if you aren't an active member there;
  - `X-Docket-Workspace` when no `workspace` is given;
  - your only workspace when there's neither;
  - nothing otherwise: 400.
- [ ] Every key in `GET /api/api-keys` carries its `workspace`.
- [ ] A key with `X-Docket-Workspace` naming another workspace gets 404.
- [ ] Suspending ana in B:
  - kills her B keys (401);
  - leaves her A keys and her session working;
  - suspending her in A too then ends her session (401).
- [ ] The chat proxy:
  - mints a key for the request's workspace;
  - that key's `GET /api/me` lists only that workspace;
  - no header with two workspaces answers 400 `invalid`;
  - a workspace you're not in answers 404 `not_found`.
- [ ] MCP:
  - no tool has a `workspace` input, and passing one still works;
  - `list_workspaces` and `create_workspace` are gone;
  - `update_workspace { name }` renames the key's workspace.
- [ ] `POST /api/workspaces` with an API key answers 403; with a session, 201.
- [ ] Existing keys after the migration: an agent's is in its workspace; a person's is in their first workspace; chat keys are gone.

## Tests

**`test/server.ts` (harness)**
- Keep one key per (user, workspace). `signedIn` mints `{ name: "tests", workspace }`.
- `s.user(existing, { workspace })` also mints a key for the new workspace.
- `s.as(name, via?, workspace?)` picks that workspace's key; the default is the workspace the user joined first.

**New `test/keys.test.ts`** (admin is in `acme`; `side` is created; ana is in both):
- A `side` key sees only `side`: `/api/workspaces`, `/api/me`, `/api/teams`, `list_teams`.
- The `side` key on `acme`'s issue: GET, PATCH and comment are all 404, over REST and over MCP `get_issue`.
- A `side` key socket doesn't receive an `acme` issue event.
- `POST /api/api-keys`:
  - `workspace: "nope"` → 404;
  - ana with no workspace → 400;
  - with `X-Docket-Workspace: side` → a `side` key;
  - a single-workspace user needs no workspace;
  - with a key → 403.
- Key plus `X-Docket-Workspace: acme` on a `side` key → 404.
- Suspension:
  - ana suspended in `side`: `side` key 401, `acme` key 200, cookie 200;
  - reinstate her, then suspend her in both: cookie 401.
- MCP:
  - `list_issues { workspace: "acme" }` with a `side` key still lists `side` (the argument is ignored);
  - `create_workspace` → error matching `/not found/`;
  - `update_workspace { name }` as the admin renames.
- `POST /api/workspaces` with a key → 403.

**`test/chat-proxy.test.ts`**
- The admin joins a second workspace.
- `/chat/echo` with `X-Docket-Workspace: side` → the bearer the stand-in service received answers `GET /api/me` with only `side`.
- No header → 400 `invalid`.
- `X-Docket-Workspace: nope` → 404 `not_found`.
- Existing single-workspace tests stay green.

**`test/users.test.ts`**
- 107-132 (suspension from sam's only workspace ends everything) and 134-151 (agent token) must stay green unchanged. They pin the last-membership branch and the agent paths.

**New `test/migrations.test.ts`** (frozen fixture)
- Paste migrations 1–3 verbatim as `SCHEMA_V3`, never to be edited.
- Build a file database at `user_version = 3` with:
  - admin in `acme` (joined first) and `side`, owning a write key with a known token;
  - an agent in `side` with a token;
  - a chat key bound to a session.
- Start the server on it: `startServer({ setup: false, env: { DATABASE_PATH } })`.
- Assert over HTTP:
  - the admin's key sees only `acme`;
  - the agent's token sees only `side`;
  - the chat key is 401.
- Assert `user_version` is 4 (or the next one).

## SPEC.md

**Access → Credentials**
- API key: "belongs to one workspace, chosen when it's made (default: the workspace you're in); it acts only there". A read key's rules are unchanged.
- Chat keys: "one per browser session and workspace, for the workspace the chat panel is in".
- Managing access needs a session: add "creating a workspace".

**Access → Suspend.** Replace the paragraph with the new rule:
- that workspace's keys die at once;
- sessions and unused sign-in links go when no active membership remains;
- other workspaces are never touched.

**Access → Rules for every request.** Add `X-Docket-Workspace`:
- the workspace a browser request acts in;
- a key's workspace is its own, and a different header is 404;
- used so far by the chat proxy and new keys.

**Account routes table:** `POST /api/api-keys` body `{ name, scope?, workspace? }`.

**MCP:** drop the `workspace` arguments, `list_workspaces` and `create_workspace`; `update_workspace` takes `name`.

**Data:** a sentence on this migration (keys get `workspace`; existing person keys go to their first workspace; chat keys are dropped).

**Types:** update `src/shared/types.ts` `ApiKey`.

## Out of scope

- Per-workspace usernames (DKT-5).
- Team keys, slugs, URLs, and the workspace being mandatory on every data route (DKT-6).
- Hiding tools per caller (DKT-2).
- MCP server naming and the connect command (DKT-8).
- Linear's finer key permissions and team-limited keys.
- docket-chat's conversation scoping (other repo).

**Project rules:**
- Linear's features, nano implementation; no new dependencies.
- Migrations are append-only and additive, with a frozen-fixture test.
- SPEC.md and `types.ts` change in the same branch.
- REST, MCP and UI stay in parity. Every mutation publishes `changed`. Outside your workspaces is 404.
- Branch `feature/workspace-keys`. `bun test` and `bun run typecheck` pass. Merge to main and delete the branch.
- Deploy only from main after `./backup.sh`, following the rehearsal checklist in the design doc.
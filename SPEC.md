# Docket

An issue tracker for people and agents, modeled on Linear: workspaces, teams, issues, docs, comments. Web UI for people, MCP for agents. Bun + SQLite + TypeScript, self-hosted anywhere. Everyone signs in; agents are apps with their own tokens.

Rules: Docket copies Linear's features; "nano" is about the implementation. Minimal, simple, clean code, few files. Few dependencies (react, react-dom, marked, zod, @modelcontextprotocol/sdk). No frameworks beyond that.

## Layout

```
src/shared/types.ts   the contract (do not change without updating both sides)
src/server/index.ts   Bun.serve: routes, /api, /mcp, /ws, serves the web app, prints the setup code
src/server/config.ts  loads an optional XDG config file into process.env (imported first)
src/server/paths.ts   XDG Base Directory resolution
src/server/db.ts      bun:sqlite connection, schema, change events, shared validation
src/server/access.ts  accounts, sessions, API keys, one-time codes, workspaces and members; the Actor
src/server/tracker.ts teams, issues, comments, labels, documents (every call acts for an Actor)
src/server/auth.ts    credentials → Actor, guards, rate limit, public setup/sign-in routes
src/server/http.ts    security headers, body cap, rate limit per credential, the built web app
src/server/chat.ts    /api/chat proxy to the docket-chat service
src/server/api.ts     REST handlers
src/server/mcp.ts     MCP server + tools
scripts/              seed (dev data), sign-in-link (recovery)
src/web/index.html    HTML entry (Bun HTML import, bundled by Bun)
src/web/*.tsx, *.css  React UI
```

Env vars and the optional XDG config file: see README's Configuration section. Dev: `bun run dev` (uses `./dev.db` unless `DATABASE_PATH` is set, and setup code `DEVEL-SETUP` unless `DOCKET_SETUP_CODE` is set). Tests: `bun test`, black-box over HTTP against a temp database. Prod: `bun run start` (sets `NODE_ENV=production`, so Bun serves bundled assets and never shows its dev error page).

## Access

Linear's model: sign-in is always required, accounts are global, each workspace has its own members and roles, agents are app users with their own token, removing someone is suspending them. Enterprise-only Linear features (SAML/SCIM, audit log, an Owner role) are out of scope.

**Accounts** (`users`): an account is a login, a person (`kind: "person"`) or an agent (`kind: "agent"`), with an optional email for people: contact info, unique across accounts (case-insensitively; 409 on a clash), not yet verified (there's no mail) and never used to find an account. How an account is known belongs to each membership, as in Linear: a `username` (lowercase `a-z 0-9 . _ -`, 2–32 characters, starting with a letter or digit; `me` is reserved), unique within the workspace among its people and agents (409 `Username "x" is taken in <Workspace>`, naming only that workspace), and a display `name`. The same username can be different people or agents in different workspaces, and one person can go by different ones. A person's **default profile** is the membership they joined most recently (whatever its status); it's used where no workspace is in play: prefilling a join, `/api/me` for a session that names no workspace, and the sign-in-link prompt. An agent account has exactly one membership. The API names people and agents by username in the workspace at hand; responses carry `UserRef = { username, name, kind }`. No passwords.

**Workspaces** (`workspace_members`): each membership has a username and name (see Accounts; suspended members keep theirs, so history keeps its names) and a role, `admin`, `member` or `agent` (agents work in teams but manage nothing: no teams, members, invites or agents), and may be suspended. Joining asks for your profile there: signed out, a name and username; signed in, your default profile unless you pick another. You see only workspaces where you're an active member; anything in another workspace answers 404, as if it didn't exist. Any person can create a workspace and becomes its admin. Any person in the workspace, member or admin, creates teams and edits a team's name and description, as in Linear by default; agents can't (403). Admins rename the workspace, create invite links, change roles, suspend and reinstate members, and add, re-token and remove agents. No one can sign in as someone else: there's no admin sign-in link or impersonation. The last active admin can't be suspended or demoted (409 "Add another admin first").

**Suspend** (`PATCH …/members/:username { suspended: true }`) ends access to that workspace at once (membership is checked on every request; their sockets reconnect without it), and that workspace's keys die at once: their API keys, agent token and chat keys there are deleted. If it was their last active membership, their sessions and unused sign-in links go too, so reinstating (`suspended: false`) gives a clean account that signs in again (the server's CLI); reinstating never brings deleted keys back. Other workspaces and their keys are never touched, so one workspace's admin can't cut anyone off from the others. Suspending or demoting an admin also deletes the unused invites they made there. They stay listed, greyed, so history keeps their name. Removing an agent is suspending it; a new token reinstates it.

**Credentials.** Secrets are random and stored only as SHA-256 hashes.
- **Session**: the web UI's cookie `docket_session` (32 random bytes as hex; HttpOnly, SameSite=Lax, Secure over HTTPS, 30 days, re-sent while in use). Idle for 30 days (by `last_seen_at`, touched at most once a minute) and it's gone. Account settings list sessions (device, IP, last seen), revoke one, or sign out everywhere else.
- **API key**: `Authorization: Bearer dk_<64 hex>`, for scripts, MCP clients and agents; it acts as its owner. It belongs to one workspace, chosen when it's made (default: the workspace you're in); it acts only there, as in Linear: it sees only that workspace (`/api/me`, `/api/workspaces`, lists, `/ws`), and anything in another is 404. People make their own (named, scope `read` or `write`) and revoke them. A read key gets 403 on anything but GET (REST) and on tools that change something (MCP). An agent's token is an API key it owns, in the agent's workspace.
- **Managing access needs a session**: listing, making or revoking API keys, listing or revoking sessions, making sign-in links and invites, creating a workspace, changing your profile, changing members and adding or re-tokening agents all answer 403 to an API key. A leaked key can't mint credentials that outlive it, or lock its owner out of their other keys.
- **One-time codes**: 10 symbols of `A–Z 2–9` without `I O 0 1` (50 bits), shown as `XXXXX-XXXXX`, single-use, 15 minutes. A link is `<origin>/login#<code>`: the fragment never reaches the server or its logs, and the page removes it from the address bar at once.
  - **Invites** (a workspace and role) are handed over by the admin, not tied to anyone: redeemed while signed in, one adds you to the workspace (as your default profile, or the `name` and `username` you send); signed out, it creates a new account and its membership (name, username, optional email).
  - **Sign-in links** open one person's account and may record a workspace: from yourself (to sign in on another device; it records the workspace you're in), or from the server's shell (`bun run sign-in-link <username> [workspace]`, for when nobody can sign in). The CLI finds the person holding that username (in that workspace, else in any; agents are refused); if several people do, it exits 1 listing `<workspace key> · <name>` for each, so you name the workspace. Redeeming one while signed in as someone else deletes that session first, so the browser is never signed in as two people. Suspension from your last workspace deletes your unused codes.
- **Setup code**: while there are no users, the server prints one at startup (`DOCKET_SETUP_CODE` fixes it, e.g. for tests and dev). `POST /api/setup` with it creates the first person, signed in, as admin of a new workspace. A wrong code is 403; once any user exists, 409.

**Rules for every request** (`auth.ts`): `/api/*` accepts a session cookie or an API key; `/mcp` only an API key; `/ws` either. Cookies ride along on same-site requests (a sibling subdomain, another localhost port), so a cookie-authed WebSocket or non-GET request needs our own `Origin` (403 otherwise), and an invite only joins the signed-in user when it does. No or bad credentials: 401 (a 401 caused by a stale cookie also clears it). Signed in but not allowed (not an admin, read-only key, someone else's comment): 403. Outside your workspaces: 404. **Every data request acts in one workspace**: a key's own, or a session's `X-Docket-Workspace: <key>` (the web app sends the one its URL shows), or, without the header, a session's only active workspace. A key's header naming a different workspace is 404. Teams, issues, labels, documents, trash and the chat proxy all act there: team keys, identifiers and slugs resolve in it, and lists show only it. Naming a workspace you aren't an active member of is 404; a session in several that names none is 400 `Pick a workspace: send X-Docket-Workspace`. Account routes (`/api/me`, sessions, keys, sign-in links, `/api/workspaces…`, `/api/locate`) need no workspace. Request bodies must be `Content-Type: application/json`, compared exactly on the media type before any `;` (so `text/plain;charset=application/json` is refused), else 415: browsers can't send that cross-origin without a CORS preflight, which Docket never allows, so this is the CSRF defence. Host check (DNS rebinding): `/api/*`, `/mcp` and `/ws` answer 403 unless the `Host` header's hostname (port ignored, case-insensitive) is `localhost`, `127.0.0.1`, `[::1]` or listed in `DOCKET_HOSTS`. Setup and code attempts are rate-limited per client IP: after 10 failures (401/403) in a minute, 429 until the minute ends (behind a proxy, all clients share the proxy's IP). The app shell, manifest, service worker and icons stay public; they hold no data.

**HTTP layer** (`http.ts`): every response carries `Content-Security-Policy` (`default-src 'self'`, plus Google Fonts and `https:` images for markdown; `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`; no inline script), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and over HTTPS `Strict-Transport-Security`; API answers add `Cache-Control: no-store` and `Vary: X-Docket-Workspace` (so a cache, like the service worker's offline fallback, never serves one workspace's answer in another). Request bodies over 1 MB answer 413. Texts are capped: titles 500 characters, names 200, descriptions and comments 100,000, doc content 500,000 (also after `edits`), else 400. Each credential (API key or session; no credential: the client IP) gets a token bucket of 600 requests refilling at 20 a second across `/api`, `/mcp` and `/ws`; past it, 429 with `Retry-After`. In production the web app is built once at startup and served with these headers; `bun run dev` keeps Bun's hot-reloading server.

**Assistant proxy** (`chat.ts`, when `CHAT_URL` is set; `GET /api/me` says `chat: true`): `/api/chat` and `/api/chat/*` go to `{CHAT_URL}/chat[/*]` (docket-chat's `CHAT_API.md`). Only a browser session gets through (an API key: 403), after the usual Origin, rate-limit and JSON checks; bodies over 16 KB answer 413. The path must stay under `/chat` once resolved (`/api/chat/%2e%2e/x` is a 404, never `{CHAT_URL}/x`). It forwards the method, query, body, `Content-Type`, `Accept` and `Last-Event-ID`, never cookies, and sets `Authorization: Bearer <chat key>`; it sends back the status, `Content-Type`, `Cache-Control`, `Retry-After`, `X-Accel-Buffering` and the body unbuffered (SSE), and aborts upstream when the browser does (Stop). Answers other than JSON or an event stream become 502, so nothing the service sends renders as a page on Docket's origin. The service has 90 s to start answering and 5 minutes in all. Its own errors look like the service's: `{error, code}` (`not_configured` or `not_found` 404, `forbidden` 403, `invalid` 413/415, `chat_unavailable` 502, `timeout` 504). Docket's usual checks answer first, as `{error}` without a code: 401 (no session), 403 (cross-origin), 413 (over 1 MB), 429 (rate limit). Without `CHAT_URL`, 404.

**Chat keys**: a read API key, one per browser session and workspace, for the workspace the chat panel is in (its `X-Docket-Workspace`, never forwarded; before minting, the proxy answers 400 `invalid` when a session in several names none, and 404 `not_found` for a workspace you aren't in). Named "Chat (automatic)", minted by the proxy and kept only hashed (the token lives in the server's memory). It lives 30 minutes (`DOCKET_CHAT_KEY_TTL_MS`) and is reused while it has two thirds of that left, so a forwarded key always has 20 minutes to go. It's deleted with its session (sign-out, revoke, idle expiry) or with suspension from its workspace, and doesn't appear in the key list. One request writes: a `POST /api/chat/actions/:id/confirm` (the person confirming a change the assistant proposed; matched exactly on the resolved path) gets a write chat key minted for it alone, deleted when that answer ends, fails or is stopped, with 5 minutes as a backstop. Every other chat request reads. `GET /api/me` answers `credential: "session" | "key" | "chat"`, so docket-chat can accept only chat keys. Any key past `expires_at` is dead everywhere (401) and purged at startup, hourly and on each mint.

**Stale tabs**: tabs share one cookie, so the web app sends `X-Docket-User: <account id it shows>` (`Me.user.id`) with every request. If it's not the signed-in account (someone signed in as someone else in another tab), the request gets 401 `{ switched: true }` and the tab reloads as whoever is really signed in, instead of acting as them under the old name.

**Workspaces can't be deleted** yet (like projects before them); a person who can sign in can always create one.

**Authors** are never sent by clients: every write is attributed to the signed-in user or agent. Only a comment's author can edit or delete it (403 otherwise, with no admin override).

**Public routes** (Host and JSON checks, rate-limited, no credentials):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/setup | | `{ needed }` |
| POST | /api/setup | `SetupInput` `{ code, name, username, email?, workspace: { name, key? } }` | 201 `{ user, workspace }` + session cookie |
| POST | /api/auth/peek | `{ code }` | `CodeInfo` `{ kind, workspace, username, you, needsProfile }` (changes nothing; `workspace` is the invite's or the one a sign-in link recorded; `username` is the link's person there, else their default profile's; `you` is who's signed in, as their default profile, whom an invite would add or another person's sign-in link would replace, else null) |
| POST | /api/auth/redeem | `{ code, name?, username?, email? }` | `{ user }` + session cookie; an invite adds the membership (signed out, it needs name and username for the new account; signed in, they default to your default profile) |
| POST | /api/logout | `{}` | ends this cookie's session and clears it |

**Account and workspace routes** (signed in):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET / PATCH | /api/me | `{ email? }` | `Me` `{ user, workspaces: [{ key, name, role, you }] }`: `user` is you in the request's workspace (a key's, or `X-Docket-Workspace`), else your default profile; `you` is how you're known in each workspace. Only here does `user` carry its numeric `id`, the account, which never changes (docket-chat keys history by it). `name` or `username` here is 400, naming the profile route |
| PATCH | /api/workspaces/:key/profile | `{ name?, username? }` | `WorkspaceMember`: yours in that workspace (a session only; 404 if you aren't an active member; 409 on a clash there) |
| GET | /api/sessions | | `Session[]` (`current` marks this one) |
| DELETE | /api/sessions, /api/sessions/:id | | all but this one, or one |
| POST | /api/sign-in-links | | 201 `CodeLink` `{ code, url, expiresAt }` for yourself |
| GET | /api/locate | exactly one of `?issue=BRD-1`, `?doc=slug`, `?team=BRD` (else 400) | `{ workspace }`: which of your active workspaces it's in, ignoring `X-Docket-Workspace` (a key: only its own); the oldest team or doc wins when several match (links made before keys and slugs were per workspace meant it); 404 `Not found` otherwise |
| GET / POST | /api/api-keys | `{ name, scope?, workspace? }` | `ApiKey[]`, each with its `workspace`; 201 `{ apiKey, token }` (token shown once) for `workspace`, default the request's (404 if you aren't an active member there) |
| DELETE | /api/api-keys/:id | | revokes |
| GET / POST | /api/workspaces | `WorkspaceInput` | yours, with your `role` (a key: only its own); 201, you're its admin (a session only). The key is the first segment of app URLs, so `api, doc, docs, icons, issue, login, mcp, settings, setup, t, ws` are reserved: 400 `Workspace key "docs" is reserved` when given, skipped when derived ("Docs" gets `docs-2`) |
| PATCH | /api/workspaces/:key | `{ name }` | (admin) |
| GET | /api/workspaces/:key/members | | `WorkspaceMember[]` (people, then agents) |
| PATCH | /api/workspaces/:key/members/:username | `{ role?, suspended? }` | (admin) |
| POST | /api/workspaces/:key/invites | `{ role? }` | (admin) 201 `CodeLink` |
| POST | /api/workspaces/:key/agents | `{ name, username }` | (admin) 201 `{ agent, token }` |
| POST | /api/workspaces/:key/agents/:username/token | | (admin) `{ token }`: the old one dies; reinstates a removed agent |
| DELETE | /api/workspaces/:key/agents/:username | | (admin) removes it |

## Data

Migration 1 creates the schema (`db.ts`); migration 2 adds `deleted_at` to issues and documents (the trash) and a unique index on `lower(users.email)` (older duplicates keep the email on the oldest account); migration 3 adds `expires_at` and `session_id` to API keys (chat keys); migration 4 gives every API key a `workspace`: an agent's token goes to its workspace, a person's existing key to the workspace they joined first, chat keys are dropped (minted again per workspace), and keys whose owner has no active workspace left are deleted; migration 5 moves `username` and `name` from `users` onto every one of that user's `workspace_members` rows (unique per workspace; the role CHECK also allows `guest`), rebuilding both tables with SQLite's 12-step procedure and keeping every id and row; migration 6 makes team keys and doc slugs unique per workspace: teams get an internal `id` (numbered in `created_at, key` order) that issues and documents point to, documents get their `workspace`, and all three tables are rebuilt the same way, keeping every id, identifier, slug and `next_number`; migration 7 adds `issue_activity`, where history starts: every existing issue gets one `created` row, by its creator at its `created_at`; migration 8 adds `mentions`, empty (texts written before count from their next save). Migrations run with foreign keys off, each in its own transaction, which runs `PRAGMA foreign_key_check` and rolls back (the server doesn't start) if anything dangles; foreign keys are on afterwards. WAL mode on.

- **users**, **workspaces**, **workspace_members**, **sessions**, **api_keys**, **codes**: see Access.
- **teams**: id (internal; the API names teams by key), workspace, key (2–5 uppercase letters, unique within the workspace: `UNIQUE (workspace, key)`), name, description, next_number, created_at, updated_at.
- **issues**: id, team_id, number (per-team sequence from `teams.next_number`; never reused after a delete), title, description, status, priority, labels (JSON array), assignee_id (a person), delegate_id (an agent), creator_id, parent_id, created_at, updated_at, completed_at. Unique (team_id, number).
- **issue_blocks**: blocker_id, blocked_id. No cycles: setting `blockedBy` fails (400) if the issue itself or any issue it already blocks, directly or through a chain, is among the blockers.
- **issue_activity** (an issue's history, Linear's activity feed): id, issue_id (cascades on purge), actor_id, on_behalf_of_id (null; reserved for changes Docket makes on its own, naming whose change set them off), kind, from_value, to_value (JSON), created_at. One row per change, written as the last step of the change's own transaction, so a refused change (400, 409) writes none; the rows of one mutation share its actor and time. Every change is logged, including those right after creation (unlike Linear: this is an audit trail). Kinds and values: `created` (creating also logs `assignee` and `delegate` when set), `title` and `status` strings, `description` (no values: no diff), `priority` numbers, `assignee` and `delegate` user ids (shown as `UserRef`s as they're known in the workspace now, so renames carry and suspended members keep their names), `labels` string arrays, `parent` an identifier, `blockedBy` identifier arrays, `claimed` the status before and after, `trashed` and `restored` (no values). An update logs only fields that really changed (labels and blockers compare as sets); claiming your own started issue again logs nothing. Issues bumped by a relation change get no rows of their own. `kind` has no CHECK, so new kinds need no rebuild.
- **comments** / **document_comments**: id, issue_id / document_id, author_id, body, created_at, edited_at.
- **documents**, **document_versions**, **document_refs**: see Documents.
- **mentions** (who is @mentioned where; the inbox and webhooks act on them): source (`issue:<id>` for a description, `comment:<id>`, `document:<id>` for content, `document_comment:<id>`), user_id, issue_id / document_id (the issue or doc it's in or on; cascades on purge), author_id, created_at; primary key (source, user_id). Recomputed in the same transaction as every save of the text, like doc refs: mentions the text still has stay as they were (same author and time), new ones get the saver and the save's time, dropped ones go; deleting a comment deletes its rows. Not in the API. **Syntax** (`MENTION_PATTERN` in types.ts, shared with the renderer): `@username` (`[a-z0-9][a-z0-9._-]{1,31}`, case-insensitive, not followed by another username character), not preceded by a letter, digit, `_ . @ / + -` (so `bob@example.com` and `https://x.com/@ana` aren't mentions), in prose: never in code (fenced, indented or inline) or link text. If no one holds the whole match, trailing `. _ -` drop one at a time (`Thanks @ana.` mentions ana). It counts only for an active member of the text's own workspace, people and agents; no one mentions themselves (one someone else made stays when they edit the text). In doc content only, a match that ends exactly at the end of the content doesn't count yet (the editor autosaves mid-word: `@al` on its way to `@alice`); `@al ` or more text after it does.

Identifier = `${team key}-${number}`, parsed case-insensitively, resolved in the request's workspace (`BRD-1` can exist in several). Issues can't move between teams. Parents, blockers and doc refs never cross workspaces. Any change to an issue or its comments bumps `updated_at`, strictly forward (at least 1 ms past its previous value, even within one millisecond), since it doubles as the version token for `baseUpdatedAt`; `db.ts` keeps that rule in one place per layer (`bumpedAt` in JS, `BUMPED_AT` in SQL), shared with documents. Creating an issue with a parent or blockers bumps and publishes them. Moving an issue to or from the trash also bumps and publishes its sub-issues, its parent, and the issues it blocked or was blocked by; docs that mentioned it get a `document` event. Changing an issue's parent or blockers likewise bumps and publishes the old and new parent and each blocker added or removed. `completed_at` is set when status enters done/canceled, cleared when it leaves. New issues start in `backlog` (as in Linear). List order: status order, then priority (1→4, then 0 last), then `updated_at` desc.

**Trash** (Linear's delete): deleting an issue or doc sets `deleted_at` (`deletedAt` in the API). It leaves lists, search, labels, team counts, relations (`blockedBy`, `blocks`, sub-issues) and doc refs, but keeps its links, so restoring (`POST …/restore`) puts everything back. Sub-issues of a trashed issue stay, still pointing at it. A trashed item can be read (with `deletedAt`) and restored, nothing else: edits, comments, claims and new relations to it answer 409 or 400. After 30 days in the trash it's deleted for good (with its comments, versions and refs), at startup and whenever something is trashed, restored or the trash is listed. Deleting or restoring twice is 409.

**Assignee and delegate** (Linear's model): the assignee is a person who owns the issue; the delegate is an agent working on it for them. Each must be an active member of the issue's workspace of the right kind (400 otherwise, e.g. "claude-a is an agent; set it as the delegate"). `me` means the caller, in values and filters.

**Claim** (`POST /api/issues/:id/claim`, MCP `claim_issue`): a person takes the assignee slot, an agent the delegate slot; an unstarted issue (`backlog`, `todo`) moves to `in_progress`, one already started (`in_progress`, `in_review`) keeps its status. One IMMEDIATE transaction reads and writes, so of two claims racing for a free issue exactly one wins. A done or canceled issue is 409 `"<ID> is done"`; one whose slot another active member holds is 409 `"<ID> is claimed by <username>"` (a suspended holder doesn't count). Claiming your own again changes nothing. To hand it back, clear the slot and set status todo.

**Issue versions**: `IssuePatch.baseUpdatedAt`: if present and different from the current `updatedAt`, the PATCH (or `update_issue`) answers 409 `{ "error": "Issue changed since you read it" }` and changes nothing; the check and the write share one IMMEDIATE transaction. Comments bump `updatedAt` too, so send it where lost updates happen (description, and the whole-list `labels` and `blockedBy`), not for single-field changes like status or priority.

## REST (JSON; errors are `{ "error": string }` with 4xx)

Plus the Access routes above. Everything here acts in the request's workspace (see Access); `?workspace=` is no longer read. A filter naming something unknown (a team not in the workspace, a username who isn't in the workspace, a parent that doesn't exist) is 400 `Unknown …`, not an empty list; a label nobody uses yet just finds nothing. PATCH bodies take only the fields listed for them: anything else is 400 naming the field (e.g. `"team"`: issues can't move between teams).

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | /api/teams | | `Team[]` |
| POST | /api/teams | `TeamInput` (created in the request's workspace; `workspace`, if given, must name it: 400 `Teams are created in the workspace you're in`; a key taken there is 409 `Team key BRD is taken in this workspace`) | 201 `Team` |
| PATCH | /api/teams/:key | `{ name?, description? }` (teams never change workspace: 400) | `Team` |
| GET | /api/issues | `?team&status=a,b&label&assignee&delegate&parent&q`, plus `first` (1–500) and `after` to page | `IssueSummary[]`; with `first`/`after`, `IssuePage` `{ issues, pageInfo: { hasNextPage, endCursor } }` |
| POST | /api/issues | `IssueInput` | 201 `Issue` |
| GET / PATCH / DELETE | /api/issues/:id | `IssuePatch` (title, description, status, priority, labels, assignee, delegate, parent, blockedBy, baseUpdatedAt) | `Issue`, with its `activity` (history, oldest first) like every route returning one (DELETE moves it to the trash) |
| POST | /api/issues/:id/restore | | `Issue` |
| GET | /api/teams/:key/trash | | `Trash` `{ issues, documents }`, newest first |
| POST | /api/issues/:id/claim | | `Issue` |
| POST | /api/issues/:id/comments | `{ body }` | 201 `Issue` |
| PATCH / DELETE | /api/issues/:id/comments/:cid | `{ body }` | `Issue` (own comments only; a `:cid` not on that issue is 404) |
| GET | /api/labels | | `string[]` (distinct, sorted) |

Editing a comment sets `editedAt`; deleting is permanent. Both bump the issue like adding one; doc comments never bump the doc (so an open editor gets no conflict).

## Realtime

`GET /ws` upgrades to a WebSocket that subscribes to the caller's workspaces (a key's: only its own). After every mutation (REST or MCP) the server publishes a `ServerEvent` `{ type: "changed", entity, workspace, id }` to that workspace's sockets only. The UI refetches what it's showing. Signing out, revoking a session or key, suspension and agent token changes close the affected sockets (code 4401); clients reconnect with what's current.

## MCP

Streamable HTTP at `/mcp`, stateless (`WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, new server+transport per request, JSON responses). Server name `docket-<workspace>`, title `Docket · <Workspace name>`, `websiteUrl` the public origin (`DOCKET_URL`, else the request's). The instructions open with the Docket origin, the workspace and who you are, so an agent with several connections can tell them apart. Needs an API key; tools act as its owner, in the key's workspace (no tool takes a `workspace`; a stray one is ignored); team keys, identifiers and slugs resolve there, and the instructions and `create_team` say keys are unique within this workspace. `tools/list` shows only what the key can use: a read key sees the read tools (`readOnlyHint`); agents don't see team management; only admins of the key's workspace see `update_workspace`. A call to a hidden tool is a tool error ("not found").

Tools return short markdown text (one line per issue: `BRD-3 · todo · high · Title · @assignee · →@delegate · #label`; comments as `**@author** · #id · time`) plus `structuredContent` with the JSON.

| Tool | Input | Who sees it | Notes |
|---|---|---|---|
| update_workspace | name | admins, write key | renames the key's workspace |
| list_members | | all | `@username · name · role`, marking you; assignees are people, delegates agents |
| list_teams | | all | with open-issue counts |
| create_team | key, name, description? | people, write key | |
| update_team | key, name?, description? | people, write key | |
| list_labels | | all | `label · N open`, so agents reuse existing labels |
| list_issues | team?, status?[], label?, assignee?, delegate?, parent?, query?, limit? (page size, default 50), after? | all | excludes done/canceled unless `status` given; a page ends with `after: "<cursor>"` when there's more |
| get_issue | id | all | full issue with description, creator, sub-issues, blockers, docs, comments, and history (latest 30 changes): a `## History` before the comments, one line per mutation (`time · @who · status todo → in_progress, labels +bug −ui`), prefixed `(N earlier changes)` when cut; `structuredContent` has all of it |
| create_issue | team, title, description?, status?, priority?, labels?, assignee?, delegate?, parent?, blockedBy? | write key | |
| update_issue | id + any of title, description, status, priority, labels, assignee, delegate, parent, blockedBy, baseUpdatedAt | write key | |
| claim_issue | id | write key | see Data |
| comment_issue | id, body | write key | |
| list_documents / get_document / create_document / update_document / comment_document / delete_document | see Documents | all for list/get; write key for the rest | |
| update_comment / delete_comment | issue? or document?, comment, body | write key | exactly one of issue/document; own comments only |

Tool descriptions must explain the conventions (workspace → team → issue/doc, statuses, priority numbers, identifiers, assignee vs delegate) so an agent can use them without reading docs. The instructions and every description, doc content and comment body field say to mention people or agents as `@username` (list_members has usernames). No issue delete tool: agents cancel instead. No tool touches credentials or membership (invites, keys, agents, suspension): agents never mint access.

## UI

Light theme only, neutral and modern, in the spirit of Linear, Vercel, Resend. Geist + Geist Mono (Google Fonts). White canvas, `#fafafa` sidebar, 1px `#ebebeb` borders, `#171717` text, `#737373` muted, black primary buttons, 6px radii, shadows only on popovers/modals. Small SVG status icons (Linear-like: dashed circle backlog, circle todo, half-filled in progress, three-quarter in review, check done, x canceled) and priority bars. Tight 13–14px type, generous whitespace, fast 120ms transitions. `dir="auto"` on all user text (content may be Arabic).

- **Boot**: `/setup` and `/login` render without a session. Everything else loads `GET /api/me` first; any 401, then or later, goes to `/login`.
- **Setup** (`/setup`): setup code, name, username (suggested from the name), optional email, workspace name.
- **Sign in** (`/login`): paste a sign-in link or code, or open a link (`/login#CODE`, which signs in straight away). An invite opened while signed out asks for name and username first ("Join <workspace>"); opened while signed in, it asks "Join <workspace>?" with the same fields, prefilled with your default profile, before adding you (Join or Cancel; a taken username keeps the form and says so). A sign-in link for someone else, opened while signed in, asks "Sign in as @x?", or "Sign in as @x (<workspace>)?" when the link recorded one ("Sign out <you> and sign in", or Cancel). If Docket isn't set up yet, it goes to `/setup`.
- **Sidebar**: workspace switcher (your workspaces plus "New workspace"), "New issue" (shortcut `C`), "All issues", "All docs", teams with open counts. Everything in it is scoped to the current workspace. Footer: you, with a menu of Settings, Workspace settings (admins) and Sign out.
- **Settings** (`/<ws>/settings/account`, `/<ws>/settings/workspace`): account: "Profile in <workspace>" (name and username there: "How people in <workspace> see you. Each workspace has its own."), email ("Contact info, the same in all your workspaces."), "Sign in on another device" (a sign-in link), sessions, the current workspace's API keys (made there; token and MCP command shown once). Workspace (admins; others see the member list): members (role, suspend or reinstate), invite links by role (shown once), agents (add: token and command shown once; new token; remove). The MCP command is `claude mcp add --transport http docket-<workspace> <origin>/mcp --header "Authorization: Bearer <token>"`, run in the project folder the agent works in (Claude Code's local scope; add `--scope user` to use it everywhere), so each workspace is its own server.
- **List view** (default): issues grouped by status with sticky headers and counts; Done and Canceled collapsed by default. Row: priority, identifier (mono, muted), status icon, title, labels, assignee and delegate, relative updated time.
- **Board view**: columns by status (no Canceled), cards, drag between columns or use the card's status picker (touch, keyboard) to change status.
- **Toolbar**: search (`/` to focus), a "Mine" chip, label, assignee and delegate filters, List/Board toggle. People in pickers list you first, marked "(you)".
- **Issue page** (`/<ws>/issue/BRD-12`): "Claim" in the header on an open issue whose slot (assignee for people) no other active member holds; inline-editable title; markdown description saved with `baseUpdatedAt`: on a 409 it refetches, and if only something else changed (e.g. a comment) it saves again on top; if the description itself changed, a banner shows their current text with "Use theirs" or "Keep mine". Properties panel (status, priority, assignee, delegate, labels, team, parent, blocked by) editable via small popovers; sub-issues; an Activity thread with composer (`⌘↵` to send): history interleaved with comments by time (history first on ties), one quiet line per mutation ("**Claude** moved from Todo to In Progress, set priority to High · 2m ago", the status icon when the status moved), "themselves" when someone assigns themselves; a run of more than 3 lines between two comments shows its last 2 under "Show N earlier changes" (creation always shows). Your own comments show Edit and Delete.
- **New issue modal**: team, title, description, status, priority, labels, assignee, delegate, parent. `⌘↵` creates, `Esc` closes.
- **Editor**: descriptions, comments, docs and the new issue's description are edited as rich text (WYSIWYG, Tiptap) over markdown, which stays the stored format. Markdown converts as you type (`# `, `- `, `1. `, `[] `, `> `, ```` ``` ````, `---`, `**bold**`…) and when pasted as text; pasted HTML becomes rich text without its images or media (the editor never loads a remote resource: it has no image node). `/` at the start of a line or after a space opens a block menu: Heading 1–3, Bulleted list, Numbered list, Checklist, Code block, Table, Quote, Divider. A selection shows a toolbar: bold, italic, strikethrough, code, link. Checkboxes are clickable. Issue identifiers and @mentions show as chips while editing too (decorations: the text stays as typed); `⌘/Ctrl`-click follows a link or chip in a new tab. Every block has `dir="auto"`. A **Markdown** toggle under the editor switches to the markdown source and back. **Fidelity guard**: before showing text as rich text, the editor loads and saves it twice, headlessly; if the result isn't stable after one pass, or changes what a reader sees (text, link targets, checkboxes, line breaks), the text opens in the source instead, with "Opened as markdown to keep its formatting exact." The editor hands back markdown only after a real edit (an undone one gives back the original exactly), so opening and closing never rewrites anything; an edit normalizes the whole text once (blank lines around blocks, table padding, bare URLs as links). Its code is a separate chunk, fetched on first edit: reading never loads it.
- **Workspaces**: URLs carry the workspace, as in Linear (`/acme/issue/BRD-1`); the current workspace is the URL's, and the app sends it as `X-Docket-Workspace`. It's remembered in localStorage (`docket.workspace`) on each visit; `/` goes there, else to your first. Everything shown (lists, sidebar, pickers, filters, chips) is that workspace's; live events for your other workspaces are ignored, except that workspace and member events refetch the workspace list. The switcher goes to `/<new ws>` (on settings or docs, the same page there). A workspace you aren't in shows "No access to <ws>" with a button to yours. Links made before URLs carried the workspace (`/issue/…`, `/doc/…`, `/t/…`, `/docs`, `/settings/…`) are replaced (not pushed) with the same page under `/<ws>/…`: the issue, doc or team's workspace from `GET /api/locate`, else yours, which then shows its usual not-found page.
- **Team settings**: a button next to the team title opens a dialog to edit the description (and, for admins, rename the workspace).
- Client routing with `history.pushState`: `/<ws>`, `/<ws>/t/:key`, `/<ws>/issue/:id`, `/<ws>/docs`, `/<ws>/t/:key/docs`, `/<ws>/t/:key/trash`, `/<ws>/doc/:slug`, `/<ws>/settings/*`; `/login` and `/setup` stay global. A path whose first segment is a reserved workspace key is one from before (redirected). The server returns index.html for these paths (see Deploy).
- Service worker: never caches non-OK responses; its cache honours `Vary`, so an answer cached for one workspace is never served in another; clears cached `/api/*` on a 401 and after a successful setup, redeem or logout, with a generation counter so a GET in flight across the switch can't re-cache the old session's data.
- Works on a phone: the sidebar collapses below 768px.

### Keyboard

Global (never while typing in a field, in a popover, or during IME composition):

| Key | Action |
|---|---|
| `C` | New issue |
| `/` | Focus search |
| `J` / `K` / `↓` / `↑` | Move focus between rows or cards (issues and docs lists only) |
| `Esc` | Close the mobile nav if open, else leave an issue/doc page for the last list, else blur |

In a popover picker (status, priority, assignee, delegate, labels, parent, blocked by, team, workspace switcher, account menu):

| Key | Action |
|---|---|
| `↓` / `Ctrl-N` | Next option |
| `↑` / `Ctrl-P` | Previous option |
| `Enter` | Pick |
| `Esc` | Close and refocus the trigger |
| `Tab` | Close without refocusing |

Elsewhere: `Enter` saves an inline title (issue/doc) by blurring; `⌘/Ctrl-Enter` saves or sends (description, comments, modals); `Esc` reverts an inline title or cancels an edit, or closes a modal/dialog (which also traps `Tab`); `E` opens a doc for editing, and inside it `⌘/Ctrl-S` saves immediately. In an editor: `⌘/Ctrl-B` bold, `⌘/Ctrl-I` italic, `⌘/Ctrl-E` code, `⌘/Ctrl-K` link (on a selection or in a link), `/` the block menu (`↑`/`↓`, `Enter`, `Esc` as in the @ menu). A capture-phase guard drops any keystroke from an IME composition (e.g. confirming Japanese/Chinese input) before it reaches a shortcut.

## Documents

Linear-style docs inside teams. Markdown is the source of truth (agents write via MCP).

- **documents**: id, workspace, team_id, slug (unique within the workspace: `UNIQUE (workspace, slug)`), title, content, position, created_at, updated_at, updated_by_id.
- **document_versions**: id, document_id, title, content, author_id, created_at. A version is written on every title/content change. Autosave-friendly: if the latest version has the same author and was first saved < 10 min ago, overwrite its title and content instead of inserting. Its `created_at` stays the first save's time, so a long session still gets a new version every 10 minutes. The first version (creation) and checkpoints (restores) are never merged into.
- **document_refs**: document_id, issue_id, ord. Recomputed on every content change from `\b[A-Z]{2,5}-\d+\b` matches that resolve to real issues in the doc's workspace (first-mention order).
- Slugs are unique within a workspace (two workspaces can each have `plan`) and stable: renaming a doc never changes its slug. A doc can move to another team of the same workspace. Deleting a doc moves it to the trash (see Trash); purging it deletes its versions, refs and comments.
- Search (`q`) matches title and content. Like issue search, it's a literal substring match: `%`, `_` and `\` in the query are escaped, not wildcards.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | /api/documents | `?workspace&team&q` | `DocumentSummary[]` (team key, then position) |
| POST | /api/documents | `DocumentInput` | 201 `Document` |
| GET / PATCH / DELETE | /api/documents/:slug | `DocumentPatch` | `Document` (DELETE moves it to the trash) |
| POST | /api/documents/:slug/restore | | `Document` |
| GET | /api/documents/:slug/raw | | `text/markdown; charset=utf-8` (the content) |
| POST | /api/documents/:slug/comments | `{ body }` | 201 `Document` |
| PATCH / DELETE | /api/documents/:slug/comments/:cid | `{ body }` | `Document` |
| GET | /api/documents/:slug/versions | | `DocumentVersionSummary[]` (newest first) |
| GET | /api/documents/:slug/versions/:id | | `DocumentVersion` |

`DocumentPatch.baseUpdatedAt` (optional) is the document's `updatedAt` the client started editing from: if present and different from the current one, the PATCH answers 409 `{ "error": "Document changed since you started editing" }` and changes nothing. Every save moves `updatedAt` strictly forward, so it works as a version token even for saves in the same millisecond. The web editor sends it with every save; MCP `update_document` accepts it too. `edits` errors (400) name the failing edit and whether `oldText` matched 0 or many times (overlapping occurrences count: `aa` matches `aaa` twice); nothing is applied unless every edit applies. `GET /api/issues/:id` includes `docs` (documents mentioning it). `Team` includes `docCount`.

MCP: `list_documents` (team?, query?; one line per doc: `slug · Title · TEAM · updated 2h ago by @alice`), `get_document` (slug), `create_document` (team, title, content, slug?, position?), `update_document` (slug, title?, content?, edits?, team?, position?, baseUpdatedAt?; prefer `edits` for small changes to long docs), `comment_document` (slug, body), `delete_document` (slug; to the trash, restorable by a person for 30 days, `destructiveHint`). Tool descriptions must say: docs are markdown; mention issues by identifier (e.g. BRD-2) and they auto-link; link other docs with `[Title](/doc/slug)`; use `edits` for targeted changes.

UI:
- A team's page has three tabs: Issues, Docs, Trash (`/<ws>/t/:key`, `/<ws>/t/:key/docs`, `/<ws>/t/:key/trash`).
- **Delete** moves an issue or doc to the trash at once (no confirm): the toast "Moved BRD-12 to trash" has Undo, which restores it. The team's Trash lists deleted issues and docs, newest first, each with Restore. A trashed item opened by URL shows an "In the trash" banner with Restore.
- Docs list (`/<ws>/docs`, `/<ws>/t/:key/docs`): grouped by team, ordered by position. Row: doc icon, title, "updated 2h ago by Alice". "New doc" button.
- Doc page (`/<ws>/doc/:slug`): a centered reading column (~720px), large inline-editable title, a quiet metadata line (team · updated by · time · versions). Typography built for long specs: clear heading scale, comfortable line height, tables that scroll horizontally on narrow screens, code blocks, blockquotes, task lists. `dir="auto"` on every block (Arabic). A sticky outline of h2/h3 on the right on wide screens (hidden on narrow), with the current section highlighted.
- Editing: `E` or the Edit button switches to the full-height editor in the same column (rich text, see UI; its Markdown toggle shows the monospace source), with the caret and scroll where you were reading. Autosave ~1s after typing stops with a quiet "Saving… / Saved" indicator, `⌘S` saves now, `Esc` returns to reading. If the doc changes remotely while editing, don't clobber: show a small banner "Updated by Alice · Reload".
- History: a side panel of versions (author, time); click to preview, "Restore" writes that content as a new version.
- Below the content: "Issues in this doc" (status icon, identifier, title) and a comment thread (same component as issues).
- Everywhere markdown renders (issue descriptions, comments, docs): bare identifiers of existing issues (e.g. `MVP-12`) become inline chips with the status icon linking to the issue (`/<ws>/issue/:id`); links to `/doc/:slug`, `/issue/:id`, `/t/:key` and `/docs` point into the workspace of the content shown (stored content is never rewritten; `[Title](/doc/slug)` stays the convention) and route client-side. `@username` of an active member of that workspace (the Data syntax rule, not in link text) becomes a plain-text chip, `@username` with the name as its title, agents tinted; `dir="ltr"` keeps it whole in Arabic text, and nothing loads. Unknown or suspended names stay text.
- **@ autocomplete** in every editor (description, new issue, comments, doc editor; rich text or source): typing `@` at the start, after a space or `(`/`[` offers up to 8 active members (people, then agents; not you) whose username or name starts with what follows: avatar, name, muted `@username`, an "Agent" tag. `↑`/`↓` move, `Enter` or `Tab` inserts `@username `, `Esc` closes it (and does nothing else), click works. It sits under the `@` (above when there's no room), inside the viewport; full width on phones.
- Issue page: a "Docs" section listing documents that mention the issue.
- New doc: modal with team and title, then opens straight into edit mode.

## Deploy

The server serves the web app at `/`, `/login`, `/setup`, `/:ws` and `/:ws/*`, and at the paths from before URLs carried the workspace (`/settings/*`, `/t/*`, `/issue/*`, `/docs`, `/doc/*`) so the app can redirect them; `/api/*` and known files win over `/:ws`, and unknown `/icons/*` stay plain 404s.

`Dockerfile` (oven/bun image) + `docker-compose.yml`: volume `./data:/app/data`, port `127.0.0.1:7100:7100`, `restart: unless-stopped`. HTTPS and exposure are the operator's choice (reverse proxy, tunnel, VPN). Anything reached by a hostname other than localhost needs that hostname in `DOCKET_HOSTS`, or data routes answer 403. On first start, the setup code is in the container's log (`docker compose logs docket`). Locked out: `docker compose exec docket bun run sign-in-link <username> [workspace]` prints a one-time link (name the workspace if several people hold that username) (set `DOCKET_URL` so it points at the public origin).

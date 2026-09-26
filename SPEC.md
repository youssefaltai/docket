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

**Accounts** (`users`): people (`kind: "person"`) and agents (`kind: "agent"`). The username is the identity; a person's email is optional contact info, unique across accounts (case-insensitively; 409 on a clash), not yet verified (there's no mail) and never used to find an account. Everyone has a unique `username` (lowercase `a-z 0-9 . _ -`, 2–32 characters, starting with a letter or digit; `me` is reserved) and a display `name`. The API names people and agents by username; responses carry `UserRef = { username, name, kind }`. No passwords.

**Workspaces** (`workspace_members`): each membership has a role, `admin`, `member` or `agent` (agents work in teams but manage nothing), and may be suspended. You see only workspaces where you're an active member; anything in another workspace answers 404, as if it didn't exist. Any person can create a workspace and becomes its admin. Admins rename the workspace, create invite links, change roles, suspend and reinstate members, and add, re-token and remove agents. No one can sign in as someone else: there's no admin sign-in link or impersonation. The last active admin can't be suspended or demoted (409 "Add another admin first").

**Suspend** (`PATCH …/members/:username { suspended: true }`) ends access to that workspace at once (membership is checked on every request; their sockets reconnect without it). If it was their last active membership, their credentials are invalidated as in Linear: sessions, API keys and unused codes are deleted, so reinstating (`suspended: false`) gives a clean account that signs in again (the server's CLI). While they're still active in another workspace their credentials stay, so one workspace's admin can't sign them out of the others. Suspending or demoting an admin also deletes the unused invites they made there. They stay listed, greyed, so history keeps their name. Removing an agent is suspending it; a new token reinstates it.

**Credentials.** Secrets are random and stored only as SHA-256 hashes.
- **Session**: the web UI's cookie `docket_session` (32 random bytes as hex; HttpOnly, SameSite=Lax, Secure over HTTPS, 30 days, re-sent while in use). Idle for 30 days (by `last_seen_at`, touched at most once a minute) and it's gone. Account settings list sessions (device, IP, last seen), revoke one, or sign out everywhere else.
- **API key**: `Authorization: Bearer dk_<64 hex>`, for scripts, MCP clients and agents; it acts as its owner. People make their own (named, scope `read` or `write`) and revoke them. A read key gets 403 on anything but GET (REST) and on tools that change something (MCP). An agent's token is an API key it owns.
- **Managing access needs a session**: listing, making or revoking API keys, listing or revoking sessions, making sign-in links and invites, changing your profile, changing members and adding or re-tokening agents all answer 403 to an API key. A leaked key can't mint credentials that outlive it, or lock its owner out of their other keys.
- **One-time codes**: 10 symbols of `A–Z 2–9` without `I O 0 1` (50 bits), shown as `XXXXX-XXXXX`, single-use, 15 minutes. A link is `<origin>/login#<code>`: the fragment never reaches the server or its logs, and the page removes it from the address bar at once.
  - **Invites** (a workspace and role) are handed over by the admin, not tied to anyone: redeemed while signed in, one adds you to the workspace; signed out, it creates a new account (name, username, optional email).
  - **Sign-in links** open one person's account: from yourself (to sign in on another device), or from the server's shell (`bun run sign-in-link <username>`, for when nobody can sign in). Redeeming one while signed in as someone else deletes that session first, so the browser is never signed in as two people. Suspension from your last workspace deletes your unused codes.
- **Setup code**: while there are no users, the server prints one at startup (`DOCKET_SETUP_CODE` fixes it, e.g. for tests and dev). `POST /api/setup` with it creates the first person, signed in, as admin of a new workspace. A wrong code is 403; once any user exists, 409.

**Rules for every request** (`auth.ts`): `/api/*` accepts a session cookie or an API key; `/mcp` only an API key; `/ws` either. Cookies ride along on same-site requests (a sibling subdomain, another localhost port), so a cookie-authed WebSocket or non-GET request needs our own `Origin` (403 otherwise), and an invite only joins the signed-in user when it does. No or bad credentials: 401 (a 401 caused by a stale cookie also clears it). Signed in but not allowed (not an admin, read-only key, someone else's comment): 403. Outside your workspaces: 404. Request bodies must be `Content-Type: application/json`, compared exactly on the media type before any `;` (so `text/plain;charset=application/json` is refused), else 415: browsers can't send that cross-origin without a CORS preflight, which Docket never allows, so this is the CSRF defence. Host check (DNS rebinding): `/api/*`, `/mcp` and `/ws` answer 403 unless the `Host` header's hostname (port ignored, case-insensitive) is `localhost`, `127.0.0.1`, `[::1]` or listed in `DOCKET_HOSTS`. Setup and code attempts are rate-limited per client IP: after 10 failures (401/403) in a minute, 429 until the minute ends (behind a proxy, all clients share the proxy's IP). The app shell, manifest, service worker and icons stay public; they hold no data.

**HTTP layer** (`http.ts`): every response carries `Content-Security-Policy` (`default-src 'self'`, plus Google Fonts and `https:` images for markdown; `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`; no inline script), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and over HTTPS `Strict-Transport-Security`; API answers add `Cache-Control: no-store`. Request bodies over 1 MB answer 413. Texts are capped: titles 500 characters, names 200, descriptions and comments 100,000, doc content 500,000 (also after `edits`), else 400. Each credential (API key or session; no credential: the client IP) gets a token bucket of 600 requests refilling at 20 a second across `/api`, `/mcp` and `/ws`; past it, 429 with `Retry-After`. In production the web app is built once at startup and served with these headers; `bun run dev` keeps Bun's hot-reloading server.

**Assistant proxy** (`chat.ts`, when `CHAT_URL` is set; `GET /api/me` says `chat: true`): `/api/chat` and `/api/chat/*` go to `{CHAT_URL}/chat[/*]` (docket-chat's `CHAT_API.md`). Only a browser session gets through (an API key: 403), after the usual Origin, rate-limit and JSON checks; bodies over 16 KB answer 413. The path must stay under `/chat` once resolved (`/api/chat/%2e%2e/x` is a 404, never `{CHAT_URL}/x`). It forwards the method, query, body, `Content-Type`, `Accept` and `Last-Event-ID`, never cookies, and sets `Authorization: Bearer <chat key>`; it sends back the status, `Content-Type`, `Cache-Control`, `Retry-After`, `X-Accel-Buffering` and the body unbuffered (SSE), and aborts upstream when the browser does (Stop). Answers other than JSON or an event stream become 502, so nothing the service sends renders as a page on Docket's origin. The service has 90 s to start answering and 5 minutes in all. Its own errors look like the service's: `{error, code}` (`not_configured` or `not_found` 404, `forbidden` 403, `invalid` 413/415, `chat_unavailable` 502, `timeout` 504). Docket's usual checks answer first, as `{error}` without a code: 401 (no session), 403 (cross-origin), 413 (over 1 MB), 429 (rate limit). Without `CHAT_URL`, 404.

**Chat keys**: a read API key per browser session, named "Chat (automatic)", minted by the proxy and kept only hashed (the token lives in the server's memory). It lives 30 minutes (`DOCKET_CHAT_KEY_TTL_MS`) and is reused while it has two thirds of that left, so a forwarded key always has 20 minutes to go. It's deleted with its session (sign-out, revoke, suspension, idle expiry) and doesn't appear in the key list. One request writes: a `POST /api/chat/actions/:id/confirm` (the person confirming a change the assistant proposed; matched exactly on the resolved path) gets a write chat key minted for it alone, deleted when that answer ends, fails or is stopped, with 5 minutes as a backstop. Every other chat request reads. `GET /api/me` answers `credential: "session" | "key" | "chat"`, so docket-chat can accept only chat keys. Any key past `expires_at` is dead everywhere (401) and purged at startup, hourly and on each mint.

**Stale tabs**: tabs share one cookie, so the web app sends `X-Docket-User: <username it shows>` with every request. If it's not the signed-in user (someone signed in as someone else in another tab), the request gets 401 `{ switched: true }` and the tab reloads as whoever is really signed in, instead of acting as them under the old name.

**Workspaces can't be deleted** yet (like projects before them); a person who can sign in can always create one.

**Authors** are never sent by clients: every write is attributed to the signed-in user or agent. Only a comment's author can edit or delete it (403 otherwise, with no admin override).

**Public routes** (Host and JSON checks, rate-limited, no credentials):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/setup | | `{ needed }` |
| POST | /api/setup | `SetupInput` `{ code, name, username, email?, workspace: { name, key? } }` | 201 `{ user, workspace }` + session cookie |
| POST | /api/auth/peek | `{ code }` | `CodeInfo` `{ kind, workspace, username, you, needsProfile }` (changes nothing; `you` is who's signed in, whom an invite would add or a sign-in link would replace) |
| POST | /api/auth/redeem | `{ code, name?, username?, email? }` | `{ user }` + session cookie; an invite adds the membership (signed out, it needs name and username for the new account) |
| POST | /api/logout | `{}` | ends this cookie's session and clears it |

**Account and workspace routes** (signed in):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET / PATCH | /api/me | `{ name?, username?, email? }` | `Me` `{ user, workspaces: [{ key, name, role }] }`; only here does `user` carry its numeric `id`, stable across renames (docket-chat keys history by it) |
| GET | /api/sessions | | `Session[]` (`current` marks this one) |
| DELETE | /api/sessions, /api/sessions/:id | | all but this one, or one |
| POST | /api/sign-in-links | | 201 `CodeLink` `{ code, url, expiresAt }` for yourself |
| GET / POST | /api/api-keys | `{ name, scope? }` | `ApiKey[]`; 201 `{ apiKey, token }` (token shown once) |
| DELETE | /api/api-keys/:id | | revokes |
| GET / POST | /api/workspaces | `WorkspaceInput` | yours, with your `role`; 201, you're its admin |
| PATCH | /api/workspaces/:key | `{ name }` | (admin) |
| GET | /api/workspaces/:key/members | | `WorkspaceMember[]` (people, then agents) |
| PATCH | /api/workspaces/:key/members/:username | `{ role?, suspended? }` | (admin) |
| POST | /api/workspaces/:key/invites | `{ role? }` | (admin) 201 `CodeLink` |
| POST | /api/workspaces/:key/agents | `{ name, username }` | (admin) 201 `{ agent, token }` |
| POST | /api/workspaces/:key/agents/:username/token | | (admin) `{ token }`: the old one dies; reinstates a removed agent |
| DELETE | /api/workspaces/:key/agents/:username | | (admin) removes it |

## Data

Migration 1 creates the schema (`db.ts`); migration 2 adds `deleted_at` to issues and documents (the trash) and a unique index on `lower(users.email)` (older duplicates keep the email on the oldest account). WAL mode on.

- **users**, **workspaces**, **workspace_members**, **sessions**, **api_keys**, **codes**: see Access.
- **teams**: key (PK, 2–5 uppercase letters, unique across all workspaces), workspace, name, description, next_number, created_at, updated_at.
- **issues**: id, team_key, number (per-team sequence from `teams.next_number`; never reused after a delete), title, description, status, priority, labels (JSON array), assignee_id (a person), delegate_id (an agent), creator_id, parent_id, created_at, updated_at, completed_at. Unique (team_key, number).
- **issue_blocks**: blocker_id, blocked_id. No cycles: setting `blockedBy` fails (400) if the issue itself or any issue it already blocks, directly or through a chain, is among the blockers.
- **comments** / **document_comments**: id, issue_id / document_id, author_id, body, created_at, edited_at.
- **documents**, **document_versions**, **document_refs**: see Documents.

Identifier = `${team_key}-${number}`, parsed case-insensitively. Issues can't move between teams. Parents, blockers and doc refs never cross workspaces. Any change to an issue or its comments bumps `updated_at`, strictly forward (at least 1 ms past its previous value, even within one millisecond), since it doubles as the version token for `baseUpdatedAt`; `db.ts` keeps that rule in one place per layer (`bumpedAt` in JS, `BUMPED_AT` in SQL), shared with documents. Creating an issue with a parent or blockers bumps and publishes them. Moving an issue to or from the trash also bumps and publishes its sub-issues, its parent, and the issues it blocked or was blocked by; docs that mentioned it get a `document` event. Changing an issue's parent or blockers likewise bumps and publishes the old and new parent and each blocker added or removed. `completed_at` is set when status enters done/canceled, cleared when it leaves. New issues start in `backlog` (as in Linear). List order: status order, then priority (1→4, then 0 last), then `updated_at` desc.

**Trash** (Linear's delete): deleting an issue or doc sets `deleted_at` (`deletedAt` in the API). It leaves lists, search, labels, team counts, relations (`blockedBy`, `blocks`, sub-issues) and doc refs, but keeps its links, so restoring (`POST …/restore`) puts everything back. Sub-issues of a trashed issue stay, still pointing at it. A trashed item can be read (with `deletedAt`) and restored, nothing else: edits, comments, claims and new relations to it answer 409 or 400. After 30 days in the trash it's deleted for good (with its comments, versions and refs), at startup and whenever something is trashed, restored or the trash is listed. Deleting or restoring twice is 409.

**Assignee and delegate** (Linear's model): the assignee is a person who owns the issue; the delegate is an agent working on it for them. Each must be an active member of the issue's workspace of the right kind (400 otherwise, e.g. "claude-a is an agent; set it as the delegate"). `me` means the caller, in values and filters.

**Claim** (`POST /api/issues/:id/claim`, MCP `claim_issue`): a person takes the assignee slot, an agent the delegate slot; an unstarted issue (`backlog`, `todo`) moves to `in_progress`, one already started (`in_progress`, `in_review`) keeps its status. One IMMEDIATE transaction reads and writes, so of two claims racing for a free issue exactly one wins. A done or canceled issue is 409 `"<ID> is done"`; one whose slot another active member holds is 409 `"<ID> is claimed by <username>"` (a suspended holder doesn't count). Claiming your own again changes nothing. To hand it back, clear the slot and set status todo.

**Issue versions**: `IssuePatch.baseUpdatedAt`: if present and different from the current `updatedAt`, the PATCH (or `update_issue`) answers 409 `{ "error": "Issue changed since you read it" }` and changes nothing; the check and the write share one IMMEDIATE transaction. Comments bump `updatedAt` too, so send it where lost updates happen (description, and the whole-list `labels` and `blockedBy`), not for single-field changes like status or priority.

## REST (JSON; errors are `{ "error": string }` with 4xx)

Plus the Access routes above. Lists only ever include your workspaces. A filter naming something unknown (a workspace or team you can't see, a username who isn't in the workspaces searched, a parent that doesn't exist) is 400 `Unknown …`, not an empty list; a label nobody uses yet just finds nothing. PATCH bodies take only the fields listed for them: anything else is 400 naming the field (e.g. `"team"`: issues can't move between teams).

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | /api/teams | `?workspace` | `Team[]` |
| POST | /api/teams | `TeamInput` (workspace required) | 201 `Team` |
| PATCH | /api/teams/:key | `{ name?, description? }` (teams never change workspace: 400) | `Team` |
| GET | /api/issues | `?workspace&team&status=a,b&label&assignee&delegate&parent&q`, plus `first` (1–500) and `after` to page | `IssueSummary[]`; with `first`/`after`, `IssuePage` `{ issues, pageInfo: { hasNextPage, endCursor } }` |
| POST | /api/issues | `IssueInput` | 201 `Issue` |
| GET / PATCH / DELETE | /api/issues/:id | `IssuePatch` (title, description, status, priority, labels, assignee, delegate, parent, blockedBy, baseUpdatedAt) | `Issue` (DELETE moves it to the trash) |
| POST | /api/issues/:id/restore | | `Issue` |
| GET | /api/teams/:key/trash | | `Trash` `{ issues, documents }`, newest first |
| POST | /api/issues/:id/claim | | `Issue` |
| POST | /api/issues/:id/comments | `{ body }` | 201 `Issue` |
| PATCH / DELETE | /api/issues/:id/comments/:cid | `{ body }` | `Issue` (own comments only; a `:cid` not on that issue is 404) |
| GET | /api/labels | `?workspace` | `string[]` (distinct, sorted) |

Editing a comment sets `editedAt`; deleting is permanent. Both bump the issue like adding one; doc comments never bump the doc (so an open editor gets no conflict).

## Realtime

`GET /ws` upgrades to a WebSocket that subscribes to the caller's workspaces. After every mutation (REST or MCP) the server publishes a `ServerEvent` `{ type: "changed", entity, workspace, id }` to that workspace's sockets only. The UI refetches what it's showing. Signing out, revoking a session or key, suspension and agent token changes close the affected sockets (code 4401); clients reconnect with what's current.

## MCP

Streamable HTTP at `/mcp`, stateless (`WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, new server+transport per request, JSON responses). Server name `docket`. Needs an API key; tools act as its owner.

Tools return short markdown text (one line per issue: `BRD-3 · todo · high · Title · @assignee · →@delegate · #label`; comments as `**@author** · #id · time`) plus `structuredContent` with the JSON.

| Tool | Input | Notes |
|---|---|---|
| list_workspaces | | yours, with your role and team counts |
| create_workspace | key?, name | people only |
| update_workspace | key, name | admins |
| list_members | workspace? | `@username · name · role`, marking you; assignees are people, delegates agents |
| list_teams | workspace? | with workspace and open-issue counts |
| create_team | key, name, workspace?, description? | workspace required when you're in more than one |
| update_team | key, name?, description? | |
| list_labels | workspace? | `label · N open`, so agents reuse existing labels |
| list_issues | workspace?, team?, status?[], label?, assignee?, delegate?, parent?, query?, limit? (page size, default 50), after? | excludes done/canceled unless `status` given; a page ends with `after: "<cursor>"` when there's more |
| get_issue | id | full issue with description, creator, sub-issues, blockers, docs, comments |
| create_issue | team, title, description?, status?, priority?, labels?, assignee?, delegate?, parent?, blockedBy? | |
| update_issue | id + any of title, description, status, priority, labels, assignee, delegate, parent, blockedBy, baseUpdatedAt | |
| claim_issue | id | see Data |
| comment_issue | id, body | |
| list_documents / get_document / create_document / update_document / comment_document / delete_document | see Documents | |
| update_comment / delete_comment | issue? or document?, comment, body | exactly one of issue/document; own comments only |

Tool descriptions must explain the conventions (workspace → team → issue/doc, statuses, priority numbers, identifiers, assignee vs delegate) so an agent can use them without reading docs. No issue delete tool: agents cancel instead. No tool touches credentials or membership (invites, keys, agents, suspension): agents never mint access.

## UI

Light theme only, neutral and modern, in the spirit of Linear, Vercel, Resend. Geist + Geist Mono (Google Fonts). White canvas, `#fafafa` sidebar, 1px `#ebebeb` borders, `#171717` text, `#737373` muted, black primary buttons, 6px radii, shadows only on popovers/modals. Small SVG status icons (Linear-like: dashed circle backlog, circle todo, half-filled in progress, three-quarter in review, check done, x canceled) and priority bars. Tight 13–14px type, generous whitespace, fast 120ms transitions. `dir="auto"` on all user text (content may be Arabic).

- **Boot**: `/setup` and `/login` render without a session. Everything else loads `GET /api/me` first; any 401, then or later, goes to `/login`.
- **Setup** (`/setup`): setup code, name, username (suggested from the name), optional email, workspace name.
- **Sign in** (`/login`): paste a sign-in link or code, or open a link (`/login#CODE`, which signs in straight away). An invite opened while signed out asks for name and username first ("Join <workspace>"); opened while signed in, it asks "Join <workspace>?" (as you, with Join and Cancel) before adding you. A sign-in link for someone else, opened while signed in, asks "Sign in as @x?" ("Sign out <you> and sign in", or Cancel). If Docket isn't set up yet, it goes to `/setup`.
- **Sidebar**: workspace switcher (your workspaces plus "New workspace"), "New issue" (shortcut `C`), "All issues", "All docs", teams with open counts. Everything in it is scoped to the current workspace. Footer: you, with a menu of Settings, Workspace settings (admins) and Sign out.
- **Settings** (`/settings/account`, `/settings/workspace`): account: profile, "Sign in on another device" (a sign-in link), sessions, API keys (token and MCP command shown once). Workspace (admins; others see the member list): members (role, suspend or reinstate), invite links by role (shown once), agents (add: token and `claude mcp add … --header "Authorization: Bearer <token>"` shown once; new token; remove).
- **List view** (default): issues grouped by status with sticky headers and counts; Done and Canceled collapsed by default. Row: priority, identifier (mono, muted), status icon, title, labels, assignee and delegate, relative updated time.
- **Board view**: columns by status (no Canceled), cards, drag between columns or use the card's status picker (touch, keyboard) to change status.
- **Toolbar**: search (`/` to focus), a "Mine" chip, label, assignee and delegate filters, List/Board toggle. People in pickers list you first, marked "(you)".
- **Issue page** (`/issue/BRD-12`): "Claim" in the header on an open issue whose slot (assignee for people) no other active member holds; inline-editable title; markdown description saved with `baseUpdatedAt`: on a 409 it refetches, and if only something else changed (e.g. a comment) it saves again on top; if the description itself changed, a banner shows their current text with "Use theirs" or "Keep mine". Properties panel (status, priority, assignee, delegate, labels, team, parent, blocked by) editable via small popovers; sub-issues; comments thread with composer (`⌘↵` to send). Your own comments show Edit and Delete.
- **New issue modal**: team, title, description, status, priority, labels, assignee, delegate, parent. `⌘↵` creates, `Esc` closes.
- **Workspaces**: the current workspace is remembered in localStorage (`docket.workspace`), falling back to the first. `/` and `/docs` show only its content; pickers and filters list only its teams, members and labels. Opening `/t/:key`, `/issue/:id` or `/doc/:slug` of another of your workspaces switches to it.
- **Team settings**: a button next to the team title opens a dialog to edit the description (and, for admins, rename the workspace).
- Client routing with `history.pushState`: `/`, `/t/:key`, `/issue/:id`, `/docs`, `/t/:key/docs`, `/t/:key/trash`, `/doc/:slug`, `/settings/*`, `/login`, `/setup`. The server returns index.html for these paths.
- Service worker: never caches non-OK responses; clears cached `/api/*` on a 401 and after a successful setup, redeem or logout, with a generation counter so a GET in flight across the switch can't re-cache the old session's data.
- Works on a phone: the sidebar collapses below 768px.

## Documents

Linear-style docs inside teams. Markdown is the source of truth (agents write via MCP).

- **documents**: id, slug (unique), team_key, title, content, position, created_at, updated_at, updated_by_id.
- **document_versions**: id, document_id, title, content, author_id, created_at. A version is written on every title/content change. Autosave-friendly: if the latest version has the same author and was first saved < 10 min ago, overwrite its title and content instead of inserting. Its `created_at` stays the first save's time, so a long session still gets a new version every 10 minutes. The first version (creation) and checkpoints (restores) are never merged into.
- **document_refs**: document_id, issue_id, ord. Recomputed on every content change from `\b[A-Z]{2,5}-\d+\b` matches that resolve to real issues in the doc's workspace (first-mention order).
- Slugs are stable: renaming a doc never changes its slug. A doc can move to another team of the same workspace. Deleting a doc moves it to the trash (see Trash); purging it deletes its versions, refs and comments.
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

MCP: `list_documents` (workspace?, team?, query?; one line per doc: `slug · Title · TEAM · updated 2h ago by @alice`), `get_document` (slug), `create_document` (team, title, content, slug?, position?), `update_document` (slug, title?, content?, edits?, team?, position?, baseUpdatedAt?; prefer `edits` for small changes to long docs), `comment_document` (slug, body), `delete_document` (slug; to the trash, restorable by a person for 30 days, `destructiveHint`). Tool descriptions must say: docs are markdown; mention issues by identifier (e.g. BRD-2) and they auto-link; link other docs with `[Title](/doc/slug)`; use `edits` for targeted changes.

UI:
- A team's page has three tabs: Issues, Docs, Trash (`/t/:key`, `/t/:key/docs`, `/t/:key/trash`).
- **Delete** moves an issue or doc to the trash at once (no confirm): the toast "Moved BRD-12 to trash" has Undo, which restores it. The team's Trash lists deleted issues and docs, newest first, each with Restore. A trashed item opened by URL shows an "In the trash" banner with Restore.
- Docs list (`/docs`, `/t/:key/docs`): grouped by team, ordered by position. Row: doc icon, title, "updated 2h ago by Alice". "New doc" button.
- Doc page (`/doc/:slug`): a centered reading column (~720px), large inline-editable title, a quiet metadata line (team · updated by · time · versions). Typography built for long specs: clear heading scale, comfortable line height, tables that scroll horizontally on narrow screens, code blocks, blockquotes, task lists. `dir="auto"` on every block (Arabic). A sticky outline of h2/h3 on the right on wide screens (hidden on narrow), with the current section highlighted.
- Editing: `E` or the Edit button switches to a full-height markdown textarea (monospace, same column). Autosave ~1s after typing stops with a quiet "Saving… / Saved" indicator, `⌘S` saves now, `Esc` returns to reading. If the doc changes remotely while editing, don't clobber: show a small banner "Updated by Alice · Reload".
- History: a side panel of versions (author, time); click to preview, "Restore" writes that content as a new version.
- Below the content: "Issues in this doc" (status icon, identifier, title) and a comment thread (same component as issues).
- Everywhere markdown renders (issue descriptions, comments, docs): bare identifiers of existing issues (e.g. `MVP-12`) become inline chips with the status icon linking to the issue; links to `/doc/:slug` and `/issue/:id` route client-side.
- Issue page: a "Docs" section listing documents that mention the issue.
- New doc: modal with team and title, then opens straight into edit mode.

## Deploy

`Dockerfile` (oven/bun image) + `docker-compose.yml`: volume `./data:/app/data`, port `127.0.0.1:7100:7100`, `restart: unless-stopped`. HTTPS and exposure are the operator's choice (reverse proxy, tunnel, VPN). Anything reached by a hostname other than localhost needs that hostname in `DOCKET_HOSTS`, or data routes answer 403. On first start, the setup code is in the container's log (`docker compose logs docket`). Locked out: `docker compose exec docket bun run sign-in-link <username>` prints a one-time link (set `DOCKET_URL` so it points at the public origin).

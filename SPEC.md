# Docket

A nano issue tracker: workspaces, projects, issues, comments. Web UI for humans, MCP for agents. Bun + SQLite + TypeScript. Self-hosted anywhere. Optional single access token (`DOCKET_TOKEN`); unset means open, for private networks.

Rules: minimal, simple, clean, smooth. Few dependencies (react, react-dom, marked, zod, @modelcontextprotocol/sdk). No frameworks beyond that.

## Layout

```
src/shared/types.ts   the contract (do not change without updating both sides)
src/server/index.ts   Bun.serve: routes, /api, /mcp, /ws, serves the web app
src/server/config.ts  loads an optional XDG config file into process.env (imported first)
src/server/paths.ts   XDG Base Directory resolution
src/server/db.ts      bun:sqlite schema, migrations, queries
src/server/api.ts     REST handlers
src/server/mcp.ts     MCP server + tools
src/web/index.html    HTML entry (Bun HTML import, bundled by Bun)
src/web/*.tsx, *.css  React UI
```

Env vars and the optional XDG config file: see README's Configuration section. Dev: `bun run dev` (uses `./dev.db` unless `DATABASE_PATH` is set). Tests: `bun test`, black-box over HTTP against a temp database. Prod: `bun run start` (sets `NODE_ENV=production`, so Bun serves bundled assets and never shows its dev error page).

## Data

- **workspaces**: key (PK, URL-safe lowercase slug, e.g. `acme`), name, created_at, updated_at.
- **projects**: key (PK, 2–5 uppercase letters, unique across all workspaces), workspace (→ workspaces.key; required by the app), name, description, next_number (the next issue number), created_at, updated_at.
- **issues**: id (PK), project_key, number (per-project sequence from `projects.next_number`; never reused after a delete), title, description, status, priority, labels (JSON array), assignee, parent_id, created_at, updated_at, completed_at. Unique (project_key, number).
- **issue_blocks**: blocker_id, blocked_id. No cycles: setting `blockedBy` fails (400) if the issue itself or any issue it already blocks, directly or through a chain, is among the blockers.
- **comments**: id, issue_id, author, body, created_at, edited_at (set on each edit, else null).

Identifier = `${project_key}-${number}`, parsed case-insensitively. Issues can't move between projects. Any change to an issue or its comments bumps `updated_at`. Deleting an issue also bumps `updated_at` on, and publishes `issue` events for, its sub-issues (parent cleared), its parent, and the issues it blocked or was blocked by; docs that mentioned it get a `document` event. Changing an issue's parent or blockers likewise bumps and publishes the old and new parent and each blocker added or removed. `completed_at` is set when status enters done/canceled, cleared when it leaves. List order: status order, then priority (1→4, then 0 last), then `updated_at` desc. WAL mode on.

## REST (JSON; errors are `{ "error": string }` with 4xx)

Request bodies (including `POST /api/login`) must be `Content-Type: application/json`, compared exactly on the media type before any `;` (so `text/plain;charset=application/json` is refused), else 415. Browsers can't send that cross-origin without a CORS preflight, which Docket never allows: this is the CSRF defence.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | /api/workspaces | | `Workspace[]` (by name) |
| POST | /api/workspaces | `WorkspaceInput` | `Workspace` |
| PATCH | /api/workspaces/:key | `{ name }` | `Workspace` |
| GET | /api/projects | `?workspace` | `Project[]` |
| POST | /api/projects | `ProjectInput` (workspace required) | `Project` |
| PATCH | /api/projects/:key | `{ name?, description?, workspace? }` (workspace moves it) | `Project` |
| GET | /api/issues | `?workspace&project&status=a,b&label&assignee&parent&q` | `IssueSummary[]` |
| POST | /api/issues | `IssueInput` | `Issue` |
| GET | /api/issues/:id | | `Issue` |
| PATCH | /api/issues/:id | `IssuePatch` | `Issue` |
| DELETE | /api/issues/:id | | `{ ok: true }` |
| POST | /api/issues/:id/comments | `{ body, author? }` (author default "anonymous") | `Issue` |
| PATCH | /api/issues/:id/comments/:cid | `{ body, author? }` | `Issue` |
| DELETE | /api/issues/:id/comments/:cid | `{ author? }` | `Issue` |
| GET | /api/labels | `?workspace` | `string[]` (distinct, sorted) |

Only a comment's author (case-insensitive) may edit or delete it, else 403. Authors are self-declared, so this guards against mistakes (an agent rewriting a person's note), not abuse. A `:cid` not on that issue or doc is 404. Editing sets `editedAt`; deleting is permanent. Both bump the issue's `updated_at` like adding a comment; doc comments never bump the doc (so an open editor gets no conflict).

## Realtime

`GET /ws` upgrades to a WebSocket. After every mutation (REST or MCP) the server publishes a `ServerEvent` to all clients. The UI refetches what it's showing.

## MCP

Streamable HTTP at `/mcp`, stateless (`WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, new server+transport per request, JSON responses). Server name `docket`.

Tools return short markdown text (one line per issue: `BRD-3 · todo · high · Title · @assignee · #label`) plus `structuredContent` with the JSON.

| Tool | Input | Notes |
|---|---|---|
| list_workspaces | | with project counts |
| create_workspace | key?, name | key defaults to the slugified name |
| update_workspace | key, name | rename; the key never changes |
| list_projects | workspace? | with workspace and open-issue counts |
| create_project | key, name, workspace?, description? | workspace required when more than one exists, else the only one |
| update_project | key, name?, description?, workspace? | workspace moves it; the key never changes |
| list_issues | workspace?, project?, status?[], label?, assignee?, parent?, query?, limit? (default 50) | excludes done/canceled unless `status` given |
| get_issue | id | full issue with description, sub-issues, blockers, comments |
| create_issue | project, title, description?, status?, priority?, labels?, assignee?, parent?, blockedBy? | |
| update_issue | id + any of title, description, status, priority, labels, assignee, parent, blockedBy | |
| comment_issue | id, body, author? (default "claude") | use for progress notes |
| list_labels | workspace? | `label · N open`, so agents reuse existing labels |

Tool descriptions must explain the conventions (workspace → project → issue/doc, statuses, priority numbers, identifiers) so an agent can use them without reading docs. No issue delete tool: agents cancel instead.

## UI

Light theme only, neutral and modern, in the spirit of Linear, Vercel, Resend. Geist + Geist Mono (Google Fonts). White canvas, `#fafafa` sidebar, 1px `#ebebeb` borders, `#171717` text, `#737373` muted, black primary buttons, 6px radii, shadows only on popovers/modals. Small SVG status icons (Linear-like: dashed circle backlog, circle todo, half-filled in progress, three-quarter in review, check done, x canceled) and priority bars. Tight 13–14px type, generous whitespace, fast 120ms transitions. `dir="auto"` on all user text (content may be Arabic).

- **Sidebar**: workspace switcher (current workspace name; popover lists workspaces plus "New workspace"), "New issue" (shortcut `C`), "All issues", projects with open counts. Everything in it is scoped to the current workspace.
- **List view** (default): issues grouped by status with sticky headers and counts; Done and Canceled collapsed by default. Row: priority, identifier (mono, muted), status icon, title, labels, assignee initial, relative updated time.
- **Board view**: columns by status (no Canceled), cards, drag between columns or use the card's status picker (touch, keyboard) to change status.
- **Toolbar**: search (`/` to focus), label and assignee filters, List/Board toggle.
- **Issue page** (`/issue/BRD-12`): inline-editable title; markdown description with edit toggle; properties panel (status, priority, assignee, labels, project, parent, blocked by) editable via small popovers; sub-issues; comments thread with composer (`⌘↵` to send).
- **New issue modal**: project, title, description, status, priority, labels, assignee, parent. `⌘↵` creates, `Esc` closes.
- **Workspaces**: the current workspace is remembered in localStorage (`docket.workspace`), falling back to the first. `/` and `/docs` show only its content; the new issue/doc project pickers list only its projects, and assignee/label pickers and filters only its people and labels; a new project is created in it. Opening `/p/:key`, `/issue/:id` or `/doc/:slug` of another workspace's project switches to that workspace. "New workspace" is a name-only modal. Project keys stay globally unique, so identifiers and routes don't change.
- Client routing with `history.pushState`: `/`, `/p/:key`, `/issue/:id`, `/docs`, `/p/:key/docs`, `/doc/:slug`. The server returns index.html for these paths.
- Works on a phone: the sidebar collapses below 768px.

## Documents

Linear-style docs inside projects. Markdown is the source of truth (agents write via MCP). Types in `src/shared/types.ts`.

**Data**:
- **documents**: id, slug (unique), project_key, title, content, position, created_at, updated_at, updated_by.
- **document_versions**: id, document_id, title, content, author, created_at. A version is written on every title/content change. Autosave-friendly: if the latest version has the same author and was first saved < 10 min ago, overwrite its title and content instead of inserting. Its `created_at` stays the first save's time, so a long session still gets a new version every 10 minutes. The first version (creation) and checkpoints (restores) are never merged into.
- **document_refs**: document_id, issue_id, ord. Recomputed on every content change from `\b[A-Z]{2,5}-\d+\b` matches that resolve to real issues (first-mention order).
- Document comments: same `Comment` shape as issues, stored in a separate `document_comments` table.
- Slugs are stable: renaming a doc never changes its slug. Deleting a project isn't a thing; deleting a doc deletes its versions, refs and comments.
- Search (`q`) matches title and content. Like issue search, it's a literal substring match: `%`, `_` and `\` in the query are escaped, not wildcards.

**REST**

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | /api/documents | `?workspace&project&q` | `DocumentSummary[]` (project key, then position) |
| POST | /api/documents | `DocumentInput` | `Document` |
| GET | /api/documents/:slug | | `Document` |
| GET | /api/documents/:slug/raw | | `text/markdown; charset=utf-8` (the content) |
| PATCH | /api/documents/:slug | `DocumentPatch` | `Document` |
| DELETE | /api/documents/:slug | | `{ ok: true }` |
| POST | /api/documents/:slug/comments | `{ body, author? }` | `Document` |
| PATCH | /api/documents/:slug/comments/:cid | `{ body, author? }` | `Document` |
| DELETE | /api/documents/:slug/comments/:cid | `{ author? }` | `Document` |
| GET | /api/documents/:slug/versions | | `DocumentVersionSummary[]` (newest first) |
| GET | /api/documents/:slug/versions/:id | | `DocumentVersion` |

`DocumentPatch.baseUpdatedAt` (optional) is the document's `updatedAt` the client started editing from: if present and different from the current `updatedAt`, the PATCH answers 409 `{ "error": "Document changed since you started editing" }` and changes nothing. Every save moves `updatedAt` strictly forward (at least 1 ms past the previous one), so it works as a version token even for saves in the same millisecond. The web editor sends it with every save; MCP `update_document` accepts it too. `edits` errors (400) name the failing edit and whether `oldText` matched 0 or many times (overlapping occurrences count: `aa` matches `aaa` twice); nothing is applied unless every edit applies. `GET /api/issues/:id` now includes `docs` (documents mentioning it). `Project` includes `docCount`. Mutations publish `{ type: "changed", entity: "document", id: slug }`.

**MCP tools** (added to the 12 above)

| Tool | Input | Notes |
|---|---|---|
| list_documents | workspace?, project?, query? | one line per doc: `slug · Title · PROJECT · updated 2h ago by claude` |
| get_document | slug | full markdown plus metadata and mentioned issues |
| create_document | project, title, content, slug?, position?, author? | |
| update_document | slug, title?, content?, edits?, project?, position?, baseUpdatedAt?, author? | prefer `edits` for small changes to long docs; `content` replaces everything; `baseUpdatedAt` rejects the update if the doc changed since it was read |
| comment_document | slug, body, author? | |
| delete_document | slug | permanent (versions and comments too); `destructiveHint` |
| update_comment | issue? or document?, comment, body, author? | exactly one of issue/document; own comments only |
| delete_comment | issue? or document?, comment, author? | same; `destructiveHint` |

`get_issue` and `get_document` show each comment as `**author** · #id · time` (plus ` · edited`), so agents can address it.

Tool descriptions must say: docs are markdown; mention issues by identifier (e.g. BRD-2) and they auto-link; link other docs with `[Title](/doc/slug)`; use `edits` for targeted changes.

**UI**
- Sidebar: "All issues", "All docs". A project's page gets two tabs: Issues, Docs (`/p/:key` and `/p/:key/docs`).
- Docs list (`/docs`, `/p/:key/docs`): grouped by project, ordered by position. Row: doc icon, title, "updated 2h ago by claude". "New doc" button.
- Doc page (`/doc/:slug`): a centered reading column (~720px), large inline-editable title, a quiet metadata line (project · updated by · time · versions). Typography built for long specs: clear heading scale, comfortable line height, tables that scroll horizontally on narrow screens, code blocks, blockquotes, task lists. `dir="auto"` on every block (Arabic). A sticky outline of h2/h3 on the right on wide screens (hidden on narrow), with the current section highlighted.
- Editing: `E` or the Edit button switches to a full-height markdown textarea (monospace, same column). Autosave ~1s after typing stops with a quiet "Saving… / Saved" indicator, `⌘S` saves now, `Esc` returns to reading. If the doc changes remotely while editing, don't clobber: show a small banner "Updated by claude · Reload".
- History: a side panel of versions (author, time); click to preview, "Restore" writes that content as a new version.
- Below the content: "Issues in this doc" (status icon, identifier, title) and a comment thread (same component as issues).
- Everywhere markdown renders (issue descriptions, comments, docs): bare identifiers of existing projects (e.g. `MVP-12`) become inline chips with the status icon linking to the issue; links to `/doc/:slug` and `/issue/:id` route client-side.
- Issue page: a "Docs" section listing documents that mention the issue.
- New doc: modal with project and title, then opens straight into edit mode.
- Routes served as index.html: add `/docs`, `/doc/*` (and `/p/*` already covers `/p/:key/docs`).

## Workspaces

Migration 3 (additive): creates `workspaces`, inserts `default` / "Default", adds the nullable `projects.workspace` column (SQLite can't add a NOT NULL column with a foreign key) and assigns every existing project to `default`. `Workspace` includes `projectCount`. Mutations publish `{ type: "changed", entity: "workspace", id: key }`.

## Issue numbering

Migration 4 (additive): adds `projects.next_number INTEGER NOT NULL DEFAULT 1`, backfilled to `MAX(number) + 1` per project. `createIssue` takes the number from it (increment inside the insert transaction), so deleting an issue never frees its number. Numbers deleted before the migration (above the current max) can be reused once.

## Comment edits

Migration 5 (additive): adds nullable `edited_at` to `comments` and `document_comments`. `Comment` includes `editedAt: string | null`.

## Deploy

`Dockerfile` (oven/bun image) + `docker-compose.yml`: volume `./data:/app/data`, port `127.0.0.1:7100:7100`, `restart: unless-stopped`, `DOCKET_TOKEN` passed through from the environment or `.env`. HTTPS and exposure are the operator's choice (reverse proxy, tunnel, VPN). Anything reached by a hostname other than localhost needs that hostname in `DOCKET_HOSTS` (see Auth), or data routes answer 403.

## Auth

`src/server/auth.ts`. With `DOCKET_TOKEN` set, `/api/*`, `/mcp` and `/ws` return 401 unless the request carries `Authorization: Bearer <token>` or the `docket_token` cookie (both compared in constant time). `POST /api/login {token}` sets that cookie (HttpOnly, SameSite=Lax, 1 year, Secure over HTTPS). The cookie never holds the token itself: its value is hex HMAC-SHA256 of `"docket session"` keyed by the token, so it only works as a cookie, not as a bearer, and changing the token logs every browser out. Login is rate-limited per client IP: after 10 failures in a minute it answers 429 until the minute ends (behind a proxy, all clients share the proxy's IP). The app shell, manifest, service worker and icons stay public; they hold no data.

**Host check** (DNS rebinding), token or not: `/api/*` (including login), `/mcp` and `/ws` answer 403 unless the `Host` header's hostname (port ignored, case-insensitive) is `localhost`, `127.0.0.1`, `[::1]` or listed in `DOCKET_HOSTS`. Behind a reverse proxy or tunnel, list the public hostname the proxy forwards in `Host`. The web client shows a login screen on any 401. Each browser keeps a display name (`localStorage["docket.name"]`, asked on first run, changed from the sidebar footer) and sends it as `author` on comments and doc writes. The service worker never caches non-OK responses.

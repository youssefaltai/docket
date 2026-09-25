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

Env: `PORT` (default 7100), `DATABASE_PATH` (default `$XDG_DATA_HOME/docket/docket.db`). Optional config file at `$XDG_CONFIG_HOME/docket/config` (or `$XDG_CONFIG_DIRS/docket/config`), `KEY=VALUE` lines; real env vars win. Dev: `bun run dev`. Prod: `bun run start`.

## Data

- **workspaces**: key (PK, URL-safe lowercase slug, e.g. `acme`), name, created_at, updated_at.
- **projects**: key (PK, 2–5 uppercase letters, unique across all workspaces), workspace (→ workspaces.key; required by the app), name, description, created_at, updated_at.
- **issues**: id (PK), project_key, number (per-project sequence), title, description, status, priority, labels (JSON array), assignee, parent_id, created_at, updated_at, completed_at. Unique (project_key, number).
- **issue_blocks**: blocker_id, blocked_id.
- **comments**: id, issue_id, author, body, created_at.

Identifier = `${project_key}-${number}`, parsed case-insensitively. Issues can't move between projects. Any change to an issue or its comments bumps `updated_at`. `completed_at` is set when status enters done/canceled, cleared when it leaves. List order: status order, then priority (1→4, then 0 last), then `updated_at` desc. WAL mode on.

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
| GET | /api/labels | | `string[]` (distinct, sorted) |

## Realtime

`GET /ws` upgrades to a WebSocket. After every mutation (REST or MCP) the server publishes a `ServerEvent` to all clients. The UI refetches what it's showing.

## MCP

Streamable HTTP at `/mcp`, stateless (`WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, new server+transport per request, JSON responses). Server name `docket`.

Tools return short markdown text (one line per issue: `BRD-3 · todo · high · Title · @assignee · #label`) plus `structuredContent` with the JSON.

| Tool | Input | Notes |
|---|---|---|
| list_workspaces | | with project counts |
| create_workspace | key?, name | key defaults to the slugified name |
| list_projects | workspace? | with workspace and open-issue counts |
| create_project | key, name, workspace?, description? | workspace required when more than one exists, else the only one |
| list_issues | workspace?, project?, status?[], label?, assignee?, parent?, query?, limit? (default 50) | excludes done/canceled unless `status` given |
| get_issue | id | full issue with description, sub-issues, blockers, comments |
| create_issue | project, title, description?, status?, priority?, labels?, assignee?, parent?, blockedBy? | |
| update_issue | id + any of title, description, status, priority, labels, assignee, parent, blockedBy | |
| comment_issue | id, body, author? (default "claude") | use for progress notes |

Tool descriptions must explain the conventions (workspace → project → issue/doc, statuses, priority numbers, identifiers) so an agent can use them without reading docs. No delete tool: agents cancel instead.

## UI

Light theme only, neutral and modern, in the spirit of Linear, Vercel, Resend. Geist + Geist Mono (Google Fonts). White canvas, `#fafafa` sidebar, 1px `#ebebeb` borders, `#171717` text, `#737373` muted, black primary buttons, 6px radii, shadows only on popovers/modals. Small SVG status icons (Linear-like: dashed circle backlog, circle todo, half-filled in progress, three-quarter in review, check done, x canceled) and priority bars. Tight 13–14px type, generous whitespace, fast 120ms transitions. `dir="auto"` on all user text (content may be Arabic).

- **Sidebar**: workspace switcher (current workspace name; popover lists workspaces plus "New workspace"), "New issue" (shortcut `C`), "All issues", projects with open counts. Everything in it is scoped to the current workspace.
- **List view** (default): issues grouped by status with sticky headers and counts; Done and Canceled collapsed by default. Row: priority, identifier (mono, muted), status icon, title, labels, assignee initial, relative updated time.
- **Board view**: columns by status (no Canceled), cards, drag between columns to change status.
- **Toolbar**: search (`/` to focus), label and assignee filters, List/Board toggle.
- **Issue page** (`/issue/BRD-12`): inline-editable title; markdown description with edit toggle; properties panel (status, priority, assignee, labels, project, parent, blocked by) editable via small popovers; sub-issues; comments thread with composer (`⌘↵` to send).
- **New issue modal**: project, title, description, status, priority, labels, assignee, parent. `⌘↵` creates, `Esc` closes.
- **Workspaces**: the current workspace is remembered in localStorage (`docket.workspace`), falling back to the first. `/` and `/docs` show only its content; the new issue/doc project pickers list only its projects; a new project is created in it. Opening `/p/:key`, `/issue/:id` or `/doc/:slug` of another workspace's project switches to that workspace. "New workspace" is a name-only modal. Project keys stay globally unique, so identifiers and routes don't change.
- Client routing with `history.pushState`: `/`, `/p/:key`, `/issue/:id`. The server returns index.html for these paths.
- Works on a phone: the sidebar collapses below 768px.

## Documents

Linear-style docs inside projects. Markdown is the source of truth (agents write via MCP). Types in `src/shared/types.ts`.

**Data** (migration 2, additive only — production already holds real data at `user_version` 1):
- **documents**: id, slug (unique), project_key, title, content, position, created_at, updated_at, updated_by.
- **document_versions**: id, document_id, title, content, author, created_at. A version is written on every title/content change. Autosave-friendly: if the latest version has the same author and is < 10 min old, overwrite it instead of inserting.
- **document_refs**: document_id, issue_id, ord. Recomputed on every content change from `\b[A-Z]{2,5}-\d+\b` matches that resolve to real issues (first-mention order).
- Document comments: same `Comment` shape as issues (separate table or a nullable FK — your call; keep it simple).
- Slugs are stable: renaming a doc never changes its slug. Deleting a project isn't a thing; deleting a doc deletes its versions, refs and comments.
- Search (`q`) matches title and content.

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
| GET | /api/documents/:slug/versions | | `DocumentVersionSummary[]` (newest first) |
| GET | /api/documents/:slug/versions/:id | | `DocumentVersion` |

`edits` errors (400) name the failing edit and whether `oldText` matched 0 or many times; nothing is applied unless every edit applies. `GET /api/issues/:id` now includes `docs` (documents mentioning it). `Project` includes `docCount`. Mutations publish `{ type: "changed", entity: "document", id: slug }`.

**MCP tools** (added to the existing 7)

| Tool | Input | Notes |
|---|---|---|
| list_documents | workspace?, project?, query? | one line per doc: `slug · Title · PROJECT · updated 2h ago by claude` |
| get_document | slug | full markdown plus metadata and mentioned issues |
| create_document | project, title, content, slug?, position?, author? | |
| update_document | slug, title?, content?, edits?, project?, position?, author? | prefer `edits` for small changes to long docs; `content` replaces everything |
| comment_document | slug, body, author? | |

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

## Deploy

`Dockerfile` (oven/bun image) + `docker-compose.yml`: volume `./data:/app/data`, port `127.0.0.1:7100:7100`, `restart: unless-stopped`, `DOCKET_TOKEN` passed through from the environment or `.env`. HTTPS and exposure are the operator's choice (reverse proxy, tunnel, VPN).

## Auth

`src/server/auth.ts`. With `DOCKET_TOKEN` set, `/api/*`, `/mcp` and `/ws` return 401 unless the request carries `Authorization: Bearer <token>` or the `docket_token` cookie (compared in constant time). `POST /api/login {token}` sets that cookie (HttpOnly, SameSite=Lax, 1 year, Secure over HTTPS). The app shell, manifest, service worker and icons stay public; they hold no data. The web client shows a login screen on any 401. Each browser keeps a display name (`localStorage["docket.name"]`, asked on first run, changed from the sidebar footer) and sends it as `author` on comments and doc writes. The service worker never caches non-OK responses.

Part of DKT-3. Design: [Workspace isolation](/doc/workspace-isolation).

**Blocked by**
- DKT-4: keys act in one workspace, and `requestWorkspace` exists.
- DKT-5: it brings in the migration-runner change this migration relies on. Rehearse one migration at a time.

## Why

Team keys and doc slugs are unique across the whole instance. `Team key BRD is taken` refuses a key that only another workspace uses, and reveals that it exists. The same goes for slugs, which get silently deduped to `plan-2`. URLs carry no workspace, so `/issue/BRD-1` can only work while `BRD` is globally unique, and the web app switches workspace behind your back when you open a link. Linear puts the workspace in every URL and scopes keys to it.

## Linear's behaviour

- Linear's URLs carry the workspace's URL key (`Organization.urlKey`, "The organization's unique URL key") and the team key ("used as a prefix in issue identifiers (e.g., 'ENG' in 'ENG-123') and in URLs"). Both quotes are from [Linear's schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql). Each workspace has its own keys: every Linear customer can have `ENG`. The resulting links look like `linear.app/<workspace>/issue/ENG-123`.
- Old workspace URL keys keep redirecting ("last 3 are kept and redirected", `Organization.previousUrlKeys` in the same schema).
- Moving an issue to another team redirects its old identifier ([editing issues](https://linear.app/docs/editing-issues)).

**Deliberate differences:**
- Docket keeps team and workspace keys permanent, so the only redirects are for links made before this change.
- Doc URLs use the slug rather than Linear's `slug-id`, as today.

## Where things are today

**Schema (`src/server/db.ts`)**
- `90-98`: `teams.key` is the primary key.
- `100-117`: `issues.team_key → teams(key)`, `UNIQUE (team_key, number)`.
- `134-145`: `documents.slug UNIQUE`, `team_key → teams(key)`.

**Tracker (`src/server/tracker.ts`)**
- `62-67`: `scopeWorkspaces` searches all of a session's workspaces.
- `154-160`: `TEAM_SELECT` counts by `team_key`.
- `173-178`: `teamRow` looks a team up by key alone.
- `188-206`: `createTeam`, whose global check is line 194.
- `239`: `ident()` builds `team_key || '-' || number`.
- `241-253`: `ISSUE_SELECT`.
- `284-296`: `issueRef` resolves an identifier globally.
- `364-383`: `listScope`, including a team filter.
- `505-508`: `bumpIssues`.
- `526-528`: `next_number`.
- `650-666`: `purgeTrash`.
- `783-792`: `documentRow` finds a slug globally.
- `811-812`: `nextPosition`.
- `897-917`: `createDocument`, whose global slug check is line 904.
- `931-936`: moving a doc to another team.
- `864-877`: `saveRefs`, already per workspace.

**REST (`src/server/api.ts`)**
- `52-61`, `137`, `185`, `191`: `?workspace=` filters.

**Server shell**
- `src/server/index.ts:30`: `APP_PATHS` has no workspace prefix.
- `src/server/http.ts:33`: API answers carry no `Vary`.
- `public/sw.js:79-83`: the service worker caches `GET /api/*` by URL alone.

**Web**
- `src/web/routing.tsx:5-24`: the `Route` type and `parseRoute`.
- `src/web/main.tsx`: `61` (workspace from localStorage), `77` (issue index across all workspaces), `127-130` (`switchWorkspace`), `154-158` (switches to a link's workspace).
- `src/web/markdown.tsx`: `70` (the chip's href `/issue/…`), `80-86` (the link renderer), `121-125` (client-side routing).
- Link sites:
  - `modals.tsx:83,180,304`;
  - `main.tsx:318`;
  - `issues.tsx:297,425`;
  - `docs.tsx:108,153,247,431,491`;
  - `components.tsx:254-256`;
  - `issue.tsx:63,193,225,405,427,475,524`;
  - `chat.tsx:399`;
  - `trash.tsx:56-70`;
  - `main.tsx:343-344` (settings).

**MCP (`src/server/mcp.ts`)**
- `25`: "unique across all workspaces".
- `231`: the `create_team` description says the same.

**Contract (`src/shared/types.ts`)**
- `124`: `Team.key` is "globally unique".
- `201`: `DocumentSummary.slug` is "globally unique".
- `229-233` and `270-272`: the `workspace` filter.
- `134-139`: `TeamInput.workspace` is required.

## Design

**Migration.** Append the next one. It rebuilds three tables under DKT-5's runner (foreign keys off, `foreign_key_check` before commit). Full SQL is in the design doc's "DKT-6" block:
- `teams(id INTEGER PRIMARY KEY, workspace, key, name, description, next_number, created_at, updated_at, UNIQUE (workspace, key))`, filled in `created_at, key` order;
- `issues(… team_id INTEGER NOT NULL REFERENCES teams(id) …, UNIQUE (team_id, number))`, copied with `JOIN teams_new t ON t.key = i.team_key`, keeping every `id`;
- `documents(… workspace, team_id …, UNIQUE (workspace, slug))`, keeping every `id`;
- recreate `issues_parent`, `issues_deleted`, `documents_team(team_id, position)` and `documents_deleted`. `teams_workspace` is covered by the unique index.

The team id stays internal: no API or type exposes it.

**Every data request acts in one workspace.** Use DKT-4's `requestWorkspace(a)` (header, else your only membership, else 400; not yours, 404) in every tracker entry point.
- Delete `scopeWorkspaces`.
- `listScope`, `listTeams`, `listLabels`, `teamRow`, `issueRef`, `documentRow`, `userFilterId` and `listTrash` all filter on that one workspace:
  - `teamRow`: `WHERE t.workspace = ? AND t.key = ?`;
  - `issueRef`: `JOIN teams t ON t.id = i.team_id WHERE t.workspace = ? AND t.key = ? AND i.number = ?`;
  - `documentRow`: `WHERE d.workspace = ? AND d.slug = ?`.
- `ident()` takes the team alias: `${t}.key || '-' || ${i}.number`.
- `ISSUE_SELECT` joins `teams pt` for the parent and `teams bt` for the blockers.
- `bumpIssues` returns `(SELECT key FROM teams WHERE id = issues.team_id) || '-' || number`.
- Uniqueness checks:
  - `createTeam` checks `(workspace, key)`: 409 `Team key BRD is taken in this workspace`;
  - `createDocument`'s `pickSlug` checks `(workspace, slug)`.
- `TeamInput.workspace` is optional. If given, it must equal the request's workspace (400 `Teams are created in the workspace you're in`), so old scripts keep working.
- `?workspace=` on `GET /api/teams`, `/api/issues`, `/api/labels` and `/api/documents` is no longer read. Remove it from `IssueFilter` and `DocumentFilter`, and from MCP (already done in DKT-4).
- Account routes (`/api/me`, sessions, keys, sign-in links, `/api/workspaces…`) don't need a workspace.

**Legacy links**
- New route: `GET /api/locate?issue=BRD-1 | ?doc=slug | ?team=BRD` → `{ workspace }`.
  - It takes exactly one parameter (400 otherwise).
  - It searches all of the caller's active workspaces and ignores the header.
  - When several match, the oldest team (for `issue` and `team`) or oldest doc wins. Before this change keys and slugs were globally unique, so that's the one old links meant.
  - No match: 404 `Not found`.
- Put it in `tracker.ts` as `locate(a, query)` and route it in `api.ts` next to the account routes.

**Reserved workspace keys.** `api, doc, docs, icons, issue, login, mcp, settings, setup, t, ws`.
- `insertWorkspace` (`access.ts:634-641`) refuses them when given explicitly: 400 `Workspace key "docs" is reserved`.
- A derived key skips them, the way it skips taken ones (`docs` becomes `docs-2`).

**Server shell**
- `APP_PATHS` becomes `["/", "/login", "/setup", "/settings/*", "/t/*", "/issue/*", "/docs", "/doc/*", "/:ws", "/:ws/*"]`. The legacy paths stay so the app can redirect them. Bun 1.4 routes `/:ws` and `/:ws/*`, and `/api/*` still wins over them.
- Add `"/icons/*"` as a plain 404, so unknown icons stay 404 instead of getting the app shell.
- `secure()` adds `Vary: X-Docket-Workspace` to API answers (`http.ts:33`). The service worker's Cache API honours `Vary`, so an offline fallback never serves one workspace's `GET /api/issues` in another.

**Web.** URLs:
- `/<ws>`, `/<ws>/docs`, `/<ws>/t/:key[/docs|/trash]`, `/<ws>/issue/:id`, `/<ws>/doc/:slug`, `/<ws>/settings/account`, `/<ws>/settings/workspace`.
- `/login` and `/setup` stay global.

`routing.tsx`:
- `Route` gains `workspace: string`.
- `parseRoute` reads the first segment as the workspace, unless it's a reserved word, which marks a legacy path.
- Add `wsPath(path)`, which prefixes the current workspace. Every `Link` and `navigate` above uses it.

`main.tsx`:
- The current workspace is the URL's. Store it in `docket.workspace` on each visit.
- `/` goes to the stored workspace, else the first.
- `/docs` and `/settings/*` go to the same workspace plus that path.
- Legacy `/issue/:id`, `/doc/:slug` and `/t/:key…` call `api.locate(…)` and then `navigate(…, true)`. If that returns 404, the usual not-found view.
- A workspace you're not in shows `EmptyState` "No access to <ws>", with a button to your workspace.
- Delete the "owner" switch at 154-158.
- The switcher navigates to `/<new ws>`.
- The issue index, teams, labels and members load for the URL's workspace only.
- `X-Docket-Workspace` follows the URL.
- Realtime: refetch data only for events whose `workspace` is current. Refetch the workspace list on any `workspace` or `member` event.

`markdown.tsx`:
- The chip href becomes `/<ws>/issue/ID`.
- The link renderer rewrites hrefs that start with `/doc/`, `/issue/`, `/t/` or `/docs` to `/<ws>…`, using the workspace of the content being shown (the current one).
- Content is stored untouched. `[Title](/doc/slug)` stays the convention for people and agents.

`modals.tsx:297-302`: the new-team modal stops sending `workspace` (line 299).

**MCP**
- `INSTRUCTIONS` line 25 becomes: `"- Teams have a 2–5 letter key (e.g. BRD), unique within this workspace. Issues are identified as KEY-number, e.g. BRD-12."`
- The `create_team` description changes "unique across all workspaces" to "unique within this workspace".
- Identifiers and slugs already resolve in the key's workspace through the tracker changes. The `/doc/slug` returned by `create_document` stays workspace-relative.

**Realtime.** `ServerEvent` is unchanged. Its `id` (team key, identifier or slug) is unique within `workspace`.

**Contract (`types.ts`)**
- `Team.key` comment: "unique within its workspace".
- `DocumentSummary.slug` comment: "unique within its workspace, stable, URL-safe".
- `TeamInput.workspace?`.
- `IssueFilter` and `DocumentFilter` lose `workspace`.

## Acceptance criteria

- [ ] `BRD` created in `acme` and in `side`: both 201. `BRD-1` in each resolves by `X-Docket-Workspace`, and by key for MCP.
- [ ] A 409 for a duplicate key or slug happens only within one workspace, and never mentions another.
- [ ] A doc slug `plan` exists in both workspaces. `/doc/plan` links in each doc's content open that workspace's `plan`.
- [ ] A session in two workspaces:
  - without the header, `GET /api/issues/BRD-1` answers 400;
  - with a header naming a workspace it isn't in, 404;
  - a single-workspace session needs no header.
- [ ] `GET /api/locate`:
  - returns the right workspace for issue, doc and team;
  - picks the oldest when two match;
  - answers 404 for a workspace you're not in;
  - answers 400 with no parameter or two.
- [ ] Every old `/issue/…`, `/doc/…`, `/t/…`, `/docs` and `/settings/…` URL lands on the same page under `/<ws>/…` (replace, not push).
- [ ] The app shell is served at `/acme` and `/acme/issue/BRD-1`; `/icons/nope` and `/api/nope` are still plain 404s.
- [ ] Creating a workspace with the key `docs` is 400; one named "Docs" gets `docs-2`.
- [ ] API answers carry `Vary: X-Docket-Workspace`.
- [ ] Migration: every issue identifier, doc slug, relation, ref, comment, version and team counter (`next_number`) is unchanged, and `foreign_key_check` is empty.

## Tests

**`test/server.ts`:** callers take an optional workspace that is sent as `X-Docket-Workspace` on cookie requests, e.g. `s.as("ana", "cookie", "side")`.

**New `test/isolation.test.ts`** (`acme` and `side`, ana in both):
- The same team key, issue number and doc slug in both, each resolving within its own workspace.
- A parent or blocker from the other workspace is 404 (it can't be named).
- Doc refs resolve per workspace.
- The header rules: 400, 404, and the single-workspace default.
- `/api/locate` cases, including the oldest match winning. Create `side`'s `BRD` after `acme`'s.
- The app shell and 404 routes, fetched with raw `fetch` (no auth).
- Reserved workspace keys.
- `Vary` header present.

**Existing tests:** the `?workspace=` calls (`seed.test.ts`, `comments.test.ts:90`, `parity.test.ts:91`) keep working, because the parameter is ignored. Update the `workspace=nope` filter case in `parity.test.ts:91`: it's now ignored rather than 400. Drop it from that list and cover the header 404 instead.

**`test/migrations.test.ts`:**
- Freeze the previous schema (after DKT-5) with two workspaces, teams, issues with a parent, blockers, comments, a doc with refs, versions and comments, and a trashed issue.
- Migrate, then compare over HTTP: identifiers, slugs, `blockedBy`, `children`, `docs` and `issues` refs, counts, and the next `create_issue` number per team.

Web routing has no unit tests. Check it by hand on `127.0.0.1` at phone width:
- the switcher;
- old links redirecting;
- chips and doc links inside markdown;
- settings under `/<ws>/settings/…`.

## SPEC.md

- **Access → Rules for every request**: data routes act in the request's workspace (a key's, or `X-Docket-Workspace`, or your only one); 400 and 404 rules; `Vary`.
- **Data**: `teams(id, workspace, key …)` with `UNIQUE (workspace, key)`; `issues.team_id`; `documents.workspace` and `team_id` with `UNIQUE (workspace, slug)`; this migration.
- **REST**: drop `?workspace`; `TeamInput.workspace` is optional and must match; new `GET /api/locate`.
- **UI → Workspaces and client routing**: the `/<ws>/…` paths, legacy redirects, reserved keys, links in markdown resolving in the content's workspace. Replace "Opening `/t/:key`… of another of your workspaces switches to it".
- **Documents**: slugs are unique within a workspace; `/doc/slug` links are workspace-relative.
- **MCP**: instructions and the `create_team` text.
- **Deploy**: `APP_PATHS`.
- **`types.ts`**: the changes above.

## Out of scope

- Renaming team or workspace keys, and redirects for renames.
- Moving issues between teams.
- Per-caller tool visibility (DKT-2).
- Guests and private teams (DKT-27).
- Rewriting stored markdown links. Links that pointed into another workspace before this change now resolve in the content's own workspace; they were already 404 for anyone not in both.

**Project rules:**
- Linear's features, nano implementation; no new dependencies.
- Append the next migration with a frozen-fixture test.
- SPEC.md and `types.ts` change in the same branch.
- REST, MCP and UI stay in parity. Every mutation publishes `changed` for its workspace. Outside your workspaces is 404.
- UI: light, Linear-like; works at phone width.
- Branch `feature/workspace-urls`. `bun test` and `bun run typecheck` pass. Merge and delete the branch.
- Deploy only from main after `./backup.sh`, following the design doc's rehearsal checklist, including the reserved-key check and old-link smoke tests.
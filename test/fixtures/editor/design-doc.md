# Workspace isolation

Workspaces become fully separate, as in Linear. Only two things stay global: a person's **login** (their session) and the **workspace switcher**. Everything else lives in one workspace: API keys and agent tokens, usernames and display names, team keys, doc slugs, identifiers and URLs.

Tracked in DKT-3. Built in three steps: DKT-4 (credentials), DKT-5 (usernames), DKT-6 (team keys, slugs, URLs).

## Why

- Adding an agent named `claude` to a second workspace fails with `Username "claude" is taken`. That also tells the admin that someone, somewhere on the instance, holds that name.
- `Team key BRD is taken` and `Slug "architecture" is already taken` leak other workspaces in the same way.
- An API key reaches every workspace its owner is in. That forces a `workspace` argument onto MCP tools, and a tangled suspension rule: credentials are deleted only when someone loses their *last* membership, because a key can't be revoked for just one workspace.

## Linear's model

- One login (email) can hold users in many workspaces. Each workspace has its own **User** record, with its own `name` and `displayName` ("must be unique within the workspace") and its own `active` (suspension) flag. Sources: [profile docs](https://linear.app/docs/profile) ("Your email address is your unique ID (User Account) for all workspaces you have created a User for") and the `User` and `AuthUser` types in [Linear's GraphQL schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql).
- You switch workspaces from the workspace menu without signing in again ([workspaces](https://linear.app/docs/workspaces)).
- Personal API keys are made in a workspace's account settings. They can be limited to read or write and to specific teams "in your workspace" ([API and webhooks](https://linear.app/docs/api-and-webhooks)).
- A team's key prefixes its identifiers and appears in its URLs (`Team.key` in the schema). Every Linear workspace can have its own `ENG` team.
- When a workspace's URL key changes, "last 3 are kept and redirected" (`Organization.previousUrlKeys` in the schema).
- A suspended user "lose[s] all access immediately" and stays listed for history ([members and roles](https://linear.app/docs/members-roles)).
- Linear's MCP server says: "each workspace needs its own separate authentication context" ([MCP](https://linear.app/docs/mcp)).

**Where Docket differs on purpose:**
- Workspace keys never change, so there are no workspace-key redirects. Only links from before this change get redirects.
- Email stays optional contact info and is never used to find an account. The account is the login, not the email.

## Decisions

1. **Account and membership.** `users` becomes the account: `id, kind, email, created_at`. A membership (`workspace_members`) carries the person's `username` and `name` in that workspace. Usernames are unique within a workspace, across both people and agents. `UserRef` keeps its shape but is resolved per workspace. The numeric `Me.user.id` is the account id and is the same everywhere.
2. **Every request acts in one workspace.** An API key acts in its own workspace. A browser session names one with the `X-Docket-Workspace` header; if it doesn't, it gets its only active membership, and failing that a data route answers 400. Account routes need no workspace: `/api/me`, sessions, API keys, sign-in links, `/api/workspaces`, and anything under `/api/workspaces/:key/…`, whose path names the workspace.
3. **Credentials.** A session is account-wide. An API key, agent token or chat key belongs to one `(user, workspace)` and dies with that membership's suspension.
4. **Team keys and doc slugs** are unique within a workspace. Teams get an internal integer id. Issues and docs point to it.
5. **URLs** take the form `/<ws>/…`. Links from before this change (`/issue/KEY-1`, `/doc/slug`, `/t/KEY`, `/docs`, `/settings/*`) redirect in the browser. When two of your workspaces match, the oldest team or doc wins; before this change keys and slugs were globally unique, so the oldest match is the one the old link meant.
6. **Links inside content stay workspace-relative.** Markdown keeps `[Title](/doc/slug)` and bare `BRD-12`, and they resolve in the workspace where the content lives. No content is rewritten.
7. **MCP** drops every `workspace` argument, plus `list_workspaces` and `create_workspace`. Identifiers resolve in the key's workspace.
8. **Suspension** from workspace W deletes that membership's keys in W. Sessions and unused sign-in links go only when no active membership remains.

## Schema, before → after

| Table | Before | After |
|---|---|---|
| users | `id, kind, username UNIQUE, name, email, created_at` | `id, kind, email, created_at` (the account) (DKT-5) |
| workspace_members | `workspace, user_id, role, created_at, suspended_at` | adds `username, name`, `UNIQUE (workspace, username)`, and `role` also allows `guest` for DKT-27 (DKT-5) |
| api_keys | `user_id, name, scope, token_hash, …, expires_at, session_id` | adds `workspace` (DKT-4) |
| codes | sign-in codes have `workspace` NULL | a sign-in code may record the workspace it was made from, for display only (DKT-5) |
| teams | `key PK, workspace, …` | `id PK, workspace, key, …, UNIQUE (workspace, key)` (DKT-6) |
| issues | `team_key → teams(key)`, `UNIQUE (team_key, number)` | `team_id → teams(id)`, `UNIQUE (team_id, number)` (DKT-6) |
| documents | `slug UNIQUE`, `team_key → teams(key)` | `workspace, team_id → teams(id)`, `UNIQUE (workspace, slug)` (DKT-6) |

Every row id stays the same, so `comments`, `issue_blocks`, `document_*` and `sessions` don't change.

## Migrations

Each step appends its own migration to `MIGRATIONS` (`src/server/db.ts`). DKT-4 only adds a column and backfills it. DKT-5 and DKT-6 rebuild tables, because SQLite can't drop a `UNIQUE` or change a foreign key in place. They follow SQLite's 12-step procedure ([ALTER TABLE, "other changes"](https://www.sqlite.org/lang_altertable.html#otheralter)): create the new table, copy the rows, drop the old one, rename the new one, recreate the indexes.

**Runner change (DKT-5).** Foreign keys stay off while migrations run. Each migration's transaction ends with `PRAGMA foreign_key_check` and throws if anything turns up. Foreign keys go back on afterwards:

```ts
db.run("PRAGMA foreign_keys = OFF"); // a migration may rebuild a table; checked before each commit
MIGRATIONS.slice(user_version).forEach((sql, i) =>
  db.transaction(() => {
    db.run(sql);
    const broken = db.query("PRAGMA foreign_key_check").all();
    if (broken.length) throw new Error(`Migration ${user_version + i + 1} broke foreign keys: ${JSON.stringify(broken.slice(0, 5))}`);
    db.run(`PRAGMA user_version = ${user_version + i + 1}`);
  })(),
);
db.run("PRAGMA foreign_keys = ON");
```

**DKT-4: keys belong to one workspace**

```sql
ALTER TABLE api_keys ADD COLUMN workspace TEXT REFERENCES workspaces(key) ON DELETE CASCADE;
DELETE FROM api_keys WHERE session_id IS NOT NULL;              -- chat keys: minted again per workspace
UPDATE api_keys SET workspace = (SELECT m.workspace FROM workspace_members m
  WHERE m.user_id = api_keys.user_id AND m.suspended_at IS NULL ORDER BY m.created_at, m.workspace LIMIT 1);
DELETE FROM api_keys WHERE workspace IS NULL;                   -- owner has no active workspace left
CREATE INDEX api_keys_workspace ON api_keys(user_id, workspace);
```

An agent is only ever in one workspace, so its token lands there. A person's older key lands in the workspace they joined **first**. The rehearsal lists these keys so the owner can make new ones where needed.

**DKT-5: usernames move to memberships**

```sql
CREATE TABLE members_new (
  workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest', 'agent')),
  created_at TEXT NOT NULL,
  suspended_at TEXT,
  PRIMARY KEY (workspace, user_id),
  UNIQUE (workspace, username)
);
INSERT INTO members_new SELECT m.workspace, m.user_id, u.username, u.name, m.role, m.created_at, m.suspended_at
  FROM workspace_members m JOIN users u ON u.id = m.user_id;
DROP TABLE workspace_members;
ALTER TABLE members_new RENAME TO workspace_members;
CREATE INDEX workspace_members_user ON workspace_members(user_id);

CREATE TABLE users_new (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
  email TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO users_new SELECT id, kind, email, created_at FROM users;
DROP TABLE users;                                               -- foreign keys are off: nothing cascades
ALTER TABLE users_new RENAME TO users;
CREATE UNIQUE INDEX users_email ON users(lower(email)) WHERE email IS NOT NULL;
```

**DKT-6: teams get an id; keys and slugs are unique per workspace**

```sql
CREATE TABLE teams_new (id INTEGER PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(key), key TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', next_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (workspace, key));
INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
  SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;

CREATE TABLE issues_new (id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), number INTEGER NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '[]', assignee_id INTEGER REFERENCES users(id), delegate_id INTEGER REFERENCES users(id),
  creator_id INTEGER NOT NULL REFERENCES users(id), parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, deleted_at TEXT, UNIQUE (team_id, number));
INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
  i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
  FROM issues i JOIN teams_new t ON t.key = i.team_key;

CREATE TABLE documents_new (id INTEGER PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(key),
  team_id INTEGER NOT NULL REFERENCES teams(id), slug TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  updated_by_id INTEGER NOT NULL REFERENCES users(id), deleted_at TEXT, UNIQUE (workspace, slug));
INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
  d.updated_at, d.updated_by_id, d.deleted_at FROM documents d JOIN teams_new t ON t.key = d.team_key;

DROP TABLE documents; DROP TABLE issues; DROP TABLE teams;
ALTER TABLE teams_new RENAME TO teams;
ALTER TABLE issues_new RENAME TO issues;
ALTER TABLE documents_new RENAME TO documents;
CREATE INDEX issues_parent ON issues(parent_id);
CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX documents_team ON documents(team_id, position);
CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
```

Today team keys are globally unique, so `JOIN teams_new t ON t.key = …` matches exactly one team per row.

## Every request acts in one workspace

| Credential | Workspace |
|---|---|
| API key, agent token, chat key | its own. An `X-Docket-Workspace` header naming any other workspace is a 404. |
| Session (web app) | `X-Docket-Workspace`, else its only active membership, else none |

`Actor` gains `workspace: string | null`. The helper `requestWorkspace(a)` returns it, or answers 404 (`Workspace x not found`) when it names a workspace you aren't an active member of, or 400 (`Pick a workspace: send X-Docket-Workspace`) when there's none.

- DKT-4 uses this rule for the chat proxy and for new API keys.
- DKT-6 uses it for every data route: teams, issues, labels, documents and trash.

Browsers can't send custom headers on a WebSocket. So `/ws` keeps subscribing a session to all of its workspaces, and the app ignores events for the others.

## Credentials after the change

- **Sessions.** One per browser, account-wide, 30 days, unchanged. Deleted on sign-out, on revoke, or when the person has no active membership left.
- **API keys.** Each belongs to `(person, workspace)`, is listed in that workspace's account settings, and acts only there. `ApiKey.workspace` says where.
- **Agent tokens.** Keys of an agent account, which is in exactly one workspace. Agents with the same username in two workspaces are two separate accounts (DKT-5).
- **Chat keys.** Minted per `(session, workspace)` from the chat panel's `X-Docket-Workspace`. They die with the session or with suspension from that workspace.
- **Sign-in links.** Open the account, not one workspace. A link may record the workspace it was made from (DKT-5), used only to show "@sam in Acme" and to open Acme after sign-in.
- **Invites.** Unchanged, except that redeeming one asks for your name and username in that workspace. They're prefilled from your most recent membership.
- **Setup code.** Unchanged.

## Suspension

Suspending someone in workspace W:
- stops their access to W at once (membership is checked on every request, and their sockets close with 4401);
- deletes their keys in W (API keys, agent token and chat keys);
- deletes the unused invites they made in W, if they were an admin (as today);
- if W was their last active membership, also deletes their sessions and unused sign-in links, since there's nothing left to sign in to.

Their other workspaces and their keys there are never touched. Reinstating doesn't bring the deleted keys back. Removing an agent is the same as suspending it; issuing it a new token reinstates it with a fresh key.

## Identity and usernames (DKT-5)

- `UserRef = { username, name, kind }` is resolved in the workspace of whatever it describes: issue, comment, doc, version or member.
- `Me.user.id` is the account. `Me.user.username` and `name` are you in the request's workspace; for a session that names no workspace, in the one you joined last. `Me.workspaces[]` gains `you: UserRef`.
- `me` in values and filters means the caller's account id.
- `X-Docket-User`, the stale-tab check, carries the account id instead of a username.
- Your profile is per workspace: `PATCH /api/workspaces/:key/profile { name?, username? }`. `PATCH /api/me` keeps only `email`, which is account-wide and stays unique across accounts, as Linear treats the email as the account.
- `bun run sign-in-link <username> [workspace]` finds the person holding that username. If different people hold it in different workspaces, it exits 1 and lists `workspace · name` for each, so you can run it again with the workspace.

## Team keys, identifiers and slugs (DKT-6)

- `BRD` can exist in several workspaces. `BRD-12` means the issue in the request's workspace; for MCP, that's the key's workspace.
- Doc references (`document_refs`), parents and blockers already stay inside one workspace. Nothing about them changes.
- Doc slugs are unique within a workspace. The `/doc/slug` links inside markdown resolve in the doc's own workspace.
- `ServerEvent` keeps its shape: `id` (team key, identifier or slug) is unique within `workspace`.

## URLs and redirects (DKT-6)

| New | Old (redirected in the browser) |
|---|---|
| `/<ws>` | `/` (goes to the last workspace you used, else your first) |
| `/<ws>/t/BRD`, `/<ws>/t/BRD/docs`, `/<ws>/t/BRD/trash` | `/t/BRD…`, found with `GET /api/locate?team=BRD` |
| `/<ws>/issue/BRD-1` | `/issue/BRD-1`, found with `GET /api/locate?issue=BRD-1` |
| `/<ws>/docs`, `/<ws>/doc/slug` | `/docs`, `/doc/slug` (found with `?doc=slug`) |
| `/<ws>/settings/account`, `/<ws>/settings/workspace` | `/settings/account`, `/settings/workspace` |

- `GET /api/locate` searches only your active workspaces and returns `{ workspace }`. When two match, the oldest wins. When none does, it answers 404 and the app shows its not-found page.
- The server serves the app shell for `/:ws` and `/:ws/*`, and keeps a plain 404 for unknown `/icons/*`.
- These workspace keys are reserved and refused on create: `api, doc, docs, icons, issue, login, mcp, settings, setup, t, ws`.

## Surfaces

**REST.** Account routes:

| Route | Change | Step |
|---|---|---|
| `GET/POST /api/api-keys`, `DELETE …/:id` | `ApiKey.workspace`; POST takes `workspace`, defaulting to the request's | DKT-4 |
| `GET /api/workspaces` | a key sees only its own workspace | DKT-4 |
| `POST /api/workspaces` | needs a session (a key couldn't reach the new workspace) | DKT-4 |
| `POST …/agents/:username/token`, `DELETE …/agents/:username` | touch only that workspace's keys | DKT-4 |
| `GET /api/me` | `user` is you in the request's workspace; `workspaces[].you` | DKT-5 |
| `PATCH /api/me` | takes only `email` | DKT-5 |
| `PATCH /api/workspaces/:key/profile` | new: your `name` and `username` there | DKT-5 |
| `…/members`, `…/members/:username`, `…/agents` | usernames are that workspace's | DKT-5 |
| `POST /api/auth/peek`, `/api/auth/redeem` | per-workspace profile when joining; `CodeInfo.workspace` for sign-in links | DKT-5 |
| `GET /api/locate` | new: `?issue` \| `?doc` \| `?team` → `{ workspace }` | DKT-6 |

Data and other routes:

| Route | Change | Step |
|---|---|---|
| `/api/chat*` | chat key for the request's workspace | DKT-4 |
| `/ws` | a key's socket hears only its own workspace | DKT-4 |
| `/api/teams*`, `/api/issues*`, `/api/labels`, `/api/documents*` | act in the request's workspace; `?workspace=` is dropped; `TeamInput.workspace` is optional and must match | DKT-6 |

**MCP**

| Tool | Change | Step |
|---|---|---|
| instructions | "Your key works in one workspace" | DKT-4 |
| instructions | "usernames and team keys are unique in this workspace" | DKT-5, DKT-6 |
| instructions | a first line naming the host, the workspace and you | DKT-8 |
| `list_workspaces`, `create_workspace` | removed | DKT-4 |
| `update_workspace` | input is just `{ name }`; hidden from non-admins | DKT-4, DKT-2 |
| `list_members`, `list_teams`, `list_labels`, `list_issues`, `list_documents`, `create_team` | `workspace` argument removed (a stray one is ignored, since zod strips unknown keys) | DKT-4 |
| `create_team`, `update_team` | people only | DKT-7, DKT-2 |
| identifier and slug tools | resolve in the key's workspace | DKT-6 |
| server info | `docket-<ws>` | DKT-8 |

**UI**

- The app sends `X-Docket-Workspace` with every request (DKT-4) and `X-Docket-User: <account id>` (DKT-5).
- Account settings show this workspace's API keys (DKT-4), and your profile in this workspace next to your email (DKT-5).
- Joining a workspace shows your name and username, prefilled and editable (DKT-5). The sign-in-link prompt shows "@x in Acme" (DKT-5).
- URLs carry the workspace, and links, chips and the sidebar follow it (DKT-6). Opening another workspace's link no longer changes workspace behind your back: the URL decides.
- The chat panel works in the current workspace (DKT-4).

## Steps

1. **DKT-4: credentials.** Additive migration, no rebuild. Can start now.
2. **DKT-5: usernames.** Brings in the runner change and rebuilds `users` and `workspace_members`. Blocked by DKT-4, because a key's actor then has exactly one username.
3. **DKT-6: team keys, slugs and URLs.** Rebuilds `teams`, `issues` and `documents`, makes the workspace mandatory for session data routes, and adds redirects. Blocked by DKT-4 and DKT-5.

Each step ships and is rehearsed on its own. DKT-2, DKT-7 and DKT-8 build on DKT-4's single-workspace keys. DKT-27 (guests, private teams) comes after all three.

## Prod migration: rehearsal checklist

Prod holds live data. Every step follows the same routine. The owner approves the deploy itself.

**1. Back up.** Run `./backup.sh` on the VPS, then copy the snapshot to `~/Backups/docket` on the Mac.

**2. Pre-check the copy** (with `bun:sqlite` or `sqlite3`):
- `PRAGMA integrity_check` returns `ok`.
- `PRAGMA foreign_key_check` returns nothing. Otherwise the new runner refuses to migrate.
- Record `PRAGMA user_version` and each table's row count.
- Record row hashes of the columns that already exist.

**3. Step-specific checks:**
- DKT-4: list the live keys that will be scoped to their owner's first workspace:
  ```sql
  SELECT k.id, k.name, u.username, (SELECT COUNT(*) FROM workspace_members m WHERE m.user_id = k.user_id AND m.suspended_at IS NULL) AS n
  FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.revoked_at IS NULL AND k.session_id IS NULL AND n > 1;
  ```
  Note which one Siri's `docket-ask` uses.
- DKT-5: every account has a membership, and everyone named in content is a member of that content's workspace. All of these must return nothing:
  ```sql
  SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM workspace_members);
  SELECT i.id, x.uid FROM issues i JOIN teams t ON t.key = i.team_key
    JOIN (SELECT id, creator_id AS uid FROM issues UNION SELECT id, assignee_id FROM issues UNION SELECT id, delegate_id FROM issues) x ON x.id = i.id
    WHERE x.uid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace = t.workspace AND m.user_id = x.uid);
  -- the same check for comments.author_id, documents.updated_by_id, document_versions.author_id, document_comments.author_id
  ```
- DKT-6: no workspace uses a reserved key. This must return nothing:
  ```sql
  SELECT key FROM workspaces WHERE key IN ('api','doc','docs','icons','issue','login','mcp','settings','setup','t','ws');
  ```

**4. Migrate the copy.**
- Build the branch.
- Run `DATABASE_PATH=<copy> PORT=7199 NODE_ENV=production bun src/server/index.ts`. The migration runs at startup.
- Check the new `user_version`, `integrity_check` and `foreign_key_check`.
- Compare row counts. The only expected difference is chat keys, which DKT-4 deletes.
- Compare the hashes of the carried columns. For rebuilt tables, join back to the key or username: for example, the hash of `SELECT i.id, t.key, i.number, i.title, … ORDER BY i.id` must equal the old `team_key`-based hash.

**5. Smoke-test the copy on `127.0.0.1:7199`** (not `localhost`, which would clobber the real session cookie):
- Sign in with `DOCKET_URL=http://127.0.0.1:7199 bun run sign-in-link <you>`.
- Open a few issues and docs.
- An old link redirects (DKT-6).
- `tools/list` and `list_issues` work with an agent token.

**6. Deploy.**
- Take a fresh live backup and copy it to the Mac.
- `docker compose build`, then `docker compose up -d`.
- Repeat step 4's checks on prod.
- Check that Siri `/ask`, the chat panel and each agent's MCP connection still work.

**7. Rollback.** Old code can't run on the new schema. Stop the container, restore the pre-deploy backup file, and start the previous image. Anything written after the deploy is lost, so verify within minutes.

## Open decisions

- **Table rebuilds and the "additive migrations" rule.** CONTRIBUTING says migrations are additive. DKT-5 and DKT-6 rebuild tables: every row is copied and nothing is lost, but columns and constraints do change.
  - The only additive route for usernames is to keep `users.username` globally unique and fill it with a placeholder (for example `~<id>`), a dead column that every future reader would have to understand.
  - There is no additive route at all for per-workspace team keys, because `teams.key` is the primary key that issues and docs point to.
  - **Recommendation:** accept rebuilds as the documented exception, guarded by the runner's `foreign_key_check`, a frozen-fixture test per migration and the prod-copy rehearsal. Reword CONTRIBUTING to say "migrations never lose data; rebuilds follow SQLite's 12-step procedure".

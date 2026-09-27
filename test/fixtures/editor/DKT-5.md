Part of DKT-3. Design: [Workspace isolation](/doc/workspace-isolation). Blocked by DKT-4: once keys are scoped to one workspace, a key's caller has exactly one username.

## Why

Usernames are unique across the whole instance. Adding an agent named `claude` to a second workspace fails with `Username "claude" is taken`, which also tells that workspace's admin that someone elsewhere holds the name. The same happens when a person joins or renames themselves. A person's login should be global; how they're known (@handle, display name) should belong to each workspace.

## Linear's behaviour

- One account (the email) holds a separate User in each workspace. Its `displayName` "must be unique within the workspace", and `name` lives on that per-workspace User too (the `User` and `AuthUser` types in [Linear's schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)).
- "Your email address is your unique ID (User Account) for all workspaces you have created a User for" ([profile](https://linear.app/docs/profile)).
- Agents are app users installed per workspace ([agents](https://linear.app/developers/agents)).

**Deliberate difference:** Docket's account is its login, not an email. Email stays optional contact info, and stays unique across accounts (as in Linear, where the email *is* the account).

## Where things are today

**Schema and migrations (`src/server/db.ts`)**
- `32-39`: `users.username` is `UNIQUE` and `users.name` is global.
- `46-53`: `workspace_members` has neither.
- `24`: foreign keys are on before migrations run.
- `193-199`: every migration runs inside a transaction. Together with line 24, this means a table can't be rebuilt safely: dropping `users` would cascade into `sessions`, `api_keys` and `codes`.

**Accounts and members (`src/server/access.ts`)**
- `85-93`: `checkUsername` checks the whole instance (409 at line 91).
- `123-132`: `insertUser` stores the username and name on the account.
- `73-80`: `toRef` and `toUser` read them from `users`.
- `114-121`: `userRow` looks up a global username, for the recovery CLI.
- `142-165`: `me` and `updateMe` read and write the username and name on the account.
- `260-274`: `activeMemberId` finds people by `users.username`, and `me` by `a.username` (line 262).
- `531-578`: `peekCode` and `redeemCode` create accounts with a global username. Joining while signed in reuses it.
- `587-591`: `recoverySignInLink(username)`.
- `665-686`: `MEMBER_SELECT` and `memberRow` join `users` for the username.
- `739-749`: `createAgent` calls `insertUser`, which makes a global username.

**Stale-tab check**
- `src/server/auth.ts:98-99`: `X-Docket-User` is compared with the username.

**Tracker (`src/server/tracker.ts`)**
- `71-76`: `ref` and `userCols`.
- `88-103`: `listComments` joins `users`.
- `116-129`: `ownComment`.
- `241-253`: `ISSUE_SELECT` joins `users` for the assignee, delegate and creator.
- `392-403`: `userFilterId` matches a global username.
- `765-766`: `DOC_COLUMNS` and `DOC_FROM`.
- `984-1002`: document versions.

**MCP (`src/server/mcp.ts`)**
- `27`: the instructions line about usernames.
- `203-205`: marks "you" by `a.username`.

**Contract (`src/shared/types.ts`)**
- `33-37`: `UserRef`, commented "unique across people and agents".
- `72-77`: `Me`.
- `107-113`: `CodeInfo`.

**Web**
- `src/web/components.tsx:22`: `isMe`.
- `src/web/issues.tsx:177-183`: the "Mine" chip.
- `src/web/pickers.tsx:225`: "(you)".
- `src/web/main.tsx:341`: the account menu.
- `src/web/settings.tsx:182-232`: the Profile form.
- `src/web/login.tsx:227-270`: the Switch and Accept dialogs.
- `src/web/api.ts:83-89`: `signedInAs`.
- `src/web/chatApi.ts:68`: sends the username as `X-Docket-User`.

**CLI:** `scripts/sign-in-link.ts:7-16`.

**Tests**
- `test/users.test.ts:48-58` asserts global uniqueness.
- `test/users.test.ts:169-175` tests renaming via `PATCH /api/me`.
- `test/access-e2e.test.ts:146-152` sends a username in `x-docket-user`.

## Design

**Model**
- `users` becomes the **account**: `id, kind, email, created_at`.
- A **membership** (`workspace_members`) carries `username` and `name`, and `UNIQUE (workspace, username)` covers people and agents together.
- Suspended members keep their handle, so history keeps its names.
- An agent account has exactly one membership. Two agents called `claude` in two workspaces are two separate accounts.
- A person's **default profile** is their most recently joined membership (any status). It's used where no workspace is in play: prefilling a join, `Me.user` for a session without a workspace, and the sign-in-link prompt.

**Migration runner** (`db.ts:24` and `193-199`). Run migrations with foreign keys off, check each one before it commits, and turn foreign keys back on afterwards:

```ts
db.run("PRAGMA foreign_keys = OFF"); // a migration may rebuild a table (SQLite's 12-step ALTER); checked before each commit
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

**Migration.** Append the next one. It uses SQLite's [12-step rebuild](https://www.sqlite.org/lang_altertable.html#otheralter). The role CHECK already allows `guest` (unused until DKT-27), so that issue won't need another rebuild.

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
CREATE TABLE users_new (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('person', 'agent')), email TEXT, created_at TEXT NOT NULL);
INSERT INTO users_new SELECT id, kind, email, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE UNIQUE INDEX users_email ON users(lower(email)) WHERE email IS NOT NULL;
```

**Contract (`types.ts`)**
- `UserRef.username`: comment becomes "unique within its workspace (people and agents)". The shape is unchanged.
- `Me`:
  - `user: User & { id: number }`. `id` is the account and never changes. `username` and `name` are yours in the request's workspace (a key's, or `X-Docket-Workspace`); for a session that names no workspace, your default profile.
  - `workspaces: { key; name; role; you: UserRef }[]`.
  - docket-chat reads `user.id`, `user.username` and `user.name`; all three keep working.
- `CodeInfo`:
  - `workspace` is also set for a sign-in link that recorded one (its name).
  - `username` is the handle there, or the default profile's.
  - `you` is the signed-in account's default profile.

**Server (`access.ts`)**
- `insertAccount(kind, email?)` replaces `insertUser`.
- `addMember(workspace, userId, role, { username, name })` validates with `checkUsername(value, workspace)` (409 `Username "x" is taken in <Workspace name>`) and `checkName`.
- `setup` creates the account, the workspace and a membership with the given name and username.
- `redeemCode`:
  - signed out: it creates an account and a membership from `{ name, username, email? }`;
  - signed in: it takes optional `{ name?, username? }`, defaulting to your default profile.
- `createWorkspace` gives you your default profile in the new workspace.
- `createAgent` makes a new agent account plus membership, unique only within that workspace. This is the headline fix.
- `me(a)` builds `workspaces[].you` and fills `user` as described above.
- `updateMe` takes only `email`. In `api.ts:80`, the PATCH fields become `["email"]`, and `name` and `username` get the `why` message: `Your name and username are per workspace: PATCH /api/workspaces/:key/profile`.
- New `updateProfile(a, workspace, { name?, username? })`:
  - requires a session, then `requireMember`;
  - updates your membership;
  - publishes `changed("member", key, newUsername)`;
  - returns your `WorkspaceMember`.
- `MEMBER_SELECT` and `memberRow` read `m.username` and `m.name`.
- `activeMemberId` resolves `"me"` as `a.id` (it must still be an active member of the right kind) and other values as `(workspace, username)`.
- `Actor.username` becomes "your username in `a.workspace`, or null". It's used only by MCP's "you" marker (`mcp.ts:203-205`).
- `updateMe(email)` publishes a `member` event, with your handle, in each of your workspaces.
- Sign-in links:
  - `selfSignInLink` records `a.workspace`, if any, in `codes.workspace`;
  - `recoverySignInLink(username, workspace?)` finds **people** holding that handle: in that workspace if one is given, else in any workspace;
  - one account found: a link;
  - none: 404;
  - several accounts: 409, listing `<workspace key> · <name>` for each.

**Stale-tab check** (`auth.ts:98-99`). `X-Docket-User` carries the account id: `expected !== String(actor.id)`. On the first deploy, an old tab sends a username, gets `401 { switched: true }` and reloads once.

**Tracker.** Resolve every `UserRef` in the row's workspace:
- join `workspace_members` on `(user_id, t.workspace)` for username and name, and take `kind` from `users`;
- this covers the issue's assignee, delegate and creator, comment authors, a doc's `updatedBy`, and version authors;
- `listComments(owner, id, workspace)` takes the workspace;
- `ownComment`'s 403 names the handle there.
`userFilterId` matches per workspace: `EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = i.assignee_id AND m.workspace = t.workspace AND m.username = ?)`. It stays a 400 `Unknown assignee` when no searched workspace has that handle.

**REST**
- New: `PATCH /api/workspaces/:key/profile` `{ name?, username? }` → `WorkspaceMember`. It needs a session. `:key` must be yours (404). A clash is 409. Other fields are 400.
- `PATCH /api/me` takes `{ email? }`.
- `POST /api/auth/redeem` takes `{ code, name?, username?, email? }`.
- `…/members/:username` and `…/agents/:username` are that workspace's handles.

**MCP.** `INSTRUCTIONS` line 27 becomes: `"- People and agents are named by username (@alice), unique within this workspace. An issue's assignee is a person who owns it; its delegate is an agent working on it for them. \"me\" means you."`

**Realtime.** Member events carry the handle in their workspace. Nothing else changes.

**UI**
- `main.tsx` keeps `you`, your `UserRef` in the current workspace from `Me.workspaces[].you`. `isMe`, the "Mine" chip, the pickers' "(you)" and the account menu use it.
- `api.ts` and `chatApi.ts` send `X-Docket-User: <me.user.id>`.
- Settings → Account (`settings.tsx:182-232`):
  - **Profile in <Workspace>**: name and username, saved with the new route. Hint: "How people in <Workspace> see you. Each workspace has its own."
  - **Email**: its own form. Hint: "Contact info, the same in all your workspaces."
- Invite accepted while signed in (`login.tsx:250-270`, `Accept`):
  - reuse `Join`'s profile fields, prefilled from `info.you`, under the title "Join <workspace>?";
  - a 409 keeps the form and shows the error.
- Sign-in-link prompt (`login.tsx:227-248`): "Sign in as @x?" becomes "Sign in as @x (<workspace>)?" when `info.workspace` is set.

**CLI** (`scripts/sign-in-link.ts`)
- Usage: `bun run sign-in-link <username> [workspace]`.
- An ambiguous handle exits 1 with lines like `acme · Sam Lee` and `side · Sam Park`, then: `Run: bun run sign-in-link sam <workspace>`.
- Update `SPEC.md:224` and `README`'s recovery line.

### Open question

**Rebuild versus a placeholder column.** The rebuild breaks CONTRIBUTING's "migrations are additive" wording. The alternative keeps `users.username` as a globally unique placeholder (`~<id>`) that is never shown again. Recommended: rebuild, as set out in DKT-3's open question. Every row and id is kept, `foreign_key_check` runs before the commit, and a frozen-fixture test and the prod rehearsal guard it. Confirm before starting.

## Acceptance criteria

- [ ] With `acme` and `side`:
  - `POST /api/workspaces/{acme,side}/agents { username: "claude" }` both answer 201;
  - each token's `GET /api/me` shows `@claude` in its own workspace only;
  - `list_members` in each marks `@claude · you`.
- [ ] A person joining `side` while signed in keeps their default handle unless they pick another. A clash is 409 and names only `side`. Signed-out joiners pick freely.
- [ ] Renaming in `side` (`PATCH /api/workspaces/side/profile`):
  - changes only `side`: in its `UserRef`s, members list and events;
  - a clash in `side` is 409;
  - an API key gets 403.
- [ ] `PATCH /api/me { username }` → 400, naming the profile route. `{ email }` still works, and its uniqueness across accounts is unchanged.
- [ ] Issues, comments, docs and versions show each person's handle and name in that workspace.
- [ ] `?assignee=sam` finds whoever holds `sam` in each workspace searched. `me` finds you.
- [ ] A tab believing it's account 1 is refused once the cookie belongs to account 2 (`switched: true`). A matching id passes.
- [ ] The CLI:
  - `bun run sign-in-link sam` works when one account holds `sam`;
  - it exits 1 and lists workspaces when two do;
  - `bun run sign-in-link sam side` picks the one in `side`;
  - agents are still refused.
- [ ] Migration: every former `users.username` and `name` now sits on each of that user's memberships; account ids, emails, sessions, keys and codes are unchanged.

## Tests

**`test/server.ts` (harness)**
- The first argument of `s.user` and `s.agent` is the handle.
- A new `as` option labels the test user (default: the handle), so the same handle can exist in two workspaces:
  - `s.agent("claude", { workspace: "side", as: "claude@side" })`;
  - `s.user("sam", { workspace: "side", as: "sam2" })` creates a different person;
  - `s.user("ana", { workspace: "side", username: "annie" })` joins as annie.

**`test/users.test.ts`**
- Replace 48-58 with "usernames are validated and unique per workspace":
  - the bad-format cases are 400;
  - duplicates in the same workspace are 409;
  - the same handle in `side` is 201 for a new person and for an agent;
  - the 409 message never names another workspace.
- Replace 169-175 with the profile route cases:
  - a rename there;
  - 409 on a clash in the same workspace;
  - a key gets 403;
  - `PATCH /api/me { username }` gets 400;
  - an email change still works.
- New: two `claude` agents act independently. A comment by each shows `@claude` with its own name. `list_members` in each marks "you".
- New: `?assignee=` and `?delegate=` resolve per workspace.

**`test/access-e2e.test.ts:146-152`:** send ids, not usernames, in `x-docket-user`.

**CLI tests** (`users.test.ts:177-191`): add the ambiguous case (exit 1, both workspaces listed) and the `<username> <workspace>` form.

**`test/migrations.test.ts`**
- Freeze the previous schema (whatever `user_version` main is at, after DKT-4) as a fixture, with:
  - a person in two workspaces;
  - an agent;
  - comments, a doc version, a key, a session and a sign-in code.
- Migrate, then assert:
  - every handle and name is carried onto each membership;
  - `/api/me` works with the old key and the old cookie;
  - `PRAGMA foreign_key_check` is empty.
- Also a runner test: a migration that leaves a dangling reference throws and leaves `user_version` unchanged. Run it on a scratch database through `bun:sqlite` in the test, using the same loop logic via a small exported helper if needed.

## SPEC.md

- **Access → Accounts**: an account is a login (`kind`, optional email). Username and name belong to each membership, unique within the workspace; `me` is reserved. Describe the default profile.
- **Access → Workspaces**: joining asks for your profile there.
- **Access → Sign-in links**: they may record a workspace; the CLI takes `<username> [workspace]`.
- **Access → Stale tabs**: the header carries the account id.
- **Routes table**: `PATCH /api/me { email }`; new `PATCH /api/workspaces/:key/profile`; the redeem body.
- **Data**: this migration, and the runner running with foreign keys off plus `foreign_key_check`.
- **MCP**: the instructions line.
- **UI → Settings**: profile per workspace, plus email.
- **Deploy**: the CLI usage.
- **`types.ts`**: `UserRef` comment, `Me`, `CodeInfo`.
- **CONTRIBUTING**: "migrations never lose data; rebuilds follow SQLite's 12-step procedure", once the open question is settled.

## Out of scope

- Team keys, doc slugs, URLs, and requiring a workspace on data routes (DKT-6).
- Credentials scoping (DKT-4).
- Guests (DKT-27, which uses the `guest` role this migration allows).
- Per-workspace avatars or emails.
- Letting one agent account join several workspaces: Docket keeps one agent per workspace, as Linear installs an app per workspace.

**Project rules:**
- Linear's features, nano implementation; no new dependencies.
- Append the next migration and add a frozen-fixture survival test.
- SPEC.md and `types.ts` change in the same branch.
- REST, MCP and UI stay in parity. Every mutation publishes `changed`. Outside your workspaces is 404. Authors are never sent by clients.
- UI: `dir="auto"` on names; works at phone width.
- Branch `feature/workspace-usernames`. `bun test` and `bun run typecheck` pass. Merge and delete the branch.
- Deploy only from main after `./backup.sh`, following the design doc's rehearsal checklist, including the membership checks for this step.
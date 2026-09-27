Full design: [Workspace isolation](/doc/workspace-isolation). This issue is the umbrella. The work ships as DKT-4, then DKT-5, then DKT-6, each on its own branch, with its own migration and its own prod rehearsal.

## Why

Workspaces on one Docket instance still share namespaces and credentials:

- An admin can't add an agent called `claude` to a second workspace: `Username "claude" is taken`. The same message tells them that someone in another workspace holds that name.
- `Team key X is taken` and doc slug clashes leak other workspaces in the same way.
- API keys reach every workspace their owner is in. That is why MCP tools need a `workspace` argument, and why suspension only deletes credentials when someone loses their *last* membership.

Only a person's login (their session) and the workspace switcher should stay global.

## Linear's behaviour

- One login can hold users in many workspaces. Each workspace has its own User, with its own `name`, its own `displayName` ("must be unique within the workspace") and its own suspension flag. Sources: [profile](https://linear.app/docs/profile) ("Your email address is your unique ID (User Account) for all workspaces you have created a User for") and the `User`/`AuthUser` types in [Linear's schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql).
- Personal API keys are made inside a workspace and can be limited to teams "in your workspace" ([API and webhooks](https://linear.app/docs/api-and-webhooks)).
- Team keys prefix identifiers and appear in URLs (`Team.key` in the schema), and every workspace can have its own `ENG`.
- Linear keeps the last three workspace URL keys and redirects them (`Organization.previousUrlKeys`).
- Linear's MCP server says "each workspace needs its own separate authentication context" ([MCP](https://linear.app/docs/mcp)).

**Deliberate differences:**
- Workspace keys never change in Docket, so only links from before this change get redirects.
- Email stays optional contact info, never used to find an account.

## Where things are today

- `src/server/db.ts:32-39`: `users.username` is `UNIQUE` across the instance.
- `src/server/db.ts:66-76`: `api_keys` has no workspace.
- `src/server/db.ts:90-98`: `teams.key` is the global primary key.
- `src/server/db.ts:134-145`: `documents.slug` is `UNIQUE` across the instance.
- `src/server/access.ts:85-93`: `checkUsername` refuses a username held anywhere (409).
- `src/server/access.ts:169-184`: `actorFor` gives every credential all of its owner's workspaces.
- `src/server/access.ts:708-713`: `suspend` only revokes credentials after the last membership.
- `src/server/tracker.ts:188-206`: `createTeam` refuses a key used in any workspace (line 194).
- `src/server/tracker.ts:284-296`: `issueRef` resolves identifiers globally.
- `src/server/tracker.ts:897-917`: `createDocument` dedupes slugs globally (line 904).
- `src/server/mcp.ts:144-150`: `oneWorkspace` makes the `workspace` argument necessary.
- `src/web/main.tsx:154-158`: the web app switches workspace when you open another workspace's team, because URLs carry no workspace.

## Design

Decided, in short. Details, SQL and the full list of affected surfaces are in the design doc.

1. `users` becomes the account (`id, kind, email, created_at`). Each membership carries `username` and `name`, unique per workspace.
2. Every request acts in one workspace. An API key, agent token or chat key acts in its own. A browser session names one with `X-Docket-Workspace`, or gets its only membership, or data routes answer 400.
3. Keys belong to one workspace. Suspending someone from W deletes their keys in W. Sessions and unused sign-in links go only when no active membership remains.
4. Teams get an internal id. Team keys and doc slugs are unique per workspace.
5. URLs become `/<ws>/…`. Old links (`/issue/KEY-1`, `/doc/slug`, `/t/KEY`, `/docs`, `/settings/*`) redirect in the browser via `GET /api/locate`; when two of your workspaces match, the oldest wins.
6. Markdown keeps `/doc/slug` and `KEY-12`, which resolve in the content's own workspace. No content is rewritten.
7. MCP drops every `workspace` argument, plus `list_workspaces` and `create_workspace`.

**Phases.** Each merges, is rehearsed on a copy of prod and deploys before the next starts.

| Step | Scope | Migration |
|---|---|---|
| DKT-4 | credentials scoped to one workspace; `X-Docket-Workspace`; suspension simplified; MCP `workspace` arguments dropped | additive (`api_keys.workspace`) |
| DKT-5 | per-workspace usernames and names; `Me.workspaces[].you`; per-workspace profile; CLI `sign-in-link <username> [workspace]` | rebuilds `users` and `workspace_members`; adds the migration-runner change |
| DKT-6 | per-workspace team keys and slugs, internal team id, `/<ws>/…` URLs, legacy redirects, session requests always name the workspace | rebuilds `teams`, `issues` and `documents` |

**Prod data migration.** Prod holds live data. Every step follows the design doc's rehearsal checklist:

- back up with `./backup.sh` and copy the backup to the Mac;
- run `integrity_check` and `foreign_key_check`, and record counts and row hashes;
- run the step-specific SQL checks;
- migrate a copy with the new build on `127.0.0.1:7199` and compare counts and hashes;
- smoke-test old links and MCP;
- back up again, run `docker compose build` then `up -d`, and verify;
- if anything is wrong, roll back by restoring the backup and the previous image.

### Open question

CONTRIBUTING says migrations are additive. DKT-5 and DKT-6 must rebuild tables: SQLite can't drop a `UNIQUE` or change a foreign key in place, and `teams.key` is the primary key that issues and docs reference. The rebuilds use SQLite's 12-step procedure, copy every row and keep every id.

**Recommendation:** allow this as a documented exception. It is guarded by:

- foreign keys off during migrations, with `PRAGMA foreign_key_check` before each commit;
- a frozen-fixture survival test per migration;
- the prod-copy rehearsal.

Reword CONTRIBUTING to say "migrations never lose data". The alternative is a globally unique placeholder in `users.username`, a permanent dead column, and it still doesn't solve team keys.

## Acceptance criteria

- [ ] DKT-4, DKT-5 and DKT-6 are merged, rehearsed on a copy of prod, and deployed, in that order.
- [ ] The same agent username, team key and doc slug can exist in two workspaces. Each resolves inside its own workspace, and neither refusal names or hints at another workspace.
- [ ] A key used in workspace A gets 404 for everything in workspace B, even when its owner is in both.
- [ ] Suspension in one workspace never signs someone out of another or kills their keys there.
- [ ] Every pre-change `/issue/…`, `/doc/…` and `/t/…` link on prod still opens the right page.
- [ ] Prod after each step: `integrity_check` ok, `foreign_key_check` empty, row counts and carried-column hashes match the backup, and Siri `/ask`, the chat panel and the agents' MCP connections work.
- [ ] The design doc is in Docket as "Workspace isolation" and matches what shipped.

## Tests

Each sub-issue lists its own tests. Across the three:

- a two-workspace scenario (the same person in both, a separate agent `claude` in each, a team `BRD` in each, a doc `plan` in each) proves nothing crosses over REST, MCP or `/ws`;
- one frozen-fixture migration-survival test per migration in `test/migrations.test.ts`.

## SPEC.md

Each sub-issue updates its own sections. When all three have landed, these read as isolated:

- Access: accounts, workspaces, suspend, credentials, request rules;
- Data;
- REST;
- Realtime;
- MCP;
- UI: Workspaces and client routing;
- Documents.

## Out of scope

- MCP tool visibility per caller (DKT-2).
- Agents creating teams (DKT-7).
- MCP server naming (DKT-8).
- Guests and private teams (DKT-27).
- Changing workspace or team keys after creation (Linear allows it with redirects; Docket keeps them permanent).
- Deleting workspaces.
- Scoping docket-chat's stored conversations per workspace: that's a change in the docket-chat repo, noted in DKT-4.
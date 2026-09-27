## Why

Agents change issues all day (status, delegate, labels, blockers, descriptions) and nothing records who did what. The issue page fakes two events ("Created", "Marked done") from timestamps, so a person can't tell whether it was an agent or a colleague who moved an issue to Done or cleared the assignee. An audit trail per issue is also the event source the inbox (DKT-11) and webhooks (DKT-12) are built on.

## Linear's behaviour

- The issue's Activity feed shows property changes interleaved with comments, including assignment and agent delegation "and who made them": https://linear.app/docs/assigning-issues
- Consecutive similar events are grouped, and older activity between comment threads is collapsed: https://linear.app/changelog/2025-04-03-collapsed-issue-history
- Changes in the first 3 minutes after creation count as part of creation and aren't logged: https://linear.app/docs/creating-issues
- Auto-close writes a history item: https://linear.app/docs/delete-archive-issues

**Deliberate differences.** Docket logs every change, including those in the first minutes: agents create and then immediately edit issues, and this is an audit trail. The UI's grouping and collapsing handle the noise. Description edits are logged without a diff (Linear doesn't document one either).

## Where things are today

- `src/server/db.ts:28-191`: `MIGRATIONS`, append-only; the next one goes after the entry ending at line 190.
- `src/server/tracker.ts:510-561` `createIssue`: one transaction (525-556) inserts the issue, blockers, bumps relatives, refreshes doc refs.
- `src/server/tracker.ts:563-607` `updateIssue`: validates columns (`issueColumns`, 341-356), reads only `status, parent_id` before the change (566, outside the transaction), writes in an IMMEDIATE transaction (593-602).
- `src/server/tracker.ts:626-642` `trashIssue` (delete/restore), transaction at 634-637.
- `src/server/tracker.ts:690-714` `claimIssue`, IMMEDIATE transaction 694-710; the write is at 708.
- `src/server/tracker.ts:476-502` `getIssue` assembles `Issue` (comments via `listComments`, 88-103).
- `src/shared/types.ts:191-198` `Issue`.
- `src/server/mcp.ts:66-81` `details()` renders get_issue; tool description at 308-320.
- `src/web/issue.tsx:441-457` `Activity`: synthetic "Created" and "Marked done" lines passed as `children` to `Comments`.
- `src/web/comments.tsx:18-40` `Comments` renders `children` first, then all comments; styles `.timeline`/`.event` at `src/web/styles.css:1096-1118`.

## Design

### Rules that apply
Docket copies Linear's features; nano is the implementation: no new dependencies, few files. Append the next migration (additive) with a migration-survival test. SPEC.md and `src/shared/types.ts` change in the same branch. REST, MCP and UI stay in parity. Workspace isolation unchanged (history is only reachable through its issue, so 404 outside your workspaces). `dir="auto"` on user text, works at phone width. Branch `feature/activity-history`; `bun test` and `bun run typecheck` pass; merge to main, delete the branch. The prod DB gets this migration rehearsed on a copy first.

### Schema (append the next migration)
```sql
-- Issue history: one row per change, written in the same transaction as the change.
-- kind has no CHECK so later kinds need no table rebuild; the app validates it.
CREATE TABLE issue_activity (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  from_value TEXT, -- JSON; see Activity
  to_value TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
-- History starts now; existing issues get their creation.
INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues;
```
Stored values: `title` strings; `status` and `claimed` statuses; `priority` numbers; `assignee`/`delegate` **user ids** (so renames show the current name); `labels` string arrays; `parent` an identifier or null; `blockedBy` identifier arrays (identifiers never change: issues can't move teams); `created`, `description`, `trashed`, `restored` store nulls.

### Contract (`src/shared/types.ts`)
```ts
export const ACTIVITY_KINDS = ["created", "title", "description", "status", "priority", "assignee", "delegate",
  "labels", "parent", "blockedBy", "claimed", "trashed", "restored"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
/** One change to an issue. from/to by kind: title, parent (identifier), status and claimed (Status) are strings;
 *  priority a number; assignee, delegate a UserRef; labels, blockedBy string arrays; null when unset, and both
 *  null for created, description, trashed, restored. */
export type ActivityValue = string | number | string[] | UserRef | null;
export interface Activity { id: number; kind: ActivityKind; actor: UserRef; from: ActivityValue; to: ActivityValue; createdAt: string }
// Issue gains:
activity: Activity[]; // oldest first
```

### Server (`tracker.ts`)
- `logActivity(a: Actor, issueId: number, changes: { kind: ActivityKind; from?: unknown; to?: unknown }[], time: string)`: inserts one row per change with the mutation's `time`. Called **once per mutation, as the last statement inside its transaction**, so hooks added later (DKT-11 notifications, DKT-12 webhook outbox) see the final state and roll back with it. Callers pass real before/after values in `changes` (for `description`, the old and new text); `logActivity` stores them in the encodings above (description as nulls), so hooks can still use the in-memory values.
- `createIssue`: `created`, plus `assignee` / `delegate` (from null) when set at creation (these drive DKT-11).
- `updateIssue`: inside the IMMEDIATE transaction, read the full before-row (`title, description, status, priority, labels, assignee_id, delegate_id, parent_id`) and the live blocker identifiers, then log only fields that really changed (labels and blockers compared as sets). A 409 (`baseUpdatedAt`) or 400 writes nothing.
- `claimIssue`: one `claimed` row (from/to = status before/after) when it writes; re-claiming your own started issue logs nothing.
- `trashIssue`: `trashed` or `restored`.
- `listActivity(issueId)`: rows oldest first, actor joined; assignee/delegate ids mapped to `UserRef` with one `WHERE id IN (…)` query. `getIssue` adds `activity`.
- Related issues bumped by a change (parent, blockers) get no rows of their own.

### REST
No new routes: `GET /api/issues/:id` (and every route returning `Issue`) carries `activity`.

### MCP
`details()` adds `## History` before `## Comments`: rows of one mutation (same actor and `createdAt`) on one line, the last 30 lines, prefixed with `(N earlier changes)` when cut:
```
2026-09-27T10:02:11.000Z · @claude · status todo → in_progress, priority none → high
2026-09-27T10:05:00.000Z · @ana · labels +bug −ui · blocked by +DKT-4
```
Per kind: `created`, `title "Old" → "New"`, `edited the description`, `assignee @a → @b` (`none`), `delegate …`, `parent none → DKT-3`, `claimed (todo → in_progress)`, `moved to trash`, `restored`. get_issue description gains: "…and comments, plus its history: who changed what and when (latest 30)." `structuredContent.issue.activity` has everything.

### UI
- `Comments` (`comments.tsx`) takes `activity?: Activity[]` and merges it with comments by `createdAt` (activity first on ties). Docs pass none.
- Rows of one mutation (same actor, same `createdAt`) render as **one line**: "**Claude** moved from Todo to In Progress, set priority to High · 2m ago" (status icon for status changes, `event-dot` otherwise; time with `fullDate` title; names, titles and labels `dir="auto"`).
- A run of more than 3 lines between two comments shows its last 2 and a quiet "Show N earlier changes" button that expands that run in place (Linear's collapse). The `created` line always shows.
- Texts: created the issue · changed the title to "X" · updated the description · moved from A to B · set priority to P / removed priority · assigned to X / unassigned X · delegated to X / removed delegate X · added label L / removed label L · set parent to ID / removed parent · marked as blocked by ID / removed blocker ID · claimed the issue · moved to trash · restored. "themselves" when the actor is the target.
- `issue.tsx` `Activity` passes `issue.activity`; the synthetic Created/Marked done lines go.

### Interaction with DKT-3 and DKT-18
Users are stored by id and identifiers are per issue within one workspace, so the schema needs nothing for DKT-3. If DKT-3 has moved username and name onto memberships, build the actor/assignee/delegate `UserRef`s from the issue's workspace membership instead of `users`. If DKT-18 has landed, stored statuses are still status keys; the UI takes their names and icons from the team's workflow.

### Automated changes

Changes Docket makes on its own (DKT-21 auto-close, DKT-31 auto-archive) are attributed to the reserved `docket` system account that DKT-21 introduces (create it here if this lands first: reserved like `me`, never a login). Add a nullable `on_behalf_of_id` to the activity row for the person or agent whose change triggered it, and render it as "Docket closed the issue (after @alice's change)". Integrations such as DKT-34's `github` account are ordinary actors.

## Acceptance criteria

- [ ] Creating an issue with an assignee and a delegate logs `created`, `assignee`, `delegate`, by the creator.
- [ ] Every field change via REST PATCH, MCP `update_issue`, claim, delete and restore appears once, with the right actor, from/to and time; unchanged fields and failed (400/409) writes log nothing.
- [ ] The issue page shows history interleaved with comments, one line per mutation, long runs collapsed; it reads correctly at phone width and in Arabic.
- [ ] MCP get_issue shows a compact `## History`.
- [ ] Renaming a user updates their name in old history; a suspended member's history keeps their name.
- [ ] After the migration, existing issues show "created" at their creation time; purging an issue removes its history.

## Tests

`test/activity.test.ts` (new):
- create with assignee (person) and delegate (agent) → `activity` kinds `[created, assignee, delegate]`, actor admin, `to` UserRefs.
- PATCH status+priority → two rows, same `createdAt`; PATCH the same values again → no new rows; labels `["a","b"]`→`["b","c"]` gives from/to arrays; blockedBy, parent (from null to identifier and back), title, description (null values).
- PATCH with a stale `baseUpdatedAt` (409) and with an invalid status (400) → activity unchanged.
- agent `claim_issue` on a todo issue → `claimed` todo→in_progress by the agent; claiming again → nothing.
- DELETE then restore → `trashed`, `restored`.
- ana (member) renames herself via PATCH /api/me → her earlier rows show the new username.
- MCP: agent `update_issue` → `get_issue` text contains `## History` and `@<agent> · status backlog → todo`.
- Purge: age the trash as in `test/parity.test.ts:66-70`, list trash, then `SELECT COUNT(*) FROM issue_activity WHERE issue_id = …` is 0.

`test/migrations.test.ts` (create it if no earlier issue has): freeze the schema of today's `MIGRATIONS[0..2]` as a constant fixture (never edit it later; later migrations add their own frozen deltas), build a DB with `PRAGMA user_version = 3`, insert a person, workspace, membership, API key (`token_hash` = sha256 of a known `dk_…` token), team and issue; start with `startServer({ setup: false, env: { DATABASE_PATH } })` (env overrides it: `test/server.ts:77-87`) and read via `s.with({ token })`: the issue is intact and `activity` is `[created]` by its creator at its `createdAt`.

## SPEC.md

- **Data**: add `issue_activity` (who changed what, one row per change, written in the change's transaction; what's stored per kind; history starts at this migration with `created`).
- **REST**: `Issue` includes `activity` (oldest first).
- **MCP**: get_issue notes "with history (latest 30 changes)".
- **UI → Issue page**: the Activity section interleaves history with comments, one line per change, long runs collapsed.

## Out of scope

- Notifications and subscriptions (DKT-11), webhooks (DKT-12), threaded comments (DKT-25).
- History for documents (they have versions), description diffs, history rows on related issues (parent/blocker counterparts), reconstructing pre-migration history beyond `created`.
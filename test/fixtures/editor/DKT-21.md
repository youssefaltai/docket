## Why

When every sub-issue of a parent is finished, someone has to remember to go close the parent too — and the
reverse, closing a parent while sub-issues are still open, leaves stragglers open forever. Linear automates
both, per team.

## Linear's behaviour

Two independent, per-team settings: auto-close a parent issue once all its sub-issues are done or canceled,
and auto-close a parent's remaining open sub-issues when the parent itself is completed.
https://linear.app/docs/parent-and-sub-issues
https://linear.app/changelog/2024-09-06-auto-close-parent-and-sub-issues

## Where things are today

- `src/server/db.ts:90-98` `teams` has no settings columns (see also DKT-31, which adds one the same way).
- `src/server/tracker.ts:563-607` `updateIssue` sets `completed_at` when a status enters/leaves
  done/canceled (`isClosed()`, line 358) but never looks at siblings or a parent.
- `src/server/tracker.ts:610-620` `relatives()` already queries an issue's parent, children and blockers
  together (used by `trashIssue`) — the parent/children half is the shape needed here, minus the blockers.
- `src/server/tracker.ts:479` `getIssue`'s `children` query (`${ISSUE_SELECT} WHERE i.parent_id = ? AND ${LIVE}`) is the query to reuse for "all live sub-issues of X".
- `src/server/access.ts:82-90` `RESERVED = ["me"]` is where a username is blocked from being taken by a real
  account — needed here to reserve the system attribution account's username.
- No existing "system actor" or activity-log concept: `comments` (db.ts:125-133) is the only per-issue
  activity trail (shown as `Activity` in `src/web/issue.tsx:441-457`), authored by a real `users.id`.
- `src/web/modals.tsx:354-404` `TeamSettingsModal` is where the two toggles go.

## Design

**System attribution account.** Automated changes need an author. Add a reserved system account, mirroring
how `"me"` is already reserved:
```sql
-- The account automated changes (auto-close) are attributed to; reserved like "me", never a real login.
INSERT INTO users (kind, username, name, created_at) VALUES ('agent', 'docket', 'Docket', datetime('now'));
```
`src/server/access.ts:83` `RESERVED` becomes `["me", "docket"]` so no one can claim the username. This account
has no workspace membership, no credentials, and is never `actorOf()` for a request — it's only ever the
`author_id` of an automated comment, resolved through the existing `ref()`/`userCols()` helpers exactly like
any other user.

**Schema** (append to the same migration as, or the one after, DKT-31's team-settings migration):
```sql
ALTER TABLE teams ADD COLUMN auto_close_parent INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_parent IN (0, 1));
ALTER TABLE teams ADD COLUMN auto_close_children INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_children IN (0, 1));
```

**Types** (`src/shared/types.ts`): `Team` gains `autoCloseParent: boolean`, `autoCloseChildren: boolean`;
`TeamInput`/`TeamPatch` gain both as optional booleans (stored as 0/1, converted at the `toTeam`/patch boundary
like other typed columns).

**Server** (`src/server/tracker.ts`), inside `updateIssue`'s transaction, after the status column is written
and `completed_at` resolved (after line 599):

1. **Auto-close children**: if this update just closed the issue (`isClosed(cols.status)` newly true) and its
   team has `auto_close_children`, fetch its live open children (`parent_id = id AND deleted_at IS NULL AND
   status NOT IN (done, canceled)`), set each to the *same* resulting status as the parent (done stays done,
   canceled stays canceled) with `completed_at = time`, post a comment on each authored by `docket`:
   `"Closed automatically: the parent issue <PARENT> was closed. (on behalf of @<actor>)"`, and recurse into
   this same step for each child that has its own children (bounded by tree depth; no cycles are possible —
   `updateIssue` already rejects an issue becoming its own ancestor, `tracker.ts:568-571`).
2. **Auto-close parent**: if this update changed status (closed *or* reopened) and the issue has a
   `parent_id`, and that parent's team has `auto_close_parent`: check whether every live child of the parent
   is now done/canceled. If so and the parent isn't already closed, set the parent to `done` with
   `completed_at = time`, post a comment on the parent authored by `docket`:
   `"Closed automatically: all sub-issues are done or canceled. (on behalf of @<actor>)"`, then re-run this
   same check one level up from the parent's own parent, if any (a chain of auto-closes can cascade upward).
3. Every issue touched (children, parent, grandparent…) is bumped and published (`bumpIssues`, `tracker.ts:505-508`, `changed("issue", …)`), same as parent/blocker changes already are (lines 578-591, 601-606).
4. These steps run inside the same `IMMEDIATE` transaction as the rest of `updateIssue` (`tracker.ts:592-602`), so a racing claim or patch on a sibling can't interleave.
5. `claimIssue` and `trashIssue` don't trigger either setting — only an explicit status change does, matching
   Linear (claiming doesn't close anything; trashing already has its own relation handling).

**REST** (`src/server/api.ts`): `PATCH /api/teams/:key` field list (line 145) gains `autoCloseParent`,
`autoCloseChildren`. No new issue-facing routes: the cascade is a side effect of the existing `PATCH
/api/issues/:id { status }`.

**MCP**: no new tool; `update_team` (`src/server/mcp.ts:245-260`) gains the same two optional boolean
inputs, and `update_issue`'s description gets one line: "closing/reopening an issue may also close its
parent or its sub-issues, per the team's settings — check `get_issue` after, and look for a comment from
@docket explaining why."

**UI**:
- `TeamSettingsModal` (`modals.tsx:354-404`) gains two checkboxes: "Auto-close parent when all sub-issues are
  done or canceled" and "Auto-close sub-issues when the parent is completed", saved via the same `updateTeam`
  call already there (line 375).
- No other UI change: the cascade shows up as normal status changes and normal comments (authored by
  "Docket", avatar included via the existing `Avatar`/`UserRef` machinery — `docket` is a `kind: "agent"`
  user, so it renders exactly like any other agent).

### Coordination with other issues

The reserved `docket` system account is shared: DKT-31 (auto-archive) and any future automation reuse it, and DKT-9 (activity history) attributes automated changes to it with the triggering person as `on behalf of`. If DKT-9 has landed, record the auto-close as activity rows instead of posting the explanatory comments; if it hasn't, post the comments as specified and DKT-9 will replace them.

## Acceptance criteria

- [ ] With `autoCloseParent` on, closing the last open sub-issue of a parent sets the parent to `done` and
      adds a `docket`-authored comment on it; with it off, nothing happens to the parent.
- [ ] With `autoCloseChildren` on, closing a parent closes all its still-open live sub-issues to the same
      status, each with a `docket`-authored comment; with it off, sub-issues are untouched.
- [ ] Reopening a sub-issue after an auto-close doesn't reopen the parent (one-directional: closing cascades,
      reopening doesn't).
- [ ] A multi-level chain (grandparent → parent → child) cascades upward correctly when all settings are on.
- [ ] `"docket"` can't be used as a real account's username (setup, invite, agent creation all 409/400).
- [ ] Realtime `changed` fires for every issue the cascade touches.
- [ ] Team settings dialog persists both toggles.

## Tests

New cases in `test/api.test.ts` or a new `test/auto-close.test.ts`:
- Enable `autoCloseParent`; close every sub-issue one by one; assert the parent flips to `done` only after
  the last one, with a comment from `@docket` mentioning the actor.
- Enable `autoCloseChildren`; close the parent; assert all open sub-issues become the same status, each with
  an attribution comment; a sub-issue already done/canceled is left alone (no duplicate comment).
- Both settings off (default): closing children never touches the parent and vice versa.
- Three-level chain with both settings on: closing the last leaf cascades all the way to the top.
- `"docket"` is rejected as a username in setup (`POST /api/setup`), invite redemption, and agent creation
  (`POST /api/workspaces/:key/agents`) — see `test/access-e2e.test.ts` for the reserved-username pattern with `"me"`.
- MCP `update_team` sets both flags; MCP `update_issue` triggers the same cascade as REST (parity).
- Migration-survival: a frozen fixture DB (previous schema, existing teams/issues) still lists teams and
  issues correctly after the migration adds the two columns (defaulting to off) and the `docket` user row.

## SPEC.md

- Data section: a new paragraph near the parent/sub-issue rules describing both settings, the cascade
  direction (closing propagates, reopening doesn't), and the `docket` system account.
- Access section: `RESERVED` usernames now include `docket` alongside `me`.
- Team settings UI bullet gains the two checkboxes.

## Out of scope

- Attribution for DKT-31's auto-archive sweep (that's a visibility change, not an issue edit — no comment is
  posted for it).
- A generic "system actor" abstraction beyond this one reserved account; if more automated behaviors need
  attribution later, they can reuse `docket`.
- Configurable target status for auto-close-parent (Linear always closes to "done"; Docket does the same,
  not "canceled", even if some children were canceled).
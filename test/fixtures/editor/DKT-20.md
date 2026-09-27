## Why

Issues get filed under the wrong team more often than teams get restructured, and today the only fix is
deleting and recreating the issue, which loses its number, comments render fine but the original identifier
and any links to it break. Linear lets you move an issue to another team and keeps the old link working.

## Linear's behaviour

Moving an issue to a different team gives it a new identifier (the target team's next number); the old
identifier and URL keep resolving, redirecting to the new one. https://linear.app/docs/editing-issues

Docket difference: Linear allows moving across workspaces too (enterprise); Docket workspaces are hard
boundaries (SPEC.md "Workspace isolation"), so this issue only allows moving within the same workspace —
mirrors how docs already move between teams of the same workspace (`DocumentPatch.team`, SPEC.md "Documents").

## Where things are today

- `src/server/tracker.ts:239` `ident()` computes an identifier from `team_key`/`number` on the fly; nothing
  stores a history of past identifiers.
- `src/server/tracker.ts:284-296` `issueRef()` resolves `"team-number"` straight against `issues`; there's no
  fallback for an identifier that used to belong to the issue.
- `src/server/tracker.ts:341-356` `issueColumns()` builds the column map for a PATCH; it has no case for
  `team` (a team change isn't just a column: it needs a new `number` from the target team's counter).
- `src/server/api.ts:47,165` `ISSUE_FIELDS` omits `"team"`; the PATCH handler passes
  `{ team: "Issues can't move between teams" }` as the rejection reason for that field.
- `src/server/mcp.ts:351-372` `update_issue`'s `inputSchema` has no `team` field.
- `src/server/tracker.ts:864-877` `saveRefs()` resolves `KEY-N` text in doc content straight against
  `issues`; after a move, new doc mentions using the *old* identifier need the same fallback as `issueRef`.
- `src/web/modals.tsx:354-404` `TeamSettingsModal` is the closest existing "team" UI; the issue page's
  `Properties` component (`src/web/issue.tsx:487-565`) has no team picker — `Prop label="Team"` (line 523-528)
  is a plain link, not editable.
- `src/web/pickers.tsx:336-345` `TeamPicker` already exists (used by `TeamCrumb` in modals.tsx) and lists
  `workspaceTeams`, so it can be reused as-is for the issue page.
- SPEC.md: "Issues can't move between teams." (Data section) and the PATCH table's field list.

Relations survive a move for free: `parent_id`, `issue_blocks.blocker_id/blocked_id` and
`document_refs.issue_id` all reference the issue's internal `id`, which never changes — only `team_key` and
`number` change. Only identifier *text* (in doc content, and anyone's old bookmark/URL) needs a fallback.

## Design

**Schema** (append the next migration):
```sql
-- An issue's identifier before it moved to another team. Old links keep resolving to the issue's new one.
CREATE TABLE issue_aliases (
  team_key TEXT NOT NULL,
  number INTEGER NOT NULL,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  workspace TEXT NOT NULL REFERENCES workspaces(key),
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_key, number)
);
CREATE INDEX issue_aliases_issue ON issue_aliases(issue_id);
```
`workspace` is redundant while team keys are globally unique, but DKT-3 may scope team keys per workspace;
storing it now means alias lookups can add a workspace condition later without another migration.

**Resolution**: `issueRef()` first tries `issues` by `(team_key, number)` as today; on a miss, it tries
`issue_aliases` joined to the live issue's current `team_key`/`number`, and returns the *current* identifier
plus a flag `wasAlias: boolean` (not part of the public type — just informs `getIssue`/REST whether to note
the move; simplest: no flag needed, since the returned `Issue.id` will simply differ from the identifier the
caller asked with, which is exactly what the client uses to detect a redirect — see UI below).

**Move** (`updateIssue`, `src/server/tracker.ts:563-607`): when `patch.team !== undefined`:
1. Look up the target team with `teamRow(a, patch.team)`; 400 if unknown; 400 `"Issues can't move to a team in another workspace"` if `team.workspace !== workspace` (kept as a real error, not blanket-rejected, unlike the old field message).
2. In the same `IMMEDIATE` transaction as the rest of the patch: insert an `issue_aliases` row for the
   issue's *current* `(team_key, number, workspace)`, then take the next number from the target team
   (`UPDATE teams SET next_number = next_number + 1 WHERE key = ? RETURNING next_number - 1`, same pattern as
   `createIssue`, `tracker.ts:526-528`), then `UPDATE issues SET team_key = ?, number = ?, ...` alongside the
   other column assignments.
3. `saveRefs()`'s identifier resolution (`tracker.ts:866-873`) gains the same alias fallback as `issueRef`, so
   a doc written *after* the move that still says the old identifier links to the (now relocated) issue.
4. No change needed for `parent_id`, `issue_blocks` or `document_refs`: they key off `issues.id`.
5. Realtime: publish `changed("issue", workspace, oldIdentifier)` (so a list/board showing the old id
   refetches and finds it gone from that team) and `changed("issue", workspace, newIdentifier)` (so the
   target team's list picks it up), plus the existing bump-and-publish of parent/blockers if those also
   changed in the same patch.

**Types** (`src/shared/types.ts`): no shape change — `Issue.id`/`IssueSummary.id` already recompute from the
current `team_key`/`number`; `IssuePatch` gains `team?: string`.

**REST** (`src/server/api.ts`):
- `ISSUE_FIELDS` (line 47) adds `"team"`.
- The PATCH handler (line 164-166) drops the `{ team: "Issues can't move between teams" }` override so
  `team` is validated normally through `issueColumns`/`updateIssue`.
- `GET /api/issues/:id` with an old identifier now returns 200 with the issue's *current* data (its `id`
  field is the new identifier) instead of 404 — this is what makes the old URL "keep resolving".

**MCP** (`src/server/mcp.ts`): `update_issue`'s `inputSchema` (line 351-367) gains
`team: teamKey.optional().describe("Move the issue to this team in the same workspace; it gets a new identifier there and the old one keeps resolving")`.

**UI**:
- `src/web/issue.tsx:523-528` `Prop label="Team"` becomes editable: wrap in `TeamPicker` (reused from
  `pickers.tsx:336`) the same way `Prop label="Parent"` uses `ParentPicker` (`issue.tsx:529-541`); `patch({ team: key })` on change.
- `IssuePage` (`issue.tsx:48-96`): after `patch()`'s response comes back, if `fresh.id !== issue.id`,
  `navigate` (client routing helper already used elsewhere, e.g. `modals.tsx:180`) replaces the URL to
  `/issue/${fresh.id}` without a full reload — the same treatment applies when the page is loaded directly at
  an old identifier: on the initial `useFetch`, if `issue.id !== id` (the route param), replace the URL.
- No new modal or confirmation: moving is a single picker action, like changing status or priority.

### Interaction with DKT-3

DKT-3 scopes URLs with a workspace prefix (`/<ws>/issue/KEY-1`). Since this move stays within one
workspace, the prefix doesn't change on a move, so the redirect logic above is unaffected either way. The
`issue_aliases.workspace` column (kept even though team keys are currently global) is there so alias lookups
can be scoped per workspace if DKT-3 makes team keys workspace-local.

### Coordination with other issues

What happens to a moved issue's **status**, **team-scoped labels**, **cycle** and **project** is specified in DKT-18, DKT-19, DKT-30 and DKT-26 respectively (each says "whichever lands second implements it"). If any of those has landed before this issue, implement its move rule here and cover it in the tests.

## Acceptance criteria

- [ ] `PATCH /api/issues/:id { team }` moves an issue to another team in the same workspace, giving it a new
      identifier (the target team's next number).
- [ ] Moving to a team in another workspace is 400; moving to an unknown team is 400.
- [ ] `GET /api/issues/:oldId` (and the web `/issue/:oldId` route) still resolves to the issue, now showing
      its new identifier; the browser URL updates to the new one without a full reload.
- [ ] Sub-issues, parent, blockers/blocked-by and doc mentions (via `document_refs`) are unaffected by the move.
- [ ] A document created after the move that mentions the *old* identifier still links to the issue.
- [ ] `update_issue` (MCP) accepts `team` and behaves the same as the REST PATCH.
- [ ] Realtime `changed` fires for both the old and new identifiers.
- [ ] The issue page's Team property is editable via a team picker.

## Tests

`test/api.test.ts` (or a new `test/move.test.ts` alongside it — check `test/parity.test.ts` for the harness style):
- Move an issue from team A to team B in the same workspace: new identifier is `B-1`-shaped; `GET` on the old identifier returns 200 with the new `id`.
- Move to a team in a different workspace: 400.
- Move to an unknown team key: 400.
- After moving, a document created with content mentioning the *old* identifier links to the issue (`document_refs`/`Document.issues`).
- Sub-issue and blocker relations (`children`, `blockedBy`, `blocks`) are unchanged across a move.
- `update_issue` MCP tool moves an issue the same way (parity with REST).
- Realtime: `s.ws()` on both the source and target team's workspace (same workspace here, so one socket) sees two `changed` events (old and new id) — see `claims.test.ts` or `parity.test.ts` for the `until()` pattern.
- Migration-survival: a frozen fixture DB at the previous `user_version` (issues/teams, no `issue_aliases` table) still lists and reads issues after migrating, and a move performed post-migration correctly inserts into the new table.

## SPEC.md

- Data section: replace "Issues can't move between teams." with a short paragraph describing the move (same
  workspace only), the new identifier, and that the old one keeps resolving via `issue_aliases`.
- REST table: `PATCH /api/issues/:id` body list gains `team`; drop the "issues can't move between teams" PATCH-rejection example.
- MCP table: `update_issue`'s field list gains `team`.

## Out of scope

- Cross-workspace moves (workspaces are a hard boundary; not planned).
- A dedicated "moved from X" activity entry in the comments thread (the old-identifier redirect already
  covers the practical need; add one later if it's missed).
- Bulk/multi-issue moves.
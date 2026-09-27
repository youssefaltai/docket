## Why

Teams that close hundreds of issues a month end up with lists, boards and MCP `list_issues` calls scanning
years of long-done work, even though those issues are already excluded from the default open-issue views.
Linear moves them out of the way automatically after a while, without deleting them.

## Linear's behaviour

Completed and canceled issues (and completed cycles) auto-archive after a period configurable per team;
archived issues are hidden from default views but stay searchable and can be unarchived.
https://linear.app/docs/delete-archive-issues

This is separate from delete: Linear's trash/delete is a distinct, shorter-lived state. Docket already has
that as its 30-day trash (SPEC.md "Trash"); this issue adds the separate, longer, opt-in archive on top,
matching Linear's split.

## Where things are today

- `src/server/db.ts:100-118` `issues` table has `deleted_at` (trash) but no archive column.
- `src/server/db.ts:90-98` `teams` table has no per-team settings at all.
- `src/server/tracker.ts:622-666` `trashIssue`/`purgeTrash` is the closest existing pattern: a timestamp
  column, a sweep function, and call sites. `purgeTrash()` runs at startup (`tracker.ts:1006`) and inside
  `trashIssue`/`listTrash` (lines 629, 671) — good template for the archive sweep's call sites.
- `src/server/tracker.ts:260` `LIVE = "i.deleted_at IS NULL"` and `listScope` (`tracker.ts:364-383`) are where
  default list filtering happens; archived issues need the same treatment as trashed ones in *default* views,
  but must stay reachable through search and direct `get_issue`/`GET /api/issues/:id`, unlike trash.
  the ` archived_at`.
- `src/shared/types.ts:191-198` `Issue`/`IssueSummary` (line 143-159) already carry `deletedAt`; no
  `archivedAt`.
- `src/web/modals.tsx:354-404` `TeamSettingsModal` is where the per-team period setting goes, next to the
  description field.
- `CLOSED_STATUSES`/`isClosed()` (`src/shared/types.ts:6`, `src/server/tracker.ts:358`) define "closed" for
  `completed_at` today.

### Interaction with DKT-18

Auto-archival should key off issues *reaching a completed or canceled state*, not off the literal status
string. Today that's exactly `completed_at IS NOT NULL` (set/cleared by `isClosed()` in `updateIssue`,
`tracker.ts:574-577`), which is already status-agnostic. When DKT-18 lands per-team custom statuses with
categories, `isClosed()`/`completed_at` presumably become category-based (done/canceled category, not literal
`status`); this issue's sweep reads `completed_at` and a team setting, so it needs **no change** when that
happens, as long as DKT-18 keeps setting `completed_at` the same way for any status in the Completed or
Canceled category.

## Design

**Schema** (append the next migration):
```sql
ALTER TABLE issues ADD COLUMN archived_at TEXT;
CREATE INDEX issues_archived ON issues(archived_at) WHERE archived_at IS NOT NULL;
ALTER TABLE teams ADD COLUMN auto_archive_days INTEGER; -- NULL = never (default); else days after completed_at
```

**Types** (`src/shared/types.ts`):
- `IssueSummary` gains `archivedAt: string | null`.
- `Team` gains `autoArchiveDays: number | null`; `TeamInput`/`TeamPatch` gain `autoArchiveDays?: number | null`.

**Server** (`src/server/tracker.ts`):
- `archiveIssue`/`unarchiveIssue`, mirroring `deleteIssue`/`restoreIssue` (lines 622-645) but simpler: a
  single `archived_at` flag, no relation stripping (relations, search, labels and team counts are unaffected
  by archiving — only default-view visibility changes). An archived issue is read-only like a trashed one
  (edits, comments, claims 409), for the same reason: it's meant to be left alone.
- `autoArchive()`: a sweep run at startup (next to `purgeTrash()`, `tracker.ts:1006`) and after any
  `updateIssue` call that sets `completed_at` (so a team's backlog of already-old closed issues gets swept
  the next time *something* in that team changes, and newly-closed issues become eligible the moment their
  window elapses on the next sweep). For each team with `auto_archive_days IS NOT NULL`, archive live,
  unarchived issues where `completed_at < datetime('now', '-' || auto_archive_days || ' days')`; bump and
  publish each.
- Default filtering: `listScope` (`tracker.ts:364-383`) excludes `archived_at IS NOT NULL` from the same
  place it excludes `deleted_at IS NOT NULL` (`LIVE`), **except** when `filter.q` is set (archived issues stay
  searchable) or `filter.archived === true` is explicitly passed. `getIssue`/`issueRef` don't filter by
  archived at all — an archived issue opened by id or identifier still loads (openable, per the brief).
- `IssueFilter` gains `archived?: boolean` (REST query param, MCP tool input) meaning "include archived
  issues in this list" rather than "only archived" — there's no dedicated archived-issues list view in this
  issue (see Out of scope).

**REST** (`src/server/api.ts`):
- `POST /api/issues/:id/archive`, `POST /api/issues/:id/unarchive` (same shape as `/restore`, line 169-171).
- `PATCH /api/teams/:key` field list (line 145) gains `autoArchiveDays`.
- `issueFilter()` (line 52-61) gains `archived: param(req, "archived") === "true"`.

**MCP**: no new tool. Mirrors "No issue delete tool: agents cancel instead" (SPEC.md, MCP section) —
archiving is workspace housekeeping, not something an agent decides; `list_issues`/`get_issue` behave exactly
as REST (archived issues excluded from default listings, still reachable via `get_issue` or `query`).

**UI**:
- `TeamSettingsModal` (`modals.tsx:354-404`) gains a `Field` with a `<select>`: Never (default) / After 1
  month / After 3 months / After 6 months / After 12 months, mapped to `null`/30/90/180/365.
- Issue page (`issue.tsx`): an `ArchivedBanner`, styled like `TrashBanner` (`components.tsx:298-312`) but
  worded "Archived on `<date>`. Unarchive it to make changes." with an Unarchive button — shown instead of
  (never alongside) `TrashBanner`, since an issue can't be both.
- List/board views: archived issues simply don't appear (server-side default filter); no new UI chrome for
  "archived" beyond the banner and being findable via search.

### Coordination with other issues

Archiving is an automated change. Attribute it to the reserved `docket` system account introduced by DKT-21 (create it here if this lands first), and once DKT-9 exists record an `archived` / `unarchived` activity row rather than a comment.

## Acceptance criteria

- [ ] A team with `autoArchiveDays` set archives its own done/canceled issues once `completed_at` is older
      than that many days; a team with it unset (default) never auto-archives.
- [ ] Archived issues are absent from `GET /api/issues` and `list_issues` by default, present when
      `archived=true`/`q` is used, and still fully readable by id/identifier.
- [ ] Editing, commenting on or claiming an archived issue is 409; restoring via `/unarchive` makes it normal
      again.
- [ ] Archiving/unarchiving doesn't touch labels, team counts, search, relations or comments.
- [ ] Realtime `changed` fires for each issue the sweep archives.
- [ ] Team settings dialog lets an admin set/clear the auto-archive period.

## Tests

New cases in `test/api.test.ts` or a new `test/archive.test.ts`:
- Set a team's `autoArchiveDays`, close an issue, fast-forward its `completed_at` directly in the fixture DB (or use a very small period and a completed_at set to the past via the API/seed) — assert it's excluded from `GET /api/issues?team=…` and `?team=…&q=<title>` still finds it.
- `POST /api/issues/:id/archive` then `PATCH` it: 409; `POST …/unarchive`: 200, editable again.
- A team with `autoArchiveDays: null` never archives regardless of age.
- `PATCH /api/teams/:key { autoArchiveDays: 90 }` round-trips through `GET /api/teams`.
- MCP `list_issues` excludes archived issues by default, matching REST (parity, see `test/parity.test.ts`).
- Migration-survival: a frozen fixture DB with issues at the previous schema still reads correctly after the migration adds `archived_at`/`auto_archive_days` (both default to absent/NULL, no behavior change for existing data).

## SPEC.md

- Data section: a new paragraph after "Trash" describing auto-archive — the column, the team setting, that
  it's independent of the 30-day trash, and the default-view/search/openable rules.
- REST table: `POST /api/issues/:id/archive`, `/unarchive`; `PATCH /api/teams/:key` body gains
  `autoArchiveDays`; `GET /api/issues` query gains `archived`.
- Team settings UI bullet (UI section) mentions the new field.

## Out of scope

- A dedicated "Archived" list/tab (Linear has one on some plans); for now archived issues are reachable by
  search or direct link only. A future issue can add a filter chip or tab if it's missed.
- Archiving documents (Linear doesn't auto-archive docs either).
- Cycles/projects (not in Docket).
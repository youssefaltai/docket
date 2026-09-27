## Why

`blockedBy` covers hard dependencies, but not "these two issues are about the same thing" (related) or "this
is the same bug, already filed" (duplicate). Without a duplicate relation, duplicates get canceled with no
trace of which issue they duplicate, and reporters/agents can't tell at a glance.

## Linear's behaviour

Three relation types: blocks, related, duplicate. Marking an issue a duplicate sets its status to the
system "Duplicate" status and records a relation to the canonical issue.
https://linear.app/docs/issue-relations

Docket difference (per this brief, since DKT-18 hasn't landed yet): Docket has no "Duplicate" status today.
Marking an issue a duplicate sets it to `canceled` (the closest existing terminal status) and records the
relation; once DKT-18 adds per-team custom statuses, a workspace could add a "Duplicate" status in the
canceled category and this issue's "set canceled" step should become "set the team's designated duplicate
status if any, else canceled" — noted as a follow-up, not built here.

## Where things are today

- `src/server/db.ts:119-124` `issue_blocks` is the only relation table, directional (`blocker_id`,
  `blocked_id`), no `kind` column — kept as-is; this issue adds a separate table rather than overloading it,
  since blocks has cycle-detection semantics (`blockerIds`, `tracker.ts:313-332`) that don't apply here.
- `src/server/tracker.ts:306-311` `relatedId()` already validates "same workspace, not trashed" for a single
  related identifier — reused as-is for both new relation kinds.
- `src/server/tracker.ts:313-332` `blockerIds()` is the pattern for a whole-list replace with validation;
  `setBlockers()` (334-338) is the pattern for rewriting a join table on update.
- `src/server/tracker.ts:341-356` `issueColumns()` handles simple column patches; relation fields
  (`blockedBy` today) are handled separately in `createIssue`/`updateIssue` (lines 523, 572, 584-591) since
  they aren't plain columns.
- `src/shared/types.ts:191-198` `Issue` has `blockedBy: string[]` (input+computed) and `blocks: string[]`
  (computed-only, the reverse of `issue_blocks`, queried in `getIssue`, `tracker.ts:480-486`).
- `src/server/api.ts:47` `ISSUE_FIELDS`; `src/server/mcp.ts:37,361` `blockedBy` field.
- `src/web/pickers.tsx:385-406` `BlockedByPicker` (multi) is the template for a "Related" picker;
  `ParentPicker` (362-384, single-select with a "None" option) is the template for a "Duplicate of" picker.
- `src/web/issue.tsx:542-558` `Properties`' "Blocked by"/"Blocks" rows are the template for "Related" and
  "Duplicate of"/"Duplicates" rows.

## Design

**Schema** (append the next migration):
```sql
-- "related" is undirected (one row per pair, from_id < to_id by insertion order — see setRelated);
-- "duplicate" is directional: from_id is the duplicate, to_id is the canonical issue.
CREATE TABLE issue_relations (
  from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
```
A "related" pair is stored once (whichever direction was set first) and queried with `from_id = ? OR to_id =
?`; a "duplicate" pair is stored `from_id = duplicate, to_id = canonical` and each issue can be the `from_id`
of at most one duplicate row (enforced in code, not SQL, same style as the one-parent rule).

**Types** (`src/shared/types.ts`):
- `Issue` gains `relatedTo: string[]` (computed, both directions, identifiers) and `duplicateOf: string |
  null` (computed) plus `duplicates: string[]` (computed, reverse of `duplicateOf` — other issues marked as
  duplicates of this one), the same computed/input split as `blocks`/`blockedBy`.
- `IssueInput`/`IssuePatch` gain `relatedTo?: string[]` (whole-list replace, like `blockedBy`) and
  `duplicateOf?: string | null` (set or clear one).

**Server** (`src/server/tracker.ts`):
- `relatedIds(a, identifiers, workspace, self)`: same shape as `blockerIds` but no cycle check — just dedupe
  and reject `self` from the list (an issue can't be related to itself).
- `setRelated(id, ids)`: `DELETE FROM issue_relations WHERE kind = 'related' AND (from_id = ? OR to_id = ?)`
  then insert one row per id with `from_id = min(id, other), to_id = max(id, other)` so the pair is stored
  once regardless of which side calls `setRelated`.
- `duplicateId(a, identifier, workspace, self)`: like `relatedId` but also 400s if `identifier === self`.
- Setting `duplicateOf` (create or update): delete any existing `kind = 'duplicate'` row with this
  `from_id`, insert the new one (or none, if cleared), and when setting one (not clearing), also set the
  issue's `status` to `canceled` (with `completed_at`) in the same transaction — mirrors how `blockedBy`
  changes bump related issues (`updateIssue`, `tracker.ts:584-591`): the canonical issue is bumped and
  published too, since its `duplicates` list changed. Clearing `duplicateOf` does **not** restore a prior
  status — the caller changes status separately if that's wanted, same as any other manual status change.
- `getIssue` (`tracker.ts:476-502`) gains `relatedTo`, `duplicateOf`, `duplicates` queries alongside the
  existing `blocks` query (line 480-486), same shape.
- Workspace/trash rules: identical to blockers — `relatedId`/`duplicateId` reuse the existing checks (same
  workspace only, not trashed) already enforced by `relatedId` (`tracker.ts:306-311`).

**REST** (`src/server/api.ts`): `ISSUE_FIELDS` (line 47) gains `"relatedTo"`, `"duplicateOf"`.

**MCP** (`src/server/mcp.ts`): `create_issue` and `update_issue` gain optional `relatedTo` (array of
identifiers, same `blockedBy` zod schema shape) and `duplicateOf` (single identifier, nullable on update).
Tool description addition: "Mark an issue a duplicate with `duplicateOf`: it's set to canceled and the
relation is recorded; use `related` (`relatedTo`) for issues that are connected but not duplicates or
blockers." `details()` (`mcp.ts:66-81`) gains a line for `relatedTo`/`duplicateOf`/`duplicates` alongside the
existing `blockedBy`/`blocks` line.

**UI**:
- `RelatedPicker` (new, `pickers.tsx`, copy of `BlockedByPicker`) and `DuplicatePicker` (new, copy of
  `ParentPicker`'s single-select shape, excluding self and existing duplicates-of-this-issue).
- `Properties` (`issue.tsx:487-565`) gains a "Related" row (like "Blocked by", using `Relations` +
  `RelatedPicker`) and a "Duplicate of" row (like "Parent", using `DuplicatePicker`); when `duplicates.length
  > 0`, a read-only "Duplicates" row lists them (like the existing "Blocks" row, `issue.tsx:554-558`).
- No confirmation dialog for marking a duplicate: picking a canonical issue immediately sends `patch({
  duplicateOf: id })`; the server-side status flip to `canceled` comes back on the next fetch and updates the
  Status property along with it (the client's optimistic `patch()`, `issue.tsx:102-116`, doesn't need to guess
  the resulting status — it already re-syncs from the server response).

## Acceptance criteria

- [ ] `relatedTo` is symmetric: setting it from either issue makes both show the relation.
- [ ] Setting `duplicateOf` records the relation, sets status to `canceled`, and shows up as `duplicates` on
      the canonical issue.
- [ ] Clearing `duplicateOf` removes the relation and leaves status as-is (still canceled, until changed
      manually).
- [ ] An issue can't be related to or a duplicate of itself; can't be a duplicate of a trashed issue or one
      in another workspace (400).
- [ ] `create_issue`/`update_issue` (MCP) accept `relatedTo`/`duplicateOf` with the same rules as REST.
- [ ] Realtime `changed` fires for both sides of a related pair and both sides of a duplicate relation.
- [ ] Properties panel shows Related, Duplicate of, and (when applicable) Duplicates.

## Tests

New cases in `test/api.test.ts` or a new `test/relations.test.ts` (check `test/parity.test.ts` for
cross-workspace/trash edge patterns already written for `blockedBy`):
- Set `relatedTo` from issue A to B: both `GET A` and `GET B` show the relation; removing it from A's list
  removes it from B too.
- Set `duplicateOf` on A pointing at B: A's status becomes `canceled`, `GET B` lists A in `duplicates`.
- Clear `duplicateOf` on A: relation gone, A's status stays `canceled`.
- 400: `duplicateOf` = self; `relatedTo` including self; `duplicateOf`/`relatedTo` naming an issue in another
  workspace or in the trash (409/400 per the existing relation-validation messages).
- MCP `create_issue`/`update_issue` parity with REST for both fields.
- Realtime: both ends of a related pair and both ends of a duplicate relation get a `changed` event.
- Migration-survival: a frozen fixture DB (existing issues, no `issue_relations` table) reads correctly after
  the migration; existing `blockedBy`/`blocks` behavior is unaffected.

## SPEC.md

- Data section: new paragraph describing `issue_relations`, the two kinds, the symmetric/directional split,
  and the "duplicate ⇒ canceled" rule with the DKT-18 follow-up note.
- REST table: `IssuePatch` field list gains `relatedTo`, `duplicateOf`.
- MCP table: `create_issue`/`update_issue` field lists gain both.

## Out of scope

- Using a dedicated "Duplicate" status (DKT-18's job once per-team statuses exist).
- Relation types beyond related/duplicate (Linear has only these three total, including blocks, which
  Docket already has).
- Bulk-marking duplicates or a "merge" action beyond the relation + status change.
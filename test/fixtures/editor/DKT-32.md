## Why

Teams that plan work by size, not just priority, need a number on each issue and a running total per status
group, so a glance at the board answers "how much is left," not just "how many issues are left."

## Linear's behaviour

Estimates are opt-in per team, with a choice of scale: exponential (1, 2, 4, 8, 16), Fibonacci (1, 2, 3, 5,
8), linear (1, 2, 3, 4, 5), or t-shirt sizes (XS, S, M, L, XL). Estimates show on issue rows and are summed in
group headers/view summaries (both issue count and total estimate shown). https://linear.app/docs/estimates

Docket difference: Linear's extended scales (32/64, 13/21, 6/7, XXL/XXXL) and t-shirt-to-Fibonacci
statistical conversion are enterprise/edge-case depth this issue skips — Docket ships the four base scales
only, each capped at 5 values, which covers the common case and stays nano. T-shirt sizes are stored and
summed as their position in the scale (XS=1…XL=5), not Linear's Fibonacci mapping, since Docket has no
separate "story point equivalent" concept to justify the extra mapping table.

## Where things are today

- `src/server/db.ts:90-118` neither `teams` nor `issues` has anything estimate-shaped.
- `src/shared/types.ts:18-28` `PRIORITIES`/`PRIORITY_LABELS` is the closest existing "small fixed scale on an
  issue" precedent to follow for shape (a `const` array + a labels record), though estimates need a
  *variable* scale (per team), not one fixed set.
- `src/server/tracker.ts:341-356` `issueColumns()` is where the plain-column patch goes.
- `src/web/issues.tsx:238-253` `IssueList`'s group `<span className="count">{items.length}</span>` (line 244)
  and `src/web/issues.tsx:366-370` `Board`'s column head `<span className="count">{items.length}</span>`
  are exactly where a summed-estimate total gets added.
- `src/web/modals.tsx:354-404` `TeamSettingsModal` is where the opt-in toggle and scale picker go.
- `src/web/issue.tsx:487-565` `Properties` is where the editable estimate field goes (only rendered when the
  team has estimates on).
- `src/web/issues.tsx:290-309` `IssueRow`, `394-435` `Card` are where the estimate badge goes on rows/cards.

## Design

**Schema** (append the next migration):
```sql
ALTER TABLE teams ADD COLUMN estimate_scale TEXT; -- NULL = off (default); else 'exponential'|'fibonacci'|'linear'|'tshirt'
ALTER TABLE issues ADD COLUMN estimate INTEGER; -- 1..5, an index into the team's scale; NULL = unestimated
```
`estimate` is stored as a 1–5 *position* in whichever scale the team uses, not the scale's display value —
this way it survives a team switching scales later without rewriting every issue (Linear does the same:
changing a team's scale doesn't retroactively convert existing values, it just changes their display).

**Types** (`src/shared/types.ts`):
```ts
export const ESTIMATE_SCALES = ["exponential", "fibonacci", "linear", "tshirt"] as const;
export type EstimateScale = (typeof ESTIMATE_SCALES)[number];

// Display value at each 1-5 position, per scale. Docket ships the 5-value base scales only (no extended tiers).
export const ESTIMATE_VALUES: Record<EstimateScale, string[]> = {
  exponential: ["1", "2", "4", "8", "16"],
  fibonacci: ["1", "2", "3", "5", "8"],
  linear: ["1", "2", "3", "4", "5"],
  tshirt: ["XS", "S", "M", "L", "XL"],
};
```
- `Team` gains `estimateScale: EstimateScale | null`; `TeamInput`/`TeamPatch` gain `estimateScale?:
  EstimateScale | null`.
- `IssueSummary` gains `estimate: number | null` (1–5, the stored position — the display string is derived
  client-side from the issue's team's `estimateScale` via `ESTIMATE_VALUES`, so the server never needs to
  know a specific issue's team's scale just to answer `GET /api/issues`; a summary from a team with no scale
  set should have `estimate: null` always, enforced server-side, see below).
- `IssueInput`/`IssuePatch` gain `estimate?: number | null`.

**Server** (`src/server/tracker.ts`):
- `issueColumns()` (line 341-356) gains: if `patch.estimate !== undefined`, 400 unless
  `team.estimateScale !== null` (`"Turn on estimates for this team first"`), then 400 unless `estimate` is an
  integer 1–5 or `null`.
- `createIssue`'s defaults (line 512-517) gain `estimate: null`.
- Changing a team's `estimateScale` to `null` (turning estimates off) does **not** clear existing issues'
  `estimate` values (they're just hidden until re-enabled) — matches how Linear preserves data when features
  are toggled off. Note this explicitly since it's a real decision, not an omission.
- No new list/filter logic needed — estimates are for display and summing, not filtering, in this issue (see
  Out of scope).

**REST** (`src/server/api.ts`):
- `ISSUE_FIELDS` (line 47) gains `"estimate"`.
- `PATCH /api/teams/:key` field list (line 145) gains `"estimateScale"`.

**MCP** (`src/server/mcp.ts`):
- `create_issue`/`update_issue` gain `estimate: z.number().int().min(1).max(5).nullable().optional().describe("Position in the team's estimate scale (1-5), if the team has estimates on; check list_teams/get a team for its scale")`.
- `update_team` gains `estimateScale: z.enum(ESTIMATE_SCALES).nullable().optional()`.
- `line()` (`mcp.ts:52-64`) appends the estimate's display value (needs the issue's team's scale — `line()`
  currently takes only an `IssueSummary`; thread the team's `estimateScale` through where `line()` is called
  with a resolved team, or simplest: keep `line()` estimate-free and let `details()`/`get_issue`'s per-issue
  output show it, since list output is already dense — **decision**: show it only in `get_issue`'s `details()`
  (which already has the full `Issue` and can look up its team), not in the terse `line()`, to avoid needing a
  team lookup per row in every `list_issues` call.

**UI**:
- `TeamSettingsModal` (`modals.tsx:354-404`) gains: a checkbox "Estimates" that reveals a `<select>` of the
  four scales when checked (unchecking sets `estimateScale: null`).
- `Properties` (`issue.tsx:487-565`) gains an "Estimate" row, shown only when `team?.estimateScale` is set: a
  small picker (new `EstimatePicker`, `pickers.tsx`, single-select over `ESTIMATE_VALUES[scale]`, same shape
  as `PriorityPicker`) plus "No estimate".
- `IssueRow` (`issues.tsx:290-309`) and `Card` (`issues.tsx:394-435`) show a small estimate badge (the scale
  display value) next to priority, only when the issue's team has estimates on and the issue has one set.
- Group headers: `IssueList`'s per-status `<span className="count">` (line 244) and `Board`'s column head
  (line 368) become, when **any** issue in view has a non-null estimate, `"{count} · {sum} pts"`-shaped (sum
  computed from each item's `estimate` position mapped through its team's scale to a number — t-shirt sizes
  sum as their 1–5 position, per the Docket-difference note above); unchanged (`{count}` only) otherwise, so
  teams without estimates see no UI change at all.

## Acceptance criteria

- [ ] A team with `estimateScale: null` (default) rejects `estimate` on its issues (400); enabling a scale
      allows 1–5.
- [ ] Estimate round-trips through create/update, REST and MCP; display value derives from the team's scale.
- [ ] Turning estimates off preserves existing issues' stored values (hidden, not deleted); turning back on
      shows them again.
- [ ] List/board group headers show a summed total only for teams/views where at least one issue is
      estimated; unaffected otherwise.
- [ ] Issue rows/cards show an estimate badge only for teams with estimates on.
- [ ] `update_team` (MCP) sets the scale; `get_issue`'s text output shows the estimate's display value.

## Tests

New cases in `test/api.test.ts` or a new `test/estimates.test.ts`:
- `PATCH /api/teams/:key { estimateScale: "fibonacci" }`; then create/update an issue with `estimate: 3`
  (displays "5" per the Fibonacci scale) — round-trip through `GET`.
- Setting `estimate` on a team with `estimateScale: null` is 400.
- `estimate: 6` or `0` is 400 (out of 1–5 range).
- Turning `estimateScale` off then back on preserves an issue's stored `estimate`.
- MCP `create_issue`/`update_issue`/`update_team` parity with REST.
- Migration-survival: existing teams/issues (frozen fixture, no `estimate_scale`/`estimate` columns) read
  fine after the migration, both defaulting to `null`.

## SPEC.md

- Data section: a short paragraph on `estimate_scale`/`estimate`, the four scales and their five values, and
  that turning estimates off hides rather than clears values.
- REST table: `TeamPatch` gains `estimateScale`; `IssuePatch` gains `estimate`.
- MCP table: `update_team` gains `estimateScale`; `create_issue`/`update_issue` gain `estimate`.
- UI section: team settings bullet mentions the toggle/scale picker; list/board row bullets mention the
  estimate badge and summed group headers.

## Out of scope

- Filtering or sorting by estimate.
- Extended scale tiers (32/64, 13/21, 6/7, XXL/XXXL) — only the base five-value scales ship.
- Cycles/projects effort tracking (Linear uses estimates for cycle completion %; Docket has neither).
- T-shirt-to-numeric statistical conversion for cross-scale comparison (Linear's nuance, not needed without
  cycles/projects to aggregate across).
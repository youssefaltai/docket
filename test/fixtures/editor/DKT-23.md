## Why

Deadlines are one of the most basic things a tracker needs and Docket has none: no way to say an issue is due
by a date, no visual nudge when it's overdue, nothing to sort or filter by.

## Linear's behaviour

A due date (date only, no time) on any issue. The due date indicator is red when due today or overdue,
orange when due within a week, gray otherwise; hovering shows the date and days remaining/overdue. Filters
include Due soon, Due today, No due date, Has due date, Overdue. https://linear.app/docs/due-dates

## Where things are today

- `src/server/db.ts:100-118` `issues` table has no date field beyond timestamps (`created_at`, `updated_at`,
  `completed_at`); those are full ISO instants, but a due date is a calendar date (Linear: date only).
- `src/server/tracker.ts:341-356` `issueColumns()` is where a new plain column patch belongs, next to
  `priority`/`labels`.
- `src/server/tracker.ts:255-259` `ISSUE_ORDER`/`STATUS_RANK`/`PRIORITY_RANK` define today's sort; a due-date
  sort is a new, separate order, not a tiebreaker within the existing one (see Design).
- `src/shared/types.ts:143-159` `IssueSummary`, `253-264` `IssueInput`, `266-268` `IssuePatch`,
  `270-279` `IssueFilter` are the four shapes to extend.
- `src/web/issues.tsx:290-309` `IssueRow` (list) and `394-435` `Card` (board) are where the due-date chip
  goes; `src/web/issue.tsx:487-565` `Properties` is where the editable due-date field goes.
- `src/web/util.ts:7-24` `timeAgo`/`ago`/`fullDate` are the existing relative-time helpers; a due date needs
  a parallel "in 3 days" / "3 days overdue" formatter, date-only (no time-of-day noise).
- `src/web/pickers.tsx` has no date picker yet; the existing `Picker` component (`pickers.tsx:36-` onward) is
  built for option lists, not a calendar — a due date needs a plain `<input type="date">`, not a new
  `Picker` variant (keeps this nano: no calendar widget dependency).

## Design

**Schema** (append the next migration):
```sql
ALTER TABLE issues ADD COLUMN due_on TEXT; -- date only, "YYYY-MM-DD"; NULL = no due date
CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
```
Stored as a plain `YYYY-MM-DD` string (sorts and compares correctly as text, like the existing ISO
timestamps), not a full timestamp — Linear's due date has no time component.

**Types** (`src/shared/types.ts`):
- `IssueSummary` gains `dueOn: string | null` (`"YYYY-MM-DD"`).
- `IssueInput`/`IssuePatch` gain `dueOn?: string | null`.
- `IssueFilter` gains `due?: "overdue" | "soon" | "today" | "none" | "any"` (matches Linear's filter set:
  Overdue, Due soon, Due today, No due date, Has due date).

**Server** (`src/server/tracker.ts`):
- `checkDueOn(value)`: validates `/^\d{4}-\d{2}-\d{2}$/` and that it parses to a real calendar date (400
  `"dueOn must be a date like 2026-09-30"` otherwise); `issueColumns()` (line 341-356) gains
  `if (patch.dueOn !== undefined) cols.due_on = patch.dueOn === null ? null : checkDueOn(patch.dueOn)`.
  `createIssue`'s `cols` defaults (line 512-517) gain `due_on: null`.
- Filtering (`queryIssues`, `tracker.ts:438-474`): a `filter.due` clause using SQLite's `date('now')`
  (server's local date — Docket has no per-user timezone setting, so "today"/"overdue" are server-time, same
  simplification as `now()` elsewhere):
  - `overdue`: `i.due_on IS NOT NULL AND i.due_on < date('now') AND i.status NOT IN (done, canceled)` (an
    overdue *closed* issue isn't shown as overdue — Linear doesn't flag finished work).
  - `soon`: `i.due_on IS NOT NULL AND i.due_on BETWEEN date('now') AND date('now', '+7 days')`.
  - `today`: `i.due_on = date('now')`.
  - `none` / `any`: `i.due_on IS NULL` / `i.due_on IS NOT NULL`.
- Sorting: a due-date sort is a *separate* list order from the default status/priority order (Linear: sort
  is a view-level choice, not a permanent tiebreaker). Add `sort?: "default" | "due"` to `IssueFilter`; when
  `"due"`, order by `i.due_on IS NULL, i.due_on ASC, ` + the existing `ISSUE_ORDER` as the tiebreaker.
  `listIssuesPage`'s cursor (`cursorOf`/`parseCursor`, `tracker.ts:406-417`) needs a due-date variant cursor
  when `sort === "due"` — smallest addition: include `due_on` as a fifth cursor field, always present (null
  sorts first), used only when `sort === "due"`.

**REST** (`src/server/api.ts`):
- `ISSUE_FIELDS` (line 47) gains `"dueOn"`.
- `issueFilter()` (line 52-61) gains `due: param(req, "due")`, `sort: param(req, "sort")`.

**MCP** (`src/server/mcp.ts`):
- `create_issue`/`update_issue` gain `dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('Due date, "YYYY-MM-DD"; null to clear')`.
- `list_issues` gains `due` (same enum) and `sort` (`"default" | "due"`) inputs.
- `line()` (`mcp.ts:52-64`) appends `· due 2026-10-01` (or `· overdue 2026-09-20`) when `dueOn` is set, so
  agents see deadlines in list output without calling `get_issue`.

**UI**:
- `Properties` (`issue.tsx:487-565`) gains a "Due date" row: a plain `<input type="date">` (no new picker
  component), showing "No due date" when unset, styled per the Linear color rule (see below) when set.
- A `DueChip` component (new, `components.tsx` or `issues.tsx`): renders `dueOn` as "in 3d" / "3d overdue" /
  "today" (reusing `util.ts`'s relative-time style, date-only), colored red (overdue or today, open issue
  only), orange (within 7 days), gray otherwise — shown in `IssueRow` (`issues.tsx:290-309`, next to
  `Blocked`) and `Card` (`issues.tsx:394-435`, in `card-meta`).
- Toolbar (`ListHeader`/`Filters`, `issues.tsx:174-217`) gains a due-date filter chip with the five Linear
  options (Overdue, Due soon, Due today, Has due date, No due date), same `Picker` pattern as the label/
  assignee filters.
- Group headers (`IssueList`, `issues.tsx:221-253`) get an optional sort toggle is **out of scope** — see
  below; only the filter chip and per-row/card chip are in scope, since Linear's "sort by due date" is a
  general per-view sort control this codebase doesn't have yet (there's no sort control at all today, only a
  fixed order) — this issue adds the `sort=due` API but wires only the filter chip in the UI, not a sort UI
  toggle, to stay minimal (see Open question).

### Open question

Should this issue also add a visible "sort by due date" control (List/Board toggle already exists at
`issues.tsx:159-166`; a sort control doesn't), or ship the API (`sort=due`) unused by the UI until a future
issue adds general sort controls? **Recommendation**: ship the filter chip (Overdue/Due soon/etc.) now, which
covers the main user need (find what's due soon), and leave `sort=due` in the REST/MCP API but unused by the
UI — a future "view options" issue can wire a sort dropdown for all sort keys at once rather than a one-off
here. Status: `backlog` for this reason (a real product call, not a blocker to reading the design).

## Acceptance criteria

- [ ] `dueOn` round-trips through create/update, REST and MCP.
- [ ] `?due=overdue` excludes closed issues even if their due date has passed.
- [ ] `?due=soon` / `today` / `none` / `any` each match Linear's definitions above.
- [ ] List rows and board cards show a due-date chip colored red/orange/gray per the rule; no chip when
      `dueOn` is null.
- [ ] Due-date filter chip in the toolbar; combinable with the existing label/assignee filters and search.
- [ ] `list_issues` (MCP) `due` filter and the one-line summary's due-date suffix work the same as REST.

## Tests

New cases in `test/api.test.ts` or a new `test/due-dates.test.ts`:
- Create/update with `dueOn`; invalid formats (`"2026-13-40"`, `"tomorrow"`) are 400.
- `?due=overdue` excludes a done issue with a past due date; includes an open one.
- `?due=soon`/`today`/`none`/`any` each return the expected set against a small fixture of issues with
  varied `dueOn` values (use a fixed `due_on` written directly via the API, not relative to real "now", or
  freeze/derive expected dates from `date('now')` computed the same way the server does).
- `sort=due` orders nulls last (or first — pick one and assert it) and ascending by date otherwise, with
  pagination (`first`/`after`) resuming correctly across a page boundary.
- MCP `create_issue`/`update_issue`/`list_issues` parity with REST for `dueOn`/`due`.
- Migration-survival: existing issues (frozen fixture, no `due_on` column) read fine after the migration,
  `dueOn: null` for all of them.

## SPEC.md

- Data section: a short paragraph on `due_on` (date-only, format, null meaning).
- REST table: `IssuePatch` gains `dueOn`; `GET /api/issues` query gains `due`, `sort`.
- MCP table: `create_issue`/`update_issue` gain `dueOn`; `list_issues` gains `due`, `sort`.
- UI section: list/board row bullets mention the due-date chip and its color rule; toolbar bullet mentions
  the due-date filter.

## Out of scope

- A general sort-order UI control (see Open question) — the API exists, the UI wires only the filter chip.
- Time-of-day due dates or reminders/notifications when something becomes overdue.
- SLAs (Linear's separate, more complex feature that replaces due dates when applied).
## Why

Teams that plan in sprints have nowhere to say "this is what we're doing these two weeks" and see how far along they are. Unfinished work has to be moved forward by hand. Linear's cycles do this per team, on a repeating schedule, with rollover built in. This is the minimal version.

## Linear's behaviour

- Cycles are opt-in per team ("Team Settings > Cycles", "Enable cycles"). They last 1–8 weeks and start on a chosen weekday, with an optional cooldown. Teams choose how many upcoming cycles to create, up to 15. https://linear.app/docs/use-cycles
- "Open issues generally roll over automatically, but issues moved to backlog, triage, canceled, or completed during cooldown are not carried into the next cycle." "There is no way to keep unfinished issues in a closed cycle." "Past cycle dates cannot be changed." https://linear.app/docs/use-cycles
- An optional automation adds started or completed issues with no cycle to the current one. Disabling cycles marks the current cycle completed and removes the upcoming ones. https://linear.app/docs/use-cycles
- "Cycles are automated and repeating; you'll set a start date and duration for cycles, which will then repeat every N weeks." https://linear.app/docs/conceptual-model
- Sub-issues "may also inherit [the parent's] cycle when created in an active status". https://linear.app/docs/parent-and-sub-issues
- An issue can be in a project and a cycle at once; exports carry both. https://linear.app/docs/exporting-data

**Where Docket differs, on purpose.** Cycles run on UTC dates (00:00 UTC), since teams have no timezone setting. There's no cooldown, no auto-add automation and no capacity or velocity. Cycles are numbered and unnamed ("Cycle 12"). All unfinished issues roll over, which is Linear's rule without cooldown. Only people change cycle settings, like the other team settings; agents use cycles.

## Where things are today

- `src/server/db.ts:90-98`: `teams`, with no schedule. `:100-117`: `issues`, with no cycle.
- `src/shared/types.ts`: `:123-132` `Team`, `:141` `TeamPatch`, `:143-159` `IssueSummary`, `:253-279` `IssueInput`/`IssuePatch`/`IssueFilter`.
- `src/server/tracker.ts`:
  - `:209-217` `updateTeam` takes only name and description.
  - `:341-356` `issueColumns`; `:510-561` `createIssue`, where a sub-issue inherits; `:563-607` `updateIssue`; `:438-474` `queryIssues`.
  - `:1005-1006` runs `purgeTrash()` at startup, the pattern for startup maintenance.
- `src/server/index.ts:75`: `setInterval(purgeExpiredKeys, …)`, the pattern for a timer.
- `src/server/api.ts:140-151`: team routes. `:145` the strict team PATCH fields.
- `src/server/mcp.ts`: `:209-225` `list_teams`, `:66-81` `details`, `:276-372` `list_issues`/`create_issue`/`update_issue`.
- Web:
  - `src/web/routing.tsx:20-23`: team sub-routes. `src/web/components.tsx:251-257`: team tabs.
  - `src/web/modals.tsx:353-404`: `TeamSettingsModal`. DKT-18 replaces it with a `/t/:key/settings` page.
  - `src/web/issues.tsx:43-171`: `IssuesView`. `src/web/issue.tsx:487-564`: `Properties`. `src/web/modals.tsx:125-159`: new issue chips.

## Design

### Data (append the next migration)

```sql
ALTER TABLE teams ADD COLUMN cycle_weeks INTEGER; -- NULL: cycles off; else 1–8
ALTER TABLE teams ADD COLUMN upcoming_cycles INTEGER NOT NULL DEFAULT 2; -- future cycles kept ready, 1–15
CREATE TABLE cycles (
  id INTEGER PRIMARY KEY,
  team_key TEXT NOT NULL REFERENCES teams(key),
  number INTEGER NOT NULL, -- 1, 2, 3… per team
  starts_at TEXT NOT NULL, -- 00:00 UTC, ISO
  ends_at TEXT NOT NULL, -- exclusive: the next cycle's starts_at
  completed_at TEXT, -- set when it ended and its unfinished issues rolled over
  UNIQUE (team_key, number)
);
ALTER TABLE issues ADD COLUMN cycle_id INTEGER REFERENCES cycles(id) ON DELETE SET NULL;
CREATE INDEX issues_cycle ON issues(cycle_id) WHERE cycle_id IS NOT NULL;
```

Existing teams start with cycles off, and existing issues have no cycle. If DKT-3 gives teams a surrogate id first, reference it.

### Contract (`src/shared/types.ts`)

```ts
export interface Cycle {
  team: string;
  number: number; // per team: 1, 2, 3…
  startsAt: string; // ISO, 00:00 UTC
  endsAt: string; // exclusive
  state: "completed" | "current" | "upcoming";
  issueCount: number; // live issues in it
  completedCount: number; // of those, completed
  progress: number; // 0–1: completed issues count 1, started ½; canceled are left out
}
```

- `Team` gains `cycleWeeks: number | null` (null: off), `upcomingCycles: number` and `currentCycle: number | null`.
- `TeamPatch` gains `cycleWeeks?: number | null`, `upcomingCycles?: number` and `cycleStartsOn?: string` (YYYY-MM-DD, only when turning cycles on).
- `IssueSummary` gains `cycle: number | null`.
- `IssueInput` gains `cycle?: number | "current" | "next" | null` (so `IssuePatch` has it too).
- `IssueFilter` gains `cycle?: string` ("current" or a number).

### Server (`src/server/tracker.ts`, `--- Cycles ---`)

- **`syncCycles(team?)`** is idempotent, runs in one transaction per team, and only touches teams with `cycle_weeks` set. At time `T`:
  1. Take each cycle with `ends_at <= T AND completed_at IS NULL`, in number order. Make sure the next number exists (starting at this `ends_at` and lasting `cycle_weeks` weeks). Move this cycle's live issues that aren't completed or canceled into the next cycle. That's by DKT-18's status categories if it has landed; otherwise, everything but `done` and `canceled`. Then set `completed_at = ends_at`. Moved issues are bumped with `BUMPED_AT` and publish `issue` events.
  2. While fewer than `upcoming_cycles` cycles start after `T`, append one after the last.
  
  If anything changed, publish `changed("team", ws, key)`.
  
  It runs:
  - at startup (next to `purgeTrash()`, `tracker.ts:1006`)
  - every minute (`setInterval` next to `index.ts:75`)
  - at the start of `listCycles` and of any cycle assignment
  - after cycle settings change
  
  So a cycle ends within a minute of midnight UTC, and never serves a stale "current".
- **Settings in `updateTeam`.** These need a person who is an active member (agents get 403 "Only people can change cycle settings"; other workspaces 404).
  - **Turning on** (`cycleWeeks` 1–8 while off). This creates cycle `MAX(number)+1` (1 for a new team), starting at `cycleStartsOn` (today UTC by default; it must be today or later, else 400), then syncs.
  - **Changing `cycleWeeks`** while on re-dates only cycles that haven't started. They're laid back to back from the current (or last) cycle's end, and the current cycle keeps its dates.
  - **`upcomingCycles`** must be 1–15 (400 otherwise). Lowering it never deletes cycles already made.
  - **`cycleStartsOn`** while cycles are already on is 400 "cycleStartsOn only applies when turning cycles on".
  - **Turning off** (`cycleWeeks: null`). The current cycle ends now (`ends_at = completed_at = T`) and keeps its issues. Upcoming cycles are deleted after clearing their issues, which are bumped and publish `issue` events. Completed cycles stay. Turning on again continues the numbering.
- **Issue `cycle`** (in `issueColumns`, create and update):
  - It's a number, `"current"`, `"next"` (the first upcoming) or `null`. `syncCycles(team)` runs first.
  - Refused (400): a team without cycles (`"WEB doesn't use cycles"`), an unknown number (`Unknown cycle 99 in WEB`), a completed one (`"Cycle 3 is over"`), and `"current"` when there's none (`"WEB has no current cycle"`).
  - A new issue with a `parent` in the same team and no `cycle` inherits the parent's cycle, if its own status is unstarted or started (todo, in_progress, in_review) and that cycle isn't over.
- **Lists.** `ISSUE_SELECT` joins cycles for `cycle`. The `cycle` filter takes `current`, which means each team's current cycle, so it works across teams. A number needs `team` (400 "Filter by cycle number needs a team"). An unknown one is 400 `Unknown cycle`.
- **`listCycles(a, team)`** syncs, then returns the team's cycles by number. `state` comes from `completed_at` and the dates, and `progress` uses the same rule as DKT-26's projects. Both share one helper if both exist.

### REST

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | /api/teams/:key/cycles | | `Cycle[]`, by number |
| PATCH | /api/teams/:key | adds `cycleWeeks`, `upcomingCycles`, `cycleStartsOn` | `Team` |

`ISSUE_FIELDS` gains `cycle`, and `GET /api/issues` takes `?cycle=current|<n>`.

### MCP

- **INSTRUCTIONS**: append to the teams bullet: "A team may use cycles, repeating 1–8 week planning periods (list_cycles); unfinished issues roll over to the next cycle when one ends."
- **New `list_cycles`** (read). Input: `team`.
  - Description: "List a team's cycles (its repeating planning periods, if it uses them), one line each: Cycle N · current|upcoming|completed · start – end dates · done/total issues · progress %. Put an issue in one with create_issue or update_issue's `cycle`."
- **`create_issue` and `update_issue`** add `cycle: z.union([z.number().int(), z.enum(["current", "next"])]).nullable()`.
  - Description: 'The team\'s cycle: its number, "current" or "next"; null to take it out. Only for teams that use cycles (list_teams says so). Unfinished issues roll over to the next cycle automatically.'
  - create_issue's description adds: "A sub-issue joins its parent's cycle when it starts out unstarted or started."
- **`list_issues`** adds `cycle: z.union([z.number().int(), z.literal("current")])` ("Only issues in this cycle: \"current\" (each team's current cycle) or a number (with team)").
- **`list_teams`** adds `· cycles every 2 weeks, current 12` to a team that uses them. **`get_issue`**'s meta line adds `cycle 12`.

### UI

- **Settings.** Add a **Cycles** section where team settings live when you start: DKT-18's team settings page if it has landed, else `TeamSettingsModal` (`modals.tsx:353-404`).
  - A "Use cycles" switch. Turning it on shows "Starts on" (`<input type="date">`, default today) and "Length" (1–8 weeks). Once on, "Plan ahead" (1–15 upcoming cycles) also shows.
  - Turning it off asks (`ask()`): "Turn off cycles? The current cycle ends now and upcoming cycles are removed; their issues leave them."
- **Cycles tab** `/t/:key/cycles`, shown when the team uses cycles. `CyclesView` lives in `issues.tsx` (it reuses `IssuesView`).
  - The current cycle is a card: "Cycle 12 · Mar 3 – Mar 17 · 5 days left", a progress bar and "5 of 12 done".
  - Then "Upcoming" rows, then "Completed" rows, newest first. Each row shows number, dates, done/total and %.
  - Rows link to `/t/:key/cycles/:n`.
  - Empty state (on, but the first cycle hasn't started): "Cycle 1 starts Mar 3."
- **Cycle page** `/t/:key/cycles/:n` is `IssuesView` with a `cycle` prop. It fetches `api.issues({ team, cycle })` and titles the header "Cycle 12" with its dates, and "New issue" presets the cycle.
- **Routing.** `routing.tsx:20` gains `/cycles(/\d+)?`. `/t/*` is already served (`index.ts:30`).
- **Issue page** `Properties` gets a "Cycle" row when the team uses cycles. It uses a `CyclePicker` listing "No cycle", "Cycle 12 (current)" and the upcoming ones; a completed cycle shows as "Cycle 9" and can be changed or cleared.
- **New issue modal:** a Cycle chip when the team uses cycles.

### Interplay

- **DKT-18**: rollover and progress use status categories. Triage and backlog issues in a cycle roll over like any unfinished issue.
- **DKT-26**: projects and cycles are independent. An issue can be in both, a project's issues can span many cycles, and nothing in D3 changes.
- **DKT-32** (estimates): cycle progress here counts issues. Estimates travel with an issue through rollover, and weighting cycle and project progress by estimate (Linear's capacity and velocity) is a follow-up once both exist, not part of either.
- **DKT-20** (moving between teams): cycles are per team, so a moved issue leaves its cycle (`cycle_id = NULL`). Whichever lands second implements that.

## Acceptance criteria

- [ ] A person can turn cycles on for a team with a start date, a length of 1–8 weeks and 1–15 upcoming cycles. The current cycle and the upcoming ones exist immediately.
- [ ] Issues can be put in the current or an upcoming cycle over REST, MCP and the UI, and taken out. Completed cycles and teams without cycles refuse.
- [ ] When a cycle ends, it's marked completed within a minute. Its unfinished issues move to the next cycle (bumped, with `issue` events), finished ones stay, and upcoming cycles are topped up.
- [ ] Changing the length re-dates only cycles that haven't started. Turning cycles off ends the current one and removes upcoming ones (their issues leave them).
- [ ] Sub-issues inherit the parent's cycle when created unstarted or started.
- [ ] `cycle=current` lists every team's current-cycle issues. The Cycles tab and cycle pages show progress.
- [ ] Agents get 403 on cycle settings. Other workspaces' teams are 404.

## Tests

New `test/cycles.test.ts` (team CYC in `acme`, `s.user("ana")`, `s.agent("bot")`, a team in a second workspace `side`). To move time, shift the dates in the DB, the way `parity.test.ts:66-69` ages the trash: `UPDATE cycles SET starts_at = strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '-14 days'), ends_at = …` via `bun:sqlite`. Then call `GET /api/teams/CYC/cycles`, which syncs.
- **Turning on:** `PATCH /api/teams/CYC {cycleWeeks: 2}`. Cycles 1 (current, today 00:00Z to +14d), 2 and 3 exist.
  - `cycleWeeks` 0 or 9 → 400. `upcomingCycles` 16 → 400. A past `cycleStartsOn` → 400.
  - As bot → 403. As ana on the `side` team → 404.
- **Assignment:**
  - `{cycle: "current"}` → 1, `"next"` → 2, `99` → 400.
  - A team without cycles → 400.
  - With a future `cycleStartsOn` on another team, `"current"` → 400.
- **Rollover:**
  - Put done, todo, in_progress and canceled issues, plus a trashed todo one, in cycle 1, then shift 14 days.
  - Cycle 1 is `completed`. Todo and in_progress are now in cycle 2 with a newer `updatedAt`, and an `s.admin.ws()` socket gets their `issue` events.
  - Done, canceled and the trashed issue stay in 1. Cycle 4 now exists.
  - Assigning to cycle 1 → 400 "Cycle 1 is over".
- **Filters:** `?cycle=current` without team works. `?cycle=2` without team → 400. `?cycle=2&team=CYC` works.
- **Sub-issues:** a todo sub-issue of a cycle-2 parent is in cycle 2; a backlog one isn't.
- **Length change:** `cycleWeeks` 2 → 1. Upcoming cycles are re-dated 7 days apart, and the current one is unchanged.
- **Turning off:** the current cycle is completed now, upcoming cycles are gone, and their issues have `cycle: null` (with events). Turning on again starts at the next number.
- **MCP:** `list_cycles` lines, `update_issue {cycle: "current"}`, `list_issues {cycle: "current"}`, and `list_teams` shows "cycles every 2 weeks".
- **Migration survival** (`test/migrations.test.ts`, create it if absent): freeze main's schema at branch time as a SQL constant (never edited). Teams and issues read back with `cycleWeeks: null` and `cycle: null`.

## SPEC.md

- **Data**:
  - teams gain `cycle_weeks`/`upcoming_cycles`; new **cycles**; issues gain `cycle_id`.
  - A **Cycles** paragraph: UTC dates; rollover of unfinished issues; sync at startup, every minute and on use; re-dating and turning off; sub-issue inheritance.
- **REST**: `GET /api/teams/:key/cycles`, the new team PATCH fields, `cycle` on issues and the filter.
- **MCP**: `list_cycles`, `cycle` on the issue tools and `list_issues`, and the INSTRUCTIONS line.
- **UI**: the Cycles settings section, the Cycles tab and cycle page, and the issue and modal Cycle property; add the routes.

## Out of scope

- Cooldown; auto-adding started or completed issues.
- Team timezones and weekday pickers (the start date sets the weekday).
- Capacity, velocity, burn-up graphs and frozen snapshots.
- Cycle names; starting the next cycle early; editing past cycles.
- Cycle documents; auto-archiving cycles; a workspace-wide cycles view; scope-change history.
- Estimate weighting (DKT-32).
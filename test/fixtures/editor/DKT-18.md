## Why

Every team has the same six statuses, hard-coded as an enum. A team can't add "QA", rename "Todo", choose where new issues start, or keep incoming requests in a Triage inbox until someone accepts them. In Linear the workflow belongs to the team. This is the riskiest data-model change on the list: the six statuses are assumed in about 40 places, all listed below.

## Linear's behaviour

- Each team has its own ordered statuses in fixed categories: Triage, Backlog, Unstarted, Started, Completed, Canceled. You can add, rename, recolor and reorder statuses within a category (categories keep their order), and delete one as long as each category keeps at least one. https://linear.app/docs/configuring-workflows
- A new team starts with Backlog > Todo > In Progress > Done > Canceled. The default status for new issues is the first Backlog status; "Make default" works on Backlog and Todo (unstarted) statuses. https://linear.app/docs/configuring-workflows
- Duplicate is "a system-managed status that cannot be renamed or customized", applied when an issue is marked as a duplicate. The duplicate "is updated to a Canceled status type". https://linear.app/docs/configuring-workflows, https://linear.app/docs/triage
- Triage is turned on per team and has exactly one status. Issues land there when created by integrations, from inside the Triage view, or by people outside the team. Triage issues are "excluded from all views". Accept moves an issue to the team's default status, Decline to a Canceled status, and there are also Mark as duplicate and Snooze. https://linear.app/docs/triage
- Completed and canceled timestamps change only when an issue moves between categories, not within one. https://linear.app/docs/google-sheets (Timestamp FAQs)

**Where Docket differs, on purpose:**
- The API names a status by a stable **key** (`in_progress`), the way docs have stable slugs. The display `name` can be renamed freely. That keeps every existing `status` value, filter and client working.
- New teams get the same set existing teams already have: Backlog, Todo, In Progress, **In Review**, Done, Canceled, plus Duplicate. Nothing changes for existing teams.
- Duplicate sits in the canceled category and can be picked by hand until the duplicate relation (DKT-22) exists. Its name, key and color are fixed.
- Nothing goes to Triage automatically. Docket has no integrations or team membership (everyone in a workspace works in every team), and agents are members, not integrations. An issue enters Triage only through an explicit `status` or "New issue" on the Triage tab.
- Only people configure workflows (like members and invites, it's a settings job). Agents read statuses from `list_teams`.

## Where things are today

Every place that assumes the six statuses:

- `src/shared/types.ts:3-16`: `STATUSES`, `Status`, `CLOSED_STATUSES`, `OPEN_STATUSES`, `STATUS_LABELS`. `:128` has `Team.counts: Record<Status, number>`, `:148` `IssueSummary.status`, `:257` `IssueInput.status` (default "backlog") and `:273` `IssueFilter.status`.
- `src/server/db.ts:106`: `issues.status TEXT NOT NULL`, with no constraint.
- `src/server/tracker.ts`:
  - `:48` `checkStatus` checks against the enum; `:345` `issueColumns` uses it.
  - `:154-160` `TEAM_SELECT` counts per status; `:167` `toTeam` fills zeros from `STATUSES`.
  - `:188-206` `createTeam`; `:209-217` `updateTeam`.
  - `:257` `STATUS_RANK` is a CASE over the enum; `:259` `ISSUE_ORDER`; `:406-417` the page cursor stores `STATUSES.indexOf`; `:466-470` the keyset condition.
  - `:358` `isClosed`; `:536` and `:574-577` set and clear `completed_at`.
  - `:440-443` the `status` filter.
  - `:514` new issues get "backlog".
  - `:683-714` `claimIssue`: backlog/todo move to in_progress, in_progress/in_review keep their status, done/canceled answer 409.
  - `:743` `listLabels` counts open issues with `CLOSED_STATUSES`.
- `src/server/api.ts:55`: the `status` query param is cast to `Status[]`. `:145` lists the team PATCH fields.
- `src/server/mcp.ts`:
  - `:26` INSTRUCTIONS list the six statuses; `:28` the claim/work flow.
  - `:34` `z.enum(STATUSES)`.
  - `:220` `list_teams` open count uses `OPEN_STATUSES`.
  - `:280, :284-289` `list_issues` description and status input; `:301` the default filter is `OPEN_STATUSES`.
  - `:326, :331` create_issue "Default backlog"; `:350` update_issue status flow; `:378` claim_issue.
- Web:
  - `src/web/icons.tsx:56-88`: `statusBody`/`statusSvg`/`StatusIcon`, one glyph per enum value.
  - `src/web/styles.css:25-30`: the `--s-<status>` colors. `src/web/chat.css:120,123` borrows `--s-in_review` and `--s-in_progress`.
  - `src/web/markdown.tsx:70`: chips call `statusSvg(issue.status)`; `:106` already has `teams` at parse time.
  - `src/web/hooks.ts:100`: `openCount`. `:112-122` `sortIssues` ranks by `STATUSES.indexOf`.
  - `src/web/issueIndex.ts:23-29`: `useResolved` uses `CLOSED_STATUSES`.
  - `src/web/pickers.tsx:238`: `STATUS_OPTIONS`. `:245-258` `StatusPicker` is team-agnostic. `:358` issue options show icons.
  - `src/web/issues.tsx`:
    - `:222` collapses done/canceled; `:233-250` groups by `STATUSES`.
    - `:255-267` `NewInStatus`; `:281-288` `StatusIconLabel`.
    - `:296, :420` row and card pickers.
    - `:330` `BOARD_STATUSES` drops canceled; `:332-371` the board.
  - `src/web/issue.tsx`:
    - `:161-162` claimable (`=== "in_progress"`, `CLOSED_STATUSES`).
    - `:385` sub-issues done count (`=== "done"`); `:403` sub-issue picker.
    - `:448-453` "Marked done" event.
    - `:494-498` Status prop; `:556` Blocks resolved.
  - `src/web/modals.tsx:62`: new issue defaults to "backlog". `:92-95` switches teams; `:126-129` status chip. `:353-404` `TeamSettingsModal`.
  - `src/web/docs.tsx:429` and `src/web/trash.tsx:53`: `StatusIcon`.
  - `src/web/main.tsx:272, :323`: sidebar open counts. `src/web/components.tsx:70-77`: the team gear. `:251-257` team tabs.
- `scripts/seed.ts:45-69` and the tests use the default keys, which stay valid. `test/claims.test.ts:69` expects `"CLM-2 is done"`.
- Outside this repo: `docket-chat/ask.ts:7` lists the six statuses in its prompt. They stay valid for default workflows (follow-up there, not here).

## Design

### Data (append the next migration to `MIGRATIONS`, db.ts:28)

```sql
-- Each team's workflow. Issues keep their status as the key (issues.status), which never changes.
CREATE TABLE workflow_statuses (
  id INTEGER PRIMARY KEY,
  team_key TEXT NOT NULL REFERENCES teams(key),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')),
  color TEXT NOT NULL,
  position REAL NOT NULL,
  UNIQUE (team_key, key)
);
CREATE UNIQUE INDEX workflow_statuses_triage ON workflow_statuses(team_key) WHERE category = 'triage';
INSERT INTO workflow_statuses (team_key, key, name, category, color, position)
  SELECT t.key, d.key, d.name, d.category, d.color, d.position FROM teams t, (
              SELECT 'backlog' AS key, 'Backlog' AS name, 'backlog' AS category, '#a3a3a3' AS color, 1 AS position
    UNION ALL SELECT 'todo', 'Todo', 'unstarted', '#8f8f8f', 2
    UNION ALL SELECT 'in_progress', 'In Progress', 'started', '#e8a800', 3
    UNION ALL SELECT 'in_review', 'In Review', 'started', '#30a46c', 4
    UNION ALL SELECT 'done', 'Done', 'completed', '#5e6ad2', 5
    UNION ALL SELECT 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6
    UNION ALL SELECT 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7
  ) d;
ALTER TABLE teams ADD COLUMN default_status TEXT NOT NULL DEFAULT 'backlog';
```

Existing issues keep `issues.status` untouched, and every value maps 1:1 to a row above, so nothing visibly changes. The colors are today's `--s-*` values. `createTeam` inserts the same seven rows from one `DEFAULT_WORKFLOW` constant in tracker.ts. The app keeps the invariant that every issue's `status` is a key of its team's workflow: statuses can't be deleted while in use without `moveTo`, and issues never change team today. If DKT-3 lands first and gives teams a surrogate id, reference that instead of `teams(key)`.

Interplay with other issues:
- **DKT-20** (moving issues between teams) must keep the invariant: a moved issue keeps its status key if the target team has it, else takes the target team's first status in the same category, else its default status. Whichever of D1 and D5 lands second implements this mapping.
- **DKT-22**'s `duplicateOf` should set `status: "duplicate"` instead of `canceled`. Whichever lands second makes that switch.
- **DKT-31** relies on `completed_at` staying category-based, as specified below.

### Contract (`src/shared/types.ts`)

Replace the enum block (`:3-16`) with:

```ts
export const STATUS_CATEGORIES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const; // fixed order
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];
export const ACTIVE_CATEGORIES: StatusCategory[] = ["backlog", "unstarted", "started"]; // what "open" means; triage is outside the workflow
export const CLOSED_CATEGORIES: StatusCategory[] = ["completed", "canceled"];
export const DUPLICATE_STATUS = "duplicate"; // the system status: fixed name, color, can't be deleted

export interface WorkflowStatus {
  key: string; // stable, a-z 0-9 _, unique in the team, what issues' `status` holds: "in_progress"
  name: string; // "In Progress"; renamable
  category: StatusCategory;
  color: string; // "#rrggbb"
  position: number; // order within its category
}
export interface WorkflowStatusInput { name: string; category: StatusCategory; color?: string; key?: string; position?: number }
export type WorkflowStatusPatch = { name?: string; color?: string; position?: number };
```

- `Team` gains `statuses: WorkflowStatus[]` (category order, then position) and `defaultStatus: string`. Its `counts` becomes `Record<string, number>`: every status key of the team, 0 when empty.
- `TeamPatch` gains `defaultStatus?: string`.
- `IssueSummary.status` becomes `string` (the key). It gains `statusCategory: StatusCategory`, for API clients; the UI derives the category from the team, so optimistic edits render right.
- `IssueInput.status` becomes `string` ("default: the team's defaultStatus").
- `IssueFilter.status` becomes `string[]`, and it gains `category?: StatusCategory[]`.

### Server (`src/server/tracker.ts`)

- **Joins.** `ISSUE_SELECT` joins `workflow_statuses ws ON ws.team_key = i.team_key AND ws.key = i.status` and selects `ws.category AS status_category, ws.position AS status_position`. `toSummary` adds `statusCategory`. `TEAM_SELECT` adds the team's statuses as a JSON array. `toTeam` fills `counts` from them.
- **Resolving a status** (`statusOf(team, value)`, replacing `checkStatus`). Match a key first, then a name, case-insensitively, within the issue's team. Otherwise answer 400 `Invalid status "x" for BRD. Use one of: backlog, todo, …`. `issueColumns` needs the team key, so `updateIssue` selects `team_key` along with `status`.
- **Order** (`:257-259`). Sort by category rank (the `STATUS_CATEGORIES` index), then `ws.position`, then priority, then `updated_at DESC`, then `id DESC`. The cursor becomes `[categoryRank, position, priorityRank, updatedAt, id]`, and `parseCursor` checks 5 keys. A 4-key cursor from before the deploy answers 400, and that client restarts paging.
- **`completed_at`** is set when the category enters completed or canceled and cleared when it leaves. The same rule applies to issues moved by a status delete.
- **Claim** (`:690-714`). Completed or canceled answers 409 `"<ID> is <key>"`, so "CLM-2 is done" is unchanged. A started issue keeps its status. Triage, backlog and unstarted issues move to the team's first started status by position. Update the docstring.
- **Filters.** For `status`, every key must exist in some team in scope, else 400 `Unknown status "x"`. `category` becomes `ws.category IN (…)`. REST without either returns all statuses, as today.
- **New issues** start in `teams.default_status`.
- **Counts.** `listLabels` (`:743`) counts open issues by category, not in completed or canceled.
- **Workflow changes.** These are new functions. Each needs a person who is an active member of the team's workspace: agents get 403 "Only people can change a workflow", another workspace gets 404. Each publishes `changed("team", workspace, key)`.
  - `createStatus(a, team, input)` is 201. The key is derived from the name with `pickSlug` (db.ts:271), using `_` instead of `-` ("In QA" → `in_qa`, an Arabic name → `status_1`); an explicit key must match `^[a-z0-9]+(_[a-z0-9]+)*$`, and a taken one is 409. Names are unique per team case-insensitively (409). The color must be `#rrggbb`, and defaults per category: triage `#f76b15`, backlog `#a3a3a3`, unstarted `#8f8f8f`, started `#e8a800`, completed `#5e6ad2`, canceled `#b4b4b4`. The position defaults to last in its category. A second triage status is 409 "BRD already has Triage"; a triage status's key defaults to `triage` and its name to "Triage".
  - `updateStatus(a, team, key, patch)`: `key` and `category` in the body are 400 ("A status's category never changes: add one in the other category, then delete this one"). Duplicate is 400 "Duplicate is a system status".
  - `deleteStatus(a, team, key, moveTo?)`:
    - Refused (409): the default status ("Make another status the default first"), the last non-Duplicate status of a non-triage category, or a status with issues (trashed ones included) when `moveTo` is missing ("3 issues are In QA: pass moveTo").
    - Refused (400): Duplicate.
    - With `moveTo` (another key of the same team), one transaction moves those issues, adjusts `completed_at` if the category changed, bumps them with `BUMPED_AT`, and publishes an `issue` event for each.
    - Deleting the triage status turns Triage off.
  - `updateTeam` takes `defaultStatus`: a backlog or unstarted key, else 400 ("The default status must be in Backlog or Unstarted"); agents get 403.

### REST (`src/server/api.ts`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| PATCH | /api/teams/:key | adds `defaultStatus` | `Team` |
| POST | /api/teams/:key/statuses | `WorkflowStatusInput` | 201 `Team` |
| PATCH | /api/teams/:key/statuses/:status | `WorkflowStatusPatch` (strict: `key`, `category` answer 400) | `Team` |
| DELETE | /api/teams/:key/statuses/:status | `?moveTo=<key>` | `Team` |
| GET | /api/issues | adds `?category=a,b` | as today |

If DKT-3 moves team routes under a workspace, these follow the team route.

### MCP (`src/server/mcp.ts`)

There are no workflow-editing tools; agents read the workflow.

- **INSTRUCTIONS `:26`** reads: "Each team has its own statuses, named by key (list_teams shows them), in Linear's fixed categories: triage (new, not yet accepted), backlog, unstarted, started, completed, canceled. By default a team has backlog, todo, in_progress, in_review, done, canceled and duplicate. Priority: …".
- **INSTRUCTIONS `:28`** reads: "…claim_issue (… it moves to the team's first started status, in_progress by default …), post progress notes with comment_issue, then set in_review when it's ready for review or done when finished (or the team's own statuses in those categories). There is no delete: set status canceled instead."
- **`status` (`:34`)** becomes `z.string().describe('A status key of the issue\'s team, e.g. "in_progress" (list_teams lists each team\'s statuses; the name, e.g. "In Progress", also works)')`.
- **`list_teams`** line: `BRD · Brand · workspace acme · 12 open · statuses: backlog (default), todo, in_progress, in_review, done, canceled, duplicate`, with `triage` first when on. Open means the active categories. Its description: "…one line each: key · name · workspace · open count · status keys in workflow order, the default for new issues marked."
- **`list_issues`**:
  - Description: "Sorted by status (category order: triage, backlog, unstarted, started, completed, canceled; then the team's order), then priority …. By default only active issues (backlog, unstarted and started categories); pass `category` (e.g. ["triage"] for issues waiting to be accepted, ["completed"] for finished ones) or `status` keys for others. There is no 'open' status."
  - Inputs: `status: z.array(z.string())` ("Only these status keys, e.g. in_progress"); new `category: z.array(z.enum(STATUS_CATEGORIES))`.
  - The default (`:301`) becomes `category: ACTIVE_CATEGORIES` when neither is given.
- **`create_issue`**: "Defaults: the team's default status (backlog unless the team changed it; list_teams marks it) …; pass todo when it's ready to be picked up, or triage to leave it for the team to accept (teams with Triage)."
- **`update_issue`**: "Status flow: in_progress when you start, in_review when ready for review, done when finished (or the team's statuses in the started and completed categories), canceled instead of deleting …".
- **`claim_issue`**: "…an issue not started yet (triage, backlog or unstarted category) moves to the team's first started status (in_progress by default); one already started keeps its status. Fails if it's completed or canceled… To hand it back, update_issue with delegate (or assignee) null and status todo."

### UI

- **Status lookup.** `statusOf(teams, teamKey, key)` in `hooks.ts` returns the team's `WorkflowStatus`. It falls back to `{ key, name: key, category: issue.statusCategory }` while teams load. All callers look status name, category and color up through it.
- **Icons** (`icons.tsx`). `StatusIcon` takes `{ category, color, fill }`:
  - triage: filled disc with a white arrow (`M4.5 7h5M7.5 5l2 2-2 2`)
  - backlog: dashed ring
  - unstarted: ring
  - started: ring plus `pie(fill)`, with fill = 1 − 0.5^(k+1) for the team's k-th started status (½ for In Progress, ¾ for In Review, as today)
  - completed: disc with a check
  - canceled (Duplicate too): disc with an x
  
  Color comes from the status. Remove `styles.css:25-30`, and give `chat.css:120,123` literal colors (`#30a46c`, `#e8a800`). Markdown chips (`markdown.tsx:70`) resolve through the `teams` they already read at `:106`.
- **Pickers** (`pickers.tsx:238-258`). `StatusPicker` takes `team` and lists that team's statuses in order. Every call site passes the issue's own team (sub-issues can be in other teams).
- **List and board** (`issues.tsx`):
  - List and board leave triage issues out, and the header count follows.
  - The list groups by status key: a group's name comes from the first team in the workspace that has the key, and groups are ordered by category rank, then the smallest position.
  - Completed and canceled groups start collapsed.
  - Board columns are the same set minus canceled-category statuses. Dropping an issue on a column its team lacks answers 400, so it toasts and reloads (the existing path).
  - `sortIssues` ranks by `(category, position)` through `statusOf`.
  - `NewInStatus` passes the key.
- **Other issue views:**
  - `openCount` sums active categories.
  - `useResolved` and Blocks (`issue.tsx:556`) use completed/canceled.
  - Claimable (`issue.tsx:161`) uses category `started`.
  - The sub-issue done count (`:385`) counts the completed category.
  - "Marked …" (`:451`) uses the status name.
  - The new issue modal defaults to the team's `defaultStatus`. When the team changes, it keeps the status if the new team has that key, else it takes the new team's default.
- **Triage tab** `/t/:key/triage`, shown only when the team has a triage status, labelled "Triage N":
  - It lists the team's triage issues (`category=triage`). Each row has **Accept**, which sets the team's `defaultStatus`, and **Decline**, which sets the first canceled-category status that isn't Duplicate.
  - Its "New issue" starts the issue in triage.
  - Empty state: "Nothing to triage. New issues from this tab wait here until someone accepts them."
- **Team settings page** `/t/:key/settings`, in `settings.tsx`. It replaces `TeamSettingsModal` (`modals.tsx:353-404`, `main.tsx:53,184,247`, `context.ts:24`); the gear at `components.tsx:70-77` links to it.
  - **General**: the description.
  - **Workflow**: a "Triage" switch (on: POST a triage status; off: DELETE it with `moveTo` = default). Statuses are grouped under category headings, each heading with "+ Add status" (an inline input; Enter creates).
    - A row is the icon, then an inline-editable name, then a "Default" badge. The icon is a button over a hidden `<input type="color">`.
    - The row menu has Make default (backlog and unstarted statuses), Move up, Move down (position = midpoint) and Delete.
    - Delete with live issues opens a picker "Move N issues to…" over the team's other statuses. With none, `ask()` confirms, and it deletes with `moveTo` = default so any trashed ones move too.
    - The Duplicate row has no menu and can't be edited.
  - The workspace rename field moves to `/settings/workspace` as a "Name" field for admins.
- **Routing.** `routing.tsx:20` gains `/settings` and `/triage` after `/t/:key`, as new `Route` views. `/t/*` is already served by `index.ts:30`.

## Acceptance criteria

- [ ] After the migration, every existing issue shows the same status, icon, color, group and order as before. Each team lists the six old statuses plus Duplicate, with `defaultStatus: "backlog"`.
- [ ] `status: "in_progress"`, `?status=done,canceled` and MCP `status: ["todo"]` behave as before.
- [ ] A person can add, rename, recolor, reorder and delete statuses. Keys never change. Invalid names, colors and categories answer 400; clashes 409; agents 403; another workspace 404.
- [ ] Issues accept a status by key or name, only from their own team's workflow.
- [ ] Deleting a status in use needs `moveTo`, and it moves live and trashed issues, fixing `completedAt`. The default, the last of a category and Duplicate can't be deleted.
- [ ] New issues (REST, MCP, UI) start in the team's default status, which must be in backlog or unstarted.
- [ ] Claim moves triage, backlog and unstarted issues to the first started status and keeps started ones. Completed and canceled answer 409.
- [ ] Triage can be turned on and off. Triage issues are absent from list, board, sidebar counts and default `list_issues`, and appear on the Triage tab with Accept and Decline.
- [ ] `IssueSummary.statusCategory` is always present. `completedAt` follows categories, not keys.
- [ ] Every workflow change publishes a `team` event; moved issues publish `issue` events.

## Tests

New `test/workflow.test.ts`, using the harness (`s.api` admin, `s.user`, `s.agent`), with a team WF plus a team in a second workspace `side` (created by admin):
- **Defaults**: a new team has the seven default statuses in order, `defaultStatus: "backlog"`, and a zero `counts` entry for each.
- **Status changes**:
  - Create "In QA" (started): key `in_qa`, 201, placed after in_review. Rename it: the key stays and issues in it keep `status: "in_qa"`.
  - Bad color or category → 400. Duplicate name → 409.
  - A body with `category` or `key` on PATCH → 400. Renaming Duplicate → 400.
  - As `s.agent("bot")` → 403. As `ana` on a `side` team → 404.
- **Resolution**: `PATCH {status: "In QA"}` sets `in_qa`. `{status: "nope"}` → 400 naming the keys. A key that only another team has → 400.
- **completedAt**: add "Shipped" (completed). Moving into it sets `completedAt`; moving to todo clears it; moving between done and Shipped leaves it alone.
- **Default status**: `PATCH /api/teams/WF {defaultStatus: "todo"}`, and new issues start in todo over REST and MCP. `defaultStatus: "done"` → 400. As an agent → 403.
- **Delete**: without `moveTo` while an issue (also a trashed one) uses it → 409. With `moveTo=todo`, both move, and an `s.admin.ws()` socket gets `issue` events for them. Deleting the default → 409, the last started status → 409, Duplicate → 400.
- **Claim** on a team whose first started status is custom (`doing`): a backlog issue → `doing`, a started one keeps its status, a Shipped one → 409 "WF-n is shipped".
- **Triage**:
  - POST a triage status, then create with `status: "triage"`.
  - It's missing from MCP `list_issues` by default and present with `category: ["triage"]`, and from `?category=triage`. `list_teams` puts `triage` first.
  - A second triage → 409. DELETE with `moveTo=backlog` turns it off.
- **Order and cursors**: the order is by category then position, and the paging in parity.test.ts still walks every issue. A 4-key cursor → 400.
- **Migration survival**, in `test/migrations.test.ts` (create it if no earlier issue did):
  - Freeze the schema of main at branch time as a SQL constant (the `MIGRATIONS` entries verbatim, plus `PRAGMA user_version = <n>`), and never edit it later. Build a DB file with `bun:sqlite`: a person `alice` in workspace `acme`, team `OLD`, and one issue per old status, with `completed_at` on done/canceled and one trashed issue.
  - Start with `startServer({ setup: false, env: { DATABASE_PATH: file } })` and sign in with `s.signIn("alice")`.
  - Every issue keeps its status, `completedAt` and list order. `OLD` has the default workflow and `defaultStatus: "backlog"`.

Update `test/mcp.test.ts` or `parity.test.ts` only where tool text changed. `bun test` and `bun run typecheck` pass.

## SPEC.md

- **Data**:
  - teams gain `default_status`.
  - New **workflow_statuses** paragraph: key/name/category/color/position, the fixed category order, Duplicate, Triage, and the delete rules.
  - `issues.status` is the team's status key.
  - "`completed_at` is set when status enters done/canceled" becomes "…enters the completed or canceled category".
  - "New issues start in `backlog`" becomes "…in the team's default status (backlog unless changed)".
  - The list order is category, then the team's order, then priority, then updated.
- **Claim**: the category wording above.
- **REST**: the new team routes, `category` on `/api/issues`, `defaultStatus` on team PATCH.
- **MCP**: the `list_teams`, `list_issues` (`category`, active default) and `create_issue` rows. Tool descriptions must explain per-team statuses and categories.
- **UI**:
  - Status icons are by category, in the status's color.
  - The list groups by status key, and the board hides canceled-category columns.
  - Triage tab.
  - "Team settings" becomes the `/t/:key/settings` page (General, Workflow), and workspace rename moves to workspace settings.
  - Add the new routes.

## Out of scope

- The duplicate relation and Triage's "Mark as duplicate" (DKT-22); Snooze and triage responsibility.
- Routing issues into Triage automatically.
- Status descriptions; changing a status's category.
- `startedAt`, `canceledAt` and `triagedAt`.
- Auto-archive (DKT-31), auto-close (DKT-21), git automations.
- Moving issues between teams (DKT-20; the status mapping rule is in Design).
- Custom views that include Triage.
- Editing workflows over MCP.
- Updating docket-chat's prompt.
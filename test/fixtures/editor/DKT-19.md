## Why

Labels today are free strings stored as JSON on each issue. They can't have a color (the dot is a hash of the name), belong to a team, or live in a group like "Type" (Bug / Feature / Chore) where an issue takes one. Renaming a label means editing every issue. A label also disappears as soon as no live issue uses it, so there's nowhere to manage them.

## Linear's behaviour

- Labels are workspace-level or team-level. Team labels are "available only where relevant", on that team's issues. https://linear.app/docs/labels
- Label groups give "one level of nesting". The group itself can't be applied, and "only one label from a given label group can be applied to an issue at a time". https://linear.app/docs/labels
- Inline creation from "Add label" uses `group/label` or `group:label`, e.g. `Type/Bug`. https://linear.app/docs/labels
- Name and color are editable. Labels can be merged. Archiving keeps a label on its issues but blocks new use. Deleting is permanent and removes the label from every issue. https://linear.app/docs/labels
- Workspace and team labels may share a name; a same-named workspace label offers to absorb the team ones. Some names are reserved (status, priority, …). https://linear.app/docs/labels

**Where Docket differs, on purpose.** The API keeps naming labels by text, so a label's **path** (`Bug`, or `Type/Bug` inside a group) is unique per workspace, case-insensitively. That rules out same-named workspace and team labels. Only `/` separates group and label: `:` is common in existing flat names such as `area:api`. There are no reserved names (Docket has no filter syntax to protect). Archive, merge and descriptions are left out (see Out of scope).

## Where things are today

- `src/server/db.ts:108`: `issues.labels TEXT NOT NULL DEFAULT '[]'`, a JSON array of names.
- `src/shared/types.ts:150`: `IssueSummary.labels: string[]`. `:186-189` `LabelCount`. `:259` `IssueInput.labels`. `:274` `IssueFilter.label`. `:282-287` `ServerEvent.entity`.
- `src/server/tracker.ts`:
  - `:51-56` `checkLabels`: trims, dedupes exact strings.
  - `:230, :269` `IssueRow.labels` and `toSummary` parse the JSON.
  - `:347` `issueColumns` writes it; `:516` `createIssue` defaults to `"[]"`.
  - `:444-447` `label` filter: `json_each`, `COLLATE NOCASE`.
  - `:738-748` `listLabels`: distinct names in use per workspace, with open counts.
- `src/server/api.ts:184-186`: `GET /api/labels` returns only the names. docket-chat uses MCP only, so the web app is the only caller.
- `src/server/mcp.ts:36`: the `labels` schema. `:60` line `#label`. `:262-274` `list_labels`.
- Web:
  - `src/web/context.ts:13`: `labels: string[]`. `src/web/main.tsx:64` and `:115-119` load them. `src/web/api.ts:152`.
  - `src/web/components.tsx:40-49`: `LabelDot` and `LabelChip`, colored by `hueStyle(name)` (`util.ts:27-36`). `src/web/styles.css:792-799`: `.label-dot` uses `--h`.
  - `src/web/pickers.tsx:310-334`: `LabelsPicker`, with a "Create label" option.
  - `src/web/issues.tsx`: `:187-200` the label filter; `:302, :431` chips on rows and cards; `:311-326` `Labels`.
  - `src/web/issue.tsx:518-522` and `src/web/modals.tsx:138-152`: label chips and pickers.
  - `src/web/settings.tsx:386-403`: `WorkspaceSettings`, with no labels section.
- Tests that assume string labels: `test/api.test.ts:54-55`, `test/comments.test.ts:83-91`, `test/parity.test.ts:34` (a trashed issue's only label disappears), and `test/claims.test.ts:99-104` (`labels: ["x"]` creates one).

## Design

### Data (append the next migration)

```sql
-- Labels: workspace-wide (team_key NULL) or a team's own. A group (is_group) holds labels one level deep.
CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  workspace TEXT NOT NULL REFERENCES workspaces(key),
  team_key TEXT REFERENCES teams(key),
  parent_id INTEGER REFERENCES labels(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  is_group INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX labels_name ON labels(workspace, COALESCE(parent_id, 0), lower(name));
CREATE TABLE issue_labels (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX issue_labels_label ON issue_labels(label_id);
-- Every name in use (trashed issues too) becomes a workspace label; "Bug" and "bug" merge.
INSERT INTO labels (workspace, name, color, created_at)
  SELECT t.workspace, MIN(trim(l.value)), '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM issues i JOIN teams t ON t.key = i.team_key, json_each(i.labels) l
  WHERE trim(l.value) <> '' GROUP BY t.workspace, lower(trim(l.value));
UPDATE labels SET color = CASE (id - 1) % 10
  WHEN 0 THEN '#357fd4' WHEN 1 THEN '#35d48a' WHEN 2 THEN '#d48a35' WHEN 3 THEN '#7f35d4' WHEN 4 THEN '#d43550'
  WHEN 5 THEN '#35c4d4' WHEN 6 THEN '#d4b435' WHEN 7 THEN '#354ad4' WHEN 8 THEN '#d45535' ELSE '#d435d4' END;
INSERT OR IGNORE INTO issue_labels (issue_id, label_id)
  SELECT i.id, lb.id FROM issues i JOIN teams t ON t.key = i.team_key, json_each(i.labels) l
  JOIN labels lb ON lb.workspace = t.workspace AND lb.parent_id IS NULL AND lower(lb.name) = lower(trim(l.value));
```

`issues.labels` stays (migrations are additive) but is no longer read or written; SPEC calls it legacy. The palette is today's ten label hues (`util.ts:28`) at the dot's `hsl(h 65% 52%)`. If DKT-3 gives teams a surrogate id first, reference it instead of `teams(key)`.

### Contract (`src/shared/types.ts`)

```ts
export const LABEL_COLORS = ["#357fd4", "#35d48a", "#d48a35", "#7f35d4", "#d43550", "#35c4d4", "#d4b435", "#354ad4", "#d45535", "#d435d4"];

export interface Label {
  id: number;
  workspace: string;
  team: string | null; // a team's own label, only on its issues; null: a workspace label
  name: string;
  path: string; // "Type/Bug" inside a group, else the name: what issues' `labels` hold
  group: string | null; // the group's name
  isGroup: boolean; // a group holds labels and is never applied itself
  color: string; // "#rrggbb"
  open: number; // open issues carrying it (a group: any of its labels)
  createdAt: string;
}
export interface LabelInput { workspace: string; name: string; team?: string | null; color?: string; group?: string | null; isGroup?: boolean }
export type LabelPatch = { name?: string; color?: string; team?: string | null; group?: string | null };
```

- `IssueSummary.labels` stays `string[]`, now paths sorted case-insensitively, so the contract is unchanged for clients. `IssueInput.labels` stays names.
- Delete `LabelCount`.
- `ServerEvent.entity` gains `"label"`, with `id` = the label id.

### Server (`src/server/tracker.ts`, `--- Labels ---`)

- **Reading.** `ISSUE_SELECT` builds `labels` as a `json_group_array` of paths from `issue_labels` joined to `labels` (with a group join: `CASE WHEN g.id IS NULL THEN l.name ELSE g.name || '/' || l.name END`). `toSummary` is unchanged.
- **Writing an issue's labels.** `labels` leaves `issueColumns` and is handled like `blockedBy`. Resolve it before the transaction and replace the rows inside it (in `createIssue` and in `updateIssue`'s IMMEDIATE transaction). Each name resolves in the issue's workspace, case-insensitively:
  1. **Path match.** If a label's path matches, use it. A team label of another team is 400 `Label "x" belongs to team WEB`. A group is 400 `Type is a label group: pick one of its labels, e.g. Type/Bug`.
  2. **Bare name.** A bare name with no `/` matches grouped labels usable here by name. Exactly one is used; several are 400 `"High" is ambiguous: Effort/High or Impact/High`.
  3. **Create.** `Group/Name` (split at the first `/`) finds or creates a workspace group `Group`, then creates `Name` in it, in the group's scope. A plain name creates a workspace label. The color is `LABEL_COLORS[count of the workspace's labels % 10]`. Each new label publishes a `label` event.
  
  Duplicates collapse. Two labels of one group are 400 `Only one label per group: Type/Bug, Type/Feature`. Keep the "labels must be an array of strings" check from `checkLabels`.
- **Filter** (`:444-447`). `label` matches a label's name or path, or a group's name ("Type" finds every Type label), case-insensitively. A name nobody uses still finds nothing (not 400), as SPEC says today.
- **`listLabels(a, { workspace?, team? })`** returns every label and group in scope, sorted by path. A `team` filter narrows to workspace labels plus that team's; an unknown team is 400. `open` counts live issues that aren't closed (by DKT-18's categories if that has landed).
- **`createLabel`, `updateLabel`, `deleteLabel`.** These need a person who is an active member of the label's workspace: agents get 403 "Only people can manage labels", another workspace 404.
  - **Names** use `requireText` (200 characters). New names can't contain `/` (400 "Use a group for Group/Label"); migrated names keep theirs. A path that's already taken is 409 `Label "Type/Bug" already exists`. The color must be `#rrggbb`.
  - **Groups** take `isGroup` only on create. A group can't be in a group (400), and a label's scope is always its group's scope (400 when `group` has another scope).
  - **Rescoping** with `team` (a key of the same workspace, or null) is 409 `Used on 3 issues outside WEB` if any issue carrying it is in another team. For a group, all its labels move with it.
  - **Moving into a group** is 409 if some issue already has another label of that group.
  - **Deleting** a group that still has labels is 409 "Move or delete its labels first". Deleting a label removes it from every issue, permanently, like Linear.
- **Events.** Renaming, regrouping or deleting changes the `labels` of every issue carrying the label. Those issues (trashed ones too) are bumped with `BUMPED_AT` and publish `issue` events, so a stale whole-list write gets `baseUpdatedAt`'s 409 instead of resurrecting the old name. Recoloring and rescoping publish only `changed("label", workspace, String(id))`.

### REST

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | /api/labels | `?workspace&team` | `Label[]`, labels and groups, sorted by path (was `string[]`) |
| POST | /api/labels | `LabelInput` | 201 `Label` |
| PATCH | /api/labels/:id | `LabelPatch` (strict; `isGroup`, `workspace` → 400) | `Label` |
| DELETE | /api/labels/:id | | the deleted `Label` |

### MCP

There are no label-management tools; agents still create labels by naming them, and people manage them in settings.

- **`list_labels`** (`:262-274`) takes `workspace?` and `team?` ("Only labels usable on this team's issues").
  - Description: "List labels, one line each: label · color · open issue count, plus `team KEY` for a team's own label (usable only on that team's issues). A label written Group/Label belongs to a group, and an issue carries at most one label per group. Check this before labeling an issue and reuse an existing label rather than inventing a near-duplicate."
  - Lines: `Type/Bug · #d43550 · 3 open` and `design · #357fd4 · team WEB · 1 open`. Groups aren't lines. `structuredContent: { labels }` has the full `Label[]`.
- **`labels`** (`:36`) reads: `'Label names, e.g. ["bug", "Type/Feature"]. Reuse labels from list_labels; an unknown name creates a workspace label, and Group/Label creates it in that group. At most one label per group.'`

### UI

- **State.** `app.labels` becomes `Label[]` (`context.ts:13`, `main.tsx:64`, `api.ts:152`), and `api` gains `createLabel`, `updateLabel` and `deleteLabel`. A helper `labelFor(labels, team, path)` falls back to `#a3a3a3`.
- **Chips.** `LabelDot` and `LabelChip` (`components.tsx:40-49`) take the label's color (`style={{ background: color }}`; drop `--h` from `.label-dot`, `styles.css:797`). A grouped label shows `<span class="muted">Type/</span>Bug`.
- **`LabelsPicker`** (`pickers.tsx:310-334`) takes `team`.
  - Options are the labels usable on that team, groups excluded, shown by path with a colored dot.
  - Picking a label whose group is already on the issue swaps it out, as Linear does.
  - The "Create label “…”" option stays. Typing `Type/Bug` creates the group and label when the issue saves.
  - Callers pass the issue's team (`issue.tsx:519`, `modals.tsx:138`). Switching teams in the new issue modal drops the old team's own labels.
- **Filter** (`issues.tsx:187-200`): groups (matching any of their labels) and labels by path, with colored dots.
- **Workspace settings.** Add a **Labels** section after Members (`settings.tsx:386-403`), for every person in the workspace (label upkeep isn't admin-only, just as anyone can create one today).
  - "New label" and "New group" open an inline form: name, color, scope (Workspace or a team), and a group for labels.
  - Rows are sorted by name, with each group's labels indented under it. A row is:
    - a color swatch (a button over a hidden `<input type="color">`)
    - an inline-editable name
    - its scope ("Workspace", or the team mark and key; a picker)
    - its open count
    - a `RowMenu` with "Move to group…" (group picker with "No group") and Delete (`ask()`: "Delete Bug? It comes off 4 issues. This can't be undone.")
  - Empty state: "No labels yet. Labels you add to issues show up here."

## Acceptance criteria

- [ ] After the migration, every issue shows the same label names. `GET /api/labels` lists them as workspace labels with colors, and case variants of one name are merged.
- [ ] `labels: ["bug"]` still works over REST and MCP. Unknown names create workspace labels, and `Type/Bug` creates the group and label.
- [ ] A group can't be applied. A second label of the same group is refused. The picker swaps within a group.
- [ ] Team labels only go on their team's issues. Rescoping that would strand issues is refused.
- [ ] Renaming a label renames it on every issue (and bumps them). Deleting removes it everywhere.
- [ ] Labels persist with 0 open issues (e.g. when their only issue is trashed) and are managed in workspace settings.
- [ ] `list_labels` shows color, group (as path) and team scope.
- [ ] Agents get 403 on label routes. Other workspaces' labels are 404 and never listed.

## Tests

New `test/labels.test.ts` (setup admin, `s.user("ana")`, `s.agent("bot")`, a second workspace `side` with team SID):
- **Implicit creation.** Create with `labels: ["Bug", "Type/Feature"]`:
  - `GET /api/labels` shows `Bug` (workspace, a palette color), group `Type` (`isGroup`) and `Type/Feature`.
  - The issue's `labels` is `["Bug", "Type/Feature"]`.
- **Group rules**:
  - `["Type"]` → 400.
  - `["Type/Feature", "Type/Chore"]` → 400.
  - `"Feature"` alone resolves to `Type/Feature`. With `Effort/High` and `Impact/High`, `"High"` → 400 ambiguous.
- **Scope rules**:
  - A team label on another team's issue → 400.
  - PATCH `team` to WEB while an issue in another team uses it → 409.
  - A label in a group of another scope → 400. A nested group → 400. A name with `/` → 400.
  - An existing path → 409. A color like `red` → 400.
- **Rename and delete**:
  - Renaming `Bug` to `Defect` changes `labels` on its issues and bumps `updatedAt`. An `s.admin.ws()` socket gets `label` and `issue` events.
  - A stale `labels` write with the old `baseUpdatedAt` → 409.
  - Deleting removes it from issues. Deleting a group with labels → 409.
- **Filter.** `?label=type` finds issues with any Type label. `?label=never-used` → `[]`.
- **Access.** As `bot`, POST/PATCH/DELETE `/api/labels` → 403, while `create_issue` with a new label still works. `ana` on a `side` label → 404. `GET /api/labels` never lists `side` labels for ana.
- **MCP.** `list_labels` shows `Type/Feature · #…` lines and `team WEB` for team labels.
- **Existing tests**:
  - `api.test.ts:54-55`: check `labels.map(l => l.path)`.
  - `comments.test.ts:83-91`: the new shape and line format.
  - `parity.test.ts:34`: the label stays, with `open: 0`.
- **Migration survival** (`test/migrations.test.ts`, create it if absent). Freeze main's schema at branch time as a SQL constant (never edited later). Build the DB with `bun:sqlite`:
  - person `alice` in `acme`, team `OLD`
  - issues with `labels` `["bug","UI"]` and `["Bug","area:api"]`
  - a trashed issue with `["old"]`
  - a second workspace with its own `["bug"]`
  
  Then `startServer({ setup: false, env: { DATABASE_PATH } })` and `s.signIn("alice")`. Each issue has the same names (`Bug`/`bug` merged into one label per workspace). `old` is listed with `open: 0`. The other workspace's `bug` is a separate label.

## SPEC.md

- **Data**:
  - New **labels** and **issue_labels** (scope, groups, the path rule, one per group). `issues.labels` becomes "legacy, unused since this migration".
  - The Trash paragraph: labels stay, but trashed issues don't count toward `open`.
- **REST**: the label routes, and the new `GET /api/labels` shape. The filter note becomes: "`label` matches a name, path or group; a label nobody uses finds nothing."
- **MCP**: the `list_labels` row; the tool descriptions explain groups and implicit creation.
- **UI**:
  - Label chips use the label's color.
  - `LabelsPicker` behavior (team-scoped, group swap, `Group/Label`).
  - The Settings bullet gains Workspace → Labels, for everyone in the workspace.
  - The Toolbar bullet: the label filter includes groups.
- **Realtime**: the `label` entity.

## Out of scope

- Archiving or retiring labels; merging; label descriptions.
- Reserved names; `group:label` syntax; same-named workspace and team labels.
- Project labels (DKT-26 doesn't add labels to projects).
- Label management over MCP.
- Bulk label edits and label ordering.
- Moving issues between teams (DKT-20). A moved issue drops its old team's own labels and keeps workspace labels; whichever of D2 and D5 lands second implements that.
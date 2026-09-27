## Why

Teams that file the same shape of issue over and over (bug reports, support tickets, sprint tasks) retype
the same title scaffolding, description structure, labels and priority every time. A saved template fills
that in with one click.

## Linear's behaviour

Templates (workspace- or team-scoped) prefill title, description, labels, priority, status, assignee and
more; picked via a "Template" control next to the team name in the issue-creation modal, or a keyboard
shortcut. https://linear.app/docs/issue-templates

Docket difference: Linear also supports workspace-wide templates and "form" templates with custom structured
fields (dropdowns, checkboxes) and default-per-context templates. This issue ships team-scoped templates only
(no workspace-wide tier — a team's few templates are enough for Docket's scale) prefilling the fields the
brief specifies (title/description/labels/priority/status), no form-builder, no default-template-per-context.

## Where things are today

- `src/server/db.ts` has no template table; the closest analog for "a named, reusable shape" is `teams`
  itself (key/name/description) — templates are simpler: no key, just a name and the prefill fields.
- `src/web/modals.tsx:57-168` `NewIssueModal` builds an `IssueInput`-shaped `Draft` from `defaults` passed
  in; a template is exactly another source of `defaults`, applied before the user edits anything.
- `src/web/modals.tsx:41-53` `TeamCrumb` sits at the top of the modal — Linear's "Template" control sits next
  to the team name there, so this is where the template picker goes.
- `src/server/tracker.ts:510-561` `createIssue` is the only place `IssueInput` becomes an issue; a template
  is not a new creation path, just a different source of the same input shape.
- `src/server/mcp.ts:322-344` `create_issue`'s tool is where MCP template support goes.

## Design

**Schema** (append the next migration):
```sql
CREATE TABLE issue_templates (
  id INTEGER PRIMARY KEY,
  team_key TEXT NOT NULL REFERENCES teams(key),
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT, -- NULL = leave at the usual default (backlog)
  priority INTEGER, -- NULL = leave at the usual default (0)
  labels TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX issue_templates_team ON issue_templates(team_key);
```
`title` is the template's own prefill for the issue title (often a scaffold like "Bug: ") — separate from
`name`, which just labels the template in the picker ("Bug report"). No `slug`, no workspace scoping, no
"default template" flag: the smallest thing that lets a team define a few named prefills.

**Types** (`src/shared/types.ts`):
```ts
export interface IssueTemplate {
  id: number;
  team: string;
  name: string;
  title: string;
  description: string;
  status: Status | null;
  priority: Priority | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}
export interface IssueTemplateInput {
  team: string;
  name: string;
  title?: string;
  description?: string;
  status?: Status | null;
  priority?: Priority | null;
  labels?: string[];
}
export type IssueTemplatePatch = Partial<Omit<IssueTemplateInput, "team">>;
```

**Server** (`src/server/tracker.ts`), a new `// --- Issue templates ---` section next to `// --- Teams ---`
(line 141), following the exact CRUD shape `createTeam`/`updateTeam` already use (`teamRow`, line 173-178, is
the pattern for "load and 404 outside your workspaces"):
- `listTemplates(a, { team? })`, `createTemplate(a, input)`, `updateTemplate(a, id, patch)`,
  `deleteTemplate(a, id)` (hard delete — templates aren't trash-worthy content like issues/docs; deleting a
  template doesn't touch issues already created from it, since a template only ever *seeds* an `IssueInput`,
  it isn't referenced afterward).
- No `changed` event kind is strictly needed (templates aren't shown live to other people mid-edit the way
  issues/docs are), but for realtime parity with everything else that mutates, publish `changed("team", workspace, teamKey)` on any template change, the same event a team rename already fires — cheap and correct,
  since the team's picker list is what needs refreshing.

**REST** (`src/server/api.ts`):
| Method | Path | Body | Returns |
|---|---|---|---|
| GET / POST | /api/templates | `?team` / `IssueTemplateInput` | `IssueTemplate[]`; 201 `IssueTemplate` |
| PATCH / DELETE | /api/templates/:id | `IssueTemplatePatch` | `IssueTemplate` |

**MCP** (`src/server/mcp.ts`): `create_issue` gains `template: z.number().int().optional().describe("An issue
template's id (see list_templates in the team) to prefill title, description, labels, priority and status;
fields you also pass override the template's")`; the tool applies the template's fields first, then the
explicit input fields, then defaults, in `createIssue` (server-side, not client-side, so MCP and REST/UI share
the same merge order). A `list_templates` tool (`workspace?`, `team?`) mirrors `list_labels`'s shape: one
line each, `id · name · TEAM`.

**UI**:
- `TeamCrumb` (`modals.tsx:41-53`) gains a "Template" chip next to the team name (only shown when the
  selected team has templates), opening a small picker (new `TemplatePicker`, `pickers.tsx`, same shape as
  `TeamPicker`) listing the team's templates by name.
- Picking a template merges its fields into `NewIssueModal`'s `draft` (`modals.tsx:58-69`) — title,
  description, status, priority, labels — leaving anything the user already typed in the title/description
  untouched is **not** the behavior: picking a template overwrites the draft's prefillable fields outright
  (it's meant to be picked first, per Linear's own "Template" placement at the top of the modal, before
  typing).
- Team settings: managing templates (create/edit/delete) needs *some* surface; the smallest one is a new
  "Templates" section in `TeamSettingsModal` (`modals.tsx:354-404`) listing existing templates with a
  Delete button each, and a "New template" button opening a small inline form (name, title, description,
  status, priority, labels — reusing the same `Field`/picker components `NewIssueModal` already uses). No
  separate settings page.

## Acceptance criteria

- [ ] Creating, editing and deleting a team's templates works via REST and is reflected in the New Issue
      modal's template picker.
- [ ] Picking a template in the New Issue modal prefills title/description/status/priority/labels; fields
      the user changes afterward still take effect (template only seeds the draft, doesn't lock it).
- [ ] `create_issue` (MCP) with `template` applies the same prefill, overridable by explicit fields in the
      same call.
- [ ] A team with no templates shows no "Template" control (no empty-state clutter).
- [ ] Deleting a template doesn't affect issues already created from it.
- [ ] `list_templates` (MCP) lists a team's templates.

## Tests

New cases in `test/api.test.ts` or a new `test/templates.test.ts`:
- Create a template with all fields set; `create_issue` (REST has no direct "from template" endpoint — MCP
  and UI both merge client/server-side per Design, so test the MCP path plus a plain template CRUD
  round-trip over REST).
- `create_issue` MCP with `template` and no other fields: resulting issue matches the template exactly.
- `create_issue` MCP with `template` and an explicit `priority`: explicit value wins over the template's.
- Deleting a template: existing issues created from it are unaffected; the template itself is gone from
  `list_templates`.
- A template naming a team outside the actor's workspaces is 404, matching every other team-scoped resource.
- Migration-survival: a frozen fixture DB (existing teams, no `issue_templates` table) reads fine after the
  migration; `list_templates` returns `[]` for pre-existing teams.

## SPEC.md

- A new short subsection near "Documents" (similarly team-scoped, similarly simple) describing
  `issue_templates`, its fields, and that it hard-deletes (no trash).
- REST table: the two new routes.
- MCP table: `create_issue` gains `template`; new `list_templates` tool row.
- UI section: New issue modal bullet mentions the Template control; team settings bullet mentions managing
  templates.

## Out of scope

- Workspace-wide templates (team-scoped only).
- Form-style templates with custom structured fields.
- A "default template for this team" auto-applied without picking it.
- Templates for documents (Linear doesn't have those either).
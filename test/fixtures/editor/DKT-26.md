## Why

Docket has nothing between an issue and a team. A launch, migration or redesign that spans several teams can't be tracked as one thing, with an owner, a status, a target date, its stages, its progress, and the specs that go with it. In Linear that's a project.

## Linear's behaviour

- **Scope.** A project groups issues toward an outcome. "Projects can be shared across multiple teams", and one of them is the lead team. "Issues can only be associated with one project at a time" (sub-issues are the workaround). https://linear.app/docs/projects
- **Properties.** Only the name is required. A project also has a lead, status, target date, description (overview), documents and resources, and the tabs Overview and Issues. Deleted projects stay 30 days under "Recently deleted". https://linear.app/docs/projects
- **Statuses** are workspace-level and admins can customize them (team-level on paid plans). https://linear.app/docs/project-status
- **Milestones** are "meaningful stages of completion" inside one project, each with an optional target date and description. They can be reordered, and progress "starts counting the moment an issue moves to a started status, and increases further once it's completed". https://linear.app/docs/project-milestones, https://linear.app/docs/conceptual-model
- **Sub-issues** "inherit the parent issue's team, priority, and project". https://linear.app/docs/parent-and-sub-issues
- **Documents** attach to projects. https://linear.app/docs/documents
- **Initiatives** sit above projects (workspace goals grouping projects). **Out of scope here.** https://linear.app/docs/initiatives

**Where Docket differs, on purpose:**
- **Statuses.** Project statuses are a fixed list of Linear's lifecycle: Backlog, Planned, In Progress, Paused, Completed, Canceled. They aren't customizable.
- **Teams.** There's no lead team; `teams` is just the set of teams taking part.
- **Deleting.** Projects can't be deleted yet; cancel one instead, as workspaces can't be deleted either. Trash for projects is a follow-up.
- **Documents.** A doc keeps its team, as every Docket doc does, and can also be attached to one project.
- **Progress** counts issues (no estimates): a completed issue counts 1, a started one ½, and canceled issues drop out.

## Where things are today

- `src/server/db.ts:100-117`: `issues`, with no project column. `:134-145`: `documents` (`team_key NOT NULL`). `:271-290`: `pickSlug`, to reuse for project slugs.
- `src/shared/types.ts`: `:143-159` `IssueSummary`, `:200-216` `DocumentSummary`/`Document`, `:229-251` `DocumentFilter`/`DocumentInput`/`DocumentPatch`, `:253-279` `IssueInput`/`IssuePatch`/`IssueFilter`, `:282-287` `ServerEvent.entity`.
- `src/server/tracker.ts`:
  - `:341-356` `issueColumns`, which gains `project_id` and `milestone_id`.
  - `:510-561` `createIssue`, where a sub-issue inherits; `:563-607` `updateIssue`.
  - `:438-474` `queryIssues` filters.
  - Docs: `:765-767` `DOC_COLUMNS`, `:772-781` `toDocSummary`, `:879-885` `listDocuments`, `:897-917` `createDocument`, `:919-952` `updateDocument`.
- `src/server/api.ts:47-48`: the strict `ISSUE_FIELDS`/`DOCUMENT_FIELDS`. `:52-61` `issueFilter`. `:189-194` document list params.
- `src/server/mcp.ts`: `:66-81` the `details` meta line, `:276-306` `list_issues`, `:322-372` `create_issue`/`update_issue`, `:400-481` doc tools.
- `src/server/index.ts:30`: `APP_PATHS`, which serves index.html for UI routes (new ones must be added).
- Web:
  - Routing: `src/web/routing.tsx:5-24`.
  - Shell: `src/web/main.tsx:210-226` picks the page; `:299-310` sidebar nav. `src/web/components.tsx:251-257`: the team tabs.
  - Issue page: `src/web/issue.tsx:254-380` `Description` (the markdown editor with a conflict banner, to reuse), `:487-564` `Properties`.
  - `src/web/issues.tsx:221-253`: `IssueList`, to reuse.
  - `src/web/modals.tsx:125-159`: new issue chips. `src/web/docs.tsx:365-382`: the doc page meta line (team picker).

## Design

### Data (append the next migration)

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  workspace TEXT NOT NULL REFERENCES workspaces(key),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'planned', 'in_progress', 'paused', 'completed', 'canceled')),
  lead_id INTEGER REFERENCES users(id),
  target_date TEXT, -- YYYY-MM-DD
  creator_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX projects_workspace ON projects(workspace);
CREATE TABLE project_teams (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_key TEXT NOT NULL REFERENCES teams(key),
  PRIMARY KEY (project_id, team_key)
);
CREATE INDEX project_teams_team ON project_teams(team_key);
CREATE TABLE milestones (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  target_date TEXT,
  position REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX milestones_name ON milestones(project_id, lower(name));
ALTER TABLE issues ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE issues ADD COLUMN milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL;
CREATE INDEX issues_project ON issues(project_id) WHERE project_id IS NOT NULL;
ALTER TABLE documents ADD COLUMN project_id INTEGER REFERENCES projects(id);
```

Existing issues and docs get `NULL` (no project). Slugs are stable like doc slugs (`pickSlug(input.slug, name, taken, { label: "slug", fallback: "project" })`) and unique the way doc slugs are: globally now, per workspace once DKT-3 lands. If DKT-3 gives teams a surrogate id, `project_teams` references it.

### Contract (`src/shared/types.ts`)

```ts
export const PROJECT_STATUSES = ["backlog", "planned", "in_progress", "paused", "completed", "canceled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  backlog: "Backlog", planned: "Planned", in_progress: "In Progress", paused: "Paused", completed: "Completed", canceled: "Canceled",
};

export interface ProjectSummary {
  slug: string; // stable, URL-safe, like a doc's
  workspace: string;
  name: string;
  status: ProjectStatus;
  lead: UserRef | null; // a person
  teams: string[]; // team keys taking part, at least one
  targetDate: string | null; // YYYY-MM-DD
  progress: number; // 0–1: completed issues count 1, started ½; canceled ones are left out
  issueCount: number; // live issues in it
  createdAt: string;
  updatedAt: string; // version token for baseUpdatedAt, bumped like an issue's
}
export interface Milestone {
  id: number;
  name: string; // unique within its project
  description: string;
  targetDate: string | null;
  position: number;
  progress: number;
  issueCount: number;
}
export interface Project extends ProjectSummary {
  description: string; // markdown
  creator: UserRef;
  milestones: Milestone[]; // by position
  docs: DocumentSummary[]; // attached docs
}
export interface ProjectInput {
  teams: string[];
  name: string;
  description?: string;
  status?: ProjectStatus;
  lead?: string | null;
  targetDate?: string | null;
  slug?: string;
}
export type ProjectPatch = Partial<Omit<ProjectInput, "slug">> & { baseUpdatedAt?: string };
export interface MilestoneInput { name: string; description?: string; targetDate?: string | null; position?: number }
export type MilestonePatch = Partial<MilestoneInput>;
```

- `IssueSummary` gains `project: string | null` (slug) and `milestone: string | null` (name). `IssueInput` gains `project?: string | null` and `milestone?: string | null`, so `IssuePatch` has them too. `IssueFilter` gains `project?: string`.
- `DocumentSummary` gains `project: string | null`. `DocumentInput` and `DocumentPatch` gain `project?: string | null`, and `DocumentFilter` gains `project?: string`.
- `ServerEvent.entity` gains `"project"` (id = slug).

### Server (`src/server/tracker.ts`, `--- Projects ---`)

- **Resolution.** `projectRow(a, slug)` answers 404 outside your workspaces. It's used by every route and by the `project` field.
- **`createProject`** needs a person or agent who is a member (as with teams).
  - `teams` must name at least one team, all in one workspace (400 otherwise), which becomes the project's workspace.
  - `name` uses `requireText`. `status` is checked with `checkOneOf`.
  - `lead` uses `activeMemberId(…, "person", "lead")`: a person who is an active member.
  - `targetDate` must be a real `YYYY-MM-DD` or null (400).
  - It returns 201 `Project` and publishes `changed("project", ws, slug)`.
- **`updateProject`** has a strict body. `baseUpdatedAt` works as for issues (409 "Project changed since you read it", IMMEDIATE transaction). `updated_at` moves with `bumpedAt`. Removing a team that still has issues in the project is 409 "3 WEB issues are in this project".
- **Progress** for a project or a milestone, over its live issues: `(completed + 0.5 × started) / (total − canceled)`, or 0 when that's 0. Categories come from DKT-18's `workflow_statuses.category`. Until D1 lands, `done` counts as completed, `canceled` as canceled, and `in_progress` and `in_review` as started. `issueCount` counts live issues.
- **Issues** (in `issueColumns` and the create and update paths):
  - **Project.** `project` is a slug in the issue's workspace (400 `project: x is in another workspace`, 400 `Unknown project "x"`). Setting it adds the issue's team to `project_teams` if missing (Linear shares projects across the teams working on them), and publishes a `project` event.
  - **Milestone.** `milestone` is a name in the issue's (new or current) project: 400 `Unknown milestone "x" in <slug>`, or 400 "Set a project first". Changing `project` clears the milestone unless the same patch names one of the new project's. `project: null` clears both.
  - **Sub-issues.** A new issue with `parent` and no `project` joins the parent's project and milestone.
  - Joining or leaving a project bumps only the issue and publishes an `issue` event.
- **Milestones.**
  - `createMilestone` defaults its position to last. Names are unique per project (409).
  - `updateMilestone` handles rename, description, target date and position.
  - `deleteMilestone` clears it on its issues (bumped, `issue` events).
  - All three return the `Project` and publish a `project` event.
- **Documents.** `project` on create and update must be a project in the doc's workspace (400 otherwise); `null` detaches it. `toDocSummary` adds the slug. `listDocuments` takes `project`. Moving a doc to another team keeps its project.
- **Lists.** `listProjects(a, { workspace?, team?, status? })` sorts by status (`PROJECT_STATUSES` order), then target date (nulls last), then name. `team` means projects that team takes part in. An unknown workspace or team is 400, as for issues.
- **Issue lists.** `queryIssues` takes `project` (an unknown slug is 400 `Unknown project`). `ISSUE_SELECT` joins projects and milestones for `project` and `milestone`.

### REST (`src/server/api.ts`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | /api/projects | `?workspace&team&status=a,b` | `ProjectSummary[]` |
| POST | /api/projects | `ProjectInput` | 201 `Project` |
| GET / PATCH | /api/projects/:slug | `ProjectPatch` (strict; `slug` → 400 "A project's slug never changes") | `Project` |
| POST | /api/projects/:slug/milestones | `MilestoneInput` | 201 `Project` |
| PATCH / DELETE | /api/projects/:slug/milestones/:id | `MilestonePatch` | `Project` |

`ISSUE_FIELDS` and `DOCUMENT_FIELDS` gain `project` (and issues `milestone`). `GET /api/issues` and `GET /api/documents` take `?project=slug`. There is no DELETE for projects.

### MCP (`src/server/mcp.ts`)

Add a bullet to INSTRUCTIONS: "Projects (list_projects) group issues from one or more teams toward a goal, with a lead, status, target date and milestones (stages); an issue is in at most one project and one of its milestones. Identified by slug."

- **`list_projects`** (read). Input: `workspace?`, `team?` ("Only projects this team takes part in"), `status?: z.array(z.enum(PROJECT_STATUSES))`.
  - Description: "List projects, one line each: slug · name · status · progress % · @lead · target date · teams. Use get_project for its description, milestones and docs, and list_issues with `project` for its issues."
- **`get_project`** (read). Input: `slug`.
  - Description: "Get a project by slug: its markdown description, status, lead, target date, teams, progress, milestones (each with progress and target date) and attached docs. For its issues use list_issues with project."
- **`create_project`**. Input: `teams: z.array(teamKey).min(1)`, `name`, `description?`, `status?`, `lead?`, `targetDate?`, `slug?`.
  - Description: "Create a project, a body of work toward a goal that spans one or more teams of a workspace; returns its slug. Check list_projects first and only create one when asked to. Status: backlog (default), planned, in_progress, paused, completed, canceled. The lead is a person's username or \"me\". targetDate is YYYY-MM-DD."
- **`update_project`**. Input: `slug`, `name?`, `description?`, `status?`, `lead?` (nullable), `targetDate?` (nullable), `teams?`, `baseUpdatedAt?`.
  - Description: "Update a project; only the fields you pass change. `teams` replaces the list (a team with issues in the project can't be dropped). Pass baseUpdatedAt from get_project when replacing the description. There is no delete: set status canceled. The slug never changes."
- **`create_milestone`**. Input: `project`, `name`, `description?`, `targetDate?`.
  - Description: "Add a milestone (a stage such as \"Beta\", with an optional target date) to a project. Put an issue in it with update_issue's milestone."
- **`update_milestone`**. Input: `project`, `milestone` (current name), `name?`, `description?`, `targetDate?` (nullable).
  - Description: "Rename a project's milestone or change its description or target date."
- **Existing tools:**
  - `create_issue`/`update_issue` add `project` ('Project slug (see list_projects); null to take it out') and `milestone` ('Milestone name in the issue\'s project; null to clear'). create_issue adds: "A sub-issue joins its parent's project unless you pass one."
  - `list_issues` adds `project`.
  - `get_issue`'s meta line shows `project <slug>` and `milestone <name>`.
  - `create_document`/`update_document` add `project` ("Attach the doc to a project (slug) of its workspace; null to detach"). `list_documents` adds `project`.

### UI

- **Routes.** `/projects` and `/t/:key/projects` show `ProjectsView`, and `/project/:slug` shows `ProjectPage`. Both live in a new `src/web/projects.tsx`. Add them to `routing.tsx` and to `APP_PATHS` (`index.ts:30`: `/projects`, `/project/*`). When DKT-3 adds the workspace prefix, they follow it.
- **Navigation.** The sidebar gets a "Projects" item after "All docs" (`main.tsx:305-309`). The team tabs (`components.tsx:251-257`) become Issues, Projects, Docs, Trash (plus any tabs other issues add).
- **Projects list.** `ListHeader` with search (by name, client-side) and a "New project" button.
  - A row is: status glyph, name (`dir="auto"`), progress as "42%" with a thin bar, lead avatar (`AssigneePicker`), target date, team marks. It links to the page.
  - Status glyphs reuse the status icons: backlog → dashed ring, planned → ring, in_progress → half pie, paused → ring in `--urgent`, completed → check disc, canceled → x disc.
  - Empty state: "No projects yet. Projects group issues from any team toward one goal, with milestones and a target date." with a "New project" button.
- **New project modal** (`modals.tsx`): a name input, then a description textarea, then chips for status, lead, target date (`<input type="date">`) and teams (multi-select, default the current team). `⌘↵` creates and opens the page.
- **Project page:**
  - Crumbs "Projects › Name"; `TitleEditor` for the name.
  - A chip row for status, lead, target date and teams, then a progress line "42% · 12 issues".
  - The description reuses `Description` from `issue.tsx:254-380` (export it), saving with `baseUpdatedAt`.
  - **Milestones** section: rows show name (inline edit), target date, progress % and count, with a `RowMenu` (Move up, Move down, Delete), and "+ Add milestone" as an inline input. Clicking a milestone filters the issue list below by it (client-side on `issue.milestone`).
  - **Docs** section: attached docs, plus "New doc", which opens `NewDocModal` with the project preset.
  - **Issues** section: `IssueList` over `api.issues({ project })`, with "New issue" (`newIssue({ project, team: teams[0] })`).
  - Empty milestones: "Break the project into stages, like Alpha and Beta."
- **Issue page** `Properties`: "Project" (a `ProjectPicker` with "No project" and the workspace's projects, loaded on open) and "Milestone" (shown when a project is set, listing its milestones).
- **New issue modal:** a Project chip. `IssueInput` defaults can carry `project`.
- **Doc page:** the meta line (`docs.tsx:365-382`) gets `· ProjectPicker` after the team.

## Acceptance criteria

- [ ] People and agents can create, list, read and update projects over REST, MCP and the UI; the three stay in parity. Projects in other workspaces are 404 and never listed.
- [ ] A project spans teams of one workspace. Issues from any of its workspace's teams can join (adding their team). An issue is in at most one project and one of that project's milestones.
- [ ] Sub-issues created under a parent join the parent's project and milestone unless told otherwise.
- [ ] Changing an issue's project clears a milestone that doesn't belong to the new one. Deleting a milestone clears it from its issues.
- [ ] Progress and issue counts follow issue status (completed 1, started ½, canceled left out) and ignore trashed issues.
- [ ] Docs can be attached to and detached from a project of their workspace and show on its page.
- [ ] The project description saves with `baseUpdatedAt`, and a stale save answers 409.
- [ ] Every mutation publishes `project` and/or `issue` events for the workspace.

## Tests

New `test/projects.test.ts` (admin, `s.user("ana")`, `s.agent("bot")`, teams WEB and APP in `acme`, SID in a second workspace `side`):
- **Create:**
  - `POST /api/projects {teams:["WEB"], name:"Launch", lead:"ana", targetDate:"2026-12-01"}` → 201, slug `launch`, status backlog.
  - `teams: []` → 400. `teams: ["WEB","SID"]` → 400. `lead: "bot"` → 400. `targetDate: "2026-13-01"` → 400. An explicit taken slug → 409.
- **Membership:**
  - An APP issue with `project: "launch"` adds APP to `teams`.
  - A SID issue with `project: "launch"` → 400. ana GET `/api/projects/<side project>` → 404.
- **Milestones:**
  - Create "Beta". An issue with `milestone: "Beta"` but no project → 400. With the project → ok.
  - Moving the issue to another project clears the milestone.
  - Deleting "Beta" clears it and publishes an `issue` event (`s.admin.ws()`).
- **Sub-issues:** a sub-issue of a project issue has the same `project` and `milestone`.
- **Progress:** with 4 issues (done, in_progress, todo, canceled), progress is (1 + 0.5) / 3. A trashed issue doesn't count.
- **Teams:** removing a team with issues in the project → 409.
- **Conflicts:** PATCH `description` with a stale `baseUpdatedAt` → 409.
- **Docs:** create a doc with `project: "launch"`. It appears in `GET /api/projects/launch` `docs` and `?project=launch`. A doc in `side` can't attach (400).
- **MCP:** as bot, `create_project`, `create_milestone`, `update_issue {project, milestone}`, `list_issues {project}`, `get_project` (shows milestones and progress). A read-only key gets refused on `create_project`.
- **Strictness:** PATCH `/api/projects/launch {slug:"x"}` → 400, and `{foo:1}` → 400 naming it.
- **Migration survival** (`test/migrations.test.ts`, create it if absent): freeze main's schema at branch time (SQL constant, never edited) with a team, issues (one a sub-issue) and a doc. After `startServer({ setup: false, env: { DATABASE_PATH } })` and `s.signIn(...)`, everything reads back unchanged with `project: null` and `milestone: null`.

## SPEC.md

- **Data**: new **projects**, **project_teams** and **milestones**. Issues gain `project_id`/`milestone_id`, and documents gain `project_id`. Add the rules (one project per issue, milestone within its project, sub-issue inheritance, progress formula, no delete).
- **REST**: the project and milestone routes; `project` on issues and docs, and their filters.
- **MCP**: the six new tool rows, the issue/doc tool additions, and the INSTRUCTIONS bullet.
- **Realtime**: the `project` entity.
- **UI**:
  - The Sidebar bullet (Projects) and the team tabs.
  - New **Projects** bullets (list, page, milestones, docs).
  - The Issue page and New issue modal (Project, Milestone), and the Doc page (project picker).
  - Routes: `/projects`, `/t/:key/projects`, `/project/:slug`.
- **Layout**: `src/web/projects.tsx`.

## Out of scope

- **Initiatives**, which group projects under company goals. https://linear.app/docs/initiatives
- Project updates and health; start date, timeline and roadmap; project labels.
- Customizable project statuses; members; priority; icon and color.
- Deleting, archiving or trashing projects; "convert issue to project".
- Estimate-weighted progress (DKT-32); progress graphs.
- Moving issues between teams (DKT-20). A moved issue keeps its project and milestone, and its new team joins `project_teams`; whichever lands second implements that.
- Project views and filters beyond status and team; project templates.
- Docs without a team.
- Cycles: DKT-30. An issue can be in a project and a cycle independently.
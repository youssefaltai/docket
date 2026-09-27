## Why

Every filter a person sets up in Docket today (label, assignee, delegate, search) is thrown away on navigation — there's no way to save "bugs assigned to me" or "unlabeled backlog" and come back to it, let alone share it with a teammate or an agent. Teams settle into a handful of standing views (by priority, by label, by person) and shouldn't have to rebuild them by hand every time.

## Linear's behaviour

https://linear.app/docs/custom-views: a saved view captures its filters plus display settings (grouping, ordering, layout); views exist at workspace scope (available to all members) or narrower (team/project); a view has an owner; it can be shared via a link, though the link alone doesn't grant access beyond what the recipient already has; a star favorites it into the sidebar, and a favorite can be set as your default landing page (https://linear.app/docs/display-options covers grouping/ordering independent of saved views, applying to any list).

Docket keeps one scope only — **per-workspace** (every active member can see and use a workspace's views, matching how everything else in Docket is already workspace-scoped; no separate team-scoped or personal-only views, which would be extra surface for little payoff at Docket's size) — and drops "set as default landing page" (a small nicety, not requested, easy to add later without a schema change).

## Where things are today

- `src/shared/types.ts:270-279` (`IssueFilter`) — the shape a saved view's filter is built from (after DKT-1 adds `delegate` support in the UI and DKT-14 adds `creator`, both server-visible fields already or soon).
- `src/web/issues.tsx:43-89` (`IssuesView`) — currently the only place filters are applied; a saved view needs to drive the same list/board rendering (`IssueList`/`Board`, `:221-435`) from a stored filter instead of local `useState`.
- No grouping/ordering options exist anywhere: `IssueList` always groups by status (`src/web/issues.tsx:233-249`, iterating `STATUSES`) and always sorts via `sortIssues` (`src/web/ui.tsx` → `src/web/hooks.ts:116`, status then priority then recency) — there is no "group by assignee/priority/label" or "order by priority/updated/created" today. Adding display options is new sort/group logic, not a rewire of existing options.
- `src/web/routing.tsx:5-24` (`Route`) — no `views`/`view` route case.
- `src/web/main.tsx:270-336` (`Sidebar`) — no "Views" section; favorites need a home here, per the brief.
- `src/shared/types.ts:281-287` (`ServerEvent`) — `entity` is a closed union (`"workspace" | "member" | "team" | "issue" | "document"`); this issue is additive (new entity kind, not a new DB column on existing rows), so extending the union is safe and matches how the type evolves alongside new features.
- `src/server/db.ts:28` (`MIGRATIONS`) — append the next migration for the new tables; no existing table changes.

## Design

### Schema (append the next migration)

```sql
CREATE TABLE custom_views (
  id INTEGER PRIMARY KEY,
  workspace TEXT NOT NULL REFERENCES workspaces(key),
  name TEXT NOT NULL,
  filter TEXT NOT NULL,   -- JSON: a subset of IssueFilter (team, status, label, assignee, delegate, creator, q) — never `workspace`, which is implicit
  group_by TEXT NOT NULL DEFAULT 'status' CHECK (group_by IN ('status', 'assignee', 'priority', 'label')),
  order_by TEXT NOT NULL DEFAULT 'priority' CHECK (order_by IN ('priority', 'updated', 'created')),
  layout TEXT NOT NULL DEFAULT 'list' CHECK (layout IN ('list', 'board')),
  position INTEGER NOT NULL,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE view_favorites (
  user_id INTEGER NOT NULL REFERENCES users(id),
  view_id INTEGER NOT NULL REFERENCES custom_views(id),
  PRIMARY KEY (user_id, view_id)
);
```
Migration-survival test (per CONTRIBUTING.md, "a new migration comes with a test that data written under the previous schema survives it"): freeze a fixture DB at the previous `user_version` with existing users/workspaces/issues (built directly with `bun:sqlite` against the frozen pre-migration schema, since no committed migration-survival test exists yet to copy from — this issue's test is the first one; write it so future migrations can copy its shape), run the new migration, and assert old data is untouched and the two new tables exist and are empty.

### Types (`src/shared/types.ts`)

```ts
export type GroupBy = "status" | "assignee" | "priority" | "label";
export type OrderBy = "priority" | "updated" | "created";

export interface ViewDisplay {
  groupBy: GroupBy;   // default "status"
  orderBy: OrderBy;   // default "priority"
  layout: "list" | "board"; // default "list"
}

export interface CustomView {
  id: number;
  workspace: string;
  name: string;
  filter: Omit<IssueFilter, "workspace">;
  display: ViewDisplay;
  creator: UserRef;
  favorite: boolean; // for the caller
  createdAt: string;
  updatedAt: string;
}

export interface CustomViewInput {
  workspace: string;
  name: string;
  filter?: Omit<IssueFilter, "workspace">;
  display?: Partial<ViewDisplay>;
}

export type CustomViewPatch = Partial<Omit<CustomViewInput, "workspace">>;
```
`ServerEvent["entity"]` gains `"view"`.

### Server (`src/server/tracker.ts`, new functions; `src/server/api.ts`, new routes)

- `listViews(a, workspace)` — workspace-scoped, includes `favorite` per caller (join `view_favorites`).
- `createView(a, input)` — validates `name` (reuse `requireText`), `filter` (whitelist known `IssueFilter` keys, same "unknown field" 400 pattern as `patch()` in `api.ts:32-40`), `display` fields against their `CHECK` sets; `position` defaults to last.
- `updateView(a, id, patch)` — same field whitelist; 403 if the caller isn't the creator and isn't a workspace admin (views are shared/visible to all, but only the owner or an admin edits/deletes them — matches Linear's "every view has an owner" plus Docket's existing admin-override pattern for workspace-level things); 404 outside the caller's workspaces.
- `deleteView(a, id)` — same authorization; hard delete (no trash for views — they're not user content like issues/docs, just saved queries, so losing one isn't data loss in the same sense; recreating one is a few clicks).
- `favoriteView(a, id, on)` — insert/delete the caller's row in `view_favorites`; no ownership check (favoriting is personal).

REST:
```
GET  /api/views              ?workspace                 → CustomView[]
POST /api/views               CustomViewInput            → 201 CustomView
GET / PATCH / DELETE /api/views/:id   CustomViewPatch     → CustomView
POST /api/views/:id/favorite  { favorite: boolean }       → CustomView
```
Every write publishes `changed("view", workspace, String(id))`.

MCP: skip (see Out of scope) — views are a UI convenience; an agent can already pass any filter directly to `list_issues`.

### UI

- `src/web/routing.tsx`: add `{ view: "views" }` (`/views`, an index/management page) and `{ view: "customview"; id: number }` (`/view/:id`).
- New `src/web/views.tsx`:
  - `ViewsPage` — lists the workspace's views (name, creator, star toggle), "New view" button opens a small modal (name + starting filter, defaulting to whatever the person currently has active if they arrived via a "Save as view" action — see below).
  - `CustomViewPage` — loads the `CustomView`, applies its `filter` to `api.issues()` (merging in the current `workspace`), renders `IssueList` or `Board` (reuse from `src/web/issues.tsx` — export them, same note as DKT-14) per `display.layout`, and groups/orders per `display.groupBy`/`orderBy`. This is the one place that needs real grouping/ordering logic beyond "always by status" — extract a small `groupIssues(issues, groupBy)` and `orderIssues(issues, orderBy)` pair of functions (new, in `src/web/ui.tsx`'s `hooks.ts` or a new `views.ts` module) used by both the saved-view page and, optionally, a future "customize this list" affordance on the plain issues view (not required by this issue, but write the functions generically so they aren't saved-view-specific).
  - Editable via the same property pickers pattern as everywhere else: a "Filters" bar matching `Filters` (`src/web/issues.tsx:174-217`, extended with the view's stored values) plus a "Group by"/"Order by"/List-Board control; changes save via `PATCH /api/views/:id` (debounced, similar spirit to doc autosave but simpler — these are small structured fields, so save immediately on each picker change rather than debouncing free text).
- `src/web/issues.tsx`: add a "Save as view" action in `IssuesView`'s header (opens the New view modal pre-filled with the current filter/layout) so views start from a working filter, not a blank form.
- Sidebar (`src/main.tsx` `Sidebar`): a "Views" section listing only favorited views (star icon, like the existing nav items), between "All docs" and "Teams", plus a link to `/views` ("All views" or a `+`/settings affordance) to manage/favorite more. Empty (no favorites): the section doesn't render, same as the existing "no teams yet" pattern.

### Workspace-isolation interaction (DKT-3)

Views are already workspace-scoped end to end (the `workspace` column, every route filtered by it) — DKT-3's planned `/<ws>/...` URL prefix applies here exactly as it will to `/issue/:id` and `/doc/:slug`; nothing here embeds an identifier that would need to change shape (view ids are opaque numeric ids, not usernames or slugs), so it works unchanged either way.

## Acceptance criteria

- [ ] "Save as view" from the issues toolbar creates a view from the current filter and layout.
- [ ] `/views` lists a workspace's views with creator and a star to favorite/unfavorite.
- [ ] Starred views appear in the sidebar; unstarring removes them from the sidebar without deleting the view.
- [ ] `/view/:id` renders issues per the view's filter, grouped and ordered per its display options, in list or board per its layout.
- [ ] Editing a view's filter/display/name persists and is visible to other workspace members immediately (realtime `changed` on `"view"`).
- [ ] Only the view's creator or a workspace admin can edit or delete it; any active member can favorite it and use it.
- [ ] Deleting a view removes it (and any favorites of it) for everyone; opening its old URL 404s like a deleted team/issue would.
- [ ] Views never leak across workspaces (404 outside the caller's workspaces, matching every other resource).
- [ ] Works at phone width.

## Tests

New `test/views.test.ts`, following the existing harness pattern (`s.api`, `s.user`, `s.as`):
- Create, list, get, patch, delete a view; 404 for another workspace's view; 403 editing/deleting someone else's view as a non-admin, 200 as an admin.
- Favorite/unfavorite; `favorite` reflects per-caller state (two different users see their own favorite status on the same view).
- Filter/display field whitelisting: an unknown field is 400 naming it, matching `IssueFilter`'s existing "Unknown field" pattern.
- Migration-survival: freeze a pre-migration fixture DB (existing users/workspaces/issues), run the new migration, assert old rows are untouched and the two new tables exist and are queryable.

## SPEC.md

- `## Data`: document `custom_views` and `view_favorites` alongside the other tables, and the new migration number ("migration N adds custom_views and view_favorites").
- New `## REST` rows for `/api/views` and `/api/views/:id[/favorite]`.
- `## Realtime`: add `"view"` to the `entity` enum's description.
- `## UI`: new bullet(s) under Sidebar (favorited views) and a short "Views" description (save, favorite, group/order/layout options) near the existing Toolbar bullet.

## Out of scope

- MCP tools for views — an agent filters directly via `list_issues`; revisit if agents start asking for saved-view parity.
- Team-scoped or personal-only (non-shared) views — everything is workspace-scoped, matching Docket's existing model.
- "Set as default landing page" — not requested; would need a per-user preference column, easy to add later.
- Manual/drag ordering as a display option — Docket has no manual issue ordering at all yet.
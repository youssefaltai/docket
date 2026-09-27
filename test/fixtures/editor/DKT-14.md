## Why

Docket has no single place to see "what's mine" across teams: a person has to open each team, or use the "Mine" chip on "All issues" (which is scoped to whichever team/workspace view they're already in). Linear's My Issues is one of its most-used views. Docket should have an equivalent, extended with a Docket-specific "Delegated" tab, since agents doing work on a person's behalf is central to the product.

## Linear's behaviour

Linear's My Issues (https://linear.app/docs/my-issues) has tabs: **Assigned** (issues assigned to you, grouped by workflow state, with a snoozed section), **Created** (issues you created), **Subscribed**, and **Activity** (things you recently interacted with). It's a fixed, non-customizable view pinned near the top of the sidebar, separate from any team.

Docket differs deliberately:
- No **Activity** tab — Docket has no per-user activity feed/history to draw from yet; adding one is a bigger feature than this issue.
- No **Snoozed** section — Docket has no snooze/notifications feature.
- **Subscribed** ships later, blocked on DKT-11 (a subscriptions/notifications feature being drafted separately) — this issue defines the tab but leaves it disabled until then.
- Docket adds a **Delegated** tab: issues the viewer owns (assignee = them) that an agent is currently working on (delegate is set). This has no Linear equivalent — Linear doesn't have a delegate concept — but it's the single most useful "what are my agents doing" view for a person, so it earns its place ahead of Subscribed/Activity.

## Where things are today

- `src/web/routing.tsx:5-24` — `Route` is a closed union (`issues | docs | trash | issue | doc | settings`); `parseRoute` has no case for a cross-team "my issues" route.
- `src/web/main.tsx:270-336` — `Sidebar`: renders workspace switcher, "New issue", then `Link`s for "All issues" (`/`) and "All docs" (`/docs`), then the team list. No "My Issues" entry.
- `src/web/issues.tsx:43-89, 174-217` — `IssuesView`/`Filters`: the existing "Mine" chip (`src/web/issues.tsx:183-186`) sets `assignee` to `getMe().user.username` within whatever team/workspace scope is already selected; it isn't a standalone cross-team view and doesn't expose Created or Delegated.
- `src/shared/types.ts:270-279` — `IssueFilter` has `workspace, team, status, label, assignee, delegate, parent, q`. **No `creator` field.** `src/server/api.ts:50-59` (`issueFilter`) and `src/server/mcp.ts:280-298` (`list_issues` inputSchema) mirror that — neither reads a `creator`/`created` parameter. `src/server/tracker.ts:438-476` (`queryIssues`) has no creator clause; `issues.creator_id` exists as a column (`src/server/db.ts` migration 1, `creator_id` on `issues`) and is already selected/returned as `Issue.creator` (`src/server/tracker.ts:243, 271`), just never filtered on.
- `src/web/pickers.tsx:230-235` (`useMembers`) and `getMe()` (`src/web/auth.ts`) give everything needed client-side once the server supports `creator`.
- `src/web/hooks.ts` / `src/web/ui.ts` — no existing "grouped tabs" component to reuse besides `Tabs` (`src/web/components.tsx`, used for the team Issues/Docs/Trash tabs at `src/web/components.tsx:207-215`) — reuse that.

## Design

### Server: add `creator` filtering (REST + MCP), needed for the Created tab

`src/shared/types.ts`:
```ts
export interface IssueFilter {
  workspace?: string;
  team?: string;
  status?: Status[];
  label?: string;
  assignee?: string; // username or "me"
  delegate?: string; // username or "me"
  creator?: string;  // username or "me" — who filed it
  parent?: string;
  q?: string;
}
```

`src/server/api.ts`: in `issueFilter()`, add `creator: param(req, "creator")`.

`src/server/tracker.ts`, in `queryIssues` right after the `filter.delegate` block:
```ts
if (filter.creator) {
  where.push("i.creator_id = ?");
  params.push(userFilterId(a, filter.creator, workspaces, "creator"));
}
```
`userFilterId` already resolves `"me"` and 400s on an unknown/out-of-workspace username — reuse it unchanged (creators can be a person or an agent, and `userFilterId` doesn't restrict by kind, so this is correct as-is).

`src/server/mcp.ts`: add `creator: assignee.optional().describe('Who filed it: a username, or "me"')` to `list_issues`'s `inputSchema` (reusing the existing `assignee` zod schema, since it's just "a username or me" with no kind restriction), and pass it through in the handler's `{ status, query, limit, after, ...filter }` destructure (already generic — no handler code change needed beyond the schema addition, since `filter` is spread into `tracker.listIssuesPage`).

REST table (SPEC.md) gains `creator` in the `/api/issues` query params list.

### Route and sidebar

`src/web/routing.tsx`: extend `Route`:
```ts
| { view: "my"; tab: "assigned" | "created" | "delegated" | "subscribed" }
```
Parse `/my` and `/my/:tab` (default tab `"assigned"` for bare `/my`; an unknown tab segment also falls back to `"assigned"` rather than 404ing, matching how `parseRoute` is generally forgiving).

`src/web/main.tsx`:
- Add a case to the `page` switch: `route.view === "my" ? <MyIssuesView tab={route.tab} /> : ...`.
- `routeTeam()` returns `null` for `"my"` (it's not team-scoped), so the sidebar doesn't highlight any team.
- `Sidebar`: add a `Link` to `/my` right after "New issue" and before "All issues", using `<Avatar user={getMe().user} />` as its icon (mirroring the existing "Mine" chip's use of `Avatar`) and label "My Issues". Active when `route.view === "my"`.

### `src/web/myissues.tsx` (new file)

```tsx
export function MyIssuesView({ tab }: { tab: "assigned" | "created" | "delegated" | "subscribed" }) {
  const app = useApp();
  const me = getMe().user;
  const workspace = app.workspace?.key;
  const filterFor = (t: typeof tab): IssueFilter | null =>
    t === "assigned"  ? { workspace, assignee: "me" } :
    t === "created"   ? { workspace, creator: "me" } :
    t === "delegated" ? { workspace, assignee: "me" } : // then keep only delegated ones, client-side
    null; // subscribed: not wired up yet
  const { data: issues, failed, reload } = useFetch(
    workspace && tab !== "subscribed" ? () => api.issues(filterFor(tab)!) : null,
    [workspace, tab],
  );
  const shown = tab === "delegated" ? issues?.filter((i) => i.delegate) : issues;
  // ...renders the same List/Board machinery as IssuesView (extract IssueList/Board or lift them
  // to a shared module so both views call the same rendering code with no duplication), a Tabs bar
  // (Assigned / Created / Delegated / Subscribed) using the existing <Tabs> component, and a
  // per-tab empty state.
}
```

Notes:
- **Delegated** is defined as "assignee = me AND delegate is set" (an issue you own that an agent is working on for you). There's no server-side "delegate is not null" filter (out of scope to add one for a single UI view); fetching `assignee: "me"` and filtering client-side is correct because `IssuesView` already fetches unpaginated lists this way (`api.issues()` with no `first`/`after` returns the whole array, same as today's "Mine" chip) — the same caveat applies (very large per-person assignments would need real pagination, which is a pre-existing limitation, not new).
- **Subscribed** renders a disabled/"Coming soon" tab until DKT-11 lands; don't fetch anything for it.
- Reuse `IssueList`/`Board` from `src/web/issues.tsx` — export them (they're currently private to that file) rather than duplicating row/card rendering. List/Board toggle can be reused too (`store.get("view")`), or simplified to List-only for v1 if that's simpler; either is fine since it's a display choice, not semantics — recommend keeping the existing List/Board toggle for consistency with the rest of the app.
- No new realtime event: this view subscribes the same way `IssuesView` does (via `LiveContext`/`useFetch`'s existing reload-on-`live` behaviour — confirm `useFetch`'s deps already include enough to refetch on `live` changes, matching the pattern other views use).

### Workspace-isolation interaction (DKT-3)

This view is workspace-scoped (like "All issues"), never cross-workspace, and filters by username — which is exactly the shape DKT-3 plans to keep working (usernames unique per workspace under the new scheme). No URL identifiers are embedded here beyond the tab name, so `/my/:tab` needs no workspace prefix even after DKT-3 lands (it already implicitly scopes to `app.workspace`, same as `/` and `/docs` do today per SPEC.md:178).

## Acceptance criteria

- [ ] Sidebar shows "My Issues" (with the viewer's avatar) above "All issues".
- [ ] `/my` (and `/my/assigned`) shows issues assigned to me in the current workspace, grouped/rendered like the existing list/board.
- [ ] `/my/created` shows issues I created (any status/assignee) in the current workspace.
- [ ] `/my/delegated` shows issues I'm the assignee of that also have a delegate set.
- [ ] `/my/subscribed` shows a disabled/placeholder tab, no crash, no fetch.
- [ ] Switching tabs updates the URL (`pushState`) and back/forward navigates between tabs.
- [ ] `GET /api/issues?creator=me` and `?creator=<username>` filter correctly; an unknown creator username is 400 `Unknown creator "..."`.
- [ ] MCP `list_issues` accepts `creator` with the same semantics.
- [ ] Works at phone width (sidebar entry collapses like the others; tabs wrap or scroll).

## Tests

- `test/parity.test.ts` (or `test/claims.test.ts`, matching the existing `assignee=`/`delegate=` filter tests) — add: `GET /api/issues?creator=me` returns issues created by the caller; `?creator=<username>` for another workspace member; `?creator=nobody` is 400 `Unknown creator "nobody"` (matching the existing pattern for unknown assignee/delegate at `test/parity.test.ts:91`).
- `test/mcp.test.ts` — `list_issues` with `creator` returns the same set as the REST equivalent (parity).
- No migration involved (no schema change — `creator_id` already exists and is indexed as part of the existing `issues` table).

## SPEC.md

- `/api/issues` row: add `creator` to the query parameter list (`?workspace&team&status=a,b&label&assignee&delegate&creator&parent&q`).
- MCP `list_issues` row: add `creator?` to its Notes/Input.
- `## UI`, **Sidebar** bullet: mention "My Issues" (Assigned / Created / Delegated / Subscribed) alongside "All issues"/"All docs".
- New short bullet or sub-bullet under UI describing the four tabs and that Subscribed is a placeholder pending DKT-11.

## Out of scope

- Subscribed tab's actual behaviour — depends on DKT-11; ship Assigned/Created/Delegated now, the tab shows as a placeholder.
- An Activity tab or snooze — no Linear-parity need identified; revisit if requested.
- Adding a general "delegate is set/unset" REST/MCP filter beyond what Created/Delegated need — DKT-1 already covers exact-delegate filtering; this issue only adds `creator`.
- Saved/custom views — DKT-28.
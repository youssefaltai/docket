## Why

Docket has no way to jump to a team, doc, or setting, or trigger an action, without the mouse and the sidebar. Linear's command menu is one of its signature interactions and one of the most-requested "feels like Linear" gaps. It also gives DKT-16's per-issue shortcuts a natural home for the actions that don't deserve their own single key (e.g. "Move to team" doesn't exist yet, but "Copy issue URL" or less-common actions could live here instead of crowding the keyboard).

## Linear's behaviour

Cmd/Ctrl+K opens a command menu: type any section, issue, project, or document name to jump straight there, or run an action (https://linear.app/docs/select-issues mentions it's also how bulk actions on a multi-selection are triggered: "Cmd/Ctrl+K to open the command bar and select the preferred action"). Linear's shortcuts-help changelog (https://linear.app/changelog/2021-03-25-keyboard-shortcuts-help) documents `?` as the separate full shortcut-list overlay — the command menu itself is action/navigation search, not a shortcut reference. Search results consistently describe it as fuzzy, covering both global actions (new issue, go to team/settings) and content (issues, docs) by identifier or title.

Docket keeps the same shape: one combobox, fuzzy-matched, two kinds of entries (actions, and navigable content), context-aware when an issue is open. Docket has no projects/cycles/initiatives, so those sections don't apply; "switch workspace" and "toggle view" replace Linear's project/cycle jumps as Docket's nearest equivalents.

## Where things are today

- `src/web/pickers.tsx:56-217` — the `<Picker>` component is exactly the "searchable popover list with keyboard nav" primitive Docket already has (combobox input, `role="listbox"`/`role="option"`, arrow/Ctrl-n/p navigation, `Enter` to pick, `Escape` to close, portal-rendered, positioned). It's anchored to a trigger button, though — the command menu needs a centered, un-anchored dialog instead (more like `<Modal>`, `src/web/modal.tsx`), so it doesn't reuse `<Picker>` directly, but it should copy its list/keyboard-nav internals (items filtering, `active` index, `aria-activedescendant`) rather than reinvent them.
- `src/web/main.tsx:190-208` — the global `useKeydown` handler is where a new `⌘K`/`Ctrl+K` binding belongs; it currently explicitly returns early on `e.metaKey || e.ctrlKey`, so the new handler must special-case `(e.metaKey || e.ctrlKey) && e.key === "k"` before that guard (or add a second `useKeydown` call, since `useKeydown` supports multiple independent registrations — check `src/web/hooks.ts:61-70` for how it composes; if it's a single global listener per call site, add one dedicated call in `App` for this shortcut so it doesn't get short-circuited by the existing modifier check).
- `src/web/issueIndex.ts` — already maintains a lightweight in-memory index of all issues (`setIssueIndex`, called from `src/web/main.tsx:76-88` on every load and live update) for identifier-chip rendering in markdown; check whether it holds enough (id, title, status) to reuse for the menu's issue search, avoiding a second full-issue fetch.
- `src/web/routing.tsx:33-36` — `navigate(to)` is how the menu would jump to a route once an action is chosen.
- `src/web/context.ts:6-27` (`AppState`) — already exposes `newIssue`, `newDoc`, `newTeam`, `newWorkspace`, `teamSettings`, `workspaces`, `teams`, `workspaceTeams` — the menu's "actions" list is built from these, no new app-state plumbing needed for navigation actions.
- `src/web/pickers.tsx:245-308` (`StatusPicker`, `PriorityPicker`, `AssigneePicker`, `DelegatePicker`) and `src/web/issue.tsx:487-565` (`Properties`) — the per-issue property setters the menu's context-aware section calls into when a specific issue is open.
- No existing fuzzy-match utility anywhere in `src/web` (`grep -rn "fuzzy\|score" src/web` finds nothing) — `<Picker>`'s own matching (`src/web/pickers.tsx:65-72`) is a plain case-insensitive substring test with an exact-match boost, not fuzzy. Reuse that same approach here rather than adding a fuzzy-matching dependency (the project takes none beyond react/react-dom/marked/zod/@modelcontextprotocol/sdk) — "fuzzy" in this issue means substring/subsequence matching implemented in a few lines, not a library.

## Design

New file `src/web/commandmenu.tsx`, mounted once in `App` (`src/web/main.tsx`) alongside `<Toaster />`/`<Confirm />`, so it's available everywhere.

### Trigger and structure

- `⌘K`/`Ctrl+K` (any page, even while typing — Linear allows opening it from within a text field, so this one does **not** check `isEditable`; it's the one shortcut that must win over typing) opens a centered modal-like overlay (reuse `<Modal>`'s backdrop/focus-trap/portal machinery from `src/web/modal.tsx`, or a stripped-down variant of it) containing one search input and a results list, `role="combobox"`/`role="listbox"`, same `active`/`aria-activedescendant` pattern as `<Picker>`.
- `Escape` closes it; `↓`/`↑` (and `Ctrl-n`/`Ctrl-p` for parity with `<Picker>`) move the active row; `Enter` runs/navigates the active row.
- Closing always returns focus to whatever had it before (same "opener" pattern as `<Modal>`, `src/web/modal.tsx:19-28`).

### Entries and fuzzy search

Build one static list of **actions** (always available, filtered by query) plus **dynamic** results:
- **Global actions**: New issue, New doc, New team, New workspace, switch workspace (one entry per workspace in `app.workspaces`), toggle List/Board view (only meaningful on an issues page — hide it elsewhere), go to Settings (account/workspace), go to All issues, go to All docs, go to My Issues (once DKT-14 lands — until then, omit it).
- **Context-aware actions**, only when `route.view === "issue"` and the issue is loaded: Set status, Set priority, Set assignee, Set delegate — each either opens a second-level list of the concrete options (status names, priority names, workspace people/agents) or, simpler and more consistent with "no new interaction pattern", closes the menu and opens the existing property `<Picker>` already on the issue page (e.g. programmatically focus/click the Status picker trigger). Recommend the latter for v1: it's a tiny bit less slick but reuses 100% of existing, tested picker code and keeps this issue small.
- **Content search**: issues by identifier or title (from the existing issue index, `src/web/issueIndex.ts`, already population-complete and live-updated — extend it to carry `title` if it doesn't already, since chip rendering may only need id+status) and docs by title (fetch `api.documents({ workspace })` lazily, cached for the session, refreshed like other directory data via `loadDirectory`/`live`).
- Matching: reuse `<Picker>`'s substring-with-exact-boost approach (`src/web/pickers.tsx:65-72`) per field (label, plus identifier/prefix for issues); cap results (e.g. top 8 actions + top 8 issues + top 5 docs) to keep the list short, same spirit as `<Picker>`'s `.slice(0, 100)`.
- Empty query: show the actions list only (no need to enumerate every issue/doc).

### Accessibility and phone

- `role="dialog"` on the overlay with `aria-label="Command menu"`, `role="combobox"` on the input wired to `aria-expanded`/`aria-controls`/`aria-activedescendant`, `role="listbox"`/`role="option"` on the list — mirrors `<Picker>` exactly (`src/web/pickers.tsx:152-211`).
- Full-width, near-top sheet below ~480px viewport width instead of a centered box (same responsive treatment `<Modal>` already needs to satisfy "works at phone width", SPEC.md:182); add a small header affordance so it's reachable on touch without the keyboard shortcut — e.g. a search-like icon button, or fold it into the existing `MenuButton`/header on mobile. Minimal option: a `⌘K`-labeled hint isn't visible on mobile anyway, so add a discoverable icon button in `ListHeader`'s `.controls` (or the sidebar) that opens the same overlay.

### No server changes

Everything the menu needs (issues, docs, teams, workspaces, members) is already fetched by the app shell or fetchable through existing REST/MCP-parity endpoints. No schema, types.ts, REST, or MCP changes.

## Acceptance criteria

- [ ] `⌘K`/`Ctrl+K` from anywhere in the app (including while a text field is focused, except inside another open popover/modal) opens the command menu.
- [ ] Typing filters both actions and content (issues by id/title, docs by title) in real time; an empty query shows just the actions.
- [ ] Arrow keys / Ctrl-n/p move the active row; Enter runs it; Escape closes without side effects.
- [ ] Choosing "New issue"/"New doc"/"New team"/"New workspace" opens the corresponding existing modal, exactly as the sidebar buttons do.
- [ ] Choosing a workspace switches to it (same behavior as the sidebar's workspace picker).
- [ ] Choosing an issue or doc navigates to it.
- [ ] On an issue page, a "Set status/priority/assignee/delegate" action opens that property's existing picker.
- [ ] Works and is reachable at phone width (a visible way to open it without a physical keyboard shortcut).
- [ ] Closing restores focus to whatever had it before opening.

## Tests

No UI test harness exists (tests are black-box over HTTP, `test/server.ts`) and this issue adds no server behavior, so no new `bun test` cases are needed. Manually verify in `bun run dev`: open with the shortcut from the issues list, an issue page, and a doc page; search an issue by identifier and by title fragment; search a doc by title; run each global action; verify Escape/click-outside closes cleanly; check phone width in devtools.

## SPEC.md

- `## UI` section: add a short paragraph (near the Toolbar/Sidebar bullets) describing the command menu: `⌘K`/`Ctrl+K` opens fuzzy search over actions and issues/docs; context-aware actions on the open issue; how to reach it on a phone.
- DKT-13's new Keyboard subsection should list `⌘K`/`Ctrl+K` too — sequence these two issues so whichever lands second updates that table rather than duplicating it.

## Out of scope

- Bulk actions on a multi-selection routed through the command menu (Linear does this) — depends on DKT-17 landing first; once it does, a follow-up can wire "N issues selected → ⌘K → bulk action" into this same component.
- Fuzzy-matching library or scoring beyond substring/exact-boost — no new dependency, per project rules.
- A dedicated `?` shortcut-help overlay — that's DKT-16.
- "Go to My Issues" — add once DKT-14 ships; until then the action list simply doesn't include it.
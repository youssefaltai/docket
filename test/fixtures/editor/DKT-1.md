## Why

SPEC.md:175 promises "label, assignee and delegate filters" in the issues toolbar, but the toolbar only offers label and assignee. Since agents are central to Docket (every issue can carry a delegate agent), a person can't currently narrow the list to "what is @claude-a working on" from the UI — they'd have to use MCP or hand-edit a REST query. The REST (`?delegate=`) and MCP (`delegate`) filters already exist and are tested; only the UI is missing.

## Linear's behaviour

Linear doesn't have an assignee/delegate split (its "delegate" is Docket-specific: an agent working an issue on a person's behalf, see SPEC.md:106). Linear's issue list filters by assignee, but has no separate concept to filter on. Docket should deliberately add its own delegate filter here since there's no Linear equivalent to copy — this is one of the few genuinely Docket-specific pieces of UI.

## Where things are today

- `src/web/issues.tsx:174-217` — `Filters({ label, setLabel, assignee, setAssignee })`: renders the "Mine" chip, then a label `Picker` and an assignee `Picker` (using `AssigneePicker`-style options built from `useMembers("person")`, `src/web/pickers.tsx:230-235`). There's no delegate picker.
- `src/web/issues.tsx:43-89` — `IssuesView`: holds `label`/`assignee` as local `useState`, debounces search, and calls `api.issues({ team, workspace, q, label, assignee })` (`src/web/issues.tsx:60-69`); `useFetch`'s deps array is `[teamKey, workspace, q, label, assignee]`. Neither `label` nor `assignee` is persisted anywhere (only `view` is, via `store.set("view", v)` at `src/web/issues.tsx:81-84`, backed by `src/web/api.ts`'s `store` wrapper over `localStorage`). So there's no existing persistence pattern for filters to match — they simply reset to empty on reload today. This issue keeps that behaviour for delegate too, for consistency.
- `src/web/api.ts:138` — `issues: (filter: IssueFilter = {}) => request<IssueSummary[]>("GET", "/api/issues" + query(filter))`: `filter` is typed as `IssueFilter` (`src/shared/types.ts:270-279`), which already includes `delegate?: string`. No client change needed here.
- `src/server/api.ts:58` and `src/server/tracker.ts:452-455` — REST already reads and applies `?delegate=` (via `userFilterId`, which resolves `"me"` and validates the username is a member). `src/server/mcp.ts:292` — MCP `list_issues` already accepts `delegate`. Both are exercised by `test/claims.test.ts:75-91`. No server changes needed.
- `src/web/pickers.tsx:230-235` — `useMembers(kind: UserKind)`: filters `useApp().members` to one kind (`"person"` or `"agent"`), you first. `useApp().members` and `loadDirectory` come from `src/web/main.tsx:113-120` (`api.members(currentKey)`, refreshed on `live`). Confirmed: `useMembers("agent")` already works and is used for `DelegatePicker` in `src/web/pickers.tsx:306-308` and `src/web/issue.tsx:513-517`.

## Design

Purely additive UI change: one new piece of state, one new `Picker`, threaded through the existing fetch.

`src/web/issues.tsx`:
- In `IssuesView`, add `const [delegate, setDelegate] = useState("")`, include `delegate` in `filtered` (`!!(q || label || assignee || delegate)`), pass it to `api.issues({ ..., delegate })` and add it to the `useFetch` deps array, and clear it in `clearFilters`.
- Pass `delegate`/`setDelegate` into `<Filters>` alongside the existing props.
- In `Filters`, add `const agents = useMembers("agent")` and a delegate `Picker`, mirroring the assignee one exactly (options: "Anyone" + `agents.map(userOption)`; `selected={[props.delegate]}`; `onOpen={loadDirectory}`; chip shows the selected agent's avatar/name or "Delegate"). No "Mine" chip for delegate — per the brief, a person filtering "assigned to me as a delegate" isn't a real use case; only agents hold the delegate slot, so a person's own username never matches it. Order: Mine chip, Label, Assignee, Delegate (label/assignee order stays as-is; delegate goes last, closest to the List/Board toggle, matching SPEC's "label, assignee and delegate" order).
- No new persistence: match the existing (lack of) persistence for label/assignee, so behaviour stays consistent across all three filters. (If persistence is ever added, it should cover label/assignee/delegate together, not delegate alone — that's a separate issue, not this one.)

Board and list both consume the same already-filtered `issues` array (`src/web/issues.tsx:136-139`, `Board`/`IssueList` receive `issues` after the fetch), so no separate wiring is needed for Board — verify by testing both views.

No schema, REST, or MCP changes. No new realtime events (filtering is read-only).

### Files touched
- `src/web/issues.tsx` (state + `Filters`)
- `SPEC.md` (no behaviour change, but the UI section already documents this exact feature — nothing to word differently, just confirm it now matches reality).

## Acceptance criteria

- [ ] The issues toolbar (`/`, `/t/:key`) shows a delegate chip/picker next to Label and Assignee, listing "Anyone" plus the workspace's active agents (you-marked if relevant — none will be, since a person is never an agent).
- [ ] Picking an agent filters the visible issues (both List and Board view) to those with that delegate.
- [ ] Picking "Anyone" clears the delegate filter.
- [ ] The delegate filter combines with search, label and assignee (AND semantics, matching the existing filters).
- [ ] "Clear" (shown when any filter is active) also clears the delegate filter.
- [ ] Switching workspaces resets the picker's option list to that workspace's agents (via the existing `loadDirectory`/`useApp().members` flow — no new code needed, just verify).
- [ ] Works at phone width (chip wraps like the others; no layout change needed since it reuses `.chip`).

## Tests

No existing UI test harness renders React (tests are black-box over HTTP, `test/server.ts`); this is a client-only change with no new server behaviour, so no new automated test is required for the filter itself — the REST/MCP `delegate` filter is already covered by `test/claims.test.ts:75-91` (`GET /api/issues?delegate=me`, `?delegate=alpha`) and `test/parity.test.ts:91` (unknown delegate is 400). Manually verify in the dev server (`bun run dev`, seed data): filter by an agent on both List and Board, and confirm "Anyone" clears it.

## SPEC.md

No wording change needed — SPEC.md:175 already says "label, assignee and delegate filters"; this issue makes the UI match. If reviewing turns up any drift (e.g. the exact chip order), adjust that one line to match what ships.

## Out of scope

- Persisting any of the three filters (label/assignee/delegate) across reloads or in the URL — none are persisted today; adding that is a separate, larger issue since it'd want a consistent design for all filters plus the "Mine" chip.
- A "delegated to me" view for agents, or a person-facing "issues I delegated" view — that's DKT-14 ("Delegated" tab).
- Any REST/MCP changes — the server already supports this fully.
## Why

Editing issues one at a time is the biggest speed gap between Docket and Linear once you have more than a handful open: relabeling a batch, reassigning everything from a departing teammate, or clearing a stale sprint all currently mean clicking into each issue (or row picker) individually. Linear's multi-select + bulk action bar is core to how it's used at scale.

## Linear's behaviour

https://linear.app/docs/select-issues: `X` toggles selection on the highlighted issue; `Shift`+`↑`/`↓` extends a range; `Shift`+click and a hover checkbox also select; `Esc` clears; `Cmd/Ctrl+A` selects all in the current filtered view. Once issues are selected, "the interface displays common bulk actions at the bottom" — update fields across the selection, reorder (not applicable to Docket, which has no manual ordering), and `Cmd/Ctrl+K`/right-click for the full action list.

Docket keeps `X`, Shift-click, Shift-J/K (Docket's own row-move keys, so Shift-arrow's Linear-parity extends naturally to Shift-J/K too) and `Esc`; the bottom action bar. Docket skips `Cmd/Ctrl+A` "select all" for v1 (small addition, but not requested) and reordering (Docket has no manual/custom ordering — DKT-28's display options may add one later). Docket routes bulk edits through fields that exist here: status, priority, assignee, delegate (Docket-specific — Linear has no delegate), labels, delete.

## Where things are today

- `src/web/issues.tsx:221-253` (`IssueList`) and `:332-392` (`Board`) — render each issue as `IssueRow`/`Card` with no selection state at all; `[data-nav]` (used by J/K focus) is the only per-row DOM hook that exists (`src/web/issues.tsx:297`, and doc rows in `src/web/docs.tsx:153`).
- `src/web/main.tsx:190-208` — the global keydown handler is where `X`/Shift-J/K/Esc-clear need to slot in, alongside the row-focus/single-key work from DKT-16; selection state has to live above both `IssueList` and `Board` (i.e. in `IssuesView`, `src/web/issues.tsx:43-89`), since the same selection must survive a List↔Board toggle.
- `src/web/issues.tsx:71-79` (`Patch`) — the existing single-issue optimistic-patch pattern (update local state, PATCH, toast+reload on failure) is the template for how bulk edits should feel, just fanned out.
- `src/web/trashActions.ts:5-13` (`deleteToTrash`) — the existing single-delete-with-undo-toast pattern; a bulk delete needs an equivalent that undoes the *whole batch* as one action (see Design).
- `src/shared/types.ts:266-268` (`IssuePatch`) and `src/server/tracker.ts:563-604` (`updateIssue`) — the single-issue update path already does everything a bulk edit needs per issue: field validation (`issueColumns`, `src/server/tracker.ts:341-355`), workspace/kind checks for assignee/delegate (`activeMemberId`, `src/server/access.ts:258-271`), `completed_at` bookkeeping, parent/blocker bump-and-publish, and a `changed("issue", workspace, id)` event (`src/server/tracker.ts:602-604`). There is no batch entry point — REST/MCP only ever update one issue.
- `src/server/db.ts` — `MIGRATIONS` is append-only (no schema change needed here: bulk edit touches no new columns).
- `test/parity.test.ts` and `test/claims.test.ts` show the harness pattern (`s.api`, `s.user`, `s.agent`, `s.as`) to follow for the new endpoint's tests.

## Design

### Server: one small bulk endpoint, sequential per-issue validation, not one giant transaction

Recommendation (the brief's open decision): add `POST /api/issues/bulk`, but implement it as a loop over the *existing*, already-correct `tracker.updateIssue`/`tracker.deleteIssue` per id — not a new hand-rolled bulk SQL transaction. Reasoning: Linear itself doesn't guarantee bulk edits are atomic across issues (a failure on one doesn't roll back the others you can already see update in its UI), each issue's validation is genuinely per-issue (different workspace membership rules could in principle apply, blockers/parent bumps differ per issue), and reusing `updateIssue`/`deleteIssue` verbatim means zero duplicated validation logic — the smallest thing that matches Linear's semantics, per CLAUDE.md's rule. Each call still gets its own IMMEDIATE transaction (as today), so no issue is left half-written; the "one transaction" the brief floats would only buy all-or-nothing across unrelated issues, which isn't a real product requirement and would make one bad id (e.g. a stale `baseUpdatedAt` you don't even want to send in bulk mode) fail the whole batch.

`src/shared/types.ts`:
```ts
export interface BulkPatch {
  ids: string[]; // 1–100 identifiers
  patch: Partial<Pick<IssuePatch, "status" | "priority" | "assignee" | "delegate" | "labels">> | { delete: true };
}
export interface BulkResult {
  id: string;
  issue?: Issue; // on success
  error?: string; // on failure (e.g. 404/403/400 for that one issue); the others still apply
}
```
(No `title`/`description`/`parent`/`blockedBy`/`baseUpdatedAt` in bulk `patch` — those aren't meaningful across a batch and match exactly the fields the brief's bulk action bar lists.)

`src/server/tracker.ts`, new function:
```ts
export function bulkUpdateIssues(a: Actor, ids: unknown, input: unknown): BulkResult[] {
  const list = checkBulkIds(ids); // 1–100, each a string
  const isDelete = typeof input === "object" && input !== null && (input as any).delete === true;
  return list.map((id) => {
    try {
      const issue = isDelete ? deleteIssue(a, id) : updateIssue(a, id, input as IssuePatch);
      return { id: issue.id, issue };
    } catch (e) {
      return { id, error: e instanceof AppError ? e.message : "Failed" };
    }
  });
}
```
Each `updateIssue`/`deleteIssue` call already publishes its own `changed` event and validates workspace/kind — nothing new to write there. Cap the batch at 100 ids (400 "Select at most 100 issues" above that) to keep one request bounded, matching the spirit of `first` capping at 500 for pagination.

`src/server/api.ts`:
```ts
"/api/issues/bulk": {
  POST: handle(async (req) => {
    const data = await body<{ ids: unknown; patch: unknown }>(req);
    return { results: tracker.bulkUpdateIssues(actorOf(req), data.ids, data.patch) };
  }, 200),
},
```
A read-scoped API key gets 403 here the same way it does on any other write (the existing scope check in `auth.ts`/`access.ts` — verify it's applied to the new route the same way as `/api/issues/:id` PATCH/DELETE).

No MCP tool: the brief allows "if it adds value" — an agent working through MCP already iterates issues one at a time via `update_issue` in a loop, which is simple and clear for an LLM caller (unlike a human clicking through a UI, an agent doesn't need a UI-batching affordance to be efficient); skip it for now (see Out of scope).

### Realtime

No new event type. Each per-issue `updateIssue`/`deleteIssue` call already calls `changed("issue", workspace, id)` (`src/server/tracker.ts:602-604`, `648-649` region) exactly as it does for a single-issue edit, so other clients see a burst of the same `ServerEvent`s they'd see from N individual edits — the existing coalescing in `src/web/main.tsx:70-102` (debounced refetch on any burst of events) already handles this without changes.

### UI: selection state and the action bar

`src/web/issues.tsx`, `IssuesView`:
- Add `const [selected, setSelected] = useState<Set<string>>(new Set())`, cleared on `[teamKey, workspace, q, label, assignee]` changes (new filter/team = new selection) and passed down to both `IssueList` and `Board`.
- `IssueRow`/`Card` gain a checkbox (shown on hover/focus, like Linear's left-edge checkbox, or always-visible at narrow widths for touch) wired to `toggle(id)`; clicking the row's checkbox never navigates (stop propagation), a plain row click still opens the issue.
- Keyboard (extends DKT-16's row-context work, same global handler): `X` toggles the focused row (from J/K's `moveFocus`); `Shift+J`/`Shift+K`/`Shift+ArrowDown`/`Shift+ArrowUp` extends the selection from the last-touched row to the next one; `Shift`+click extends from the last-clicked row; `Escape` clears the selection first if non-empty (before its existing "leave the page" behavior — check the precedence against `src/web/main.tsx:200-204`'s existing Escape handling, since clearing selection should win when both could apply).
- A new `<BulkBar>` component (new file `src/web/bulkbar.tsx` or inline in `issues.tsx`) renders fixed to the bottom of the content area when `selected.size > 0`: "N selected", a Clear (X) button, then pickers for Status/Priority/Assignee/Delegate/Labels (reuse `StatusPicker`/`PriorityPicker`/`AssigneePicker`/`DelegatePicker`/`LabelsPicker` from `src/web/pickers.tsx` — each already renders a trigger + popover; give them a neutral "set for all" value so nothing looks falsely selected) and a Delete icon button.
- Picking a value calls `api.bulkUpdate({ ids: [...selected], patch: { status: v } })` (new `api.ts` wrapper posting to `/api/issues/bulk`), applies each `BulkResult` optimistically to local state (success → merge; failure → toast naming the id and reason, per-issue, since one bad id shouldn't hide from the operator that N-1 succeeded), and does **not** clear the selection afterward (so a person can apply two properties in a row — set status, then priority — matching Linear's "apply several bulk actions before clearing").
- Delete: confirms via the existing `ask()` (`src/web/toast.tsx:92-95`, since deleting N issues at once is a bigger blast radius than one — unlike the single-issue delete, which is undo-only with no confirm) with wording like "Move 5 issues to trash?"; on confirm, calls the bulk endpoint with `{ delete: true }`, then shows **one** toast ("Moved 5 issues to trash", Undo) whose Undo calls `restoreIssue` for every id that succeeded (mirroring `trashToast`, `src/web/toast.tsx:30-31`, but batched).
- `Board`: selection and the same bar work identically; a card's checkbox sits in `.card-head` (`src/web/issues.tsx:419-424`).

## Acceptance criteria

- [ ] `X` toggles selection on the row/card with keyboard focus; a visible checkbox reflects it.
- [ ] Shift-click extends selection from the last-clicked row; Shift-J/K/Shift-arrows extend from the last-touched row.
- [ ] `Escape` clears an active selection (and only falls through to page navigation when nothing is selected).
- [ ] With ≥1 issue selected, a bottom bar shows the count and Status/Priority/Assignee/Delegate/Labels/Delete controls.
- [ ] Setting a property via the bar applies it to every selected issue; a failure on one issue (e.g. it was deleted by someone else meanwhile) toasts that issue's error without blocking the rest.
- [ ] Delete asks for confirmation once for the whole batch, then trashes all selected issues and shows one Undo toast that restores all of them.
- [ ] Selection is cleared when the filters/team/search change, and after a successful bulk delete.
- [ ] `POST /api/issues/bulk` requires a write-scoped credential (403 for a read key), 404s any id outside the caller's workspaces (same as single-issue routes), and rejects more than 100 ids (400).
- [ ] Realtime: another connected client sees the same live updates it would from N individual edits (no missed refresh).
- [ ] Works at phone width: the action bar is reachable and usable (may need to be a compact icon row rather than full labels below ~480px).

## Tests

New `test/bulk.test.ts` (or add to `test/parity.test.ts`), following the `s.api`/`s.user`/`s.agent` harness pattern:
- `POST /api/issues/bulk` with `{ ids: [a, b], patch: { status: "in_progress" } }` updates both and returns `{ results: [{id, issue}, {id, issue}] }`.
- Mixed success/failure: one id from another workspace (404-worthy) or already deleted (409-worthy) returns `{ id, error }` in its slot while the other ids still succeed — assert the successful ones actually changed.
- `{ patch: { delete: true } }` moves all ids to the trash; each is independently restorable.
- Read-scoped API key: 403.
- More than 100 ids: 400.
- `{ patch: { assignee: "nobody" } }` fails per-issue with the same message `updateIssue` already gives (`"assignee: nobody isn't ..."`/unknown username), not a 500.
- Realtime: a bulk update publishes one `changed` event per affected issue (assert via the `/ws` test helper the same way single-update tests do, if such a helper exists — check `test/server.ts` for the pattern).
- No migration test needed (no schema change).

## SPEC.md

- New REST table row: `POST /api/issues/bulk` — `{ ids, patch }` (patch: status/priority/assignee/delegate/labels, or `{ delete: true }`) → `{ results: [{ id, issue? , error? }] }`; capped at 100 ids.
- `## UI` — **List view**/**Board view** bullets: mention multi-select (`X`, Shift-click/Shift-J/K, `Esc` to clear) and the bulk action bar (status, priority, assignee, delegate, labels, delete), with delete confirming once for the whole batch (unlike single-issue delete, which doesn't confirm).

## Out of scope

- An MCP bulk tool — agents already loop `update_issue`/`claim_issue` calls one at a time, which is the clearer pattern for an LLM caller; revisit only if agents report it's a real bottleneck.
- `Cmd/Ctrl+A` select-all and manual reordering — not requested; Docket has no manual issue ordering to reorder within.
- Bulk parent/blockedBy/title/description edits — not meaningful in bulk and not in the brief's list.
- Wiring bulk actions into the DKT-15 command menu — a natural follow-up once both exist, left for a later issue.
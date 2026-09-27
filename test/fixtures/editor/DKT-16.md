## Why

Docket already lets you move focus across issue rows (J/K, arrows: `src/web/main.tsx:205-207`) but can't act on the focused row or the open issue without a mouse: no single-key status/priority/assignee/delegate/labels change, no keyboard delete, no navigation chords, and no discoverable list of what exists. Linear's speed reputation rests heavily on this; it's also the natural next step once DKT-13 has inventoried what's there and DKT-15 has given "everything else" a home in the command menu.

## Linear's behaviour

Search results consistently describe: `C` create, `S` status, `P` priority, `L` labels, `A` assignee, `I` assign to me, `X` select, `J`/`K` move, `?` help, and `G`-chords for navigation (`GI` inbox, `GM` my issues, `GT` triage, `GA` active, `GB` backlog, `GC` cycles, `GP` projects, `GS` settings) — https://fastshortcuts.com/shortcuts/linear/, corroborated by the changelog announcing the `?` shortcuts-help window (https://linear.app/changelog/2021-03-25-keyboard-shortcuts-help: "you can now press `?` to bring up the help window"). Linear also supports `⌘⌫`/`⌘Backspace`-style deletion with undo, consistent with Docket's own trash pattern.

Docket adds `D` for delegate — no Linear equivalent, since Docket splits assignee (person) and delegate (agent) where Linear has one assignee. `G` chords route to Docket's own destinations: Docket has no Inbox or Triage yet, so `GI` is reserved for DKT-14's "My Issues" inbox-like view once it exists (brief's wording) rather than bound to nothing; `GD` goes to docs (Docket's nearest thing to Linear's project/doc jumps) and `GS` to settings, matching Linear's mnemonic style.

## Where things are today

- `src/web/main.tsx:190-208` — the existing global handler, guarded by `!isEditable(e.target)` and no modifier keys, is where these should live; it already special-cases `route.view === "issues" || route.view === "docs"` for J/K, so the new bindings extend the same handler (or a sibling one) with a per-row/per-page dispatch.
- **Focused row vs. open issue** — there are two contexts to support: (1) an issue *row* has DOM focus after J/K navigation (`document.activeElement` is one of the `[data-nav]` elements set up by `moveFocus`, `src/web/main.tsx:372-380`), and (2) the issue *page* itself (`route.view === "issue"`, `src/web/issue.tsx`). Both need the same key set to act on "the current issue" — resolve "current issue" as: on the issue page, `issue.id`/the loaded `Issue`; on a list/board, the id of the focused `[data-nav]` element (add a `data-issue-id` attribute to `IssueRow`/`Card` in `src/web/issues.tsx:290-309, 394-435` so the handler can read it without threading extra state through every row).
- `src/web/pickers.tsx:245-308` — `StatusPicker`, `PriorityPicker`, `AssigneePicker`, `DelegatePicker`, `LabelsPicker` are the existing controls; each renders a trigger `<button>` plus a `<Picker>` popover. The cleanest way to make `S`/`P`/`A`/`D`/`L` "open the right picker" without duplicating picker logic is to find and `.click()` the corresponding trigger button for the current row/issue (e.g. `document.querySelector('[data-nav]:focus-within] .row-btn')` is fragile — better: give each picker trigger a stable `data-shortcut="status|priority|assignee|delegate|labels"` attribute on the relevant row/issue-page instances, and look it up scoped to the focused row or the issue page's `<Properties>`).
- `src/web/issue.tsx:163, 193, 201-213` — `claimable`, `claim()`, and the delete button (`remove`, wired to `deleteToTrash`) already implement "claim" (→ `I`, assign to me / claim) and "delete to trash with undo toast" (`src/web/trashActions.ts:5-13`, which already shows a `trashToast` with Undo — `⌘⌫` just needs to call the same `remove()`/`deleteToTrash` path that the existing trash icon button uses, both on the issue page and (new) from a focused list row).
- `src/web/issues.tsx:290-309` (`IssueRow`) has no delete action today at all (only the issue page does); adding `⌘⌫` on a focused row needs a row-level delete call (`api.deleteIssue`, same as `IssuePage`'s `remove`) wired through the same `Patch`/toast pattern the row already uses for `onPatch`.
- `src/web/hooks.ts:97-99` (`isEditable`) and `src/web/main.tsx:424-430` (the IME `stopImmediatePropagation` guard) — both must gate every new binding, exactly as they already gate `C`/`/`/J/K/Escape. This is the brief's explicit safety requirement and is already proven infrastructure; no new guard needs inventing.
- `src/web/routing.tsx:5-24` — `G`-chords need a two-key sequence (`G` then a second key within a short window); nothing like that exists yet (every current shortcut is single-key or has a modifier). This is the one genuinely new piece of keyboard infrastructure this issue adds.

## Design

### Chord infrastructure (new, small)

Add a tiny helper in `src/web/hooks.ts` (or inline in `main.tsx`, since it's only used there for now): track `lastKey`/`lastKeyAt` in a ref; on `G`, arm a 900ms window; if the next non-modifier key arrives within it, treat it as `G<key>` and consume both; otherwise let `G` alone fall through (Docket has no bare-`G` binding, so this is purely additive). Reset on `Escape` or any other key.

### List/board row and issue-page shortcuts

In the existing global handler (`src/web/main.tsx:190-208`), after the J/K block, add (still gated by `!isEditable`, no modifiers, no open popover/modal, not `defaultPrevented`):

| Key | Where | Action |
|---|---|---|
| `S` | focused row or issue page | Open the Status picker for the current issue |
| `P` | ″ | Open the Priority picker |
| `A` | ″ | Open the Assignee picker |
| `D` | ″ | Open the Delegate picker |
| `L` | ″ | Open the Labels picker |
| `I` | ″ | Claim / assign to me: on the issue page, same as clicking "Claim" (`src/web/issue.tsx:163`) when `claimable`; on a row, add the equivalent — `api.claimIssue(id)` then apply the result like `onPatch` does, toast on error |
| `⌘⌫` / `Ctrl⌫` | ″ | Delete to trash with undo — issue page: same as the existing trash button; row: new, mirrors `deleteToTrash` |
| `?` | anywhere (not editable) | Opens the shortcut help overlay |
| `G` then `I` | anywhere | Go to My Issues (`/my`, once DKT-14 ships; until then this chord is a no-op — don't bind it to "All issues", since that would need rebinding later and confuse users) |
| `G` then `D` | anywhere | Go to All docs (`/docs`) |
| `G` then `S` | anywhere | Go to Settings (`/settings/account`) |

Opening a picker programmatically: give each relevant trigger a `data-shortcut="status" | "priority" | "assignee" | "delegate" | "labels"` attribute (on `StatusPicker`/etc.'s rendered `<button>` — thread it through the existing `Trigger` prop type in `src/web/pickers.tsx:219` as an optional `shortcut?: string` mapped to `data-shortcut`), then resolve the trigger to click as: `(focused [data-nav] row ?? the issue page's <aside className="issue-props">) .querySelector('[data-shortcut="status"]')`. This reuses every existing picker's open/close/keyboard behavior verbatim — no new popover code.

`I` and `⌘⌫` call the same API functions the existing buttons call (`api.claimIssue`, `api.deleteIssue`) rather than duplicating them; on a list row, apply the optimistic-update/toast pattern already used by `Patch` (`src/web/issues.tsx:71-79`) so behavior matches editing any other row property.

### `?` help overlay

New file `src/web/shortcuts.tsx`: a simple `<Modal>`-based (or the same lightweight overlay `DKT-15` builds for the command menu — coordinate so there's only one "centered dialog" pattern, not two) static table grouped like DKT-13's SPEC.md section (Global, List/issue, Picker), rendered from a single shared constant so SPEC.md, this overlay, and any future command-menu "help" entry never drift independently. Triggered by `?` (guarded the same way as every other single-key shortcut) and closable with `Escape`/click-outside.

### No server changes

Every action here already exists as a REST/MCP-backed operation (`update_issue`/`PATCH /api/issues/:id`, `claim_issue`/`POST .../claim`, delete/`DELETE .../:id`). No schema, types.ts, REST, or MCP changes.

## Acceptance criteria

- [ ] With a row focused (after J/K) or on the issue page, `S`/`P`/`A`/`D`/`L` open the matching picker; picking a value behaves exactly as clicking the picker would.
- [ ] `I` claims the current issue (row or page) when claimable; a no-op (or a toast explaining why, matching the existing claim error handling) when it isn't.
- [ ] `⌘⌫`/`Ctrl⌫` moves the current issue to the trash and shows the existing Undo toast, from both a focused row and the issue page.
- [ ] `?` opens a help overlay listing every shortcut from DKT-13's table plus this issue's additions; `Escape` closes it.
- [ ] `G I` (no-op until DKT-14), `G D` → `/docs`, `G S` → `/settings/account`; a stray `G` followed by an unbound key, or followed by nothing within ~900ms, does nothing (no navigation, no error).
- [ ] None of the above fire while a text input/textarea/`contentEditable` is focused, inside an open popover/modal, or during IME composition (verified the same way the existing `C`/`/`/J-K bindings already are: `isEditable`, `.pop`/`.backdrop` check, the capture-phase IME guard at `src/web/main.tsx:424-430`).

## Tests

No UI test harness exists; this is a client-only change reusing already-tested server endpoints (claim, update, delete are covered by `test/claims.test.ts`, `test/parity.test.ts`, `test/mcp.test.ts`). No new `bun test` cases are required for the shortcuts themselves. Manually verify in `bun run dev`: each single key from a focused row and from the issue page; the chord timing (fast vs. slow second key); that typing `s`, `p`, etc. inside the description/comment/search fields never triggers anything; IME composition (a CJK input method, or simulate via `isComposing`) doesn't leak a stray Enter/Escape into these bindings.

## SPEC.md

- Extend DKT-13's "Keyboard" subsection (land after it, or merge in the same PR if convenient) with a "List and issue page" row group: `S/P/A/D/L`, `I`, `⌘⌫`, `?`, and the `G`-chords, matching the table above.
- `## UI`, **Issue page** bullet: mention the `?` help overlay and that properties are also settable by keyboard.

## Out of scope

- The `⌘K` command menu itself — DKT-15; this issue's `?` overlay is a separate, simpler static reference, not a fuzzy search.
- Multi-select (`X`, Shift-range) and bulk actions — DKT-17.
- `G A`/`G B`/`G T`/`G C`/`G P` (active/backlog/triage/cycles/projects) — Docket has no triage, cycles or projects; not applicable.
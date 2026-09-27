## Why

SPEC.md's UI section mentions shortcuts piecemeal (`C` for new issue, `⌘↵`, `E`, `/`) but never lists what's actually implemented: row navigation (J/K, arrows), picker navigation (Ctrl-n/p, Tab), or the IME/editable guard that makes all of this safe. An implementer picking up a future keyboard issue (like DKT-16 or DKT-15) has to read four files to find out what already exists and what convention to follow; a future contributor could easily add a shortcut that collides with one they didn't know about. This is a docs-only issue: no behaviour changes.

## Linear's behaviour

Linear documents its shortcuts in a dedicated keyboard-shortcuts reference (command menu, single-key shortcuts, G-chords) — see the shortcuts list surfaced by `?` in Linear's app. Docket has no `?` overlay yet (DKT-16 adds one); this issue is just about SPEC.md catching up to what's already shipped, as a foundation those later issues can extend rather than re-derive.

## Where things are today

Every keydown handler in the web app, grepped exhaustively (`grep -rn "onKeyDown\|useKeydown\|e.key ===" src/web`):

- **Global app shortcuts** — `src/web/main.tsx:190-208` (`useKeydown`, bubble phase, guarded by `!e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey && !modal && !isEditable(e.target)` and skipped while any `.pop`/`.backdrop` is open):
  - `C` / `c` — new issue (`app.newIssue()`)
  - `/` — focus search (`focusSearch()`, `src/web/main.tsx:364-369`, navigates to the last list view first if needed)
  - `Escape` — closes the mobile nav if open, else navigates from an issue/doc page back to `nav.lastList`/`nav.lastDocs`, else blurs the focused element
  - `J` / `K` / `ArrowDown` / `ArrowUp` (only when `route.view` is `"issues"` or `"docs"`) — `moveFocus(±1)` (`src/web/main.tsx:372-380`) moves focus across every `[data-nav]` element (issue rows/cards, doc rows) in DOM order, wrapping isn't implemented (clamped at the ends), and scrolls the target into view.
- **List/search header** — `src/web/components.tsx:277-289` (the `#search` input's own `onKeyDown`): `Escape` clears the query if non-empty, else blurs; `ArrowDown` or `Enter` moves focus to the first `[data-nav]` row.
- **Picker popovers** — `src/web/pickers.tsx:167-183` (the search input inside every `<Picker>`: status, priority, assignee, delegate, labels, parent, blocked-by, team, workspace switcher, account menu):
  - `ArrowDown` or `Ctrl+N` — move active option down
  - `ArrowUp` or `Ctrl+P` — move active option up
  - `Enter` (without ⌘/Ctrl) — pick the active option
  - `Escape` — close and refocus the trigger
  - `Tab` — close without refocusing (lets focus move to the next control normally)
- **Inline title editor** — `src/web/components.tsx:159-165` (`useInlineEdit`, used by issue and doc titles): `Enter` blurs (which saves), `Escape` reverts the draft and blurs.
- **Issue description editor** — `src/web/issue.tsx:325-333`: `⌘/Ctrl+Enter` saves, `Escape` cancels (discarding the draft).
- **Comment composer** — `src/web/comments.tsx:119-128` (shared by issue and doc comment threads): `⌘/Ctrl+Enter` sends (or saves, when editing), `Escape` cancels an edit or blurs the composer.
- **Doc page** — `src/web/docs.tsx:224-236` (`useKeydown(..., capture = true)`, so it runs before the global handler's `Escape`; guarded the same way as the global handler): `E` / `e` enters edit mode (when a doc is loaded and not already editing); `Escape` exits edit mode (confirming discard if there are unsaved conflicted changes, `stopEdit`), closes the version preview, or closes the history panel — whichever is open, in that priority order.
- **Doc markdown editor** — `src/web/docs.tsx:769-777`: `⌘/Ctrl+S` saves immediately (bypassing the ~1s autosave debounce); `Escape` exits edit mode via `onExit` (`stopEdit`).
- **Generic modal** — `src/web/modal.tsx:44-63` (`<Modal>`, used by New Issue/Doc/Team/Workspace and Team Settings): `Escape` closes; `⌘/Ctrl+Enter` calls `onSubmit`; `Tab`/`Shift+Tab` traps focus within the dialog (cycles from last focusable back to first and vice versa).
- **Modal text fields** — `src/web/modals.tsx:107-113` and `:200-206`: plain `Enter` (without ⌘/Ctrl) submits certain single-line fields (e.g. a team key input) directly, in addition to the modal's own `⌘Enter`.
- **IME guard** — `src/web/main.tsx:424-430`: a capture-phase `window` listener calls `e.stopImmediatePropagation()` whenever `e.isComposing || e.keyCode === 229`, so no shortcut above ever fires on a keystroke that's really an IME composing Enter/Escape (e.g. confirming Japanese/Chinese input). Added in commit d0a10e4; any new shortcut work must keep relying on this guard rather than re-implementing IME detection.
- **The `isEditable` guard** — `src/web/hooks.ts:97-99`: used by every global-ish handler above to skip inputs, textareas and `contentEditable` elements, so single-key shortcuts (`C`, `/`, `J/K`, `E`) never fire while typing.
- **Chat dock** (`src/web/chat.tsx:38, 199-200, 288-289, 473-475`) has its own Escape/Enter handling, but the chat panel isn't part of SPEC's UI section (it's documented under "Assistant proxy" in Access) — out of scope for this pass; a future chat-focused issue should fold it in if the chat dock ever gets its own SPEC.md UI subsection.

## Design

Add a **"Keyboard"** subsection to SPEC.md's `## UI` section, placed after the existing bullet list (before `## Documents`), structured as a compact table plus a short paragraph of rules. Suggested wording (adapt to match SPEC's terse style):

```markdown
### Keyboard

Global (not while typing in a field, in a popover, or during IME composition):

| Key | Action |
|---|---|
| `C` | New issue |
| `/` | Focus search |
| `J` / `K` / `↓` / `↑` | Move focus between rows or cards (issues and docs lists) |
| `Esc` | Close the mobile nav, or leave an issue/doc page for the last list |

In a popover picker (status, priority, assignee, delegate, labels, parent, blocked by, team, workspace, account menu):

| Key | Action |
|---|---|
| `↓` / `Ctrl-N` | Next option |
| `↑` / `Ctrl-P` | Previous option |
| `Enter` | Pick |
| `Esc` | Close |
| `Tab` | Close and move on |

Elsewhere: `⌘/Ctrl-Enter` saves or sends (description, comments, modals); `Esc` cancels an edit or closes a modal/dialog (which also traps `Tab`); `E` opens a doc for editing, and inside it `⌘/Ctrl-S` saves immediately. Keys typed during IME composition (e.g. confirming Japanese/Chinese input) are never treated as shortcuts.
```

No code changes. No types.ts, REST, or MCP changes.

## Acceptance criteria

- [ ] SPEC.md's `## UI` section has a "Keyboard" subsection covering every shortcut listed above (global, picker, and the save/cancel/edit conventions), matching the actual implementation exactly (re-verify each `file:line` at merge time in case another issue landed first).
- [ ] The existing scattered mentions (`C` at SPEC.md:171/177, `⌘↵` at SPEC.md:176/177, `E` at SPEC.md:215) are left as inline references (they read naturally in context) but don't contradict the new subsection.
- [ ] No behavioural drift: this issue changes no `src/` file.

## Tests

None — documentation only. `bun test` and `bun run typecheck` should pass unchanged (nothing to break).

## SPEC.md

Add the "Keyboard" subsection under `## UI` as drafted above, after the bulleted list and before `## Documents`.

## Out of scope

- Adding a `?` shortcut-help overlay — that's DKT-16, which should read this issue's table as its source list and extend it with single-key issue shortcuts (S/P/A/D/L/I/⌘⌫/G-chords).
- ⌘K command menu shortcuts — DKT-15.
- Documenting the chat dock's shortcuts — chat isn't in SPEC's UI section today.
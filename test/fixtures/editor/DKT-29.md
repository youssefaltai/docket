## Why

Docket's descriptions, comments and docs are all plain `<textarea>`s that write and read raw markdown. That's simple and exactly matches the source-of-truth model (agents write markdown via MCP, so the wire format must always be markdown), but it means no live formatting feedback, no slash-menu for headings/lists/tables, and typing `**bold**` shows literal asterisks until you toggle to reading mode. Linear's editor is rich-text over a markdown-compatible model. Before anyone builds this, Docket needs one decision: keep textareas, or move to something richer — and if richer, which of the two dependency-free shapes.

## Linear's behaviour

https://linear.app/docs/editor: "Type in Markdown or paste it directly and it will be converted into rich text automatically" — bidirectional markdown↔rich-text conversion; formatting via keyboard shortcuts (⌘B/⌘I/⌘K), a `/` slash menu (`/code`, `/table`, `/diagram`, …), and a floating toolbar on text selection; supports headings, lists (including checklists), tables, code blocks, diagrams, collapsible sections, dividers, `:emoji:`, `@mentions`, and auto-embeds for links.

Docket should not fully match this: markdown is the explicit source of truth (SPEC.md's Documents section: "Markdown is the source of truth (agents write via MCP)"), so whatever ships must still be markdown in, markdown out — an agent's `create_issue`/`update_document` call and a person's edit must never diverge in what they produce. Diagrams, emoji shortcodes and auto-embeds are Linear extras with no Docket need today (`marked`, Docket's one markdown dependency, doesn't render Mermaid or embeds anyway) — out of scope regardless of which path is chosen.

## What the current editor does (so nothing regresses)

- **Issue description** (`src/web/issue.tsx:254-380`, `Description`): inline-toggle between a read view (`Markdown` render + an edit pencil button) and a `<textarea>`. `⌘/Ctrl+Enter` saves, `Escape` cancels. Saves send `baseUpdatedAt`; a 409 either silently re-saves on top (if only something unrelated, like a comment, changed) or shows a conflict banner with the other version and "Use theirs"/"Keep mine" (`:290-313`). No autosave — an explicit Save button, disabled while `saving` or `conflict`. `dir="auto"` on the textarea.
- **Comments** (`src/web/comments.tsx:85-142`, `Composer`, shared by issues and docs): a small auto-resizing (`useAutosize`) textarea, `⌘/Ctrl+Enter` sends, `Escape` cancels/blurs. No autosave, no conflict handling (comments don't carry `baseUpdatedAt` — SPEC.md: "doc comments never bump the doc"). Edit mode reuses the same `Composer` with `initial`/`onCancel`.
- **Doc content** (`src/web/docs.tsx:599-781`, `DocEditor`): a full-height auto-growing textarea. Autosave ~1s after typing stops (`change` → `setTimeout(save, 1000)`, `:681-688`), `⌘/Ctrl+S` saves immediately bypassing the debounce, `Escape` exits edit mode (confirming discard only if there's an unsaved *conflicted* draft, via `stopEdit`/`ask()`). Tracks `base`/`echo`/`inflight`/`baseUpdatedAt` to detect a genuine remote change vs. a benign echo of its own save (`:624-679`); on a real external change, blocks autosave and shows a banner ("Updated by X" — Reload / Keep mine, `:744-759`) rather than silently overwriting. `beforeunload` warns on unsaved changes and best-effort saves on unmount (`:706-718`). Scroll-position preservation when opening/growing (`:720-740`).
- **All three**: `dir="auto""` (Arabic-friendly), IME composition never leaks into `⌘Enter`/Escape (the capture-phase guard, `src/web/main.tsx:424-430`), and rendering (read mode) goes through the shared `Markdown` component (`src/web/markdown.tsx`, backed by `marked`), which is also what turns bare `BRD-12`-style identifiers into linked chips and resolves `/doc/:slug`, `/issue/:id` links client-side (SPEC.md's "Everywhere markdown renders" bullet).

Whatever this issue's follow-up implements must preserve every one of these behaviours: `⌘S`/`⌘↵` save semantics, autosave timing and its conflict banner, the description's 409/"Use theirs"/"Keep mine" flow, IME safety, and `dir="auto"`.

## The two dependency-free paths

Docket takes no dependency beyond `react`, `react-dom`, `marked`, `zod`, `@modelcontextprotocol/sdk` (CLAUDE.md, CONTRIBUTING.md). Both options below add zero packages.

### Option A — `contentEditable` with markdown round-trip

A `div[contentEditable]` that parses markdown to DOM on load (reusing `marked`, which already parses markdown → HTML for the read view) and serializes DOM back to markdown on save/blur (a new, hand-written serializer — the hard part: HTML→markdown is not something `marked` does, and browser `contentEditable` DOM shapes are notoriously inconsistent across browsers for pasted content, undo history, and nested lists). Gets: real bold/italic/heading rendering while typing, native cursor/selection/undo. Loses: predictable serialization (every edge case — nested lists, code blocks, a pasted table — needs its own DOM→markdown rule, and `contentEditable`'s DOM mutations are famously hard to control precisely, e.g. browsers disagree on what `Enter` inside a list produces). This is the shape of Linear's own editor (it's ProseMirror-based, i.e. exactly "structured document with a markdown import/export boundary"), but Linear built that with a rich-text framework; Docket would be hand-rolling the same problem with none of that framework's edge-case handling.

### Option B — live-preview textarea with a formatting toolbar and `/` menu

Keep the `<textarea>` as the single source of truth (no serialization step, ever — what's typed *is* the markdown, byte for byte), and layer three additive pieces of UI:
1. A **toolbar** (bold/italic/link/list/code, shown above or floating near a selection) that inserts/wraps markdown syntax at the cursor/selection (`textarea.setRangeText`-based — a handful of small, well-understood string operations, not DOM manipulation).
2. A **`/` menu**: typing `/` at the start of a line opens a small popover (reusing the existing `<Picker>`-style list/keyboard-nav pattern from `src/web/pickers.tsx`) offering heading/list/checklist/code-block/table snippets, which insert their markdown template at the cursor.
3. Optionally, a **live split or inline preview** — either a side-by-side rendered pane (more screen real estate, but doubles the reading column width, which conflicts with the doc page's centered ~720px reading-width design, SPEC.md's Documents UI section) or leave read/edit as the existing toggle (simplest, zero layout change, matches how the description and doc editors already work: read view ⇄ edit view, not simultaneous).

Gets: zero serialization risk (markdown in is markdown out, always, byte-identical to typing it by hand — an agent's and a person's edits are provably the same format, which matters a lot given MCP is the primary write path for descriptions), trivial to keep every existing behaviour above (autosave, `baseUpdatedAt`, conflict banners, IME guard — none of that code needs to change, since it all operates on the textarea's string value already). Loses: no true WYSIWYG — you still see `**bold**` while typing, just with easier ways to produce it and a `/` menu for structure.

## Recommendation

**Option B.** The decisive factor is the source-of-truth rule: "Markdown is the source of truth (agents write markdown via MCP)" isn't just true for docs, it's true for issue descriptions and comments too (MCP's `create_issue`/`update_issue`/`comment_issue` all take a markdown string), and Option A introduces a lossy round-trip exactly at the boundary that matters most — a person editing what an agent wrote (or vice versa) must never see their formatting subtly reshaped by a serializer's edge cases. Option B also reuses more of what already exists (the `<Picker>` list pattern for the `/` menu, `marked` unchanged, every autosave/conflict/IME mechanism untouched) and is a much smaller, more predictable implementation — closer to "nano" than hand-rolling a markdown-aware `contentEditable` engine. The toolbar and `/` menu can ship incrementally (toolbar first, `/` menu after) and either can be dropped without touching storage or the save pipeline, since both are purely textarea-cursor operations.

### Open question

Should the toolbar/`/`-menu ship for all three surfaces (description, comments, docs) at once, or docs first (longest-form, most benefit) with comments/description following once the pattern is proven? Recommended answer: **docs first**. Comments are short and rarely need headings/tables; the description editor is the second priority; a shared `<MarkdownToolbar>`/`<SlashMenu>` component pair (built once, reused by whichever surface adopts it next) keeps this from becoming three separate implementations.

## Design (for the implementing issue, once this decision is accepted)

This issue is the decision record; a follow-up issue does the work. It should:
- Extract a shared `useMarkdownToolbar(ref: RefObject<HTMLTextAreaElement>)` hook (selection-wrap/insert helpers) and a `<SlashMenu>` popover reusing `<Picker>`'s list/keyboard internals (same reuse note as DKT-15's command menu — by the time this lands, there may already be a shared "searchable popover list" extraction worth factoring out of `<Picker>` for both).
- Touch `src/web/docs.tsx` (`DocEditor`) first, then `src/web/issue.tsx` (`Description`) and `src/web/comments.tsx` (`Composer`) — each already isolates its textarea behind a small component, so the toolbar/menu can be added as siblings inside each without touching save/autosave/conflict logic.
- No schema, types.ts, REST, or MCP changes — the wire format doesn't change at all; this is presentation-only.

## Acceptance criteria (for this decision issue)

- [ ] Team agrees on Option B (or documents why Option A was chosen instead) before any implementation issue is opened.
- [ ] The open question above (docs-first vs. all-three-at-once) is resolved in the follow-up issue's design.

## Tests

None — this issue makes no code change.

## SPEC.md

No change yet. The follow-up implementation issue should update the Documents UI section ("Editing: `E` or the Edit button…") and the Issue page bullet to mention the toolbar/slash menu once built.

## Out of scope

- Any implementation — this issue is the decision only.
- Diagrams, emoji shortcodes, auto-embeds, collapsible sections — Linear extras with no current Docket need and no dependency-free path via `marked`.
- Real-time collaborative editing (multiple cursors) — unrelated to this decision; Docket's conflict model (409 + banner) stays as-is either way.
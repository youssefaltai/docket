## Why

Acknowledging a comment ("seen", "agreed", "thanks") takes a whole new comment today, which bumps the issue and adds noise. Linear has emoji reactions for this. They're also a cheap signal for agents: an agent can react 👀 to show it picked up a request without writing a comment.

## Linear's behaviour

- "You can add emoji reactions to issues, comments, project updates, and initiative updates. All official Unicode emojis are available by default." Reactions on "the issue description itself, or on individual comments or threads": https://linear.app/docs/comment-on-issues
- Type `:` + a name to insert an emoji (`:+1:`) in the editor: https://linear.app/docs/editor

**Deliberate differences.** No custom emoji uploads. The picker offers a short set of common emoji plus a field that accepts any single emoji (typed, pasted or from the OS picker); no `:shortcode:` search. Reactions don't notify anyone and don't bump `updatedAt` (so they never cause `baseUpdatedAt` conflicts). Document bodies get no reactions (Linear doesn't list them), doc comments do.

## Where things are today

- `src/server/tracker.ts:81-103` `COMMENTS` and `listComments` (both comment tables), `136-139` `deleteComment`, `476-502` `getIssue`, `887-895` `getDocument`, `717-727` / `968-973` the comment-change wrappers (issue changes bump `updated_at`; doc ones don't).
- `src/shared/types.ts:178-184` `Comment`, `191-198` `Issue`.
- `src/server/api.ts:162-183` issue and comment routes, `213-226` doc comment routes.
- `src/server/mcp.ts:83-86` `commentsSection` (comment headers), `66-81` `details`, `89-97` `commentOn` (issue-or-document routing), `496-500` `commentTarget`.
- `src/web/comments.tsx:42-82` `CommentItem`; `src/web/issue.tsx:372-379` the rendered description; `src/web/pickers.tsx` has the popover/`Picker` primitives.

## Design

### Rules that apply
Linear's features, nano implementation, no dependencies (no emoji data package). Append the next migration (additive) + survival test. SPEC.md and types.ts in the same branch. REST/MCP/UI parity. Authors are never sent by clients: a reaction is always the caller's. Outside your workspaces 404; trashed issues/docs are read-only (409). Every change publishes `changed`. `dir="auto"` where names show. Branch `feature/reactions`; tests/typecheck pass; merge, delete branch.

### Schema (append the next migration)
```sql
CREATE TABLE reactions (
  target TEXT NOT NULL,   -- 'issue:<id>' (the description), 'comment:<id>', 'document_comment:<id>'
  user_id INTEGER NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's on (purge cascades)
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's on
  created_at TEXT NOT NULL,
  PRIMARY KEY (target, user_id, emoji)
);
```
(`target` uses the same `<kind>:<id>` convention as DKT-10's `mentions.source`.)

### Contract (`types.ts`)
```ts
export interface Reaction { emoji: string; users: UserRef[] } // users in the order they reacted
// Comment gains: reactions: Reaction[]   (emoji ordered by first reaction)
// Issue gains:   reactions: Reaction[]   (on the description)
```

### Validation
One emoji: after trimming, exactly one grapheme (`Intl.Segmenter`) that contains a `\p{Extended_Pictographic}` or `\p{Regional_Indicator}` code point or is a keycap (`^[#*0-9]️?⃣$`), at most 32 UTF-16 units. Else 400 `emoji must be a single emoji, e.g. 👍`. Stored as sent (NFC). At most 20 distinct emoji per target (409 beyond).

### Server (`tracker.ts`)
- `listReactions(targets: string[]): Map<string, Reaction[]>`: one query for all targets of an issue or doc; `listComments` and `getIssue` attach them.
- `react(a, target, owner, emoji, on: boolean)`: `INSERT OR IGNORE` / `DELETE` your own row; idempotent both ways. The comment must belong to the given issue/doc (404 otherwise); live issue/doc only (409 in the trash). No `updated_at` bump; publish `changed("issue" | "document", …)`.
- `deleteComment` also deletes `reactions` with `target = 'comment:<id>'` / `'document_comment:<id>'`.

### REST (emoji URL-encoded in the path; Bun decodes route params)
| Method | Path | Returns |
|---|---|---|
| PUT / DELETE | /api/issues/:id/reactions/:emoji | `Issue` |
| PUT / DELETE | /api/issues/:id/comments/:cid/reactions/:emoji | `Issue` |
| PUT / DELETE | /api/documents/:slug/comments/:cid/reactions/:emoji | `Document` |

PUT and DELETE aren't CORS-simple, and cookie writes need our Origin, so no body is needed.

### MCP
- `react`: `issue?` or `document?` (exactly one, via `commentOn`), `comment?` (required for a document), `emoji`, `remove?` (default false). "Add (or with remove, take back) your emoji reaction on an issue's description or on a comment, e.g. 👀 to show you've picked up a request, 👍 to agree. It doesn't notify anyone; use a comment for anything that needs an answer."
- `commentsSection` appends reactions to a comment's header: `**@ana** · #12 · 2026-… · 👍 2 🎉 1`; `details` adds `Reactions: 👀 1 (@claude)` under the description when there are any. Structured content carries the users.

### UI
- A `Reactions` component in `comments.tsx`: pills `👍 2` under a comment's body and under the issue description (`issue.tsx`), highlighted when yours; click toggles yours; hover title lists names ("Ana, Claude"). An "Add reaction" smiley icon button (shown on hover, always on touch) opens a small popover: a grid of 16 common emoji (👍 👎 😄 🎉 😕 ❤️ 🚀 👀 ✅ ❌ 🔥 💯 🙏 🤔 👏 ⏳) and an input that accepts any one emoji (Enter adds it). Keyboard: arrows move in the grid, Enter picks, Esc closes. Optimistic toggle, reconciled with the returned Issue/Document.
- Doc comments get the same pills (docs pass the doc routes in `CommentActions`).
- Reactions never load images: emoji are text.

### Interaction with DKT-3
Nothing: reactions hang off issue/comment ids and user ids.

## Acceptance criteria

- [ ] People and agents can add and remove their own reactions on the issue description, issue comments and doc comments; the same emoji twice is still one.
- [ ] Counts and who reacted show on the page and in get_issue/get_document; they update live for other viewers.
- [ ] Invalid emoji (text, two emoji) are 400; trashed targets 409; other workspaces 404; a comment id from another issue 404.
- [ ] Reacting doesn't change `updatedAt` and notifies no one.

## Tests

`test/reactions.test.ts` (new):
- ana `PUT /api/issues/RX-1/comments/<cid>/reactions/👍` → that comment's `reactions: [{ emoji: "👍", users: [ana] }]`; again → unchanged; bob adds 👍 → users [ana, bob]; ana `DELETE` → [bob].
- description: `PUT /api/issues/RX-1/reactions/🎉` → `issue.reactions`; `updatedAt` unchanged.
- valid: `👍🏽`, `👨‍👩‍👧`, `🇸🇦`, `1️⃣`; invalid: `abc`, `a`, `👍👍`, `a👍` → 400.
- comment id of another issue → 404; trashed issue → 409; a member of another workspace → 404; read-only key → 403.
- doc comment reactions via `/api/documents/<slug>/comments/<cid>/reactions/✅`.
- deleting a comment removes its reactions (`bun:sqlite` count, like `test/parity.test.ts:66`).
- MCP: agent `react { issue, comment, emoji: "👀" }` → get_issue header contains `👀 1`; `remove: true` takes it back.
- realtime: another member's socket receives `changed issue`.

`test/migrations.test.ts`: frozen pre-migration fixture survives; old comments return `reactions: []`.

## SPEC.md

- **Data**: `reactions` (targets, validation, cap, no bump, not notified).
- **REST**: the three PUT/DELETE routes; `Comment.reactions`, `Issue.reactions`.
- **MCP**: `react`; how get_issue shows reactions.
- **UI**: reaction pills and picker on comments and the description.

## Out of scope

- Reaction notifications or webhooks (DKT-11, DKT-12), custom emoji, `:shortcode:` search, reactions on document bodies.
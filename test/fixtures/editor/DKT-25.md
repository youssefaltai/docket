## Why

Every comment is top-level, so a question and its answers get separated by unrelated updates, and there's no way to say "this is settled". On issues where agents post many progress notes, discussions become hard to follow. Linear threads replies under a comment and lets you resolve a thread; agents need to reply in a thread too.

## Linear's behaviour

https://linear.app/docs/comment-on-issues:
- "All users with access to an issue can post comments and threaded replies." Hover a comment → "Reply to comment"; if a thread exists, write in the box at the bottom of the thread.
- "Mark a thread as resolved through the overflow menu on the root message"; resolving from a particular reply exposes that reply.
- Emoji reactions work on comments and threads.

**Deliberate differences.** One level of threading (replies to a reply join its thread). Anyone who can comment can resolve or reopen a thread (Linear doesn't document a restriction). A new reply reopens a resolved thread, so a follow-up question is never hidden. No "resolve from a reply". A root comment that has replies can't be deleted (409; edit it instead), so nobody's replies disappear with it.

## Where things are today

- `src/server/db.ts:125-133` `comments` and `162-170` `document_comments` tables (no parent, no resolution).
- `src/server/tracker.ts:81-139` the shared comment helpers for both tables: `listComments` (88-103, ordered by id), `insertComment` (105-113), `ownComment` (116-129, author-only), `updateComment`, `deleteComment`; wrappers `changeIssueComments` (717-727, bumps the issue) and `changeDocumentComments` (968-973, doesn't bump the doc); exports at 729-736 and 975-982.
- `src/server/api.ts:175-183` issue comment routes (POST passes only `body`, 176), `213-226` doc comment routes.
- `src/server/mcp.ts:83-86` `commentsSection`, `387-398` `comment_issue`, `483-494` `comment_document`, `89-97` `commentOn`, `496-544` comment target + update/delete tools.
- `src/shared/types.ts:178-184` `Comment`.
- `src/web/comments.tsx:11-15` `CommentActions`, `18-40` `Comments` (flat list), `42-82` `CommentItem` (Edit/Delete for your own), `85-142` `Composer`; callers `src/web/issue.tsx:150-154` and `src/web/docs.tsx:440-447`; timeline CSS `src/web/styles.css:1096-1177`.

## Design

### Rules that apply
Linear's features, nano implementation, no dependencies. Append the next migration (additive) + survival test. SPEC.md and types.ts in the same branch. REST/MCP/UI parity; MCP descriptions explain threads. Only the author edits or deletes a comment; resolving is open to every member. Authors are never sent by clients. Outside your workspaces 404; trashed issues/docs 409. Every change publishes `changed`. Branch `feature/comment-threads`; tests/typecheck pass; merge, delete branch.

### Schema (append the next migration)
```sql
ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
ALTER TABLE comments ADD COLUMN resolved_at TEXT;
ALTER TABLE comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE;
ALTER TABLE document_comments ADD COLUMN resolved_at TEXT;
ALTER TABLE document_comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
```
(SQLite allows `ADD COLUMN … REFERENCES` with a NULL default. Existing comments become thread roots.)

### Contract (`types.ts`)
```ts
// Comment gains:
parent: number | null;       // the thread's root comment id; null for a root
resolvedAt: string | null;   // roots only: the thread was resolved then
resolvedBy: UserRef | null;
```
`Issue.comments` / `Document.comments` stay one flat list ordered by id; clients group by `parent`.

### Server (`tracker.ts`)
- `insertComment(…, parent?)`: `parent` must be a comment on the same issue/doc (404 `Comment N not found` otherwise); a reply's id resolves to its root. Inserting a reply clears the root's `resolved_at`/`resolved_by_id` (reopens it).
- `resolveThread(a, owner, ownerId, commentId, resolved: boolean)`: any member; the comment must be a root (400 "Resolve a thread from its first comment"); sets or clears `resolved_at`/`resolved_by_id`; idempotent. Runs through `changeIssueComments` / `changeDocumentComments` like edits (issues bump, docs don't).
- `deleteComment`: a root with replies → 409 "This comment has replies; edit it instead". Replies delete normally.
- `listComments` selects `parent_id`, `resolved_at` and the resolver's `UserRef`.
- With DKT-11 in: replies notify subscribers like any comment (`commented`); nothing thread-specific.

### REST
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/issues/:id/comments | `{ body, parent? }` | 201 `Issue` |
| POST | /api/documents/:slug/comments | `{ body, parent? }` | 201 `Document` |
| PUT / DELETE | /api/issues/:id/comments/:cid/resolved | | `Issue` (resolve / reopen) |
| PUT / DELETE | /api/documents/:slug/comments/:cid/resolved | | `Document` |

### MCP
- `comment_issue` and `comment_document` gain `parent?: number` — "Reply in the thread of comment #N (ids are shown in get_issue/get_document). Reply to the comment you're answering rather than starting a new one; replying reopens a resolved thread." Their descriptions add: "Comments are threaded: top-level comments start threads, replies go under them."
- New `resolve_thread`: `issue?` or `document?` (exactly one, `commentOn`), `comment` (the thread's first comment), `resolved?` (default true). "Mark a comment thread resolved (the question is answered or the decision made), or reopen it with resolved: false. Anyone can."
- `commentsSection` renders threads: each root as today, its replies indented with `↳ **@b** · #13 · time`; a resolved thread shows only the root header plus `· resolved by @x · N replies` (bodies hidden; they're in `structuredContent`).

### UI (`comments.tsx`)
- `Comments` groups replies under their root (roots in time order; with DKT-9 in, a thread sits in the timeline at its root's time). Replies indent with a left rule.
- Every comment gets a Reply icon button (hover; always visible on touch) that opens a Composer at the end of its thread ("Reply…", `⌘↵` sends, Esc cancels). The root's actions add "Resolve thread" (check icon) for everyone.
- A resolved thread collapses to one line: check icon, "Resolved by Ana · 3 replies", and "Show"; expanded, the root offers "Reopen".
- `CommentActions` gains `reply(parent, body)` and `resolve(id, resolved)`; `issue.tsx` and `docs.tsx` wire them to new `api.ts` calls. `dir="auto"` on bodies and names, as now.

### Interaction with DKT-3
None: threads are comment ids within one issue or doc.

## Acceptance criteria

- [ ] Replying (UI, REST, MCP) puts the comment under its thread; a reply to a reply joins the same thread; a parent from another issue/doc is 404.
- [ ] Anyone can resolve and reopen a thread; resolving a reply is 400; a new reply reopens it.
- [ ] Resolved threads are collapsed in the UI and in get_issue; open threads show fully.
- [ ] Deleting a root that has replies is 409; deleting a reply works; only authors edit or delete.
- [ ] Works the same for doc comments; existing comments are roots after the migration.

## Tests

`test/threads.test.ts` (new):
- ana comments; bob replies with `parent` → `parent` = root id; claude (agent) replies to bob's reply over MCP `comment_issue { parent }` → `parent` = root id.
- `parent` of a comment on another issue → 404; `parent` on a doc comment id via the issue route → 404.
- bob `PUT …/comments/<root>/resolved` → `resolvedAt`, `resolvedBy.username: "bob"`; on a reply → 400; `DELETE …/resolved` reopens; resolve, then ana replies → reopened.
- ana deletes her root with replies → 409; bob deletes his reply → 200; claude can't edit bob's reply → 403.
- MCP `resolve_thread`, and get_issue shows `↳` for replies and `resolved by @bob · 2 replies` for a resolved thread.
- the same for a doc: reply and resolve via `/api/documents/<slug>/comments`; doc `updatedAt` unchanged.
- trashed issue → reply 409; outsider → 404.

`test/migrations.test.ts`: frozen pre-migration fixture with issue and doc comments → after upgrade they have `parent: null`, `resolvedAt: null` and can be replied to.

## SPEC.md

- **Data**: comment columns `parent_id`, `resolved_at`, `resolved_by_id`; one-level threads, reopen on reply, delete rule.
- **REST**: `parent` on POST comments; the `resolved` PUT/DELETE routes; `Comment` fields.
- **MCP**: `parent` on the comment tools, `resolve_thread`, threaded rendering.
- **UI**: reply, resolve/reopen, collapsed resolved threads.

## Out of scope

- Resolving from a reply, inline comments on description text (Linear's ⌘⌥M), AI thread summaries, per-thread subscriptions (DKT-11 subscribes per issue/doc), reactions (DKT-35).
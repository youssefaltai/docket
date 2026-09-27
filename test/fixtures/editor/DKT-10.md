## Why

There's no way to pull someone into an issue or doc: writing `@ana` is plain text, and nobody learns they were named. Agents especially need this: mentioning an agent is how a person asks it for help in place. This issue makes `@username` a real, stored mention with chips and autocomplete; the inbox (DKT-11) and webhooks (DKT-12) act on the stored mentions.

## Linear's behaviour

- Type `@` in a description or comment to mention a user; mentioning someone "will send a notification to their Inbox and subscribe them to the issue": https://linear.app/docs/editor
- Mentions work in documents and their comments too: https://linear.app/docs/issue-documents
- Agents are app users that can be mentioned ("app:mentionable"), which triggers them: https://linear.app/developers/agents , https://linear.app/docs/agents-in-linear

**Deliberate difference.** Linear's editor stores mentions as structured nodes. Docket's source of truth is markdown (agents write it over MCP), so a mention is the plain text `@username`, resolved on save against the workspace's active members.

## Where things are today

- `src/server/tracker.ts:105-113` `insertComment` (returns nothing), `131-134` `updateComment`, `136-139` `deleteComment`; `717-727` `changeIssueComments` (one transaction); `968-973` `changeDocumentComments` (**no transaction**).
- `src/server/tracker.ts:864-877` `saveRefs`: the pattern to copy (recompute references from content on every save).
- Description writes: `createIssue` 510-561 (insert at 539-541), `updateIssue` 563-607 (transaction 593-602). Doc content: `createDocument` 897-917, `updateDocument` 919-952 (transaction 944-949).
- `src/web/markdown.tsx:57-73` the `issueRef` marked extension (chips for identifiers); `102-128` `Markdown` (reads `useApp()`); `src/web/context.ts:14-15` `members` of the current workspace.
- Textareas that write markdown: `src/web/comments.tsx:110-129` (Composer), `src/web/issue.tsx:318-334` (description), `src/web/docs.tsx:760-778` (DocEditor, autosaves ~1 s after typing, 681-688), `src/web/modals.tsx:114` (new issue description).
- `src/server/mcp.ts:23-29` INSTRUCTIONS; `42-47` shared `docContent`/`description` schemas; comment bodies at 392 and 488.

## Design

### Rules that apply
Linear's features, nano implementation, no new dependencies. Append the next migration (additive) with a migration-survival test. SPEC.md and types.ts in the same branch. REST/MCP/UI parity. Workspace isolation: only active members of the text's own workspace can be mentioned. Rendered markdown must never load remote resources: chips are plain text elements, no avatars or images. `dir="auto"` on user text. Branch `feature/mentions`; tests and typecheck pass; merge, delete branch.

### Syntax
`@username` where username is `[a-z0-9][a-z0-9._-]{1,31}` (case-insensitive), not preceded by a letter, digit, `_ . @ / + -` (so `bob@example.com` and `https://x.com/@ana` aren't mentions), outside fenced/inline code. If the full match isn't a member, trailing `. _ -` are dropped one at a time and retried (`Thanks @ana.` mentions ana). It counts only for an **active member of the workspace the text belongs to** (people or agents), never the author. In **doc content** only, a candidate that ends exactly at the end of the content doesn't count yet: the doc editor autosaves while you type, so `@al` on its way to `@alice` must not mention `al`. Export the pattern source as `MENTION_PATTERN` from `src/shared/types.ts` so both sides use the same rule.

### Schema (append the next migration)
```sql
-- Who is @mentioned where; recomputed on every save of the text, like document_refs.
CREATE TABLE mentions (
  source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
  user_id INTEGER NOT NULL REFERENCES users(id),
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source, user_id)
);
CREATE INDEX mentions_user ON mentions(user_id);
```

### Server (`tracker.ts`)
- `saveMentions(a, workspace, source, owner: { issueId?: number; documentId?: number }, text, time, { typing = false } = {}): number[]`: resolves candidates with one `users JOIN workspace_members … suspended_at IS NULL` query, deletes rows of users no longer mentioned, inserts new ones, **returns the user ids newly mentioned** (the hook DKT-11 notifies and DKT-12 reports). Editing text that keeps a mention creates nothing new.
- Call it in the same transaction as the write: `createIssue` and `updateIssue` when `description` is set (`issue:<id>`); `insertComment` / `updateComment` (`comment:<id>` or `document_comment:<id>`; make `insertComment` return `lastInsertRowid` and take the workspace); `createDocument` / `updateDocument` when content changes (`document:<id>`, `typing: true`).
- `deleteComment` deletes that source's rows; purging an issue or doc cascades.
- Wrap `changeDocumentComments`' change in `db.transaction`.

### REST
No new routes or fields.

### MCP
- INSTRUCTIONS gains: "- Mention people or agents as @username (see list_members) in descriptions, comments and docs."
- `description`, `docContent` and the comment `body` schemas end with: "Mention people or agents as @username (list_members has usernames)."

### UI
- **Chips** (`markdown.tsx`): a `mention` inline extension beside `issueRef`: same boundary and trailing-punctuation rule, resolved against `useApp().members` that are active (not `suspendedAt`); not inside links (`inLink`); code is never tokenized as text, so code stays literal. Render `<span class="mention" dir="ltr" title="{name}">@username</span>` (`mention-agent` for agents, tinted like `avatar-agent`); `dir="ltr"` keeps `@name` intact inside Arabic text. Unknown or suspended names stay plain text. Add `members` to the memo's deps.
- **Autocomplete**: new `src/web/editor.tsx` (extend it if DKT-24 created it first for uploads) exporting `useMentionMenu(ref, value, setValue)` → `{ menu, onKeyDown }`. It opens when the text before the caret matches `(^|[\s(\[])@([a-z0-9._-]{0,32})$`; lists up to 8 active members (people, then agents; not you) whose username or name starts with the query; ↑/↓ move, Enter or Tab inserts `@username ` in place of the typed `@query`, Esc closes it (consumed, so the textarea's own Esc doesn't also fire), click works. Positioned at the caret (mirror-div measurement), clamped to the viewport; on phones full width under the line. Row: Avatar, name (`dir="auto"`), muted `@username`, "Agent" tag. Wire it into the four textareas above (each `onKeyDown` asks the menu first).
- CSS in `styles.css`: `.mention` (subtle pill like `.md a.issue-ref` at 1389, agent tint like `.avatar-agent` at 820), `.mention-menu`.

### Interaction with DKT-3
Resolution is per workspace (the text's workspace members) and rows store user ids, so per-workspace usernames fit. If DKT-3 has moved usernames onto memberships, resolve `@name` against the text's workspace memberships rather than `users.username`.

## Acceptance criteria

- [ ] `@ana` in an issue description, issue comment, doc or doc comment of ana's workspace is stored as a mention; in a code span, an email, a URL, for a suspended member, someone outside the workspace or yourself it isn't.
- [ ] Editing text keeps existing mentions, adds new ones, removes dropped ones; deleting a comment removes its mentions.
- [ ] A doc whose content ends in `@al` (mid-typing) mentions nobody; `@al ` or `@al` followed by more text does.
- [ ] Mentions render as chips (agents distinguishable), readable in Arabic text; nothing loads from the network.
- [ ] Typing `@` in any of the four editors offers members; keyboard and mouse both insert.

## Tests

`test/mentions.test.ts` (new). Mentions aren't in the API, so read `mentions` with `bun:sqlite` on `s.databasePath` as `test/parity.test.ts:66` does:
- ana (member) and agent `claude`; comment "hey @ana and @Claude, cc bob@example.com, `@admin`, https://x.com/@ana" by admin → rows for ana and claude only.
- `Thanks @ana.` → ana; `@nobody` → none; self-mention → none; suspended member → none; a member of another workspace only → none.
- edit the comment to drop ana and add admin (by ana) → rows follow; delete the comment → none for its source.
- description on create and on PATCH; doc content ending in `@ana` → none, then `@ana done` → ana; doc comment.
- MCP `comment_issue` by the agent mentioning `@ana` → row with `author_id` of the agent.

`test/migrations.test.ts`: add a case with a frozen fixture of the schema just before this migration: data written then survives, and a comment edited afterwards gets its mentions.

## SPEC.md

- **Data**: `mentions` table and the syntax rule (boundary, code, trailing punctuation, active members of the text's workspace, not yourself, the doc end-of-content rule).
- **MCP**: INSTRUCTIONS/tool descriptions mention `@username`.
- **UI**: "Everywhere markdown renders" adds mention chips; editors offer `@` autocomplete.

## Out of scope

- Notifying and subscribing the mentioned (DKT-11); triggering agents on a mention (DKT-12).
- `@` mentions of issues, docs or teams (identifiers already auto-link), profile pages, mention search/filters.
## Why

Nothing tells a person that an agent finished their issue, that someone replied, or that they were mentioned; nothing tells an agent that an issue was delegated to it. Everyone has to poll lists. Linear's answer is subscriptions plus an Inbox. This builds both on the activity log (DKT-9) and stored mentions (DKT-10), for people in the web UI and for agents over MCP.

## Linear's behaviour

- You're auto-subscribed when you create an issue, are assigned it, or are @mentioned in its description or a comment; Shift+S subscribes, Cmd/Ctrl+Shift+S unsubscribes: https://linear.app/docs/notifications
- Inbox: key events on subscribed issues; `G I` opens it; J/K move; U read/unread; Option/Alt+U all read; Backspace deletes one, Shift+Backspace deletes all read; up to 2,000 notifications kept: https://linear.app/docs/inbox
- "Status changes" notify on completion and cancelation of subscribed issues: https://linear.app/docs/notifications
- Doc creators are subscribed to their doc; mentions in docs and doc comments notify: https://linear.app/docs/issue-documents
- Agents get "Inbox notifications" too (a webhook category for app users): https://linear.app/developers/agents

**Deliberate differences.** Commenting also subscribes you (people and agents expect replies). Moving to **in_review** notifies too: agents hand work back through in_review, and the assignee needs to know. Delegation notifies the agent (Linear starts an agent session instead). No snooze, reminders, email, push or priority tab, and no `G I` chord (Docket has no G-chords yet). The inbox is per workspace, like the sidebar.

## Where things are today

- `src/server/tracker.ts`: after DKT-9, `logActivity` is the one call per issue mutation (inside its transaction); after DKT-10, `saveMentions` returns newly mentioned user ids; comments go through `insertComment` (105-113) inside `changeIssueComments` (717-727) / `changeDocumentComments` (968-973); `createDocument` 897-917.
- `src/server/db.ts:203-212` `onChange`/`changed(entity, workspace, id)`: one listener; `src/server/index.ts:77` publishes every event to the workspace topic; sockets subscribe per workspace at `index.ts:64-67`.
- `src/shared/types.ts:282-287` `ServerEvent` (entities workspace, member, team, issue, document); `191-198` `Issue`; `211-216` `Document`.
- `src/server/api.ts:162-183` issue routes, `195-226` document routes, `52-61` `issueFilter` (query → `IssueFilter`, `src/shared/types.ts:270-279`), applied in `src/server/tracker.ts:438-474` `queryIssues`; `src/server/index.ts:30` `APP_PATHS` (server-side app routes).
- `src/web/main.tsx:89-97` live events → refetch; `270-336` `Sidebar` (nav items 299-310); `190-208` global shortcuts; `210-226` page switch. `src/web/routing.tsx:5-24` `Route`/`parseRoute`. Headers: `src/web/issue.tsx:199-215`, `src/web/docs.tsx:242-289`. Icons `src/web/icons.tsx:23-44`.

## Design

### Rules that apply
Linear's features, nano implementation, no dependencies, few files. Append the next migration (additive) + migration-survival test. SPEC.md and types.ts in the same branch. REST/MCP/UI parity; MCP descriptions teach the conventions. Every mutation publishes a `changed` event. Anything outside your workspaces is 404; a notification is only ever visible to its recipient. `dir="auto"` on user text, phone width. Branch `feature/inbox`; tests/typecheck pass; merge, delete branch.

### Schema (append the next migration)
```sql
CREATE TABLE subscriptions (
  user_id INTEGER NOT NULL REFERENCES users(id),
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  CHECK ((issue_id IS NULL) != (document_id IS NULL))
);
CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
CREATE INDEX subscriptions_user ON subscriptions(user_id);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),               -- the recipient
  workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                          -- assigned | delegated | mentioned | commented | status
  actor_id INTEGER NOT NULL REFERENCES users(id),
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  comment_id INTEGER,                                          -- in comments (issue) or document_comments (doc); no FK: two tables
  status TEXT,                                                 -- kind status: the new status
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, id);
-- Existing work is subscribed the way new work will be.
INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
-- A doc's creator is the author of its first version.
INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
  WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
```

### Contract (`types.ts`)
```ts
export const NOTIFICATION_KINDS = ["assigned", "delegated", "mentioned", "commented", "status"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export interface Notification {
  id: number;
  kind: NotificationKind;
  workspace: string;
  actor: UserRef;
  issue: { id: string; title: string; status: Status } | null; // id: identifier
  document: { slug: string; title: string } | null;
  comment: { id: number; excerpt: string } | null; // first 200 characters, newlines as spaces; null if it was deleted
  status: Status | null; // kind "status": what it moved to
  createdAt: string;
  readAt: string | null;
}
export interface Inbox { notifications: Notification[]; unread: number } // newest first, at most 500; unread counts all
// Issue and Document gain: subscribed: boolean  (the caller)
// ServerEvent.entity gains "inbox" (id: the recipient's username; sent only to that user's sockets)
```

### Server: new `src/server/inbox.ts`
Fan-out helpers imported by `tracker.ts` (inbox.ts never imports tracker.ts), plus the inbox reads/writes:
- `subscribe(userId, { issueId | documentId }, time)` (INSERT OR IGNORE) and `unsubscribe`.
- `notify(recipients: number[], n: { kind, actorId, workspace, issueId?, documentId?, commentId?, status? }, time)`: drops the actor and anyone not an active member of `workspace`, inserts one row each, trims each recipient to their newest 2,000, publishes `changed("inbox", workspace, username, userId)` per recipient. Runs inside the caller's transaction (bun:sqlite is synchronous, so the event goes out in the same tick as the commit; a rollback only costs a harmless refetch).
- Triggers (all in the mutation's transaction):
  - **DKT-9 `logActivity`**: `created`/`claimed` → subscribe the actor. `assignee` → X: subscribe X, notify X `assigned`. `delegate` → Y: subscribe Y, notify Y `delegated`. `status` → in_review, done or canceled: notify the issue's subscribers `status`.
  - **Comments** (`insertComment`): subscribe the author; notify the issue's (or doc's) subscribers `commented`, except users this comment mentions.
  - **DKT-10 `saveMentions`** new ids: subscribe each, notify `mentioned` (with the comment when the source is one).
  - `createDocument`: subscribe the creator.
  - `deleteComment`: delete notifications with that `comment_id` on that issue/doc.
- `listInbox(a, { workspace?, unread? })`, `markRead(a, { ids?, workspace?, read })`, `deleteNotifications(a, { ids?, read?, workspace? })`: only the caller's rows in their active workspaces; an id that isn't theirs is 404. Excerpts join `comments` or `document_comments` at read time.
- `db.ts`: `changed(entity, workspace, id, userId?)`; `index.ts` publishes events with a `userId` to topic `user:<id>` (subscribed on socket open) instead of the workspace topic; the wire event is still `ServerEvent`.

### REST
| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | /api/notifications | `?workspace&unread=true` | `Inbox` |
| PATCH | /api/notifications | `{ ids?: number[], workspace?, read: boolean }` (no ids: all of yours, in `workspace` if given) | `Inbox` |
| DELETE | /api/notifications | `?ids=1,2` or `?read=true` (all read ones) `&workspace` | `Inbox` |
| PUT / DELETE | /api/issues/:id/subscription | | `Issue` (live issues only: 409 in the trash) |
| PUT / DELETE | /api/documents/:slug/subscription | | `Document` |
| GET | /api/issues | new filter `subscribed=true` (issues you're subscribed to; `IssueFilter.subscribed?: boolean`) | as today |

Each write publishes (`inbox` to the caller; `issue`/`document` for subscription changes). The `subscribed` filter is Linear's My Issues → Subscribed (https://linear.app/docs/notifications); DKT-14's Subscribed tab builds on it.

### MCP
- INSTRUCTIONS gains: "- Your inbox (list_notifications) is what needs you: issues delegated or assigned to you, @mentions of you, and new comments or status changes on issues and docs you're subscribed to (you're subscribed to what you create, claim, are assigned, delegated, mentioned in, or comment on). Check it when you start; mark items read once handled."
- `list_notifications` (read-only): `workspace?`, `unread?` (default true), `limit?` (default 50, max 200). "Your notifications, newest first, one line each: #id · unread · kind · target · by @actor · time · "excerpt". Kinds: delegated (an issue was delegated to you: start with get_issue and claim_issue), assigned, mentioned, commented, status. Mark them read with mark_notifications_read when handled." Line: `#41 · unread · delegated · DKT-12 Fix login · by @ana · 5m ago`, `#42 · unread · mentioned · doc spec (Spec) · by @ana · 1m ago · "@claude can you…"`.
- `mark_notifications_read`: `ids?` or `all?: true` (exactly one), `workspace?`, `read?` (default true).
- `subscribe`: `issue?` or `document?` (exactly one, like `commentOn`), `subscribed?` (default true). "Follow or unfollow an issue or doc: subscribers get its new comments and status changes in their inbox."
- `list_issues` gains `subscribed?: boolean` ("only issues you're subscribed to").

### UI
- Route `/inbox` (`Route { view: "inbox" }`; add to `APP_PATHS`). Sidebar: **Inbox** first in the nav, above All issues, with `InboxIcon` and the current workspace's unread count (`nav-count`, accent). `App` keeps `unread`, loads `api.inbox(workspace)` on workspace change and on `inbox` events (not on other events).
- `src/web/inbox.tsx`: one row per issue/doc (grouped by target, newest first): latest actor's Avatar, identifier (mono) + title or doc title (`dir="auto"`), latest event text ("Ana mentioned you", "Claude moved to In Review" with status icon, "Ana commented: excerpt…", "Ana assigned you", "Ana delegated to you"), "+2" when grouped, relative time, unread dot. Click or Enter: mark the group read, open the issue/doc. Keys: J/K or ↑/↓ move, U toggle read, Alt/Option+U all read, Backspace delete the group, Shift+Backspace delete all read. Empty: "You're all caught up" / "Mentions, assignments and updates on what you follow show up here."
- Issue and doc headers: a bell icon button (Subscribe / Unsubscribe, `aria-pressed`); `Shift+S` toggles it on those pages (not while typing).

### Interaction with DKT-3 and DKT-18
Notifications and subscriptions store user and issue ids plus the workspace key; nothing depends on global usernames. If DKT-3 has landed (every request acts in one workspace, MCP tools lose `workspace`), drop the `workspace` query/arguments here and scope to the request's workspace; the page is `/<ws>/inbox`. If DKT-18 has landed, `status` notifies on moves into a `completed` or `canceled` category status, or into the key `in_review` when the team has it.

## Acceptance criteria

- [ ] Delegating an issue to an agent puts `delegated` in its inbox (MCP `list_notifications`); assigning a person, `assigned`.
- [ ] Mentioning someone notifies them once (`mentioned`), not also `commented`; editing that comment doesn't notify again.
- [ ] Subscribers (not the author) get `commented`; `status` on in_review/done/canceled only; the actor never notifies themselves; suspended or non-members get nothing.
- [ ] Creating, claiming, being assigned/delegated/mentioned, commenting subscribe you; unsubscribing sticks until one of those happens again.
- [ ] Inbox page groups per issue/doc, marks read/unread, deletes, updates live in other tabs; sidebar count follows; works at phone width.
- [ ] Nobody can read, mark or delete another user's notifications (404).

## Tests

`test/inbox.test.ts` (new), with ana (member), bob (member), agent `claude`:
- admin creates an issue delegated to claude and assigned to ana → claude's `list_notifications` has `delegated`; ana's `GET /api/notifications` has `assigned`; admin has none.
- claude comments → ana and admin (subscribed) get `commented` with excerpt; claude doesn't.
- bob comments "@ana look" → ana gets exactly one `mentioned` (no `commented`); bob is now subscribed (`subscribed: true`).
- claude sets in_review → ana, admin, bob get `status: in_review`; setting priority notifies nobody.
- ana `DELETE /api/issues/:id/subscription` → later comments don't reach her; a new mention does.
- `PATCH /api/notifications { ids, read: true }` → `unread` drops; bob patching ana's id → 404; `DELETE ?read=true` removes read ones.
- suspend bob, comment → bob gets nothing.
- docs: creator subscribed; doc comment notifies the creator; mention in doc content notifies.
- realtime: ana's `ws()` receives `{ entity: "inbox", id: "ana" }` on a notification; bob's socket doesn't.
- MCP `mark_notifications_read { all: true }`, `subscribe { issue, subscribed: false }`.
- `GET /api/issues?subscribed=true` as ana lists exactly her subscribed issues; MCP `list_issues { subscribed: true }` matches.
- workspace isolation: another workspace's member never sees these; `?workspace=` unknown → 400.

`test/migrations.test.ts`: frozen fixture of the schema before this migration with an issue (creator, assignee, delegate) and a comment → after upgrade each is `subscribed: true` on that issue.

## SPEC.md

- **Data**: `subscriptions`, `notifications` (kinds, triggers, auto-subscribe rules, 2,000 cap, backfill).
- **REST**: the table above; `Issue`/`Document` gain `subscribed`; `?subscribed=true` on `/api/issues`.
- **Realtime**: per-user `inbox` events on the user's own sockets.
- **MCP**: three tools, `list_issues subscribed`, and the INSTRUCTIONS line.
- **UI**: Inbox page and keys, sidebar count, subscribe bell and `Shift+S`.

## Out of scope

- Webhooks for agent notifications (DKT-12); reply-specific thread notifications (DKT-25 replies notify through `commented`).
- Email, push, Slack, snooze, reminders, notification preferences; the My Issues "Subscribed" tab itself (DKT-14).
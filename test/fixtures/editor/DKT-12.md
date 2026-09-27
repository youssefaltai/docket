## Why

An agent runtime today has to poll Docket to find out it was delegated an issue or mentioned. Webhooks let a workspace push issue, comment and document changes, and each agent's inbox notifications, to an HTTP endpoint the moment they happen, so an agent can be started instead of polling. They must be signed, retried, logged, and unable to reach internal networks by accident.

## Linear's behaviour

https://linear.app/developers/webhooks:
- Payload: `action` (`create`/`update`/`remove`), `type`, `data`, `updatedFrom` (previous values on update), `url`, `createdAt`, `actor`, `webhookTimestamp` (ms), `webhookId`, `organizationId`.
- Headers `Linear-Signature` (hex HMAC-SHA256 of the raw body with the webhook's secret), `Linear-Delivery` (UUID), `Linear-Event`, `Linear-Timestamp`; receivers should reject timestamps more than a minute off.
- Must answer 200 within 5 s; failures retry 3 times after 1 minute, 1 hour and 6 hours; persistently failing webhooks may be disabled and must be re-enabled manually.
- Only workspace admins can create or read webhooks; URLs must be public HTTPS.

Agents: webhooks with "Inbox notifications" and "Agent session events"; a session is created "when an agent is mentioned or delegated an issue": https://linear.app/developers/agents , https://linear.app/developers/agent-interaction

**Deliberate differences.** No agent sessions/activities: agent triggers are the agent's **inbox notifications** (DKT-11) delivered as `type: "Notification"` (kinds `delegated`, `mentioned`, `commented`, `assigned`, `status`). Any 2xx counts as success. Private addresses are refused unless the operator allows them (agents often run on the same host or tailnet). Headers are named `Docket-*`.

## Where things are today

- Hooks to add to: DKT-9 `logActivity` (one call per issue mutation, in its transaction, with before/after values); comments `insertComment`/`updateComment`/`deleteComment` at `src/server/tracker.ts:105-139`; documents `createDocument` 897-917, `updateDocument` 919-952, `trashDocument` 955-962; DKT-11 `notify()` in `src/server/inbox.ts`.
- `src/server/access.ts:246-254` `requireSession` / `requireAdminSession` (private; export the latter): the "managing access takes a session" rule.
- `src/server/api.ts:37-45` strict PATCH bodies; `105-133` workspace admin routes (pattern for the new ones).
- `src/server/index.ts:75` `setInterval(purgeExpiredKeys, …)`: where background work starts; `90` how the public URL is derived (`DOCKET_URL`).
- `src/web/settings.tsx:386-403` `WorkspaceSettings`; `80-106` `Secret`/`useSecret` (show-once secrets); `467-528` `Agents` (row menu pattern); `src/web/auth.ts:34-59` admin API client.
- `test/chat-proxy.test.ts:14` an in-test `Bun.serve({ port: 0 })` stand-in service: the receiver pattern.

## Design

### Rules that apply
Linear's features, nano implementation, no dependencies (`node:crypto`, `node:dns` and `fetch` only). Append the next migration (additive) + migration-survival test. SPEC.md, README (config) and types.ts in the same branch. Managing webhooks is like managing credentials: workspace admins, **browser session only** (API keys get 403), no MCP tools (agents never mint access). Outside your workspaces: 404. Every mutation publishes `changed`. Branch `feature/webhooks`; tests/typecheck pass; merge, delete branch.

### Schema (append the next migration)
```sql
CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY,
  workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
  url TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
  secret TEXT NOT NULL,                 -- the signing key: kept in the clear because signing needs it; shown once
  enabled INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX webhooks_workspace ON webhooks(workspace);
-- The outbox: written in the same transaction as the change, sent by a background loop.
CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
  payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  response_status INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  last_attempt_at TEXT
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
```

### Contract (`types.ts`)
```ts
export const WEBHOOK_RESOURCES = ["Issue", "Comment", "Document", "Notification"] as const;
export type WebhookResource = (typeof WEBHOOK_RESOURCES)[number];
export interface Webhook { id: number; url: string; label: string; resourceTypes: WebhookResource[]; enabled: boolean;
  failures: number; createdBy: UserRef; createdAt: string; updatedAt: string } // never the secret
export interface WebhookInput { url: string; label?: string; resourceTypes?: WebhookResource[] } // default: all four
export type WebhookPatch = Partial<WebhookInput> & { enabled?: boolean }; // enabling resets failures
export interface WebhookDelivery { id: number; uuid: string; type: WebhookResource; action: "create" | "update" | "remove";
  entity: string; status: "pending" | "delivered" | "failed"; attempts: number; responseStatus: number | null;
  error: string | null; createdAt: string; lastAttemptAt: string | null; nextAttemptAt: string | null }
/** The JSON body of every delivery. */
export interface WebhookPayload<T = unknown> {
  action: "create" | "update" | "remove"; type: WebhookResource; workspace: string; actor: UserRef;
  createdAt: string;                      // when the change happened
  data: T;
  updatedFrom?: Record<string, unknown>;  // update: previous values of the fields that changed
  url: string;                            // the entity in the web app (DOCKET_URL + path)
  webhookId: number; webhookTimestamp: number; // ms, this attempt
}
```
`data` per type: **Issue** `IssueSummary & { description, creator }` (`remove` = moved to the trash; restore is an `update` with `updatedFrom: { deletedAt }`); **Comment** `Comment & { issue: string | null; document: string | null }`; **Document** `DocumentSummary` (no content; fetch it); **Notification** `Notification & { user: UserRef }` for notifications whose recipient is an **agent**, `action: "create"`. "Delegated to agent" is `type Notification, data.kind "delegated"`; "agent mentioned" is `data.kind "mentioned"` (with `data.comment` when in a comment).

### Server: new `src/server/webhooks.ts`
- `enqueue(workspace, type, action, entity, actor, data, updatedFrom?)`: builds the payload once, inserts a `pending` delivery (`next_attempt_at` now) for each **enabled** webhook of the workspace whose `resource_types` include `type`. Called inside the mutation's transaction from: DKT-9 `logActivity` (one Issue event per mutation; `updatedFrom` from the changes' in-memory before values), the three comment functions, the three document functions, and DKT-11 `notify()` for agent recipients. It never imports `tracker.ts` (callers pass `data`).
- Document `update` events wait 10 s and merge into a still-unattempted pending delivery for the same webhook and slug (newer `data`, older `updatedFrom`), so autosave doesn't send one per second.
- `startWebhooks()` (called in `index.ts` beside `purgeExpiredKeys`): a send pass delivers due deliveries, up to 4 at a time (an in-memory set prevents double sends). `enqueue` schedules a pass right after the current tick (`setTimeout(pass, 0)`), a failed attempt schedules one at its retry time, and a 1 s interval catches anything left (e.g. after a restart). Hourly, deliveries older than 7 days are deleted.
- Send: re-check the target (below), add `webhookTimestamp`, `POST` with `redirect: "manual"` and a 5 s timeout (`DOCKET_WEBHOOK_TIMEOUT_MS`, tests only). Headers: `Content-Type: application/json`, `User-Agent: Docket-Webhook`, `Docket-Delivery: <uuid>`, `Docket-Event: <type>`, `Docket-Timestamp: <ms>`, `Docket-Signature: <hex HMAC-SHA256(secret, raw body)>`. 2xx = delivered (webhook `failures` = 0). Anything else (non-2xx, 3xx, timeout, network error, blocked) retries after 1 min, 1 h, 6 h (`DOCKET_WEBHOOK_RETRY_MS`, comma-separated, tests only); after the 4th attempt the delivery is `failed` and `failures` += 1. At 10 the webhook is disabled (`enabled = 0`) and its pending deliveries fail with "webhook disabled". Only the status code and a short error (`HTTP 500`, `timeout after 5 s`, `blocked: 10.0.0.5 is private`) are kept, never response bodies.
- **Target check** (`checkTarget`), on create/update (400 with the reason) and before every attempt: `https:` only (`http:` too when `DOCKET_WEBHOOK_ALLOW_PRIVATE=true`); no user:password; resolve with `dns.promises.lookup(host, { all: true })`; refuse if **any** address is private unless `DOCKET_WEBHOOK_ALLOW_PRIVATE=true`: IPv4 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4; IPv6 ::, ::1, fc00::/7, fe80::/10, ff00::/8, and IPv4-mapped (`::ffff:0:0/96`) / NAT64 (`64:ff9b::/96`) checked as IPv4. Redirects are never followed. Known limit, documented: a DNS answer can change between the check and the connect.
- CRUD with `requireAdminSession` (exported from access.ts). Secrets: `dkwh_` + 32 random bytes hex, returned only by create and rotate.
- `appUrl(path)`: `(DOCKET_URL || http://localhost:$PORT)` + path; the one place payload URLs are built.

### REST (admin, browser session; 403 for keys and non-admins; 404 outside)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET / POST | /api/workspaces/:key/webhooks | `WebhookInput` | `Webhook[]`; 201 `{ webhook, secret }` |
| PATCH / DELETE | /api/workspaces/:key/webhooks/:id | `WebhookPatch` (strict fields) | `Webhook`; `{ ok: true }` |
| POST | /api/workspaces/:key/webhooks/:id/secret | | `{ secret }` (the old one stops at once) |
| GET | /api/workspaces/:key/webhooks/:id/deliveries | | `WebhookDelivery[]` (newest 50) |

Writes publish `changed("workspace", key, key)`.

### UI (Workspace settings, admins)
A **Webhooks** section after Agents: rows with label (or host), URL (mono, muted), resource chips, state (Enabled / Disabled / "Disabled after 10 failed deliveries"). "Add webhook" form: URL, Label, checkboxes Issues, Comments, Documents, Agent notifications. The secret shows once via `Secret` with "Verify `Docket-Signature` (HMAC-SHA256 of the raw body) and reject a `webhookTimestamp` more than a minute off." Row menu: Edit, Disable/Enable, New secret (confirm), Deliveries (inline list: time, "Issue update DKT-12", Delivered 200 / Failed: timeout / Pending, retry in 58m, attempts), Delete (confirm). Calls in `src/web/auth.ts`.

### Interaction with DKT-3
Webhooks are per workspace already. Payload `url`s go through `appUrl()`, so DKT-3's `/<ws>/issue/KEY-1` is a one-line change there.

## Acceptance criteria

- [ ] An admin (browser) creates, edits, disables, rotates and deletes webhooks; API keys and members get 403; other workspaces 404; the secret is shown once.
- [ ] Creating, updating, trashing/restoring issues, comments and docs delivers the matching event with `updatedFrom` on updates; a PATCH that changes nothing sends nothing.
- [ ] Delegating to an agent and mentioning an agent deliver `Notification` events (`delegated`, `mentioned`); people's notifications are never sent.
- [ ] Signatures verify with the secret; a failing receiver is retried on schedule, then marked failed; 10 failed deliveries in a row disable the webhook; the log shows all of it.
- [ ] Private, loopback, link-local and metadata addresses are refused unless `DOCKET_WEBHOOK_ALLOW_PRIVATE=true`; redirects are not followed; plain http is refused otherwise.

## Tests

`test/webhooks.test.ts` (new): a receiver `Bun.serve({ port: 0 })` records requests and answers per test; server started with `env: { DOCKET_WEBHOOK_ALLOW_PRIVATE: "true", DOCKET_WEBHOOK_RETRY_MS: "50,50,50", DOCKET_WEBHOOK_TIMEOUT_MS: "300" }`; poll for deliveries like `Socket.until`.
- create as `s.as("admin", "cookie")` → 201 with `secret`; `GET` has no secret; `s.as("admin", "bearer")` → 403; member ana → 403; admin of another workspace → 404; unknown field in PATCH → 400.
- create an issue → one POST: `Docket-Event: Issue`, body `action: create`, `data.id`, `url` ends `/issue/<id>`; `Docket-Signature` equals `createHmac("sha256", secret).update(rawBody).digest("hex")`; `webhookTimestamp` within 60 s.
- PATCH status → `update` with `updatedFrom.status: "backlog"`; same status again → nothing new.
- issue created with `delegate: "claude"` → a `Notification` delivery with `data.kind: "delegated"`, `data.user.username: "claude"`; comment "@claude please look" → `mentioned`; a comment mentioning ana → no Notification delivery.
- `resourceTypes: ["Notification"]` receives only those; a webhook of workspace "side" gets nothing from "acme".
- receiver answers 500 then 200 → delivery `delivered`, `attempts: 2`; always 500 → `failed` after 4; 10 such deliveries → webhook `enabled: false`; slow receiver (> timeout) and a 302 count as failures.
- second server **without** the allow flag: creating `http://127.0.0.1:1/`, `https://127.1/`, `https://0x7f000001/`, `https://[::1]/`, `https://[::ffff:127.0.0.1]/`, `https://169.254.169.254/`, `https://10.0.0.1/`, `https://user:pw@example.com/` → 400; `http://…` public → 400 (https only).
- rotate the secret → next delivery verifies only with the new one.

`test/migrations.test.ts`: frozen pre-migration fixture survives; the webhook tables exist and are empty.

## SPEC.md

- New **Webhooks** section: who manages them, events and payload (with the `data` per type and the Notification kinds as the agent trigger), headers and how to verify, retries/timeouts/disable, delivery log retention, target rules and the private-address flag, the 10 s document-update merge.
- **Access**: webhook management joins "managing access needs a session"; note the secret is the one secret kept in the clear (it signs).
- **Data**: `webhooks`, `webhook_deliveries`. README Configuration: `DOCKET_WEBHOOK_ALLOW_PRIVATE`.

## Out of scope

- Agent sessions/activities (Linear's AgentSession model), per-team webhooks, manual redelivery or test pings, reaction/label/team events, inbound GitHub webhooks (DKT-34).
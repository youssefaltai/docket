// The contract shared by the server (REST, MCP) and the web UI.

export const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export type Status = (typeof STATUSES)[number];

export const CLOSED_STATUSES: Status[] = ["done", "canceled"];
export const OPEN_STATUSES = STATUSES.filter((s) => !CLOSED_STATUSES.includes(s));

export const STATUS_LABELS: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

// Linear's convention: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
export const PRIORITIES = [0, 1, 2, 3, 4] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

/** Who did or owns something: a person or an agent. */
export type UserKind = "person" | "agent";

export interface UserRef {
  username: string; // lowercase a-z 0-9 . _ -, 2–32 chars, unique within its workspace (people and agents)
  name: string;
  kind: UserKind;
}

/**
 * An @mention in markdown prose (not in code or link text): `@username`, not preceded by a letter, digit or
 * `_ . @ / + -` (so bob@example.com and https://x.com/@ana aren't mentions). Group 1 is the candidate; see
 * `mentionOf`. It counts for an active member of the text's workspace. Use with flags "giu".
 */
export const MENTION_PATTERN = "(?<![\\p{L}\\p{N}_.@/+-])@([a-z0-9][a-z0-9._-]{1,31})(?![a-z0-9._-])";

/** Who a candidate names: itself, else with trailing `. _ -` dropped one at a time ("Thanks @ana." is ana). */
export function mentionOf(candidate: string, known: (username: string) => boolean): string | undefined {
  for (let name = candidate.toLowerCase(); name.length >= 2; name = name.slice(0, -1)) {
    if (known(name)) return name;
    if (!/[._-]$/.test(name)) return undefined;
  }
}

export interface User extends UserRef {
  email: string | null; // people only, optional; unverified contact info, never used to find an account
  createdAt: string;
}

// Workspace roles. Agents are members with role "agent": they work in teams but manage nothing (no teams, members or access).
export type Role = "admin" | "member" | "agent";

/** The first segment of app URLs other than a workspace's (/<ws>/…): no workspace can take these keys. */
export const RESERVED_WORKSPACE_KEYS = ["api", "doc", "docs", "icons", "issue", "login", "mcp", "settings", "setup", "t", "ws"];

export interface Workspace {
  key: string; // URL-safe lowercase slug, e.g. "acme"; not one of RESERVED_WORKSPACE_KEYS
  name: string;
  role: Role; // yours
  teamCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceInput {
  key?: string; // default: slugified name, deduped with -2, -3…
  name: string;
}

export type WorkspacePatch = Partial<Omit<WorkspaceInput, "key">>; // the key never changes

export interface WorkspaceMember {
  user: UserRef;
  email: string | null;
  role: Role;
  joinedAt: string;
  suspendedAt: string | null; // suspended members can't reach the workspace; their history stays theirs
}

/** GET /api/me. */
export interface Me {
  // id: the account, which never changes, for services that key data by person (docket-chat); ids stay internal
  // everywhere else. username and name: yours in the request's workspace (a key's own, or X-Docket-Workspace);
  // for a session naming none, your default profile (the membership you joined most recently).
  user: User & { id: number };
  workspaces: { key: string; name: string; role: Role; you: UserRef }[]; // you: how you're known there; for a key, only its own workspace
  credential: "session" | "key" | "chat"; // what this request came with; "chat": a key the chat proxy minted
  chat: boolean; // the assistant is set up (CHAT_URL): show its panel
}

export interface Session {
  id: number;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
  ip: string;
  current: boolean;
}

export const API_KEY_SCOPES = ["read", "write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKey {
  id: number;
  name: string;
  scope: ApiKeyScope;
  workspace: string; // the workspace key; the key works only there
  createdAt: string;
  lastUsedAt: string | null;
}

/** A one-time sign-in link or invite: `url` is `<origin>/login#<code>`; both expire after 15 minutes. */
export interface CodeLink {
  code: string; // XXXXX-XXXXX
  url: string;
  expiresAt: string;
}

/** What a code is for, without using it up (POST /api/auth/peek). */
export interface CodeInfo {
  kind: "invite" | "sign-in";
  workspace: string | null; // the workspace's name: an invite's, or the one a sign-in link recorded
  username: string | null; // sign-in: whose account it opens (their username there, else their default profile's)
  you: UserRef | null; // signed in: your default profile, whom an invite would add or another's sign-in link would replace (the page asks first)
  needsProfile: boolean; // an invite redeemed while signed out creates an account: it needs name and username
}

export interface SetupInput {
  code: string;
  name: string;
  username: string;
  email?: string;
  workspace: WorkspaceInput;
}

export interface Team {
  key: string; // 2–5 uppercase letters, e.g. "BRD"; unique within its workspace; prefixes its issue identifiers
  workspace: string; // workspace key
  name: string;
  description: string;
  counts: Record<Status, number>;
  docCount: number;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

export interface TeamInput {
  key: string;
  workspace?: string; // optional: teams are created in the request's workspace, and this must name it if given
  name: string;
  description?: string;
}

export type TeamPatch = Partial<Omit<TeamInput, "key" | "workspace">>; // the key and workspace never change

export interface IssueSummary {
  id: string; // identifier, e.g. "BRD-12"
  team: string; // team key
  number: number;
  title: string;
  status: Status;
  priority: Priority;
  labels: string[];
  assignee: UserRef | null; // a person: who owns it
  delegate: UserRef | null; // an agent working on it for the assignee (Linear's delegate)
  parent: string | null; // identifier
  blockedBy: string[]; // identifiers
  relatedTo: string[]; // identifiers, either direction: related is symmetric
  duplicateOf: string | null; // identifier of the canonical issue this one duplicates
  dueOn: string | null; // due date, a calendar date "YYYY-MM-DD" (no time), as in Linear
  createdAt: string;
  updatedAt: string;
  completedAt: string | null; // set when status becomes done/canceled
  deletedAt: string | null; // in the trash since then; purged 30 days later
}

/** One page of a list, Linear-style: pass `endCursor` as `after` for the next. */
export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface IssuePage {
  issues: IssueSummary[];
  pageInfo: PageInfo;
}

/** A team's trash: deleted issues and docs, restorable for 30 days, newest first. */
export interface Trash {
  issues: IssueSummary[];
  documents: DocumentSummary[];
}

export interface Comment {
  id: number;
  author: UserRef;
  body: string; // markdown
  createdAt: string;
  editedAt: string | null; // set when the body was last edited
  parent: number | null; // the thread's root comment id; null for a root (one level: a reply to a reply joins its thread)
  resolvedAt: string | null; // roots only: the thread was resolved then (a new reply reopens it)
  resolvedBy: UserRef | null;
  reactions: Reaction[]; // emoji reactions, ordered by first reaction
}

/** One emoji reaction on an issue's description, a comment or a doc comment: who reacted with it, in order. */
export interface Reaction {
  emoji: string;
  users: UserRef[]; // in the order they reacted
}

export interface LabelCount {
  label: string;
  open: number; // open issues carrying it
}

export const ACTIVITY_KINDS = [
  "created",
  "title",
  "description",
  "status",
  "priority",
  "assignee",
  "delegate",
  "labels",
  "parent",
  "blockedBy",
  "relatedTo",
  "duplicateOf",
  "dueOn",
  "claimed",
  "trashed",
  "restored",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * One change to an issue. from/to by kind: title, parent and duplicateOf (identifiers), status and claimed (Status), dueOn
 * ("YYYY-MM-DD") are strings; priority a number; assignee, delegate a UserRef; labels, blockedBy, relatedTo string arrays; null when unset, and both
 * null for created, description, trashed, restored.
 */
export type ActivityValue = string | number | string[] | UserRef | null;

export interface Activity {
  id: number;
  kind: ActivityKind;
  actor: UserRef;
  from: ActivityValue;
  to: ActivityValue;
  createdAt: string; // the same for every change one mutation made
}

export interface Issue extends IssueSummary {
  description: string; // markdown
  creator: UserRef;
  children: IssueSummary[];
  blocks: string[]; // identifiers this issue blocks
  duplicates: string[]; // identifiers of issues marked as duplicates of this one
  comments: Comment[];
  activity: Activity[]; // its history, oldest first
  docs: DocumentSummary[]; // documents whose content mentions this issue
  subscribed: boolean; // you (the caller) get its new comments and status changes in your inbox
  reactions: Reaction[]; // emoji reactions on the description
}

export interface DocumentSummary {
  slug: string; // unique within its workspace, stable, URL-safe: "architecture", "spec-customer"
  team: string; // team key
  title: string;
  position: number; // manual order within the team, ascending
  createdAt: string;
  updatedAt: string;
  updatedBy: UserRef;
  deletedAt: string | null; // in the trash since then; purged 30 days later
}

export interface Document extends DocumentSummary {
  content: string; // markdown
  issues: IssueSummary[]; // issues mentioned in the content, in order of first mention
  comments: Comment[];
  versionCount: number;
  subscribed: boolean; // you (the caller) get its new comments in your inbox
}

export interface DocumentVersionSummary {
  id: number;
  author: UserRef;
  title: string;
  createdAt: string;
}

export interface DocumentVersion extends DocumentVersionSummary {
  content: string;
}

export interface DocumentFilter {
  team?: string;
  q?: string; // matches title and content
}

export interface DocumentInput {
  team: string;
  title: string;
  content?: string;
  slug?: string; // default: slugified title (a-z, 0-9, "-"), deduped with -2, -3…; "doc-<n>" if empty
  position?: number; // default: last in the team
}

export interface DocumentPatch {
  title?: string;
  content?: string; // full replacement; mutually exclusive with edits
  edits?: { oldText: string; newText: string }[]; // exact find/replace, applied in order; each oldText must match once
  team?: string; // docs can move between teams of the same workspace; the slug stays
  position?: number;
  checkpoint?: boolean; // always record a new version instead of merging into the latest (e.g. a restore)
  baseUpdatedAt?: string; // the updatedAt this edit started from; if the doc has changed since, 409 and nothing is applied
}

export interface IssueInput {
  team: string;
  title: string;
  description?: string;
  status?: Status; // default "backlog", as in Linear
  priority?: Priority; // default 0
  labels?: string[];
  assignee?: string | null; // a person's username, or "me"
  delegate?: string | null; // an agent's username, or "me" (as an agent)
  parent?: string | null;
  blockedBy?: string[];
  relatedTo?: string[]; // replaces the whole list, on both sides
  duplicateOf?: string | null; // marks it a duplicate of that issue and sets it canceled; null clears (status stays)
  dueOn?: string | null; // "YYYY-MM-DD"; null clears
}

export type IssuePatch = Partial<Omit<IssueInput, "team">> & {
  baseUpdatedAt?: string; // the updatedAt you read; if the issue changed since, the patch is refused (409)
};

/**
 * POST /api/issues/bulk: one change for up to 100 issues, applied to each in turn exactly as its own PATCH
 * or DELETE would be. `addLabels`/`removeLabels` edit each issue's own labels (after `labels`, if given).
 */
export type BulkIssuePatch =
  | (Pick<IssuePatch, "status" | "priority" | "assignee" | "delegate" | "labels"> & { addLabels?: string[]; removeLabels?: string[] })
  | { delete: true };

export interface BulkIssueInput {
  ids: string[];
  patch: BulkIssuePatch;
}

/** One per id, in order: the issue as its own route would return it, or why that one failed (the rest still apply). */
export interface BulkIssueResult {
  id: string;
  issue?: Issue;
  error?: string;
  status?: number; // the HTTP status its own route would have answered with
}

export interface IssueFilter {
  team?: string;
  status?: Status[];
  label?: string;
  assignee?: string; // username or "me"
  delegate?: string; // username or "me"
  creator?: string; // username or "me" -- who filed it
  parent?: string;
  q?: string; // matches identifier, title, description
  subscribed?: boolean; // true: only issues you're subscribed to
  due?: DueFilter;
  sort?: IssueSort;
}

/**
 * Linear's due-date filters, by the server's date (UTC): overdue (before today, open issues only), soon (today to 7 days
 * ahead), today, any (has a due date), none (no due date).
 */
export const DUE_FILTERS = ["overdue", "soon", "today", "any", "none"] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

/** List order: default (status, priority, most recently updated) or due (earliest due date first, none last; then default). */
export const ISSUE_SORTS = ["default", "due"] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

export const NOTIFICATION_KINDS = ["assigned", "delegated", "mentioned", "commented", "status"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Something in your inbox: one event on an issue or doc, by someone else. */
export interface Notification {
  id: number;
  kind: NotificationKind;
  workspace: string;
  actor: UserRef;
  issue: { id: string; title: string; status: Status } | null; // id: identifier
  document: { slug: string; title: string } | null;
  comment: { id: number; excerpt: string } | null; // first 200 characters, newlines as spaces; null once deleted
  status: Status | null; // kind "status": what it moved to
  createdAt: string;
  readAt: string | null;
}

/** GET /api/notifications: yours in the request's workspace, newest first, at most 500; `unread` counts the issues and docs with unread ones, as the inbox groups them. */
export interface Inbox {
  notifications: Notification[];
  unread: number;
}

// --- Webhooks: a workspace's changes, POSTed to an endpoint as they happen (admins manage them in a browser session) ---

export const WEBHOOK_RESOURCES = ["Issue", "Comment", "Document", "Notification"] as const;
export type WebhookResource = (typeof WEBHOOK_RESOURCES)[number];
export type WebhookAction = "create" | "update" | "remove";

/** Never carries the secret: it's shown once, by create and rotate. */
export interface Webhook {
  id: number;
  url: string;
  label: string;
  resourceTypes: WebhookResource[];
  enabled: boolean;
  failures: number; // deliveries in a row that failed for good; 10 disables the webhook
  createdBy: UserRef;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookInput {
  url: string; // https (http and private addresses only with DOCKET_WEBHOOK_ALLOW_PRIVATE=true)
  label?: string;
  resourceTypes?: WebhookResource[]; // default: all four
}

export type WebhookPatch = Partial<WebhookInput> & { enabled?: boolean }; // enabling resets failures

export interface WebhookDelivery {
  id: number;
  uuid: string; // Docket-Delivery, the same on every attempt
  type: WebhookResource;
  action: WebhookAction;
  entity: string; // issue identifier, doc slug, comment id or notification id
  status: "pending" | "delivered" | "failed";
  attempts: number;
  responseStatus: number | null;
  error: string | null; // "HTTP 500", "timeout after 5 s", "blocked: 10.0.0.5 is private"; never a response body
  createdAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
}

/**
 * The JSON body of every delivery. `data` by type: Issue `IssueSummary & { description, creator }`; Comment
 * `Comment & { issue, document }` (identifier or slug); Document `DocumentSummary`; Notification
 * `Notification & { user }` (an agent's: `delegated`, `mentioned`, `commented`, `status`).
 */
export interface WebhookPayload<T = unknown> {
  action: WebhookAction;
  type: WebhookResource;
  workspace: string;
  actor: UserRef;
  createdAt: string; // when the change happened
  data: T;
  updatedFrom?: Record<string, unknown>; // update: previous values of the fields that changed
  url: string; // the entity in the web app
  webhookId: number;
  webhookTimestamp: number; // ms, this attempt
}

// Pushed over the WebSocket at /ws after every mutation, to the workspace's members. "inbox" events (and
// subscription changes) go only to that one user's sockets in that workspace.
export interface ServerEvent {
  type: "changed";
  entity: "workspace" | "member" | "team" | "issue" | "document" | "inbox";
  workspace: string;
  id: string; // workspace key, username, team key, issue identifier or document slug; inbox: the recipient's username
}

export interface ApiError {
  error: string;
}

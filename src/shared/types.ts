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
  username: string; // lowercase a-z 0-9 . _ -, 2–32 chars, unique across people and agents
  name: string;
  kind: UserKind;
}

export interface User extends UserRef {
  email: string | null; // people only, optional; unverified contact info, never used to find an account
  createdAt: string;
}

// Workspace roles. Agents are members with role "agent": they work in teams but manage nothing.
export type Role = "admin" | "member" | "agent";

export interface Workspace {
  key: string; // URL-safe lowercase slug, e.g. "acme"
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
  user: User;
  workspaces: { key: string; name: string; role: Role }[];
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
  workspace: string | null; // invite: the workspace's name
  username: string | null; // sign-in: whose account it opens
  you: UserRef | null; // invite peeked while signed in: the account that would join (the page asks before redeeming)
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
  key: string; // 2–5 uppercase letters, e.g. "BRD"; globally unique; prefixes its issue identifiers
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
  workspace: string;
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
}

export interface LabelCount {
  label: string;
  open: number; // open issues carrying it
}

export interface Issue extends IssueSummary {
  description: string; // markdown
  creator: UserRef;
  children: IssueSummary[];
  blocks: string[]; // identifiers this issue blocks
  comments: Comment[];
  docs: DocumentSummary[]; // documents whose content mentions this issue
}

export interface DocumentSummary {
  slug: string; // globally unique, stable, URL-safe: "architecture", "spec-customer"
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
  workspace?: string;
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
}

export type IssuePatch = Partial<Omit<IssueInput, "team">> & {
  baseUpdatedAt?: string; // the updatedAt you read; if the issue changed since, the patch is refused (409)
};

export interface IssueFilter {
  workspace?: string;
  team?: string;
  status?: Status[];
  label?: string;
  assignee?: string; // username or "me"
  delegate?: string; // username or "me"
  parent?: string;
  q?: string; // matches identifier, title, description
}

// Pushed over the WebSocket at /ws after every mutation, to the workspace's members.
export interface ServerEvent {
  type: "changed";
  entity: "workspace" | "member" | "team" | "issue" | "document";
  workspace: string;
  id: string; // workspace key, username, team key, issue identifier or document slug
}

export interface ApiError {
  error: string;
}

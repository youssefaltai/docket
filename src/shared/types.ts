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

export interface Workspace {
  key: string; // URL-safe lowercase slug, e.g. "acme"
  name: string;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceInput {
  key?: string; // default: slugified name, deduped with -2, -3…
  name: string;
}

export type WorkspacePatch = Partial<Omit<WorkspaceInput, "key">>; // the key never changes

export interface Project {
  key: string; // 2–5 uppercase letters, e.g. "BRD"; globally unique across workspaces
  workspace: string; // workspace key
  name: string;
  description: string;
  counts: Record<Status, number>;
  docCount: number;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

export interface IssueSummary {
  id: string; // identifier, e.g. "BRD-12"
  project: string; // project key
  number: number;
  title: string;
  status: Status;
  priority: Priority;
  labels: string[];
  assignee: string | null;
  parent: string | null; // identifier
  blockedBy: string[]; // identifiers
  createdAt: string;
  updatedAt: string;
  completedAt: string | null; // set when status becomes done/canceled
}

export interface Comment {
  id: number;
  author: string;
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
  children: IssueSummary[];
  blocks: string[]; // identifiers this issue blocks
  comments: Comment[];
  docs: DocumentSummary[]; // documents whose content mentions this issue
}

export interface DocumentSummary {
  slug: string; // globally unique, stable, URL-safe: "architecture", "spec-customer"
  project: string; // project key
  title: string;
  position: number; // manual order within the project, ascending
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface Document extends DocumentSummary {
  content: string; // markdown
  issues: IssueSummary[]; // issues mentioned in the content, in order of first mention
  comments: Comment[];
  versionCount: number;
}

export interface DocumentVersionSummary {
  id: number;
  author: string;
  title: string;
  createdAt: string;
}

export interface DocumentVersion extends DocumentVersionSummary {
  content: string;
}

export interface DocumentFilter {
  workspace?: string;
  project?: string;
  q?: string; // matches title and content
}

export interface DocumentInput {
  project: string;
  title: string;
  content?: string;
  slug?: string; // default: slugified title (a-z, 0-9, "-"), deduped with -2, -3…; "doc-<n>" if empty
  position?: number; // default: last in the project
  author?: string; // REST default "anonymous" (the web UI sends the viewer's name), MCP default "claude"
}

export interface DocumentPatch {
  title?: string;
  content?: string; // full replacement; mutually exclusive with edits
  edits?: { oldText: string; newText: string }[]; // exact find/replace, applied in order; each oldText must match once
  project?: string; // docs can move between projects; the slug stays
  position?: number;
  author?: string;
  checkpoint?: boolean; // always record a new version instead of merging into the latest (e.g. a restore)
  baseUpdatedAt?: string; // the updatedAt this edit started from; if the doc has changed since, 409 and nothing is applied
}

export interface ProjectInput {
  key: string;
  workspace: string;
  name: string;
  description?: string;
}

export type ProjectPatch = Partial<Omit<ProjectInput, "key">>; // the key never changes; workspace moves it

export interface IssueInput {
  project: string;
  title: string;
  description?: string;
  status?: Status; // default "todo"
  priority?: Priority; // default 0
  labels?: string[];
  assignee?: string | null;
  parent?: string | null;
  blockedBy?: string[];
}

export type IssuePatch = Partial<Omit<IssueInput, "project">>;

export interface IssueFilter {
  workspace?: string;
  project?: string;
  status?: Status[];
  label?: string;
  assignee?: string;
  parent?: string;
  q?: string; // matches identifier, title, description
}

// A person or agent with their own token. Humans and agents alike write under their name.
export const MEMBER_KINDS = ["human", "agent"] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];
export const MEMBER_ROLES = ["admin", "member"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export interface Member {
  name: string;
  kind: MemberKind;
  role: MemberRole;
  createdAt: string;
  revokedAt: string | null; // revoked members can't sign in; their name stays reserved
}

export interface MemberInput {
  name: string;
  kind: MemberKind;
  role?: MemberRole; // default "member"
}

/** A member plus their new token, shown once (on create and rotate). */
export interface MemberToken {
  member: Member;
  token: string;
}

/** GET /api/me. `member` is null for the shared DOCKET_TOKEN, or no token in open mode ("root", an admin). */
export interface Me {
  member: Member | null;
  admin: boolean;
}

// Pushed over the WebSocket at /ws after every mutation.
export interface ServerEvent {
  type: "changed";
  entity: "workspace" | "project" | "issue" | "document" | "member";
  id: string; // workspace key, project key, issue identifier, document slug or member name
}

export interface ApiError {
  error: string;
}

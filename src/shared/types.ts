// The contract shared by the server (REST, MCP) and the web UI.

/**
 * Each team has its own workflow: ordered statuses in Linear's fixed categories, in this order. Issues name their
 * status by its stable key ("in_progress"); its name ("In Progress") can be renamed freely.
 */
export const STATUS_CATEGORIES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];
export const ACTIVE_CATEGORIES: StatusCategory[] = ["backlog", "unstarted", "started"]; // what "open" means; triage is outside the workflow
export const CLOSED_CATEGORIES: StatusCategory[] = ["completed", "canceled"];
export const DUPLICATE_STATUS = "duplicate"; // the system status: fixed name, color and category; can't be deleted

export interface WorkflowStatus {
  key: string; // stable, a-z 0-9 _, unique in the team: what issues' `status` holds, e.g. "in_progress"
  name: string; // "In Progress"; renamable
  category: StatusCategory;
  color: string; // "#rrggbb"
  position: number; // order within its category
}

export interface WorkflowStatusInput {
  name?: string; // required, except for triage ("Triage")
  category: StatusCategory;
  color?: string; // default: the category's
  key?: string; // default: derived from the name ("In QA" → in_qa); triage: "triage"
  position?: number; // default: last in its category
}

export type WorkflowStatusPatch = { name?: string; color?: string; position?: number }; // key and category never change

/** Every new team's workflow (every existing team's since migration 16): the six statuses teams always had, plus Duplicate. */
export const DEFAULT_WORKFLOW: WorkflowStatus[] = [
  { key: "backlog", name: "Backlog", category: "backlog", color: "#a3a3a3", position: 1 },
  { key: "todo", name: "Todo", category: "unstarted", color: "#8f8f8f", position: 2 },
  { key: "in_progress", name: "In Progress", category: "started", color: "#e8a800", position: 3 },
  { key: "in_review", name: "In Review", category: "started", color: "#30a46c", position: 4 },
  { key: "done", name: "Done", category: "completed", color: "#5e6ad2", position: 5 },
  { key: "canceled", name: "Canceled", category: "canceled", color: "#b4b4b4", position: 6 },
  { key: DUPLICATE_STATUS, name: "Duplicate", category: "canceled", color: "#b4b4b4", position: 7 },
];

/** A new status's color when none is given. */
export const CATEGORY_COLORS: Record<StatusCategory, string> = {
  triage: "#f76b15", backlog: "#a3a3a3", unstarted: "#8f8f8f", started: "#e8a800", completed: "#5e6ad2", canceled: "#b4b4b4",
};

// Linear's convention: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
export const PRIORITIES = [0, 1, 2, 3, 4] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = { 0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };

/**
 * Estimates (Linear's, opt-in per team): a team picks a scale, and an issue holds a 1–5 position in it, shown as that
 * scale's value. The position stays when the team changes scale or turns estimates off. T-shirt sizes sum by position.
 */
export const ESTIMATE_SCALES = ["exponential", "fibonacci", "linear", "tshirt"] as const;
export type EstimateScale = (typeof ESTIMATE_SCALES)[number];

export const ESTIMATE_VALUES: Record<EstimateScale, string[]> = {
  exponential: ["1", "2", "4", "8", "16"],
  fibonacci: ["1", "2", "3", "5", "8"],
  linear: ["1", "2", "3", "4", "5"],
  tshirt: ["XS", "S", "M", "L", "XL"],
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
// Guests see only the teams they're added to, and nothing workspace-wide (views, settings beyond their account).
export type Role = "admin" | "member" | "guest" | "agent";

/** The first segment of app URLs other than a workspace's (/<ws>/…): no workspace can take these keys. */
export const RESERVED_WORKSPACE_KEYS = ["api", "doc", "docs", "icons", "issue", "login", "mcp", "settings", "setup", "t", "ws"];

export interface Workspace {
  key: string; // URL-safe lowercase slug, e.g. "acme"; not one of RESERVED_WORKSPACE_KEYS
  name: string;
  role: Role; // yours
  teamCount: number; // the teams you can see
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
  integration: boolean; // an integration's account (GitHub's): never picked, delegated to, given a token or removed as an agent
  teams: string[]; // the teams they're in, of those you can see (keys)
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
  statuses: WorkflowStatus[]; // its workflow: category order, then position
  defaultStatus: string; // where new issues start: a backlog or unstarted key
  autoCloseParent: boolean; // a parent here closes (first completed status) once all its sub-issues are completed or canceled
  autoCloseChildren: boolean; // closing a parent here closes its open sub-issues to the same status
  autoArchiveDays: number | null; // null (default): never; else archive completed/canceled issues this many days after completedAt
  estimateScale: EstimateScale | null; // estimates on, in this scale; null: off (issues keep theirs, hidden)
  cycleWeeks: number | null; // cycles on, each this many weeks (1–8); null: off
  upcomingCycles: number; // upcoming cycles kept ready while cycles are on (1–15)
  currentCycle: number | null; // the current cycle's number, if one is running
  counts: Record<string, number>; // live issues per status key; 0 for each of the team's statuses without any
  docCount: number;
  private: boolean; // only its members see it (admins too, once they join)
  member: boolean; // you're in it
  createdAt: string; // ISO 8601
  updatedAt: string;
}

/**
 * GET /api/workspaces/:key/teams (admins): every team of the workspace, private ones you aren't in too, by key and name
 * only (nothing inside them), so an admin can find one to join.
 */
export interface TeamListing {
  key: string;
  name: string;
  private: boolean;
  member: boolean; // you're in it
  memberCount: number; // its active members
}

export interface TeamInput {
  key: string;
  workspace?: string; // optional: teams are created in the request's workspace, and this must name it if given
  name: string;
  description?: string;
  autoCloseParent?: boolean; // default false
  autoCloseChildren?: boolean; // default false
  autoArchiveDays?: number | null; // default null (never)
  estimateScale?: EstimateScale | null; // default null (off)
  private?: boolean; // default false; the creator is its first member either way (PATCH: admins only)
}

// The key and workspace never change.
export type TeamPatch = Partial<Omit<TeamInput, "key" | "workspace">> & {
  defaultStatus?: string;
  cycleWeeks?: number | null; // 1–8 turns cycles on (or changes the length of those not started yet); null turns them off
  upcomingCycles?: number; // 1–15
  cycleStartsOn?: string; // "YYYY-MM-DD", today or later: where the first cycle starts, only when turning cycles on (default today, UTC)
};

/**
 * A team's cycle (Linear's): one of its repeating planning periods, numbered per team, on UTC dates. When one ends, its
 * unfinished issues roll over to the next.
 */
export interface Cycle {
  team: string;
  number: number; // per team: 1, 2, 3…
  startsAt: string; // ISO, 00:00 UTC
  endsAt: string; // exclusive: the next cycle's startsAt (or when cycles were turned off)
  state: "completed" | "current" | "upcoming";
  issueCount: number; // live issues in it
  completedCount: number; // of those, completed
  progress: number; // 0–1, as a project's: completed issues count 1, started ½; canceled are left out
}

/** The cycle's last day (its exclusive `endsAt` minus one day) as "YYYY-MM-DD", for display: "Sep 28 – Oct 11", never the exclusive end. */
export function cycleLastDay(endsAt: string): string {
  return new Date(Date.parse(endsAt) - 86400000).toISOString().slice(0, 10);
}

export interface IssueSummary {
  id: string; // identifier, e.g. "BRD-12"
  team: string; // team key
  number: number;
  title: string;
  status: string; // a status key of its team's workflow
  statusCategory: StatusCategory; // that status's category, for API clients (the web app reads it from the team)
  priority: Priority;
  estimate: number | null; // 1–5, a position in its team's scale (ESTIMATE_VALUES); null when unset or the team has estimates off
  labels: string[]; // label paths ("Bug", "Type/Feature"), sorted case-insensitively
  assignee: UserRef | null; // a person: who owns it
  delegate: UserRef | null; // an agent working on it for the assignee (Linear's delegate)
  parent: string | null; // identifier
  blockedBy: string[]; // identifiers
  relatedTo: string[]; // identifiers, either direction: related is symmetric
  duplicateOf: string | null; // identifier of the canonical issue this one duplicates
  dueOn: string | null; // due date, a calendar date "YYYY-MM-DD" (no time), as in Linear
  createdAt: string;
  updatedAt: string;
  completedAt: string | null; // set when its status enters the completed or canceled category, cleared when it leaves
  deletedAt: string | null; // in the trash since then; purged 30 days later
  previousIdentifiers: string[]; // identifiers it had before it moved team, oldest first; each still resolves to it
  archivedAt: string | null; // hidden from default lists since then (manually, or by the team's auto-archive period); still searchable and openable
  project: string | null; // its project's slug: an issue is in at most one
  milestone: string | null; // the name of one of its project's milestones
  cycle: number | null; // its team's cycle, by number
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

/** New labels' colors, in turn (a label's own color is any "#rrggbb"). */
export const LABEL_COLORS = ["#357fd4", "#35d48a", "#d48a35", "#7f35d4", "#d43550", "#35c4d4", "#d4b435", "#354ad4", "#d45535", "#d435d4"];

/**
 * A label (Linear's): a workspace's, or one team's own (usable only on that team's issues). A group holds labels one level
 * deep and is never applied itself; an issue carries at most one label per group. Issues name labels by `path`, unique in
 * the workspace case-insensitively.
 */
export interface Label {
  id: number;
  workspace: string;
  team: string | null; // a team's own label, only on its issues; null: a workspace label
  name: string;
  path: string; // "Type/Bug" inside a group, else the name: what issues' `labels` hold
  group: string | null; // its group's name
  isGroup: boolean;
  color: string; // "#rrggbb"
  open: number; // open issues carrying it, not in the trash (a group: carrying any of its labels)
  createdAt: string;
}

export interface LabelInput {
  name: string; // no "/": use a group for Group/Label
  workspace?: string; // optional: labels are created in the request's workspace, and this must name it if given
  team?: string | null; // a team key: that team's own label; default: its group's scope, else the workspace
  color?: string; // default: the next of LABEL_COLORS
  group?: string | null; // the name of a group to put it in
  isGroup?: boolean;
}

export type LabelPatch = { name?: string; color?: string; team?: string | null; group?: string | null };

export const ACTIVITY_KINDS = [
  "created", "team", "title", "description", "status", "priority", "estimate", "assignee", "delegate", "labels", "parent", "blockedBy",
  "relatedTo", "duplicateOf", "dueOn", "claimed", "trashed", "restored", "archived", "unarchived", "project", "milestone", "cycle",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * One change to an issue. from/to by kind: team (its identifier before and after a move), title, parent and duplicateOf (identifiers), status and claimed (status keys), dueOn
 * ("YYYY-MM-DD"), project (a slug) and milestone (its name then) are strings; priority, estimate (a position) and cycle (its number) numbers; assignee, delegate a UserRef; labels, blockedBy,
 * relatedTo string arrays; null when unset, and both
 * null for created, description, trashed, restored, archived, unarchived.
 */
export type ActivityValue = string | number | string[] | UserRef | null;

export interface Activity {
  id: number;
  kind: ActivityKind;
  actor: UserRef; // @docket (Docket itself) for its automated changes, e.g. an auto-close
  onBehalfOf: UserRef | null; // an automated change: whose change set it off
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
  branchName: string; // the git branch to use for it, for the caller: "ana/dkt-12-fix-login"
  links: IssueLink[]; // pull requests, then commits, that mention it (the GitHub integration)
}

/** A pull request or commit linked to an issue by the GitHub integration. Its title comes from GitHub: plain text. */
export interface IssueLink {
  url: string; // http(s)
  kind: "pull_request" | "commit";
  title: string; // the PR's title, or the commit message's first line
  number: number | null; // the PR's number
  state: "draft" | "open" | "merged" | "closed" | null; // PRs only
  closes: boolean; // a closing link (branch, title or closing word) moves the issue along; a contributing one only links
  createdAt: string;
  updatedAt: string;
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
  project: string | null; // the project it's attached to (slug), if any; it keeps its team either way
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
  project?: string; // slug: docs attached to it
  q?: string; // matches title and content
}

export interface DocumentInput {
  team: string;
  title: string;
  content?: string;
  slug?: string; // default: slugified title (a-z, 0-9, "-"), deduped with -2, -3…; "doc-<n>" if empty
  position?: number; // default: last in the team
  project?: string | null; // attach it to a project (slug) of its workspace
}

export interface DocumentPatch {
  title?: string;
  content?: string; // full replacement; mutually exclusive with edits
  edits?: { oldText: string; newText: string }[]; // exact find/replace, applied in order; each oldText must match once
  team?: string; // docs can move between teams of the same workspace; the slug (and the project) stays
  position?: number;
  project?: string | null; // a project (slug) of its workspace; null detaches it
  checkpoint?: boolean; // always record a new version instead of merging into the latest (e.g. a restore)
  baseUpdatedAt?: string; // the updatedAt this edit started from; if the doc has changed since, 409 and nothing is applied
}

export interface IssueInput {
  team: string;
  title?: string; // required unless a template supplies one
  description?: string;
  status?: string; // a status key (or name) of the team's workflow; default: the team's defaultStatus
  priority?: Priority; // default 0
  estimate?: number | null; // 1–5, a position in the team's scale; only on a team with estimates on
  labels?: string[]; // names or paths; an unknown one creates a workspace label (Group/Label: in that group)
  assignee?: string | null; // a person's username, or "me"
  delegate?: string | null; // an agent's username, or "me" (as an agent)
  parent?: string | null;
  blockedBy?: string[];
  relatedTo?: string[]; // replaces the whole list, on both sides
  duplicateOf?: string | null; // marks it a duplicate of that issue and sets its team's Duplicate status; null clears (status stays)
  dueOn?: string | null; // "YYYY-MM-DD"; null clears
  project?: string | null; // a project's slug (its team joins the project); a sub-issue defaults to its parent's, and its milestone
  milestone?: string | null; // a milestone's name in its project; changing the project clears it unless one is named too
  cycle?: number | "current" | "next" | null; // a cycle of the team (not a completed one); a sub-issue defaults to its parent's when it starts unstarted or started
  /** An issue template's id (of the same team): its title, description, status, priority and labels are applied
   *  first, then this input's own fields (which win), then the usual defaults. */
  template?: number;
}

export type IssuePatch = Partial<Omit<IssueInput, "team" | "template">> & {
  // Moves it to another team of its workspace: it gets that team's next number, and its old identifier keeps resolving.
  // Its status carries over by key, else the team's first of that category, else the team's default; the old team's own labels come off.
  team?: string;
  baseUpdatedAt?: string; // the updatedAt you read; if the issue changed since, the patch is refused (409)
};

/**
 * A team's saved prefill for new issues (Linear's issue templates; team-scoped only, no workspace-wide tier).
 * Picking one in the New issue modal, or passing its id as create_issue's `template`, seeds title, description,
 * status, priority and labels; picking or applying one only seeds the draft, so anything typed afterward, or
 * passed explicitly alongside `template`, still wins. Deleting a template never touches issues made from it.
 */
export interface IssueTemplate {
  id: number;
  team: string; // team key
  name: string; // labels it in the picker, e.g. "Bug report"
  title: string; // the prefilled title, often a scaffold like "Bug: "
  description: string; // markdown
  status: string | null; // a status key of the team's workflow; null: the team's default status at use time
  priority: Priority | null; // null: default (0) at use time
  labels: string[]; // label paths, sorted case-insensitively
  createdAt: string;
  updatedAt: string;
}

export interface IssueTemplateInput {
  team: string;
  name: string;
  title?: string;
  description?: string;
  status?: string | null;
  priority?: Priority | null;
  labels?: string[];
}

export type IssueTemplatePatch = Partial<Omit<IssueTemplateInput, "team">>;

/**
 * POST /api/issues/bulk: one change for up to 100 issues, applied to each in turn exactly as its own PATCH
 * or DELETE would be. `addLabels`/`removeLabels` edit each issue's own labels (after `labels`, if given).
 */
export type BulkIssuePatch =
  | (Pick<IssuePatch, "status" | "priority" | "estimate" | "assignee" | "delegate" | "project" | "labels"> & { addLabels?: string[]; removeLabels?: string[] })
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
  status?: string[]; // status keys; each must be one of some team's in scope
  category?: StatusCategory[];
  label?: string; // a label's name or path, or a group's name (any of its labels)
  assignee?: string; // username or "me"
  delegate?: string; // username or "me"
  creator?: string; // username or "me" -- who filed it
  parent?: string;
  project?: string; // slug
  cycle?: string; // "current" (each team's current cycle) or a number (with team)
  q?: string; // matches identifier, title, description
  subscribed?: boolean; // true: only issues you're subscribed to
  due?: DueFilter;
  sort?: IssueSort;
  archived?: boolean; // true: include archived issues (default: excluded, unless q is set)
}

/**
 * Linear's due-date filters, by the server's date (UTC): overdue (before today, not completed or canceled), soon (today to 7 days
 * ahead), today, any (has a due date), none (no due date).
 */
export const DUE_FILTERS = ["overdue", "soon", "today", "any", "none"] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

/** List order: default (status category, the team's status order, priority, most recently updated) or due (earliest due date first, none last; then default). */
export const ISSUE_SORTS = ["default", "due"] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

// --- Views: saved filters with display options (Linear's custom views), shared by a workspace's members ---

/** The IssueFilter fields a view saves: all but `sort`, since a view orders by its display's `orderBy`. */
export const VIEW_FILTER_FIELDS = ["team", "status", "category", "label", "assignee", "delegate", "creator", "parent", "project", "cycle", "q", "subscribed", "due", "archived"] as const;
export type ViewFilter = Pick<IssueFilter, (typeof VIEW_FILTER_FIELDS)[number]>;

export const GROUP_BYS = ["status", "assignee", "priority", "label"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const ORDER_BYS = ["priority", "updated", "created"] as const;
export type OrderBy = (typeof ORDER_BYS)[number];
export const LAYOUTS = ["list", "board"] as const;
export type Layout = (typeof LAYOUTS)[number];

export interface ViewDisplay {
  groupBy: GroupBy; // default "status"
  orderBy: OrderBy; // default "priority": priority (1→4, none last), then most recently updated
  layout: Layout; // default "list"
}

export interface CustomView {
  id: number;
  workspace: string;
  name: string;
  filter: ViewFilter; // applied in the viewer's workspace; "me" means the viewer
  display: ViewDisplay;
  creator: UserRef; // with workspace admins, the only one who can change or delete it
  favorite: boolean; // yours (the caller's): starred into your sidebar
  createdAt: string;
  updatedAt: string;
}

export interface CustomViewInput {
  name: string;
  workspace?: string; // optional: views are created in the request's workspace, and this must name it if given
  filter?: ViewFilter;
  display?: Partial<ViewDisplay>;
}

export type CustomViewPatch = { name?: string; filter?: ViewFilter; display?: Partial<ViewDisplay> }; // filter: replaces the whole filter

export const NOTIFICATION_KINDS = ["assigned", "delegated", "mentioned", "commented", "status"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Something in your inbox: one event on an issue or doc, by someone else. */
export interface Notification {
  id: number;
  kind: NotificationKind;
  workspace: string;
  actor: UserRef;
  issue: { id: string; title: string; status: string } | null; // id: identifier; status: a key of its team's workflow
  document: { slug: string; title: string } | null;
  comment: { id: number; excerpt: string } | null; // first 200 characters as plain text, newlines as spaces; null once deleted
  status: string | null; // kind "status": the status key it moved to
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

/** A workspace's GitHub integration (admins, in a browser session). The secret is shown once: by connecting, or a new secret. */
export interface GitHubConnection {
  connected: boolean;
  url: string; // the payload URL to give GitHub
  account: UserRef | null; // the GitHub agent account its changes are made as; null before the first connect
}

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

// Attachments: files uploaded to a workspace, linked from markdown by their url. Private to the workspace's members.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface Attachment {
  id: string; // 16 random bytes, base64url (22 characters)
  url: string; // "/api/attachments/<id>/<encoded name>": what markdown links to
  name: string;
  contentType: string; // sniffed by Docket, never the uploader's claim
  size: number;
  uploader: UserRef;
  team: string | null; // the team it was uploaded in (only those who see the team get it), or null: the workspace's
  createdAt: string;
}

/** The only images markdown loads: same-origin attachment URLs. Anything else shows as a link. */
export const ATTACHMENT_URL = /^\/api\/attachments\/([A-Za-z0-9_-]{22})\/[^/?#\s"'<>\\]+$/;

/** The raster images an attachment may be shown as; everything else downloads. */
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** An attachment's name in markdown link text: brackets and backslashes dropped, the rest of markdown's punctuation escaped. */
const label = (name: string) => name.replace(/[[\]\\]/g, "").replace(/[*_`<>]/g, "\\$&") || "file";

/** The markdown that shows an attachment: an image for raster images, else a link. */
export const attachmentMarkdown = (a: Pick<Attachment, "name" | "url" | "contentType">) =>
  `${INLINE_IMAGE_TYPES.includes(a.contentType) ? "!" : ""}[${label(a.name)}](${a.url})`;

// --- Projects (Linear's): a body of work toward a goal, spanning one or more teams of a workspace ---

/** Linear's project lifecycle, fixed (not customizable). */
export const PROJECT_STATUSES = ["backlog", "planned", "in_progress", "paused", "completed", "canceled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  backlog: "Backlog", planned: "Planned", in_progress: "In Progress", paused: "Paused", completed: "Completed", canceled: "Canceled",
};

export interface ProjectSummary {
  slug: string; // unique within its workspace, stable, URL-safe, like a doc's
  workspace: string;
  name: string;
  status: ProjectStatus;
  lead: UserRef | null; // a person
  teams: string[]; // keys of the teams taking part (at least one), sorted
  targetDate: string | null; // "YYYY-MM-DD"
  progress: number; // 0–1 over its live issues: a completed one counts 1, a started one ½; canceled ones are left out
  issueCount: number; // its live issues
  createdAt: string;
  updatedAt: string; // version token for baseUpdatedAt
}

export interface Milestone {
  id: number;
  name: string; // unique within its project, case-insensitively
  description: string;
  targetDate: string | null;
  position: number; // order within the project
  progress: number; // as the project's, over its issues
  issueCount: number;
}

export interface Project extends ProjectSummary {
  description: string; // markdown
  creator: UserRef;
  milestones: Milestone[]; // by position
  docs: DocumentSummary[]; // attached docs
}

export interface ProjectInput {
  teams: string[]; // keys of teams of the request's workspace
  name: string;
  description?: string;
  status?: ProjectStatus; // default backlog
  lead?: string | null; // a person's username, or "me"
  targetDate?: string | null; // "YYYY-MM-DD"
  slug?: string; // default: slugified name, deduped; "project-<n>" if empty
}

export type ProjectPatch = Partial<Omit<ProjectInput, "slug">> & {
  baseUpdatedAt?: string; // the updatedAt you read; if the project changed since, the patch is refused (409)
};

export interface MilestoneInput {
  name: string;
  description?: string;
  targetDate?: string | null; // "YYYY-MM-DD"
  position?: number; // default: last
}

export type MilestonePatch = Partial<MilestoneInput>;

// Pushed over the WebSocket at /ws after every mutation, to the workspace's members. "inbox" events (and
// subscription changes) go only to that one user's sockets in that workspace.
export interface ServerEvent {
  type: "changed";
  entity: "workspace" | "member" | "team" | "issue" | "document" | "label" | "project" | "view" | "inbox";
  workspace: string;
  id: string; // workspace key, username, team key, issue identifier, document or project slug, label id or view id; inbox: the recipient's username
}

export interface ApiError {
  error: string;
}

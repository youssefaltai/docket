import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ACTIVE_CATEGORIES,
  CLOSED_CATEGORIES,
  DUE_FILTERS,
  ESTIMATE_SCALES,
  ESTIMATE_VALUES,
  INLINE_IMAGE_TYPES,
  ISSUE_SORTS,
  attachmentMarkdown,
  cycleLastDay,
  PRIORITIES,
  PRIORITY_LABELS,
  PROJECT_STATUSES,
  STATUS_CATEGORIES,
  type Activity,
  type Permission,
  type WorkspaceRole,
  PERMISSIONS,
  TEAM_PERMISSIONS,
  type Comment,
  type Cycle,
  type Document,
  type DocumentSummary,
  type EstimateScale,
  type Issue,
  type IssueLink,
  type IssueSummary,
  type Notification,
  type Priority,
  type Project,
  type ProjectSummary,
  type Reaction,
  type UserRef,
} from "../shared/types.ts";
import * as access from "./access.ts";
import type { Actor } from "./access.ts";
import { files, getAttachment, saveAttachment } from "./attachments.ts";
import { actorOf } from "./auth.ts";
import { AppError } from "./db.ts";
import { originOf } from "./http.ts";
import * as inbox from "./inbox.ts";
import * as rolesApi from "./roles.ts";
import { holdsAnywhere, readOnly } from "./permissions.ts";
import * as tracker from "./tracker.ts";

/** Where this connection is and who it acts as. `username`: yours in `workspace`. */
type Here = { origin: string; workspace: string; workspaceName: string; username: string };

// The first line says which Docket and workspace this is, so an agent with several connections can tell them apart.
const instructions = (a: Actor, here: Here) => `You're connected to Docket at ${here.origin}, workspace "${here.workspaceName}" (${here.workspace}), as @${here.username} (${a.kind}). Every tool acts there.
Docket is an issue tracker shared by people and agents, modeled on Linear.
- Workspace → team → issues and docs. Your key works in one workspace: everything you list, read and change is there.
- Teams have a 2–5 letter key (e.g. BRD), unique within this workspace. Issues are identified as KEY-number, e.g. BRD-12. A team may use cycles, repeating 1–8 week planning periods (list_cycles); unfinished issues roll over to the next cycle when one ends.
- Each team has its own statuses, named by key (list_teams shows them), in Linear's fixed categories: triage (new, not yet accepted), backlog, unstarted, started, completed, canceled. By default a team has backlog, todo, in_progress, in_review, done, canceled and duplicate. Priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
- People and agents are named by username (@alice), unique within this workspace. An issue's assignee is a person who owns it; its delegate is an agent working on it for them. "me" means you.
${
  readOnly(a)
    ? "- This key is read-only: you can list and read everything here, but not change anything."
    : "- Working on an issue: get_issue, then claim_issue (an agent becomes its delegate, a person its assignee, and it moves to the team's first started status, in_progress by default; if someone else holds it, pick another), post progress notes with comment_issue, then set in_review when it's ready for review or done when finished (or the team's own statuses in those categories). There is no delete: set status canceled instead."
}
- Documents (specs, plans, notes) live in teams and are identified by a slug, e.g. "architecture". They are markdown: mention issues by identifier (BRD-2) and they auto-link; link other docs with [Title](/doc/slug). Change a long doc with update_document's \`edits\` rather than rewriting it.
- Projects (list_projects) group issues from one or more teams toward a goal, with a lead, status, target date and milestones (stages); an issue is in at most one project and one of its milestones. Identified by slug.
- Mention people or agents as @username (see list_members) in descriptions, comments and docs.
- Your inbox (list_notifications) is what needs you: issues delegated or assigned to you, @mentions of you, and new comments or status changes on issues and docs you're subscribed to (you're subscribed to what you create, claim, are assigned, delegated, mentioned in, or comment on). Check it when you start; mark items read once handled.`;

const identifier = z.string().describe('Issue identifier: team key + number, e.g. "BRD-12" (case-insensitive)');
const teamKey = z.string().describe('Team key, e.g. "BRD" (see list_teams)');
const status = z.string().describe('A status key of the issue\'s team, e.g. "in_progress" (list_teams lists each team\'s statuses; the name, e.g. "In Progress", also works)');
const priority = z.literal(PRIORITIES).describe("0 none, 1 urgent, 2 high, 3 medium, 4 low");
const labels = z.array(z.string()).describe('Label names, e.g. ["bug", "Type/Feature"]. Reuse labels from list_labels; an unknown name creates a workspace label, and Group/Label creates it in that group. At most one label per group.');
const blockedBy = z.array(identifier).describe("Identifiers of issues that must be finished before this one");
const relatedTo = z.array(identifier).describe("Identifiers of issues connected to this one that aren't duplicates or blockers; related is two-way. Replaces the whole list");
const duplicateOf = identifier.describe("The issue this one duplicates: it's set to its team's Duplicate status (a canceled one) and the relation is recorded");
const dueOn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Due date, a calendar date like "2026-09-30" (no time)');
const estimate = z.number().int().min(1).max(5).describe("A position in the team's estimate scale, 1 (smallest) to 5, if the team has estimates on (list_teams shows its scale and values)");
const cycle = z.union([z.number().int(), z.enum(["current", "next"])]).describe('The team\'s cycle: its number, "current" or "next"; null to take it out. Only for teams that use cycles (list_teams says so). Unfinished issues roll over to the next cycle automatically.');
const assignee = z.string().describe('A person\'s username (see list_members), or "me"');
const delegate = z.string().describe('An agent\'s username (see list_members), or "me" if you are one');

const slug = z.string().describe('Document slug, e.g. "architecture" (see list_documents)');
const projectSlug = z.string().describe('Project slug, e.g. "launch" (see list_projects)');
const milestone = z.string().describe("A milestone's name in the issue's project (get_project lists them)");
const docProject = projectSlug.describe("Attach the doc to a project (slug) of its workspace; null to detach");
const targetDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Target date, a calendar date like "2026-12-01"');
const MENTION = "Mention people or agents as @username (list_members has usernames).";
const docContent = z.string().describe(`Markdown. Mention issues by identifier (e.g. BRD-2) and they auto-link; link other docs with [Title](/doc/slug). ${MENTION}`);

const title = z.string().describe("Short, imperative title");
const description = z.string().describe(`Markdown description. ${MENTION}`);
const body = z.string().describe(`Markdown. ${MENTION}`);
const parent = z.number().int().optional().describe("Reply in the thread of comment #N (ids are shown in get_issue/get_document). Reply to the comment you're answering rather than starting a new one; replying reopens a resolved thread.");
const THREADS = "Comments are threaded: top-level comments start threads, replies go under them.";

const at = (user: UserRef) => `@${user.username}`;

/** "👍 2 🎉 1", or "" with none. */
const reactionsText = (reactions: Reaction[]) => reactions.map((r) => `${r.emoji} ${r.users.length}`).join(" ");

/** "Reactions: 👀 1 (@claude), 👍 2 (@ana, @bob)", or false with none. */
const reactionsLine = (reactions: Reaction[]) =>
  reactions.length > 0 && `Reactions: ${reactions.map((r) => `${r.emoji} ${r.users.length} (${r.users.map(at).join(", ")})`).join(", ")}`;

/** "due 2026-10-01", or "overdue 2026-09-20" for an open issue due before today (the server's date, UTC). */
function due(issue: IssueSummary): string | null {
  if (!issue.dueOn) return null;
  const overdue = issue.dueOn < new Date().toISOString().slice(0, 10) && !CLOSED_CATEGORIES.includes(issue.statusCategory);
  return `${overdue ? "overdue" : "due"} ${issue.dueOn}`;
}

/** An estimate position as its team's scale shows it: 4 is "5" in fibonacci, "L" in tshirt. */
const estimateValue = (scale: EstimateScale | null, position: number) => (scale ? ESTIMATE_VALUES[scale][position - 1]! : String(position));

/** One line per issue: `BRD-3 · todo · high · Title · @assignee · →@delegate · #label · due 2026-10-01`. */
function line(issue: IssueSummary): string {
  return [
    issue.id,
    issue.status,
    PRIORITY_LABELS[issue.priority].toLowerCase(),
    issue.title,
    issue.assignee && at(issue.assignee),
    issue.delegate && `→${at(issue.delegate)}`,
    issue.labels.map((l) => `#${l}`).join(" "),
    due(issue),
  ].filter(Boolean).join(" · ");
}

/** A linked PR or commit: `PR #12 · open · Fix login · <url>`, `commit · Fix typo · <url>`. */
const linkLine = (l: IssueLink) =>
  (l.kind === "pull_request" ? [`PR #${l.number}`, l.state, l.title, l.url] : ["commit", l.title, l.url]).filter(Boolean).join(" · ");

function details(issue: Issue, scale: EstimateScale | null): string {
  const meta = [
    `team ${issue.team}`,
    issue.estimate !== null && `estimate ${estimateValue(scale, issue.estimate)}`,
    issue.previousIdentifiers.length > 0 && `previously ${issue.previousIdentifiers.join(", ")}`,
    issue.project && `project ${issue.project}`,
    issue.milestone && `milestone ${issue.milestone}`,
    issue.cycle !== null && `cycle ${issue.cycle}`,
    `created by ${at(issue.creator)}`,
    issue.parent && `parent ${issue.parent}`,
    issue.blockedBy.length > 0 && `blocked by ${issue.blockedBy.join(", ")}`,
    issue.blocks.length > 0 && `blocks ${issue.blocks.join(", ")}`,
    issue.relatedTo.length > 0 && `related to ${issue.relatedTo.join(", ")}`,
    issue.duplicateOf && `duplicate of ${issue.duplicateOf}`,
    issue.duplicates.length > 0 && `duplicates: ${issue.duplicates.join(", ")}`,
    `updated ${issue.updatedAt}`,
    `branch ${issue.branchName}`,
  ];
  const parts = [line(issue), meta.filter(Boolean).join(" · "), issue.description || "_No description._", reactionsLine(issue.reactions)];
  if (issue.deletedAt) parts.unshift(`**In the trash** since ${issue.deletedAt}: read-only until someone restores it.`);
  if (issue.children.length) parts.push(`## Sub-issues\n${issue.children.map(line).join("\n")}`);
  if (issue.docs.length) parts.push(`## Docs\n${issue.docs.map(docLine).join("\n")}`);
  if (issue.links.length) parts.push(`## Links\n${issue.links.map(linkLine).join("\n")}`);
  if (issue.activity.length) parts.push(historySection(issue.activity, scale));
  if (issue.comments.length) parts.push(commentsSection(issue.comments));
  return parts.filter(Boolean).join("\n\n");
}

/** One change, compactly: `status todo → in_progress`, `labels +bug −ui`; Docket's own say whose change set them off. */
function change(row: Activity, scale: EstimateScale | null): string {
  const { kind, from, to, onBehalfOf } = row;
  if (onBehalfOf && kind === "status") return `closed the issue, status ${from} → ${to} (after ${at(onBehalfOf)}'s change)`; // an auto-close
  const show = (v: Activity["from"]) => {
    if (v === null || v === 0) return "none"; // 0: no priority
    if (typeof v === "object") return at(v as UserRef);
    if (kind === "estimate") return estimateValue(scale, v as number);
    return kind === "priority" ? PRIORITY_LABELS[v as Priority].toLowerCase() : String(v);
  };
  const diff = () => {
    const [was, now] = [(from ?? []) as string[], (to ?? []) as string[]];
    return [...now.filter((v) => !was.includes(v)).map((v) => `+${v}`), ...was.filter((v) => !now.includes(v)).map((v) => `−${v}`)].join(" ");
  };
  switch (kind) {
    case "created":
    case "restored":
    case "archived":
    case "unarchived":
      return kind;
    case "title":
      return `title ${JSON.stringify(from)} → ${JSON.stringify(to)}`;
    case "description":
      return "edited the description";
    case "labels":
      return `labels ${diff()}`;
    case "blockedBy":
      return `blocked by ${diff()}`;
    case "relatedTo":
      return `related ${diff()}`;
    case "duplicateOf":
      return `duplicate of ${show(from)} → ${show(to)}`;
    case "dueOn":
      return `due date ${show(from)} → ${show(to)}`;
    case "claimed":
      return `claimed (${from} → ${to})`;
    case "trashed":
      return "moved to trash";
    default:
      return `${kind} ${show(from)} → ${show(to)}`;
  }
}

const HISTORY_LINES = 30;

/**
 * One line per mutation, the latest 30: `time · @who · change, change`. A mutation's rows are consecutive,
 * with one actor and time, and never repeat a kind (that starts the next mutation, made in the same millisecond).
 */
function historySection(activity: Activity[], scale: EstimateScale | null): string {
  const lines: { key: string; kinds: string[]; text: string[] }[] = [];
  for (const row of activity) {
    const key = `${row.createdAt} · ${at(row.actor)}`;
    const last = lines.at(-1);
    if (last?.key === key && !last.kinds.includes(row.kind)) {
      last.kinds.push(row.kind);
      last.text.push(change(row, scale));
    } else lines.push({ key, kinds: [row.kind], text: [change(row, scale)] });
  }
  const cut = lines.length - HISTORY_LINES;
  const shown = lines.slice(-HISTORY_LINES).map((l) => `${l.key} · ${l.text.join(", ")}`);
  return `## History\n${cut > 0 ? `(${cut} earlier changes)\n` : ""}${shown.join("\n")}`;
}

/** Threads in order: each root, then its replies (`↳`); a resolved thread is its root's header only (bodies are in structuredContent). */
function commentsSection(comments: Comment[]): string {
  // A collapsed resolved thread hides reactions along with the bodies.
  const headerBase = (c: Comment) => [`**${at(c.author)}**`, `#${c.id}`, c.createdAt, c.editedAt && "edited"].filter(Boolean).join(" · ");
  const header = (c: Comment) => [headerBase(c), reactionsText(c.reactions)].filter(Boolean).join(" · ");
  const threads = comments
    .filter((c) => c.parent === null)
    .map((root) => {
      const replies = comments.filter((c) => c.parent === root.id);
      if (root.resolvedAt) return `${headerBase(root)} · resolved by ${at(root.resolvedBy!)} · ${replies.length} ${replies.length === 1 ? "reply" : "replies"}`;
      return [root, ...replies].map((c) => `${c.parent === null ? "" : "↳ "}${header(c)}\n${c.body}`).join("\n\n");
    });
  return `## Comments\n${threads.join("\n\n")}`;
}

/** Routes a comment tool to its issue or its document; exactly one must be given. */
function commentOn<T>({ issue, document }: { issue?: string; document?: string }, onIssue: (id: string) => T, onDocument: (slug: string) => T): T {
  if (issue && !document) return onIssue(issue);
  if (document && !issue) return onDocument(document);
  throw new AppError("Pass exactly one of issue or document");
}

function ago(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (60 * 24))}d ago`;
}

/** One line per document: `slug · Title · TEAM · updated 2h ago by @alice`. */
const docLine = (doc: DocumentSummary) => `${doc.slug} · ${doc.title} · ${doc.team} · updated ${ago(doc.updatedAt)} by ${at(doc.updatedBy)}`;

function docDetails(doc: Document): string {
  const parts = [
    doc.deletedAt && `**In the trash** since ${doc.deletedAt}: read-only until someone restores it.`,
    `# ${doc.title}`,
    `slug ${doc.slug} · team ${doc.team}${doc.project ? ` · project ${doc.project}` : ""} · updated ${doc.updatedAt} by ${at(doc.updatedBy)} · ${doc.versionCount} version${doc.versionCount === 1 ? "" : "s"}`,
    "---",
    doc.content || "_Empty._",
    "---",
  ];
  if (doc.issues.length) parts.push(`## Mentioned issues\n${doc.issues.map(line).join("\n")}`);
  if (doc.comments.length) parts.push(commentsSection(doc.comments));
  return parts.filter(Boolean).join("\n\n");
}

const percent = (progress: number) => `${Math.round(progress * 100)}%`;

/** One line per project: `launch · Launch · in_progress · 42% · @ana · target 2026-12-01 · teams APP, WEB`. */
function projectLine(p: ProjectSummary): string {
  return [p.slug, p.name, p.status, percent(p.progress), p.lead && at(p.lead), p.targetDate && `target ${p.targetDate}`, `teams ${p.teams.join(", ")}`]
    .filter(Boolean)
    .join(" · ");
}

function projectDetails(p: Project): string {
  const milestones = p.milestones.map((m) =>
    [`${m.name} · ${percent(m.progress)} of ${m.issueCount} issue${m.issueCount === 1 ? "" : "s"}`, m.targetDate && `target ${m.targetDate}`, m.description]
      .filter(Boolean)
      .join(" · "),
  );
  const parts = [
    `# ${p.name}`,
    `${projectLine(p)} · ${p.issueCount} issue${p.issueCount === 1 ? "" : "s"} · created by ${at(p.creator)} · updated ${p.updatedAt}`,
    "---",
    p.description || "_No description._",
    "---",
    `## Milestones\n${milestones.join("\n") || "None yet."}`,
  ];
  if (p.docs.length) parts.push(`## Docs\n${p.docs.map(docLine).join("\n")}`);
  return parts.join("\n\n");
}

/** One line per cycle: `Cycle 12 · current · 2026-09-28 – 2026-10-11 · 3/8 done · 44%` (shows the last day, not the exclusive end). */
function cycleLine(c: Cycle): string {
  return [`Cycle ${c.number}`, c.state, `${c.startsAt.slice(0, 10)} – ${cycleLastDay(c.endsAt)}`, `${c.completedCount}/${c.issueCount} done`, percent(c.progress)].join(" · ");
}

/** One line per notification: `#41 · unread · delegated · BRD-12 Fix login · by @ana · 5m ago · "excerpt"`. */
function notificationLine(n: Notification): string {
  const target = n.issue ? `${n.issue.id} ${n.issue.title}` : n.document ? `doc ${n.document.slug} (${n.document.title})` : "";
  const kind = n.kind === "status" ? `status → ${n.status}` : n.kind;
  const excerpt = n.comment && `"${n.comment.excerpt}"`;
  return [`#${n.id}`, n.readAt ? "read" : "unread", kind, target, `by ${at(n.actor)}`, ago(n.createdAt), excerpt].filter(Boolean).join(" · ");
}

/** Mutations echo metadata only, so a long document isn't sent back on every edit. */
const docMeta = ({ content, ...meta }: Document) => ({ document: meta });

const result = (text: string, structuredContent: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text }], structuredContent });

function createServer(a: Actor, origin: string): McpServer {
  const workspace = access.requestWorkspace(a); // a key's own
  const here = { origin, workspace, workspaceName: access.listWorkspaces(a).find((w) => w.key === workspace)!.name, username: access.usernameOf(a)! };
  const server = new McpServer(
    { name: `docket-${workspace}`, title: `Docket · ${here.workspaceName}`, version: "1.0.0", websiteUrl: origin },
    { instructions: instructions(a, here) },
  );
  /**
   * Registers a tool only if this caller can use it, so tools/list shows just those: a read key gets the read-only tools,
   * and `requires` narrows the rest to those who hold each permission here or in some team (holdsAnywhere); the tool
   * still checks it, in its team, when called. Calling a hidden one is a "not found" tool error.
   */
  const register = <I extends ZodRawShapeCompat | undefined = undefined>(
    name: string,
    config: { description: string; inputSchema?: I; annotations?: ToolAnnotations },
    cb: ToolCallback<I>,
    requires: Permission[] = [],
  ) => {
    if (readOnly(a) && !config.annotations?.readOnlyHint) return;
    if (!requires.every((p) => holdsAnywhere(a, p))) return;
    server.registerTool(name, config, cb);
  };

  register(
    "update_workspace",
    {
      description: "Rename your workspace (admins only). Its key never changes. Only do this when asked to.",
      inputSchema: { name: z.string() },
    },
    ({ name }) => {
      const workspace = access.updateWorkspace(a, access.requestWorkspace(a), { name });
      return result(`Updated workspace ${workspace.key} · ${workspace.name}`, { workspace });
    },
    ["workspace.rename"],
  );

  register(
    "list_members",
    {
      description: "List a workspace's people and agents, one line each: @username · name · role (its name), then `integration` (GitHub's account), `suspended` and `you` where they apply. Assignees are people; delegates are agents.",
      annotations: { readOnlyHint: true },
    },
    () => {
      const members = access.listMembers(a, access.requestWorkspace(a));
      const you = access.usernameOf(a);
      const lines = members.map((m) =>
        [at(m.user), m.user.name, m.roleName, m.integration && "integration", m.suspendedAt && "suspended", m.user.username === you && "you"].filter(Boolean).join(" · "),
      );
      return result(lines.join("\n"), { members, you });
    },
  );

  register(
    "list_teams",
    {
      description: "List the teams you can see in this workspace, one line each: key · name · workspace · `private` (only its members see it) · `member` (you're in it) · open count · status keys in workflow order, the default for new issues marked, the estimate scale if the team has estimates on (an issue's estimate is a position 1-5 in it), and its cycle length and current cycle if it uses cycles. A team's key (e.g. BRD) prefixes its issue identifiers (BRD-12). Statuses are per team: use a team's own keys for its issues (categories: triage, backlog, unstarted, started, completed, canceled; structuredContent has each status's name and category).",
      annotations: { readOnlyHint: true },
    },
    () => {
      const teams = tracker.listTeams(a);
      const lines = teams.map((t) => {
        const open = t.statuses.filter((s) => ACTIVE_CATEGORIES.includes(s.category)).reduce((sum, s) => sum + (t.counts[s.key] ?? 0), 0);
        const statuses = t.statuses.map((s) => (s.key === t.defaultStatus ? `${s.key} (default)` : s.key)).join(", ");
        const estimates = t.estimateScale && `estimates: ${t.estimateScale} (${ESTIMATE_VALUES[t.estimateScale].join(", ")})`;
        const cycles =
          t.cycleWeeks && `cycles every ${t.cycleWeeks === 1 ? "week" : `${t.cycleWeeks} weeks`}${t.currentCycle === null ? "" : `, current ${t.currentCycle}`}`;
        const marks = [t.private && "private", t.member && "member"];
        return [t.key, t.name, `workspace ${t.workspace}`, ...marks, `${open} open`, `statuses: ${statuses}`, estimates, cycles].filter(Boolean).join(" · ");
      });
      return result(lines.join("\n") || "No teams yet.", { teams });
    },
  );

  register(
    "create_team",
    {
      description: "Create a team in a workspace. The key is 2–5 letters (uppercased), permanent, unique within this workspace, and prefixes every issue identifier: key BRD gives BRD-1, BRD-2… Check list_teams first; only create a team when asked to.",
      inputSchema: {
        key: z.string().describe('2–5 letters, e.g. "BRD"'),
        name: z.string(),
        description: z.string().optional(),
      },
    },
    (input) => {
      const team = tracker.createTeam(a, input);
      return result(`Created team ${team.key} · ${team.name} in workspace ${team.workspace}`, { team });
    },
  );

  register(
    "update_team",
    {
      description: "Update a team's name, description, auto-close settings, auto-archive, estimate scale or cycles; only the fields you pass change. Its key and workspace never change. Only do this when asked to.",
      inputSchema: {
        key: teamKey,
        name: z.string().optional(),
        description: z.string().optional(),
        autoCloseParent: z.boolean().optional().describe("Close a parent issue (to the team's first completed status) once all its sub-issues are completed or canceled"),
        autoCloseChildren: z.boolean().optional().describe("When a parent issue is completed or canceled, close its open sub-issues to the same status"),
        autoArchiveDays: z.number().int().positive().nullable().optional().describe("Archive an issue this many days after it's completed or canceled; null for never"),
        estimateScale: z.enum(ESTIMATE_SCALES).nullable().optional().describe("Turn estimates on with this scale: exponential 1,2,4,8,16; fibonacci 1,2,3,5,8; linear 1-5; tshirt XS,S,M,L,XL. null turns them off (issues keep theirs, hidden)"),
        cycleWeeks: z.number().int().min(1).max(8).nullable().optional().describe("Turn cycles on with this length in weeks (1-8), or change the length of cycles not started yet; null turns cycles off"),
        upcomingCycles: z.number().int().min(1).max(15).optional().describe("How many upcoming cycles to keep ready (1-15)"),
        cycleStartsOn: z.string().optional().describe("YYYY-MM-DD, today or later: where the first cycle starts. Only when turning cycles on"),
      },
    },
    ({ key, ...patch }) => {
      const team = tracker.updateTeam(a, key, patch);
      return result(`Updated team ${team.key} · ${team.name} in workspace ${team.workspace}`, { team });
    },
  );

  register(
    "list_labels",
    {
      description: "List labels, one line each: label · color · open issue count, plus `team KEY` for a team's own label (usable only on that team's issues). A label written Group/Label belongs to a group, and an issue carries at most one label per group. Check this before labeling an issue and reuse an existing label rather than inventing a near-duplicate.",
      inputSchema: { team: teamKey.optional().describe("Only labels usable on this team's issues") },
      annotations: { readOnlyHint: true },
    },
    ({ team }) => {
      const labels = tracker.listLabels(a, { team });
      const lines = labels.filter((l) => !l.isGroup).map((l) => [l.path, l.color, l.team && `team ${l.team}`, `${l.open} open`].filter(Boolean).join(" · "));
      return result(lines.join("\n") || "No labels yet.", { labels });
    },
  );

  register(
    "list_cycles",
    {
      description: "List a team's cycles (its repeating planning periods, if it uses them), one line each: Cycle N · current|upcoming|completed · start – end dates · done/total issues · progress %. Put an issue in one with create_issue or update_issue's `cycle`.",
      inputSchema: { team: teamKey },
      annotations: { readOnlyHint: true },
    },
    ({ team }) => {
      const cycles = tracker.listCycles(a, team);
      return result(cycles.map(cycleLine).join("\n") || `${team.trim().toUpperCase()} has no cycles.`, { cycles });
    },
  );

  register(
    "list_templates",
    {
      description: "List a team's issue templates, one line each: id · name · TEAM. Pass a template's id as create_issue's template to prefill title, description, status, priority and labels. Team-scoped only: managed by people in team settings.",
      inputSchema: { team: teamKey.optional().describe("Only this team's templates") },
      annotations: { readOnlyHint: true },
    },
    ({ team }) => {
      const templates = tracker.listTemplates(a, { team });
      const lines = templates.map((t) => `${t.id} · ${t.name} · ${t.team}`);
      return result(lines.join("\n") || "No templates yet.", { templates });
    },
  );

  register(
    "list_issues",
    {
      description: "List issues, one line each: identifier · status · priority · title · @assignee · →@delegate · #labels · due date (\"overdue\" when an open issue's date has passed). Sorted by status (category order: triage, backlog, unstarted, started, completed, canceled; then the team's order), then priority (urgent first, none last), then most recently updated; sort \"due\" puts the earliest due date first (none last). By default only active issues (backlog, unstarted and started categories); pass `category` (e.g. [\"triage\"] for issues waiting to be accepted, [\"completed\"] for finished ones) or `status` keys for others. There is no 'open' status. Pages of `limit` (default 50): when there are more, the output ends with a cursor to pass as `after` for the next page. Unknown team, assignee, delegate, creator or parent is an error, not an empty list. Use get_issue for the description, comments, sub-issues and blockers.",
      inputSchema: {
        team: teamKey.optional(),
        status: z.array(z.string()).optional().describe('Only these status keys, e.g. ["in_progress"] (list_teams shows each team\'s). Leave status and category out for active issues; "open" is not a status.'),
        category: z.array(z.enum(STATUS_CATEGORIES)).optional().describe("Only statuses in these categories, e.g. [\"triage\"] or [\"completed\", \"canceled\"]. Default (with no status either): backlog, unstarted, started"),
        priority: z.array(priority).optional().describe("Only these priorities, e.g. [1, 2] for urgent and high (0 none, 1 urgent, 2 high, 3 medium, 4 low)"),
        label: z.string().optional(),
        assignee: assignee.optional(),
        delegate: delegate.optional(),
        creator: assignee.optional().describe('Who filed it: a username, or "me"'),
        parent: identifier.optional().describe("Only sub-issues of this issue, e.g. BRD-12"),
        project: projectSlug.optional().describe("Only issues in this project (slug, see list_projects)"),
        cycle: z.union([z.number().int(), z.literal("current")]).optional().describe('Only issues in this cycle: "current" (each team\'s current cycle) or a number (with team)'),
        query: z.string().optional().describe("Text to find in identifier, title or description"),
        subscribed: z.boolean().optional().describe("true: only issues you're subscribed to"),
        due: z.enum(DUE_FILTERS).optional().describe("By due date (the server's date, UTC): overdue (past, open issues only), soon (today to 7 days ahead), today, any (has one), none"),
        sort: z.enum(ISSUE_SORTS).optional().describe("default (status, priority, recently updated) or due (earliest due date first, none last)"),
        archived: z.boolean().optional().describe("true: also include archived issues (excluded by default, but still found by query)"),
        limit: z.number().int().min(1).max(500).optional().describe("Page size (default 50)"),
        after: z.string().optional().describe("The cursor from the end of the previous page"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status, category, query, cycle, limit = 50, after, ...filter }) => {
      const scope = status || category ? { status, category } : { category: ACTIVE_CATEGORIES };
      const { issues, pageInfo } = tracker.listIssuesPage(a, { ...filter, ...scope, cycle: cycle?.toString(), q: query }, { first: limit, after });
      const lines = issues.map(line);
      if (pageInfo.hasNextPage) lines.push(`…more: call again with after: "${pageInfo.endCursor}"`);
      return result(lines.join("\n") || "No matching issues.", { issues, pageInfo });
    },
  );

  register(
    "get_issue",
    {
      description: "Get one issue by identifier (e.g. BRD-12; one it had before it moved team works too): markdown description, status, priority, labels, assignee, delegate, parent, sub-issues, blocked-by/blocks, related, duplicate-of/duplicates, and comments, plus its history: who changed what and when (latest 30), the git branch name to use, and linked pull requests. Read it before starting work on an issue.",
      inputSchema: { id: identifier },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => {
      const issue = tracker.getIssue(a, id);
      const scale = tracker.listTeams(a).find((t) => t.key === issue.team)?.estimateScale ?? null;
      return result(details(issue, scale), { issue });
    },
  );

  register(
    "create_issue",
    {
      description: "Create an issue in a team; returns its identifier (e.g. BRD-13). Defaults: the team's default status (backlog unless the team changed it; list_teams marks it; pass todo when it's ready to be picked up, or triage to leave it for the team to accept, in teams with Triage), priority 0 (none). Set parent to make it a sub-issue, blockedBy for issues that must be finished first. Mark an issue a duplicate with duplicateOf: it's set to its team's Duplicate status and the relation is recorded; use relatedTo for issues that are connected but not duplicates or blockers. A sub-issue joins its parent's project unless you pass one. A sub-issue joins its parent's cycle when it starts out unstarted or started. Pass template (see list_templates) to prefill title, description, status, priority and labels from a team template; any of those fields you also pass override the template's, and title becomes optional once a template supplies one.",
      inputSchema: {
        team: teamKey,
        title: title.optional().describe("Required unless template supplies one"),
        description: description.optional(),
        status: status.optional().describe("Default: the team's default status (list_teams marks it)"),
        priority: priority.optional().describe("0 none (default), 1 urgent, 2 high, 3 medium, 4 low"),
        estimate: estimate.optional(),
        labels: labels.optional(),
        assignee: assignee.optional().describe('The person who owns it: a username, or "me"'),
        delegate: delegate.optional().describe("An agent to work on it"),
        parent: identifier.optional().describe("Parent issue identifier, making this a sub-issue"),
        blockedBy: blockedBy.optional(),
        relatedTo: relatedTo.optional(),
        duplicateOf: duplicateOf.optional(),
        dueOn: dueOn.optional(),
        project: projectSlug.optional().describe("Project slug (see list_projects); its team joins the project"),
        milestone: milestone.optional(),
        cycle: cycle.nullable().optional(),
        template: z.number().int().optional().describe("An issue template's id (see list_templates in the team) to prefill title, description, labels, priority and status; fields you also pass override the template's"),
      },
    },
    (input) => {
      const issue = tracker.createIssue(a, input);
      return result(`Created ${issue.id}\n${line(issue)}`, { issue });
    },
    ["issues.write"],
  );

  register(
    "update_issue",
    {
      description: "Update an issue; only the fields you pass change. Status flow: in_progress when you start, in_review when ready for review, done when finished (or the team's statuses in the started and completed categories; list_teams), canceled instead of deleting (there is no delete). labels, blockedBy and relatedTo replace the whole list, so include existing entries you want to keep, and pass baseUpdatedAt (from get_issue) when replacing them or the description, so you don't overwrite someone else's change. To start work, use claim_issue. Don't reassign an issue someone else holds; use claim_issue. Mark an issue a duplicate with duplicateOf: it's set to its team's Duplicate status and the relation is recorded; use relatedTo for issues that are connected but not duplicates or blockers. Pass null for assignee, delegate, parent or duplicateOf to clear it (clearing duplicateOf leaves the status as it is). Log progress with comment_issue rather than editing the description. Closing an issue may also close its parent or its sub-issues, per the teams' auto-close settings: check get_issue after; @docket made those changes, after yours. Move an issue to another team (team) only when asked to.",
      inputSchema: {
        id: identifier,
        team: teamKey.optional().describe("Move it to this team of the same workspace: it gets a new identifier there (the old one keeps resolving), keeps its status if that team has it (else the team's first of that category, else its default), and loses the old team's own labels"),
        title: title.optional(),
        description: description.optional(),
        status: status.optional(),
        priority: priority.optional(),
        estimate: estimate.nullable().optional().describe("A position in the team's estimate scale, 1 to 5, if the team has estimates on (list_teams); null to clear"),
        labels: labels.optional(),
        assignee: assignee.nullable().optional().describe('The person who owns it, or "me"; null to unassign'),
        delegate: delegate.nullable().optional().describe("The agent working on it; null to clear"),
        parent: identifier.nullable().optional().describe("Parent issue identifier; null to detach"),
        blockedBy: blockedBy.optional(),
        relatedTo: relatedTo.optional(),
        duplicateOf: duplicateOf.nullable().optional().describe("The issue this one duplicates (it's set to its team's Duplicate status); null to clear"),
        dueOn: dueOn.nullable().optional().describe('Due date, a calendar date like "2026-09-30"; null to clear'),
        project: projectSlug.nullable().optional().describe("Project slug (see list_projects); null to take it out. A new project clears the milestone unless you pass one of its own"),
        milestone: milestone.nullable().optional().describe("A milestone's name in the issue's project; null to clear"),
        cycle: cycle.nullable().optional(),
        baseUpdatedAt: z.string().optional().describe("The updated time you read with get_issue. If the issue changed since, nothing is applied (reread and retry)."),
      },
    },
    ({ id, ...patch }) => {
      const issue = tracker.updateIssue(a, id, patch);
      const was = id.trim().toUpperCase();
      const moved = patch.team !== undefined && was !== issue.id;
      return result(`${moved ? `Moved ${was} to ${issue.id}` : `Updated ${issue.id}`}\n${line(issue)}`, { issue });
    },
    ["issues.write"],
  );

  register(
    "claim_issue",
    {
      description: "Take an issue to work on, in one step no one else can interleave with: an agent becomes its delegate, a person its assignee, and an issue not started yet (triage, backlog or unstarted category) moves to the team's first started status (in_progress by default); one already started keeps its status. Fails if it's completed or canceled, or someone else holds it (the error names them): then pick another issue rather than working on it too. Claiming your own again is fine. To hand it back, update_issue with delegate (or assignee) null and status todo.",
      inputSchema: { id: identifier },
    },
    ({ id }) => {
      const issue = tracker.claimIssue(a, id);
      return result(`Claimed ${issue.id}\n${line(issue)}`, { issue });
    },
    ["issues.write"],
  );

  register(
    "comment_issue",
    {
      description: `Add a markdown comment to an issue, as you. Use it for progress notes, findings, decisions, and a summary of what you did when finishing (changes made, links). ${THREADS} Comments bump the issue's updated time.`,
      inputSchema: { id: identifier, body, parent },
    },
    ({ id, body, parent }) => {
      const issue = tracker.addComment(a, id, body, parent);
      return result(`${parent === undefined ? "Commented on" : `Replied to #${parent} on`} ${issue.id}`, { issue });
    },
    ["comments.write"],
  );

  register(
    "list_documents",
    {
      description: "List documents (specs, plans, notes), one line each: slug · title · team · updated time and author. Ordered by team, then position. Use get_document with the slug to read one.",
      inputSchema: {
        team: teamKey.optional(),
        project: projectSlug.optional().describe("Only docs attached to this project"),
        query: z.string().optional().describe("Text to find in title or content"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ team, project, query }) => {
      const documents = tracker.listDocuments(a, { team, project, q: query });
      return result(documents.map(docLine).join("\n") || "No matching documents.", { documents });
    },
  );

  register(
    "get_document",
    {
      description: "Get a document by slug: its full markdown content, metadata, the issues it mentions (with status), and comments. Read it before editing so `edits` can quote the current text exactly.",
      inputSchema: { slug },
      annotations: { readOnlyHint: true },
    },
    ({ slug }) => {
      const document = tracker.getDocument(a, slug);
      return result(docDetails(document), { document });
    },
  );

  register(
    "create_document",
    {
      description: "Create a markdown document in a team; returns its slug. Docs are markdown: use headings, lists, tables, code blocks. Mention issues by identifier (e.g. BRD-2) and they auto-link and appear on the issue's page; link other docs with [Title](/doc/slug). The slug defaults to the title slugified (deduped) and never changes, even if the title does.",
      inputSchema: {
        team: teamKey,
        title: z.string().describe('Document title, e.g. "Architecture"'),
        content: docContent,
        slug: z.string().optional().describe("URL-safe id (a-z, 0-9, dashes); default derived from the title"),
        position: z.number().optional().describe("Order within the team, ascending; default last"),
        project: docProject.optional(),
      },
    },
    (input) => {
      const document = tracker.createDocument(a, input);
      return result(`Created document ${document.slug} · ${document.title} (/doc/${document.slug})`, docMeta(document));
    },
    ["docs.write"],
  );

  register(
    "update_document",
    {
      description: "Update a document; only the fields you pass change. For small changes to a long doc, prefer `edits`: exact find/replace pairs applied in order, each oldText must match the current content exactly once (quote enough surrounding text to be unique). If any edit fails, nothing is applied and the error names the edit. `content` replaces the whole document; don't pass both. Content is markdown: issue identifiers (e.g. BRD-2) auto-link, link docs with [Title](/doc/slug). The slug never changes.",
      inputSchema: {
        slug,
        title: z.string().optional(),
        content: docContent.optional().describe(`Full replacement markdown. Prefer edits for small changes. ${MENTION}`),
        edits: z
          .array(
            z.object({
              oldText: z.string().describe("Exact current text, matching exactly once"),
              newText: z.string().describe("Replacement text (empty string deletes)"),
            }),
          )
          .optional()
          .describe("Targeted find/replace edits, applied in order, all or nothing"),
        team: teamKey.optional().describe("Move the doc to this team (same workspace)"),
        position: z.number().optional().describe("Order within the team, ascending"),
        project: docProject.nullable().optional(),
        baseUpdatedAt: z.string().optional().describe("The updatedAt you read with get_document. If the doc changed since, nothing is applied (reread and retry). Recommended with `content`."),
      },
    },
    ({ slug, ...patch }) => {
      const document = tracker.updateDocument(a, slug, patch);
      return result(`Updated document ${document.slug} · ${document.title}`, docMeta(document));
    },
    ["docs.write"],
  );

  register(
    "comment_document",
    {
      description: `Add a markdown comment to a document, as you, e.g. review notes, questions, or a summary of what you changed. ${THREADS} Comments don't change the content.`,
      inputSchema: { slug, body, parent },
    },
    ({ slug, body, parent }) => {
      const document = tracker.addDocumentComment(a, slug, body, parent);
      return result(`${parent === undefined ? "Commented on" : `Replied to #${parent} on`} document ${document.slug}`, docMeta(document));
    },
    ["comments.write"],
  );

  const commentTarget = {
    issue: identifier.optional().describe("The issue the comment is on; pass this or document"),
    document: slug.optional().describe("The document the comment is on; pass this or issue"),
    comment: z.number().int().describe("Comment id, shown as #12 in get_issue / get_document"),
  };

  register(
    "update_comment",
    {
      description: "Edit one of your own comments on an issue or a document, e.g. to fix a typo or an outdated note. It shows as edited. For new information, add a new comment instead.",
      inputSchema: { ...commentTarget, body: z.string().describe(`Markdown, replaces the whole comment. ${MENTION}`) },
    },
    ({ comment, body, ...target }) =>
      commentOn(
        target,
        (id) => {
          const issue = tracker.updateIssueComment(a, id, comment, body);
          return result(`Edited comment #${comment} on ${issue.id}`, { issue });
        },
        (slug) => {
          const document = tracker.updateDocumentComment(a, slug, comment, body);
          return result(`Edited comment #${comment} on document ${document.slug}`, docMeta(document));
        },
      ),
    ["comments.write"],
  );

  register(
    "delete_comment",
    {
      description: "Delete one of your own comments on an issue or a document. Only for comments posted by mistake.",
      inputSchema: commentTarget,
      annotations: { destructiveHint: true },
    },
    ({ comment, ...target }) =>
      commentOn(
        target,
        (id) => {
          const issue = tracker.deleteIssueComment(a, id, comment);
          return result(`Deleted comment #${comment} on ${issue.id}`, { issue });
        },
        (slug) => {
          const document = tracker.deleteDocumentComment(a, slug, comment);
          return result(`Deleted comment #${comment} on document ${document.slug}`, docMeta(document));
        },
      ),
    ["comments.write"],
  );

  register(
    "resolve_thread",
    {
      description: "Mark a comment thread resolved (the question is answered or the decision made), or reopen it with resolved: false. Anyone can. Pass the thread's first comment; a resolved thread shows collapsed, and a new reply reopens it.",
      inputSchema: {
        issue: commentTarget.issue,
        document: commentTarget.document,
        comment: z.number().int().describe("The thread's first comment id, shown as #12 in get_issue / get_document"),
        resolved: z.boolean().optional().describe("Default true; false reopens it"),
      },
    },
    ({ comment, resolved = true, ...target }) => {
      const done = `${resolved ? "Resolved" : "Reopened"} thread #${comment} on`;
      return commentOn(
        target,
        (id) => {
          const issue = tracker.resolveIssueThread(a, id, comment, resolved);
          return result(`${done} ${issue.id}`, { issue });
        },
        (slug) => {
          const document = tracker.resolveDocumentThread(a, slug, comment, resolved);
          return result(`${done} document ${document.slug}`, docMeta(document));
        },
      );
    },
    ["comments.write"],
  );

  register(
    "bulk_update_issues",
    {
      description: "Apply one change to up to 100 issues, each exactly as its own update_issue would (history, notifications). patch takes status, priority, estimate, assignee, delegate, project, labels (replaces), addLabels, removeLabels. Not atomic: the reply says per issue whether it changed or why not. Prefer it over many update_issue calls for triage.",
      inputSchema: {
        ids: z.array(identifier).min(1).max(100),
        patch: z.object({
          status: status.optional(),
          priority: priority.optional(),
          estimate: estimate.nullable().optional(),
          assignee: assignee.nullable().optional(),
          delegate: delegate.nullable().optional(),
          project: projectSlug.nullable().optional(),
          labels: labels.optional(),
          addLabels: labels.optional(),
          removeLabels: labels.optional(),
        }).strict(),
      },
    },
    ({ ids, patch }) => {
      const results = tracker.bulkUpdateIssues(a, ids, patch);
      const lines = results.map((r) => (r.issue ? `Updated ${r.issue.id}` : `${r.id} failed: ${r.error}`));
      return result(lines.join("\n"), { results });
    },
    ["issues.write"],
  );

  register(
    "archive_issue",
    {
      description: "Archive an issue (hides it from default lists; list_issues archived: true shows it), or bring it back with archived: false. Use for finished work that's just clutter; it deletes nothing.",
      inputSchema: { id: identifier, archived: z.boolean().optional().describe("Default true; false unarchives") },
    },
    ({ id, archived = true }) => {
      const issue = archived ? tracker.archiveIssue(a, id) : tracker.unarchiveIssue(a, id);
      return result(`${archived ? "Archived" : "Unarchived"} ${issue.id}`, { issue });
    },
    ["issues.write"],
  );

  register(
    "restore",
    {
      description: "Bring an issue or document back from the trash (to undo a delete or cancel-by-mistake; the trash keeps them 30 days). Pass exactly one of issue or document.",
      inputSchema: { issue: identifier.optional(), document: slug.optional() },
    },
    (target) =>
      commentOn(
        target,
        (id) => {
          const issue = tracker.restoreIssue(a, id);
          return result(`Restored ${issue.id}`, { issue });
        },
        (slug) => {
          const document = tracker.restoreDocument(a, slug);
          return result(`Restored document ${document.slug}`, docMeta(document));
        },
      ),
  );

  register(
    "document_versions",
    {
      description: "A document's edit history. Without `version`: its versions, newest first (id · time · author · title). With one: that version's title and full markdown, to see what changed or to copy old content back with update_document.",
      inputSchema: { slug, version: z.number().int().optional().describe("A version id from the list") },
      annotations: { readOnlyHint: true },
    },
    ({ slug, version }) => {
      if (version !== undefined) {
        const v = tracker.getDocumentVersion(a, slug, version);
        return result(`# ${v.title}\n\n${v.content}`, { version: v });
      }
      const versions = tracker.listDocumentVersions(a, slug);
      return result(versions.map((v) => `${v.id} · ${ago(v.createdAt)} · ${at(v.author)} · ${v.title}`).join("\n") || "No versions.", { versions });
    },
  );

  register(
    "delete_document",
    {
      description: "Move a document to the trash (with its versions and comments); any member can restore it for 30 days, then it's gone. Only when asked to, or to remove a duplicate you just created; otherwise edit it.",
      inputSchema: { slug },
      annotations: { destructiveHint: true },
    },
    ({ slug }) => {
      tracker.deleteDocument(a, slug);
      return result(`Moved document ${slug} to the trash`, { ok: true });
    },
    ["docs.write"],
  );

  register(
    "list_projects",
    {
      description: "List projects, one line each: slug · name · status · progress % · @lead · target date · teams. Use get_project for its description, milestones and docs, and list_issues with `project` for its issues.",
      inputSchema: {
        team: teamKey.optional().describe("Only projects this team takes part in"),
        status: z.array(z.enum(PROJECT_STATUSES)).optional().describe("Only projects in these statuses"),
      },
      annotations: { readOnlyHint: true },
    },
    (filter) => {
      const projects = tracker.listProjects(a, filter);
      return result(projects.map(projectLine).join("\n") || "No projects yet.", { projects });
    },
  );

  register(
    "get_project",
    {
      description: "Get a project by slug: its markdown description, status, lead, target date, teams, progress, milestones (each with progress and target date) and attached docs. For its issues use list_issues with project.",
      inputSchema: { slug: projectSlug },
      annotations: { readOnlyHint: true },
    },
    ({ slug }) => {
      const project = tracker.getProject(a, slug);
      return result(projectDetails(project), { project });
    },
  );

  const projectStatus = z.enum(PROJECT_STATUSES).describe("backlog, planned, in_progress, paused, completed or canceled");
  const lead = z.string().describe('The person leading it: a username (see list_members), or "me"');

  register(
    "create_project",
    {
      description: 'Create a project, a body of work toward a goal that spans one or more teams of a workspace; returns its slug. Check list_projects first and only create one when asked to. Status: backlog (default), planned, in_progress, paused, completed, canceled. The lead is a person\'s username or "me". targetDate is YYYY-MM-DD.',
      inputSchema: {
        teams: z.array(teamKey).min(1).describe('Keys of the teams taking part, e.g. ["WEB", "APP"]'),
        name: z.string(),
        description: description.optional(),
        status: projectStatus.optional(),
        lead: lead.optional(),
        targetDate: targetDate.optional(),
        slug: z.string().optional().describe("URL-safe id (a-z, 0-9, dashes); default derived from the name"),
      },
    },
    (input) => {
      const project = tracker.createProject(a, input);
      return result(`Created project ${project.slug}\n${projectLine(project)}`, { project });
    },
    ["projects.write"],
  );

  register(
    "update_project",
    {
      description: "Update a project; only the fields you pass change. `teams` replaces the list (a team with issues in the project can't be dropped). Pass baseUpdatedAt from get_project when replacing the description. There is no delete: set status canceled. The slug never changes.",
      inputSchema: {
        slug: projectSlug,
        name: z.string().optional(),
        description: description.optional(),
        status: projectStatus.optional(),
        lead: lead.nullable().optional().describe('The person leading it, or "me"; null to clear'),
        targetDate: targetDate.nullable().optional().describe('A calendar date like "2026-12-01"; null to clear'),
        teams: z.array(teamKey).min(1).optional().describe("Keys of the teams taking part; replaces the list"),
        baseUpdatedAt: z.string().optional().describe("The updatedAt you read with get_project. If the project changed since, nothing is applied (reread and retry)."),
      },
    },
    ({ slug, ...patch }) => {
      const project = tracker.updateProject(a, slug, patch);
      return result(`Updated project ${project.slug}\n${projectLine(project)}`, { project });
    },
    ["projects.write"],
  );

  register(
    "create_milestone",
    {
      description: 'Add a milestone (a stage such as "Beta", with an optional target date) to a project. Put an issue in it with update_issue\'s milestone.',
      inputSchema: {
        project: projectSlug,
        name: z.string().describe('Unique within the project, e.g. "Beta"'),
        description: z.string().optional(),
        targetDate: targetDate.optional(),
      },
    },
    ({ project: slug, ...input }) => {
      const project = tracker.createMilestone(a, slug, input);
      return result(`Added milestone ${input.name.trim()} to ${project.slug}`, { project });
    },
    ["projects.write"],
  );

  register(
    "update_milestone",
    {
      description: "Rename a project's milestone or change its description or target date.",
      inputSchema: {
        project: projectSlug,
        milestone: z.string().describe("The milestone's current name"),
        name: z.string().optional(),
        description: z.string().optional(),
        targetDate: targetDate.nullable().optional().describe('A calendar date like "2026-12-01"; null to clear'),
      },
    },
    ({ project: slug, milestone: name, ...patch }) => {
      const found = tracker.getProject(a, slug).milestones.find((m) => m.name.toLowerCase() === name.trim().toLowerCase());
      if (!found) throw new AppError(`Unknown milestone "${name}" in ${slug}`);
      const project = tracker.updateMilestone(a, slug, found.id, patch);
      return result(`Updated milestone ${patch.name?.trim() ?? found.name} in ${project.slug}`, { project });
    },
    ["projects.write"],
  );

  register(
    "list_notifications",
    {
      description: 'Your notifications, newest first, one line each: #id · unread · kind · target · by @actor · time · "excerpt". Kinds: delegated (an issue was delegated to you: start with get_issue and claim_issue), assigned, mentioned, commented, status (an issue you follow moved to in_review or a completed or canceled status, e.g. done, canceled, duplicate). Mark them read with mark_notifications_read when handled.',
      inputSchema: {
        unread: z.boolean().optional().describe("Only unread ones (default true); false lists read ones too"),
        limit: z.number().int().min(1).max(200).optional().describe("How many (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ unread = true, limit = 50 }) => {
      const found = inbox.listInbox(a, { unread, limit });
      const empty = unread ? "No unread notifications." : "Your inbox is empty.";
      return result(found.notifications.map(notificationLine).join("\n") || empty, { ...found });
    },
  );

  register(
    "mark_notifications_read",
    {
      description: "Mark notifications read once you've handled them (or unread again): pass ids (from list_notifications, without the #) or all: true.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Notification ids, e.g. [41, 42]"),
        all: z.boolean().optional().describe("true: all of yours"),
        read: z.boolean().optional().describe("Default true; false marks them unread"),
      },
    },
    ({ ids, all, read = true }) => {
      if ((ids === undefined) === (all !== true)) throw new AppError("Pass exactly one of ids or all: true");
      const found = inbox.markRead(a, { ids, read });
      return result(`Marked ${all ? "all" : ids!.map((id) => `#${id}`).join(", ")} ${read ? "read" : "unread"} · ${found.unread} unread left`, { ...found });
    },
    ["inbox.manage"],
  );

  register(
    "subscribe",
    {
      description: "Follow or unfollow an issue or doc: subscribers get its new comments and status changes in their inbox. You're subscribed automatically to what you create, claim, comment on, or are assigned, delegated or mentioned in.",
      inputSchema: {
        issue: identifier.optional().describe("The issue; pass this or document"),
        document: slug.optional().describe("The document; pass this or issue"),
        subscribed: z.boolean().optional().describe("Default true; false unsubscribes"),
      },
    },
    ({ subscribed = true, ...target }) =>
      commentOn(
        target,
        (id) => {
          const issue = tracker.subscribeIssue(a, id, subscribed);
          return result(`${subscribed ? "Subscribed to" : "Unsubscribed from"} ${issue.id}`, { issue });
        },
        (slug) => {
          const document = tracker.subscribeDocument(a, slug, subscribed);
          return result(`${subscribed ? "Subscribed to" : "Unsubscribed from"} document ${document.slug}`, docMeta(document));
        },
      ),
  );

  register(
    "react",
    {
      description: "Add (or with remove, take back) your emoji reaction on an issue's description or on a comment, e.g. 👀 to show you've picked up a request, 👍 to agree. It doesn't notify anyone; use a comment for anything that needs an answer.",
      inputSchema: {
        issue: identifier.optional().describe("The issue; pass this or document"),
        document: slug.optional().describe("The document; pass this or issue (comment is then required)"),
        comment: z.number().int().optional().describe("React to this comment instead of the issue's description (required for a document)"),
        emoji: z.string().describe("A single emoji, e.g. 👍"),
        remove: z.boolean().optional().describe("Default false; true takes back your reaction"),
      },
    },
    ({ comment, emoji, remove = false, ...target }) => {
      const on = !remove;
      const done = (what: string) => `${on ? "Reacted" : "Removed reaction"} ${emoji} on ${what}`;
      return commentOn(
        target,
        (id) => {
          const issue = tracker.reactToIssue(a, id, emoji, on, comment);
          return result(done(comment === undefined ? issue.id : `#${comment} on ${issue.id}`), { issue });
        },
        (slug) => {
          if (comment === undefined) throw new AppError("comment is required to react on a document");
          const document = tracker.reactToDocumentComment(a, slug, comment, emoji, on);
          return result(done(`#${comment} on document ${document.slug}`), docMeta(document));
        },
      );
    },
    ["comments.write"],
  );

  register(
    "attach_file",
    {
      description: "Upload a file (a log, a report, a screenshot) to link from a comment, description or doc; returns the markdown to paste: ![name](url) for images, [name](url) otherwise. Prefer this over pasting long logs into comments. Pass exactly one of text (UTF-8) or base64. At most about 700 KB per call over MCP; files are private to this workspace's members, and with `team` to those who see that team: pass the team of the issue or doc you'll link it from.",
      inputSchema: {
        name: z.string().describe('File name, e.g. "build.log" or "screenshot.png"'),
        text: z.string().optional().describe("The file's content as UTF-8 text"),
        base64: z.string().optional().describe("The file's bytes, base64-encoded (for images and other binary files)"),
        team: z.string().optional().describe('The team key of the issue or doc it goes in, e.g. "BRD": only those who see that team can open it'),
      },
    },
    async ({ name, text, base64, team }) => {
      if ((text === undefined) === (base64 === undefined)) throw new AppError("Pass exactly one of text or base64");
      let bytes: Uint8Array;
      if (text !== undefined) bytes = new TextEncoder().encode(text);
      else {
        const clean = base64!.replace(/\s+/g, "");
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new AppError("base64 isn't valid base64");
        bytes = Buffer.from(clean, "base64");
      }
      const attachment = await saveAttachment(a, name, bytes, team);
      return result(attachmentMarkdown(attachment), { attachment, markdown: attachmentMarkdown(attachment) });
    },
    ["files.upload"],
  );

  register(
    "get_attachment",
    {
      description: "Read an attached file by its URL as found in markdown (/api/attachments/…): text files come back as text, PNG/JPEG/GIF/WebP images as images you can see (up to 5 MB), anything else as its name, type and size.",
      inputSchema: { url: z.string().describe('The attachment\'s URL or path, e.g. "/api/attachments/AbC…/shot.png"') },
      annotations: { readOnlyHint: true },
    },
    async ({ url }): Promise<CallToolResult> => {
      const attachment = getAttachment(a, url);
      const file = async () => {
        const body = await files.get(attachment.id);
        if (!body) throw new AppError("Attachment not found", 404); // e.g. a database restored without its files
        return new Response(body);
      };
      const meta = `${attachment.name} · ${attachment.contentType} · ${attachment.size} bytes · by ${at(attachment.uploader)} · ${attachment.createdAt}`;
      const structuredContent = { attachment };
      if (attachment.contentType.startsWith("text/")) {
        const text = await (await file()).text();
        const cut = text.length > TEXT_LIMIT ? `\n\n(cut: showing the first ${TEXT_LIMIT} of ${text.length} characters)` : "";
        return { content: [{ type: "text", text: `${meta}\n\n${text.slice(0, TEXT_LIMIT)}${cut}` }], structuredContent };
      }
      if (INLINE_IMAGE_TYPES.includes(attachment.contentType) && attachment.size <= IMAGE_LIMIT) {
        const data = Buffer.from(await (await file()).arrayBuffer()).toString("base64");
        return { content: [{ type: "text", text: meta }, { type: "image", data, mimeType: attachment.contentType }], structuredContent };
      }
      return result(meta, structuredContent);
    },
  );

  const roleKey = z.string().describe('A role\'s key, e.g. "member" (list_roles)');
  const permissions = z.array(z.enum(PERMISSIONS)).describe(`The role's permissions, all of them (it replaces the list). Team ones (${TEAM_PERMISSIONS.join(", ")}) can be held per team; workspace.browse is seeing the workspace's public teams and people (a guest lacks it).`);
  const ROLES = "A role is a named set of permissions in this workspace; each member (person or agent) has one, and may have one of their own in a team, which replaces it for the team's permissions there only. You can only give permissions you hold yourself, never change your own role, and some person always keeps every permission (Admin's).";
  const roleLine = (r: WorkspaceRole) => [r.key, r.name, r.builtin && "built-in", `${r.members} members`, r.permissions.join(", ") || "no permissions"].filter(Boolean).join(" · ");

  if (["roles.manage", "members.assign_role", "team.roles"].some((p) => holdsAnywhere(a, p as Permission))) {
    register(
      "list_roles",
      {
        description: `List this workspace's roles, one line each: key · name · \`built-in\` · how many hold it · its permissions. ${ROLES}`,
        annotations: { readOnlyHint: true },
      },
      () => {
        const roles = rolesApi.listRoles(a);
        return result(roles.map(roleLine).join("\n"), { roles });
      },
    );
  }

  register(
    "create_role",
    {
      description: `Create a role from permissions you hold. To start from an existing role (e.g. Admin, which can't be changed), copy its permissions from list_roles. Only do this when asked to. ${ROLES}`,
      inputSchema: { name: z.string(), permissions, description: z.string().optional(), key: z.string().optional().describe("URL-safe key; default from the name") },
    },
    (input) => {
      const role = rolesApi.createRole(a, input);
      return result(`Created role ${roleLine(role)}`, { role });
    },
    ["roles.manage"],
  );

  register(
    "update_role",
    {
      description: `Rename, redescribe or change the permissions of a role; only the fields you pass change, and its holders get the new permissions at once. Not Admin, not your own role, and not one holding a permission you lack. Only do this when asked to. ${ROLES}`,
      inputSchema: { key: roleKey, name: z.string().optional(), description: z.string().optional(), permissions: permissions.optional() },
    },
    ({ key, ...patch }) => {
      const role = rolesApi.updateRole(a, key, patch);
      return result(`Updated role ${roleLine(role)}`, { role });
    },
    ["roles.manage"],
  );

  register(
    "delete_role",
    {
      description: "Delete a role that isn't built in. While members, team roles or invites hold it, moveTo names the role they move to. Only do this when asked to.",
      inputSchema: { key: roleKey, moveTo: roleKey.optional() },
      annotations: { destructiveHint: true },
    },
    ({ key, moveTo }) => {
      rolesApi.deleteRole(a, key, moveTo);
      return result(`Deleted role ${key}${moveTo ? `; its members are now ${moveTo}` : ""}`, { deleted: key });
    },
    ["roles.manage"],
  );

  register(
    "set_member_role",
    {
      description: `Give a person or agent of this workspace a role (list_roles has their keys; list_members shows who holds what). You need to hold every permission of both their current and their new role. Only do this when asked to. ${ROLES}`,
      inputSchema: { username: z.string().describe("A member's username (see list_members)"), role: roleKey },
    },
    ({ username, role }) => {
      const member = access.updateMember(a, access.requestWorkspace(a), username, { role });
      return result(`@${member.user.username} is now ${member.roleName}`, { member });
    },
    ["members.assign_role"],
  );

  if (holdsAnywhere(a, "team.roles") || holdsAnywhere(a, "members.assign_role")) {
    register(
      "set_team_role",
      {
        description: `Give a member of a team a role of their own in it, replacing their workspace role for the team's permissions (not for what they see), or with role null go back to their workspace role. Takes team.roles in that team or members.assign_role. Only do this when asked to. ${ROLES}`,
        inputSchema: { team: teamKey, username: z.string().describe("A member of the team (see list_members)"), role: roleKey.nullable() },
      },
      ({ team, username, role }) => {
        const set = rolesApi.setTeamRole(a, team, username, role);
        return result(`@${set.user.username} in ${set.team}: ${set.role ?? "their workspace role"}`, set);
      },
    );
  }

  return server;
}

const TEXT_LIMIT = 100_000; // characters of a text file get_attachment returns
const IMAGE_LIMIT = 5 * 1024 * 1024; // bytes of an image it returns as image content

/** Stateless Streamable HTTP: a fresh server and transport per request, JSON responses. */
export async function handleMcp(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, { status: 405, headers: { Allow: "POST" } });
  }
  // The public origin: DOCKET_URL (as for sign-in-link), else the one the client used.
  const origin = process.env.DOCKET_URL?.replace(/\/+$/, "") || originOf(req);
  const server = createServer(actorOf(req), origin);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}

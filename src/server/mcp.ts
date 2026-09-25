import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  OPEN_STATUSES,
  PRIORITIES,
  PRIORITY_LABELS,
  STATUSES,
  type Comment,
  type Document,
  type DocumentSummary,
  type Issue,
  type IssueSummary,
  type UserRef,
} from "../shared/types.ts";
import * as access from "./access.ts";
import type { Actor } from "./access.ts";
import { actorOf } from "./auth.ts";
import { AppError } from "./db.ts";
import * as tracker from "./tracker.ts";

const INSTRUCTIONS = `Docket is an issue tracker shared by people and agents, modeled on Linear.
- Workspace → team → issues and docs. You see only the workspaces you're a member of; list_teams shows each team's workspace, and \`workspace\` keeps list_issues or list_documents inside one.
- Teams have a 2–5 letter key (e.g. BRD), unique across all workspaces. Issues are identified as KEY-number, e.g. BRD-12.
- Statuses: backlog, todo, in_progress, in_review, done, canceled. Priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
- People and agents are named by username (@alice). An issue's assignee is a person who owns it; its delegate is an agent working on it for them. "me" means you.
- Working on an issue: get_issue, then claim_issue (an agent becomes its delegate, a person its assignee, and it moves to in_progress; if someone else holds it, pick another), post progress notes with comment_issue, then set in_review or done. There is no delete: set status canceled instead.
- Documents (specs, plans, notes) live in teams and are identified by a slug, e.g. "architecture". They are markdown: mention issues by identifier (BRD-2) and they auto-link; link other docs with [Title](/doc/slug). Change a long doc with update_document's \`edits\` rather than rewriting it.`;

const identifier = z.string().describe('Issue identifier: team key + number, e.g. "BRD-12" (case-insensitive)');
const teamKey = z.string().describe('Team key, e.g. "BRD" (see list_teams)');
const workspaceKey = z.string().describe('Workspace key, e.g. "acme" (see list_workspaces)');
const status = z.enum(STATUSES).describe("backlog | todo | in_progress | in_review | done | canceled");
const priority = z.literal(PRIORITIES).describe("0 none, 1 urgent, 2 high, 3 medium, 4 low");
const labels = z.array(z.string()).describe('Label names, e.g. ["bug", "ui"]');
const blockedBy = z.array(identifier).describe("Identifiers of issues that must be finished before this one");
const assignee = z.string().describe('A person\'s username (see list_members), or "me"');
const delegate = z.string().describe('An agent\'s username (see list_members), or "me" if you are one');

const slug = z.string().describe('Document slug, e.g. "architecture" (see list_documents)');
const docContent = z
  .string()
  .describe("Markdown. Mention issues by identifier (e.g. BRD-2) and they auto-link; link other docs with [Title](/doc/slug).");

const title = z.string().describe("Short, imperative title");
const description = z.string().describe("Markdown description");

const at = (user: UserRef) => `@${user.username}`;

/** One line per issue: `BRD-3 · todo · high · Title · @assignee · →@delegate · #label`. */
function line(issue: IssueSummary): string {
  return [
    issue.id,
    issue.status,
    PRIORITY_LABELS[issue.priority].toLowerCase(),
    issue.title,
    issue.assignee && at(issue.assignee),
    issue.delegate && `→${at(issue.delegate)}`,
    issue.labels.map((l) => `#${l}`).join(" "),
  ]
    .filter(Boolean)
    .join(" · ");
}

function details(issue: Issue): string {
  const meta = [
    `team ${issue.team}`,
    `created by ${at(issue.creator)}`,
    issue.parent && `parent ${issue.parent}`,
    issue.blockedBy.length > 0 && `blocked by ${issue.blockedBy.join(", ")}`,
    issue.blocks.length > 0 && `blocks ${issue.blocks.join(", ")}`,
    `updated ${issue.updatedAt}`,
  ];
  const parts = [line(issue), meta.filter(Boolean).join(" · "), issue.description || "_No description._"];
  if (issue.deletedAt) parts.unshift(`**In the trash** since ${issue.deletedAt}: read-only until someone restores it.`);
  if (issue.children.length) parts.push(`## Sub-issues\n${issue.children.map(line).join("\n")}`);
  if (issue.docs.length) parts.push(`## Docs\n${issue.docs.map(docLine).join("\n")}`);
  if (issue.comments.length) parts.push(commentsSection(issue.comments));
  return parts.join("\n\n");
}

function commentsSection(comments: Comment[]): string {
  const header = (c: Comment) => [`**${at(c.author)}**`, `#${c.id}`, c.createdAt, c.editedAt && "edited"].filter(Boolean).join(" · ");
  return `## Comments\n${comments.map((c) => `${header(c)}\n${c.body}`).join("\n\n")}`;
}

/** Routes a comment tool to its issue or its document; exactly one must be given. */
function commentOn<T>(
  { issue, document }: { issue?: string; document?: string },
  onIssue: (id: string) => T,
  onDocument: (slug: string) => T,
): T {
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
function docLine(doc: DocumentSummary): string {
  return `${doc.slug} · ${doc.title} · ${doc.team} · updated ${ago(doc.updatedAt)} by ${at(doc.updatedBy)}`;
}

function docDetails(doc: Document): string {
  const parts = [
    `# ${doc.title}`,
    `slug ${doc.slug} · team ${doc.team} · updated ${doc.updatedAt} by ${at(doc.updatedBy)} · ${doc.versionCount} version${doc.versionCount === 1 ? "" : "s"}`,
    "---",
    doc.content || "_Empty._",
    "---",
  ];
  if (doc.issues.length) parts.push(`## Mentioned issues\n${doc.issues.map(line).join("\n")}`);
  if (doc.comments.length) parts.push(commentsSection(doc.comments));
  return parts.join("\n\n");
}

/** Mutations echo metadata only, so a long document isn't sent back on every edit. */
function docMeta({ content, ...meta }: Document) {
  return { document: meta };
}

function result(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function createServer(a: Actor): McpServer {
  const server = new McpServer({ name: "docket", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  /** Wraps a tool that changes something: a read-only API key can't call it. */
  const writes =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (a.scope === "read") throw new AppError("This API key is read-only", 403);
      return fn(...args);
    };
  /** The workspace to use when a tool's is optional: the given one, or your only one. */
  const oneWorkspace = (workspace: string | undefined) => {
    if (workspace) return workspace;
    const mine = [...a.workspaces.keys()];
    if (mine.length === 1) return mine[0]!;
    throw new AppError(`Pass workspace: one of ${mine.join(", ") || "(none)"}`);
  };

  server.registerTool(
    "list_workspaces",
    {
      description: "List the workspaces you're a member of, one line each: key · name · your role · team count.",
      annotations: { readOnlyHint: true },
    },
    () => {
      const workspaces = access.listWorkspaces(a);
      const lines = workspaces.map((w) => `${w.key} · ${w.name} · ${w.role} · ${w.teamCount} team${w.teamCount === 1 ? "" : "s"}`);
      return result(lines.join("\n") || "You aren't in any workspace.", { workspaces });
    },
  );

  server.registerTool(
    "create_workspace",
    {
      description: "Create a workspace (people only); you become its admin. Only create one when asked to.",
      inputSchema: {
        key: z.string().optional().describe('URL-safe id (a-z, 0-9, dashes), e.g. "acme"; default derived from the name'),
        name: z.string(),
      },
    },
    writes((input) => {
      const workspace = access.createWorkspace(a, input);
      return result(`Created workspace ${workspace.key} · ${workspace.name}`, { workspace });
    }),
  );

  server.registerTool(
    "update_workspace",
    {
      description: "Rename a workspace (admins only). Its key never changes. Only do this when asked to.",
      inputSchema: { key: workspaceKey, name: z.string() },
    },
    writes(({ key, name }) => {
      const workspace = access.updateWorkspace(a, key, { name });
      return result(`Updated workspace ${workspace.key} · ${workspace.name}`, { workspace });
    }),
  );

  server.registerTool(
    "list_members",
    {
      description:
        "List a workspace's people and agents, one line each: @username · name · role · status, marking you. Assignees are people; delegates are agents.",
      inputSchema: { workspace: workspaceKey.optional().describe("Required if you're in more than one workspace") },
      annotations: { readOnlyHint: true },
    },
    ({ workspace }) => {
      const members = access.listMembers(a, oneWorkspace(workspace));
      const lines = members.map((m) =>
        [at(m.user), m.user.name, m.role, m.suspendedAt && "suspended", m.user.username === a.username && "you"].filter(Boolean).join(" · "),
      );
      return result(lines.join("\n"), { members, you: a.username });
    },
  );

  server.registerTool(
    "list_teams",
    {
      description:
        "List teams with their workspace and open-issue counts, one line each: key · name · workspace · open count. A team's key (e.g. BRD) prefixes its issue identifiers (BRD-12).",
      inputSchema: { workspace: workspaceKey.optional().describe("Only teams in this workspace") },
      annotations: { readOnlyHint: true },
    },
    ({ workspace }) => {
      const teams = tracker.listTeams(a, { workspace });
      const lines = teams.map((t) => {
        const open = OPEN_STATUSES.reduce((sum, s) => sum + t.counts[s], 0);
        return `${t.key} · ${t.name} · workspace ${t.workspace} · ${open} open`;
      });
      return result(lines.join("\n") || "No teams yet.", { teams });
    },
  );

  server.registerTool(
    "create_team",
    {
      description:
        "Create a team in a workspace. The key is 2–5 letters (uppercased), permanent, unique across all workspaces, and prefixes every issue identifier: key BRD gives BRD-1, BRD-2… Check list_teams first; only create a team when asked to.",
      inputSchema: {
        key: z.string().describe('2–5 letters, e.g. "BRD"'),
        workspace: workspaceKey.optional().describe("Required if you're in more than one workspace"),
        name: z.string(),
        description: z.string().optional(),
      },
    },
    writes(({ workspace, ...input }) => {
      const team = tracker.createTeam(a, { ...input, workspace: oneWorkspace(workspace) });
      return result(`Created team ${team.key} · ${team.name} in workspace ${team.workspace}`, { team });
    }),
  );

  server.registerTool(
    "update_team",
    {
      description:
        "Update a team's name or description; only the fields you pass change. Its key and workspace never change. Only do this when asked to.",
      inputSchema: {
        key: teamKey,
        name: z.string().optional(),
        description: z.string().optional(),
      },
    },
    writes(({ key, ...patch }) => {
      const team = tracker.updateTeam(a, key, patch);
      return result(`Updated team ${team.key} · ${team.name} in workspace ${team.workspace}`, { team });
    }),
  );

  server.registerTool(
    "list_labels",
    {
      description:
        "List the labels in use, one line each: label · open issue count. Check it before labeling an issue and reuse an existing label rather than inventing a near-duplicate.",
      inputSchema: { workspace: workspaceKey.optional().describe("Only labels on this workspace's issues") },
      annotations: { readOnlyHint: true },
    },
    ({ workspace }) => {
      const labels = tracker.listLabels(a, { workspace });
      return result(labels.map((l) => `${l.label} · ${l.open} open`).join("\n") || "No labels yet.", { labels });
    },
  );

  server.registerTool(
    "list_issues",
    {
      description:
        "List issues, one line each: identifier · status · priority · title · @assignee · →@delegate · #labels. Sorted by status, then priority (urgent first, none last), then most recently updated. Only open issues (backlog, todo, in_progress, in_review) unless you pass `status`. Pages of `limit` (default 50): when there are more, the output ends with a cursor to pass as `after` for the next page. Unknown team, assignee, delegate or parent is an error, not an empty list. Use get_issue for the description, comments, sub-issues and blockers.",
      inputSchema: {
        workspace: workspaceKey.optional().describe("Only issues in this workspace's teams"),
        team: teamKey.optional(),
        status: z.array(status).optional().describe("Only these statuses. Default: all except done and canceled."),
        label: z.string().optional(),
        assignee: assignee.optional(),
        delegate: delegate.optional(),
        parent: identifier.optional().describe("Only sub-issues of this issue, e.g. BRD-12"),
        query: z.string().optional().describe("Text to find in identifier, title or description"),
        limit: z.number().int().min(1).max(500).optional().describe("Page size (default 50)"),
        after: z.string().optional().describe("The cursor from the end of the previous page"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status, query, limit = 50, after, ...filter }) => {
      const { issues, pageInfo } = tracker.listIssuesPage(a, { ...filter, status: status ?? OPEN_STATUSES, q: query }, { first: limit, after });
      const lines = issues.map(line);
      if (pageInfo.hasNextPage) lines.push(`…more: call again with after: "${pageInfo.endCursor}"`);
      return result(lines.join("\n") || "No matching issues.", { issues, pageInfo });
    },
  );

  server.registerTool(
    "get_issue",
    {
      description:
        "Get one issue by identifier (e.g. BRD-12): markdown description, status, priority, labels, assignee, delegate, parent, sub-issues, blocked-by/blocks, and comments. Read it before starting work on an issue.",
      inputSchema: { id: identifier },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => {
      const issue = tracker.getIssue(a, id);
      return result(details(issue), { issue });
    },
  );

  server.registerTool(
    "create_issue",
    {
      description:
        "Create an issue in a team; returns its identifier (e.g. BRD-13). Defaults: status backlog (as in Linear; pass todo when it's ready to be picked up), priority 0 (none). Set parent to make it a sub-issue, blockedBy for issues that must be finished first.",
      inputSchema: {
        team: teamKey,
        title,
        description: description.optional(),
        status: status.optional().describe("Default backlog"),
        priority: priority.optional().describe("0 none (default), 1 urgent, 2 high, 3 medium, 4 low"),
        labels: labels.optional(),
        assignee: assignee.optional().describe('The person who owns it: a username, or "me"'),
        delegate: delegate.optional().describe("An agent to work on it"),
        parent: identifier.optional().describe("Parent issue identifier, making this a sub-issue"),
        blockedBy: blockedBy.optional(),
      },
    },
    writes((input) => {
      const issue = tracker.createIssue(a, input);
      return result(`Created ${issue.id}\n${line(issue)}`, { issue });
    }),
  );

  server.registerTool(
    "update_issue",
    {
      description:
        "Update an issue; only the fields you pass change. Status flow: in_progress when you start, in_review when ready for review, done when finished, canceled instead of deleting (there is no delete). labels and blockedBy replace the whole list, so include existing entries you want to keep, and pass baseUpdatedAt (from get_issue) when replacing them or the description, so you don't overwrite someone else's change. To start work, use claim_issue. Don't reassign an issue someone else holds; use claim_issue. Pass null for assignee, delegate or parent to clear it. Log progress with comment_issue rather than editing the description.",
      inputSchema: {
        id: identifier,
        title: title.optional(),
        description: description.optional(),
        status: status.optional(),
        priority: priority.optional(),
        labels: labels.optional(),
        assignee: assignee.nullable().optional().describe('The person who owns it, or "me"; null to unassign'),
        delegate: delegate.nullable().optional().describe("The agent working on it; null to clear"),
        parent: identifier.nullable().optional().describe("Parent issue identifier; null to detach"),
        blockedBy: blockedBy.optional(),
        baseUpdatedAt: z
          .string()
          .optional()
          .describe("The updated time you read with get_issue. If the issue changed since, nothing is applied (reread and retry)."),
      },
    },
    writes(({ id, ...patch }) => {
      const issue = tracker.updateIssue(a, id, patch);
      return result(`Updated ${issue.id}\n${line(issue)}`, { issue });
    }),
  );

  server.registerTool(
    "claim_issue",
    {
      description:
        "Take an issue to work on, in one step no one else can interleave with: an agent becomes its delegate, a person its assignee, and an unstarted issue (backlog, todo) moves to in_progress; one already in_progress or in_review keeps its status. Fails if the issue is done or canceled, or someone else holds it (the error names them): then pick another issue rather than working on it too. Claiming your own again is fine. To hand it back, update_issue with delegate (or assignee) null and status todo.",
      inputSchema: { id: identifier },
    },
    writes(({ id }) => {
      const issue = tracker.claimIssue(a, id);
      return result(`Claimed ${issue.id}\n${line(issue)}`, { issue });
    }),
  );

  server.registerTool(
    "comment_issue",
    {
      description:
        "Add a markdown comment to an issue, as you. Use it for progress notes, findings, decisions, and a summary of what you did when finishing (changes made, links). Comments bump the issue's updated time.",
      inputSchema: { id: identifier, body: z.string().describe("Markdown") },
    },
    writes(({ id, body }) => {
      const issue = tracker.addComment(a, id, body);
      return result(`Commented on ${issue.id}`, { issue });
    }),
  );

  server.registerTool(
    "list_documents",
    {
      description:
        "List documents (specs, plans, notes), one line each: slug · title · team · updated time and author. Ordered by team, then position. Use get_document with the slug to read one.",
      inputSchema: {
        workspace: workspaceKey.optional().describe("Only docs in this workspace's teams"),
        team: teamKey.optional(),
        query: z.string().optional().describe("Text to find in title or content"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ workspace, team, query }) => {
      const documents = tracker.listDocuments(a, { workspace, team, q: query });
      return result(documents.map(docLine).join("\n") || "No matching documents.", { documents });
    },
  );

  server.registerTool(
    "get_document",
    {
      description:
        "Get a document by slug: its full markdown content, metadata, the issues it mentions (with status), and comments. Read it before editing so `edits` can quote the current text exactly.",
      inputSchema: { slug },
      annotations: { readOnlyHint: true },
    },
    ({ slug }) => {
      const document = tracker.getDocument(a, slug);
      return result(docDetails(document), { document });
    },
  );

  server.registerTool(
    "create_document",
    {
      description:
        "Create a markdown document in a team; returns its slug. Docs are markdown: use headings, lists, tables, code blocks. Mention issues by identifier (e.g. BRD-2) and they auto-link and appear on the issue's page; link other docs with [Title](/doc/slug). The slug defaults to the title slugified (deduped) and never changes, even if the title does.",
      inputSchema: {
        team: teamKey,
        title: z.string().describe('Document title, e.g. "Architecture"'),
        content: docContent,
        slug: z.string().optional().describe("URL-safe id (a-z, 0-9, dashes); default derived from the title"),
        position: z.number().optional().describe("Order within the team, ascending; default last"),
      },
    },
    writes((input) => {
      const document = tracker.createDocument(a, input);
      return result(`Created document ${document.slug} · ${document.title} (/doc/${document.slug})`, docMeta(document));
    }),
  );

  server.registerTool(
    "update_document",
    {
      description:
        "Update a document; only the fields you pass change. For small changes to a long doc, prefer `edits`: exact find/replace pairs applied in order, each oldText must match the current content exactly once (quote enough surrounding text to be unique). If any edit fails, nothing is applied and the error names the edit. `content` replaces the whole document; don't pass both. Content is markdown: issue identifiers (e.g. BRD-2) auto-link, link docs with [Title](/doc/slug). The slug never changes.",
      inputSchema: {
        slug,
        title: z.string().optional(),
        content: docContent.optional().describe("Full replacement markdown. Prefer edits for small changes."),
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
        baseUpdatedAt: z
          .string()
          .optional()
          .describe("The updatedAt you read with get_document. If the doc changed since, nothing is applied (reread and retry). Recommended with `content`."),
      },
    },
    writes(({ slug, ...patch }) => {
      const document = tracker.updateDocument(a, slug, patch);
      return result(`Updated document ${document.slug} · ${document.title}`, docMeta(document));
    }),
  );

  server.registerTool(
    "comment_document",
    {
      description:
        "Add a markdown comment to a document, as you, e.g. review notes, questions, or a summary of what you changed. Comments don't change the content.",
      inputSchema: { slug, body: z.string().describe("Markdown") },
    },
    writes(({ slug, body }) => {
      const document = tracker.addDocumentComment(a, slug, body);
      return result(`Commented on document ${document.slug}`, docMeta(document));
    }),
  );

  const commentTarget = {
    issue: identifier.optional().describe("The issue the comment is on; pass this or document"),
    document: slug.optional().describe("The document the comment is on; pass this or issue"),
    comment: z.number().int().describe("Comment id, shown as #12 in get_issue / get_document"),
  };

  server.registerTool(
    "update_comment",
    {
      description:
        "Edit one of your own comments on an issue or a document, e.g. to fix a typo or an outdated note. It shows as edited. For new information, add a new comment instead.",
      inputSchema: { ...commentTarget, body: z.string().describe("Markdown, replaces the whole comment") },
    },
    writes(({ comment, body, ...target }) =>
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
    ),
  );

  server.registerTool(
    "delete_comment",
    {
      description: "Delete one of your own comments on an issue or a document. Only for comments posted by mistake.",
      inputSchema: commentTarget,
      annotations: { destructiveHint: true },
    },
    writes(({ comment, ...target }) =>
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
    ),
  );

  server.registerTool(
    "delete_document",
    {
      description:
        "Move a document to the trash (with its versions and comments); a person can restore it for 30 days, then it's gone. Only when asked to, or to remove a duplicate you just created; otherwise edit it.",
      inputSchema: { slug },
      annotations: { destructiveHint: true },
    },
    writes(({ slug }) => {
      tracker.deleteDocument(a, slug);
      return result(`Moved document ${slug} to the trash`, { ok: true });
    }),
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server and transport per request, JSON responses. */
export async function handleMcp(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null },
      { status: 405, headers: { Allow: "POST" } },
    );
  }
  const server = createServer(actorOf(req));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}

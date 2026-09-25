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
} from "../shared/types.ts";
import { authorFor, claimerFor, resolveAssignee, type Viewer, viewerOf } from "./auth.ts";
import * as db from "./db.ts";

const INSTRUCTIONS = `Docket is a small issue tracker shared by a human and agents.
- Workspace → project → issues and docs. A workspace (e.g. "acme") groups related projects; call list_projects to see which workspace each project is in, and pass \`workspace\` to list_issues or list_documents to stay inside one.
- Projects have a 2–5 letter key (e.g. BRD), unique across all workspaces. Issues are identified as KEY-number, e.g. BRD-12.
- Statuses: backlog, todo, in_progress, in_review, done, canceled.
- Priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
- Working on an issue: get_issue, then claim_issue (assigns you and sets in_progress; if someone else holds it, pick another), post progress notes with comment_issue, then set in_review or done. There is no delete: set status canceled instead.
- Members: people and agents can have their own token. Connected with one, you act as that member (author is set for you); list_members shows who can be assigned.
- Documents (specs, plans, notes) live in projects and are identified by a slug, e.g. "architecture". They are markdown: mention issues by identifier (BRD-2) and they auto-link; link other docs with [Title](/doc/slug). Change a long doc with update_document's \`edits\` rather than rewriting it.`;

const identifier = z.string().describe('Issue identifier: project key + number, e.g. "BRD-12" (case-insensitive)');
const projectKey = z.string().describe('Project key, e.g. "BRD"');
const workspaceKey = z.string().describe('Workspace key, e.g. "acme" (see list_workspaces)');
const status = z.enum(STATUSES).describe("backlog | todo | in_progress | in_review | done | canceled");
const priority = z.literal(PRIORITIES).describe("0 none, 1 urgent, 2 high, 3 medium, 4 low");
const labels = z.array(z.string()).describe('Label names, e.g. ["bug", "ui"]');
const blockedBy = z.array(identifier).describe("Identifiers of issues that must be finished before this one");

const slug = z.string().describe('Document slug, e.g. "architecture" (see list_documents)');
const docContent = z
  .string()
  .describe(
    "Markdown. Mention issues by identifier (e.g. BRD-2) and they auto-link; link other docs with [Title](/doc/slug).",
  );
const author = z.string().optional().describe('Default "claude". Ignored when you connect with your own member token.');

const title = z.string().describe("Short, imperative title");
const description = z.string().describe("Markdown description");

/** One line per issue: `BRD-3 · todo · high · Title · @assignee · #label`. */
function line(issue: IssueSummary): string {
  return [
    issue.id,
    issue.status,
    PRIORITY_LABELS[issue.priority].toLowerCase(),
    issue.title,
    issue.assignee && `@${issue.assignee}`,
    issue.labels.map((l) => `#${l}`).join(" "),
  ]
    .filter(Boolean)
    .join(" · ");
}

function details(issue: Issue): string {
  const meta = [
    `project ${issue.project}`,
    issue.parent && `parent ${issue.parent}`,
    issue.blockedBy.length > 0 && `blocked by ${issue.blockedBy.join(", ")}`,
    issue.blocks.length > 0 && `blocks ${issue.blocks.join(", ")}`,
    `updated ${issue.updatedAt}`,
  ];
  const parts = [line(issue), meta.filter(Boolean).join(" · "), issue.description || "_No description._"];
  if (issue.children.length) parts.push(`## Sub-issues\n${issue.children.map(line).join("\n")}`);
  if (issue.docs.length) parts.push(`## Docs\n${issue.docs.map(docLine).join("\n")}`);
  if (issue.comments.length) parts.push(commentsSection(issue.comments));
  return parts.join("\n\n");
}

function commentsSection(comments: Comment[]): string {
  const header = (c: Comment) => [`**${c.author}**`, `#${c.id}`, c.createdAt, c.editedAt && "edited"].filter(Boolean).join(" · ");
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
  throw new db.AppError("Pass exactly one of issue or document");
}

function ago(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (60 * 24))}d ago`;
}

/** One line per document: `slug · Title · PROJECT · updated 2h ago by claude`. */
function docLine(doc: DocumentSummary): string {
  return `${doc.slug} · ${doc.title} · ${doc.project} · updated ${ago(doc.updatedAt)} by ${doc.updatedBy}`;
}

function docDetails(doc: Document): string {
  const parts = [
    `# ${doc.title}`,
    `slug ${doc.slug} · project ${doc.project} · updated ${doc.updatedAt} by ${doc.updatedBy} · ${doc.versionCount} version${doc.versionCount === 1 ? "" : "s"}`,
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

function createServer(viewer: Viewer): McpServer {
  const server = new McpServer({ name: "docket", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const by = (author: string | undefined) => authorFor(viewer, author, "claude") as string;
  const who = <T,>(assignee: T) => resolveAssignee(viewer, assignee) as T;

  server.registerTool(
    "list_workspaces",
    {
      description:
        "List workspaces, one line each: key · name · project count. A workspace groups related projects (workspace → project → issues and docs).",
      annotations: { readOnlyHint: true },
    },
    () => {
      const workspaces = db.listWorkspaces();
      const lines = workspaces.map((w) => `${w.key} · ${w.name} · ${w.projectCount} project${w.projectCount === 1 ? "" : "s"}`);
      return result(lines.join("\n") || "No workspaces yet.", { workspaces });
    },
  );

  server.registerTool(
    "create_workspace",
    {
      description:
        "Create a workspace to group a separate body of work's projects. Check list_workspaces first; only create one when asked to.",
      inputSchema: {
        key: z.string().optional().describe('URL-safe id (a-z, 0-9, dashes), e.g. "acme"; default derived from the name'),
        name: z.string(),
      },
    },
    (input) => {
      const workspace = db.createWorkspace(input);
      return result(`Created workspace ${workspace.key} · ${workspace.name}`, { workspace });
    },
  );

  server.registerTool(
    "update_workspace",
    {
      description: "Rename a workspace. Its key never changes. Only do this when asked to.",
      inputSchema: { key: workspaceKey, name: z.string() },
    },
    ({ key, name }) => {
      const workspace = db.updateWorkspace(key, { name });
      return result(`Updated workspace ${workspace.key} · ${workspace.name}`, { workspace });
    },
  );

  server.registerTool(
    "list_projects",
    {
      description:
        "List projects with their workspace and open-issue counts, one line each: key · name · workspace · open count. A project's key (e.g. BRD) prefixes its issue identifiers (BRD-12).",
      inputSchema: { workspace: workspaceKey.optional().describe("Only projects in this workspace") },
      annotations: { readOnlyHint: true },
    },
    ({ workspace }) => {
      const projects = db.listProjects({ workspace });
      const lines = projects.map((p) => {
        const open = OPEN_STATUSES.reduce((sum, s) => sum + p.counts[s], 0);
        return `${p.key} · ${p.name} · workspace ${p.workspace} · ${open} open`;
      });
      return result(lines.join("\n") || "No projects yet.", { projects });
    },
  );

  server.registerTool(
    "create_project",
    {
      description:
        "Create a project in a workspace. The key is 2–5 letters (uppercased), permanent, unique across all workspaces, and prefixes every issue identifier: key BRD gives BRD-1, BRD-2… Check list_projects first; only create a project when asked to.",
      inputSchema: {
        key: z.string().describe('2–5 letters, e.g. "BRD"'),
        workspace: workspaceKey.optional().describe("Required when more than one workspace exists; otherwise the only one"),
        name: z.string(),
        description: z.string().optional(),
      },
    },
    ({ workspace, ...input }) => {
      if (!workspace) {
        const all = db.listWorkspaces();
        if (all.length !== 1) {
          throw new db.AppError(`Pass workspace: one of ${all.map((w) => w.key).join(", ") || "(none yet, create one first)"}`);
        }
        workspace = all[0]!.key;
      }
      const project = db.createProject({ ...input, workspace });
      return result(`Created project ${project.key} · ${project.name} in workspace ${project.workspace}`, { project });
    },
  );

  server.registerTool(
    "update_project",
    {
      description:
        "Update a project's name or description, or move it to another workspace; only the fields you pass change. Its key never changes, so issue identifiers stay the same. Only do this when asked to.",
      inputSchema: {
        key: projectKey,
        name: z.string().optional(),
        description: z.string().optional(),
        workspace: workspaceKey.optional().describe("Move the project to this workspace"),
      },
    },
    ({ key, ...patch }) => {
      const project = db.updateProject(key, patch);
      return result(`Updated project ${project.key} · ${project.name} in workspace ${project.workspace}`, { project });
    },
  );

  server.registerTool(
    "list_issues",
    {
      description:
        "List issues, one line each: identifier · status · priority · title · @assignee · #labels. Sorted by status, then priority (urgent first, none last), then most recently updated. Only open issues (backlog, todo, in_progress, in_review) unless you pass `status`. Use get_issue for the description, comments, sub-issues and blockers.",
      inputSchema: {
        workspace: workspaceKey.optional().describe("Only issues in this workspace's projects"),
        project: projectKey.optional(),
        status: z.array(status).optional().describe("Only these statuses. Default: all except done and canceled."),
        label: z.string().optional(),
        assignee: z.string().optional().describe('A name, or "me" (your member token)'),
        parent: identifier.optional().describe("Only sub-issues of this issue, e.g. BRD-12"),
        query: z.string().optional().describe("Text to find in identifier, title or description"),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum issues to return (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status, query, limit = 50, assignee, ...filter }) => {
      const all = db.listIssues({ ...filter, assignee: who(assignee), status: status ?? OPEN_STATUSES, q: query });
      const issues = all.slice(0, limit);
      const lines = issues.map(line);
      if (all.length > limit) lines.push(`…and ${all.length - limit} more (raise limit or narrow the filters)`);
      return result(lines.join("\n") || "No matching issues.", { issues, total: all.length });
    },
  );

  server.registerTool(
    "list_members",
    {
      description:
        "List members (people and agents with their own token), one line each: name · kind · role, marking you. Once any member exists, assignees must be member names.",
      annotations: { readOnlyHint: true },
    },
    () => {
      const members = db.listMembers().filter((m) => !m.revokedAt);
      const you = viewer.member?.name;
      const lines = members.map((m) => `${m.name} · ${m.kind} · ${m.role}${m.name === you ? " · you" : ""}`);
      return result(lines.join("\n") || "No members yet: assignees are free text.", { members, you: you ?? null });
    },
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
      const labels = db.listLabels({ workspace });
      return result(labels.map((l) => `${l.label} · ${l.open} open`).join("\n") || "No labels yet.", { labels });
    },
  );

  server.registerTool(
    "get_issue",
    {
      description:
        "Get one issue by identifier (e.g. BRD-12): markdown description, status, priority, labels, assignee, parent, sub-issues, blocked-by/blocks, and comments. Read it before starting work on an issue.",
      inputSchema: { id: identifier },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => {
      const issue = db.getIssue(id);
      return result(details(issue), { issue });
    },
  );

  server.registerTool(
    "create_issue",
    {
      description:
        "Create an issue in a project; returns its identifier (e.g. BRD-13). Defaults: status todo, priority 0 (none). Statuses: backlog, todo, in_progress, in_review, done, canceled. Priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. Set parent to make it a sub-issue, blockedBy for issues that must be finished first.",
      inputSchema: {
        project: projectKey,
        title,
        description: description.optional(),
        status: status.optional().describe("Default todo"),
        priority: priority.optional().describe("0 none (default), 1 urgent, 2 high, 3 medium, 4 low"),
        labels: labels.optional(),
        assignee: z.string().optional().describe('Who owns it: a member name (see list_members), or "me"'),
        parent: identifier.optional().describe("Parent issue identifier, making this a sub-issue"),
        blockedBy: blockedBy.optional(),
      },
    },
    ({ assignee, ...input }) => {
      const issue = db.createIssue({ ...input, assignee: who(assignee) });
      return result(`Created ${issue.id}\n${line(issue)}`, { issue });
    },
  );

  server.registerTool(
    "update_issue",
    {
      description:
        "Update an issue; only the fields you pass change. Status flow: in_progress when you start, in_review when ready for review, done when finished, canceled instead of deleting (there is no delete). labels and blockedBy replace the whole list, so include existing entries you want to keep, and pass baseUpdatedAt (from get_issue) when replacing them or the description, so you don't overwrite someone else's change. To start work, prefer claim_issue. Pass null for assignee or parent to clear it. Log progress with comment_issue rather than editing the description.",
      inputSchema: {
        id: identifier,
        title: title.optional(),
        description: description.optional(),
        status: status.optional(),
        priority: priority.optional(),
        labels: labels.optional(),
        assignee: z.string().nullable().optional().describe('Who owns it, or "me"; null to unassign'),
        parent: identifier.nullable().optional().describe("Parent issue identifier; null to detach"),
        blockedBy: blockedBy.optional(),
        baseUpdatedAt: z
          .string()
          .optional()
          .describe("The updated time you read with get_issue. If the issue changed since, nothing is applied (reread and retry)."),
      },
    },
    ({ id, assignee, ...patch }) => {
      const issue = db.updateIssue(id, { ...patch, assignee: who(assignee) });
      return result(`Updated ${issue.id}\n${line(issue)}`, { issue });
    },
  );

  server.registerTool(
    "claim_issue",
    {
      description:
        "Take an issue to work on: assigns it to you and sets in_progress, in one step no one else can interleave with. Fails if the issue is done or canceled, or someone else holds it (the error names them): then pick another issue rather than working on it too. Claiming your own again is fine. To hand it back, update_issue with assignee null and status todo.",
      inputSchema: {
        id: identifier,
        assignee: z
          .string()
          .optional()
          .describe("Only without a member token: who to claim it for. With one, you always claim for yourself."),
      },
    },
    ({ id, assignee }) => {
      const issue = db.claimIssue(id, claimerFor(viewer, assignee));
      return result(`Claimed ${issue.id}\n${line(issue)}`, { issue });
    },
  );

  server.registerTool(
    "comment_issue",
    {
      description:
        "Add a markdown comment to an issue. Use it for progress notes, findings, decisions, and a summary of what you did when finishing (changes made, links). Comments bump the issue's updated time.",
      inputSchema: {
        id: identifier,
        body: z.string().describe("Markdown"),
        author,
      },
    },
    ({ id, body, author }) => {
      const issue = db.addComment(id, body, by(author));
      return result(`Commented on ${issue.id}`, { issue });
    },
  );

  server.registerTool(
    "list_documents",
    {
      description:
        "List documents (specs, plans, notes), one line each: slug · title · project · updated time and author. Ordered by project, then position. Use get_document with the slug to read one.",
      inputSchema: {
        workspace: workspaceKey.optional().describe("Only docs in this workspace's projects"),
        project: projectKey.optional(),
        query: z.string().optional().describe("Text to find in title or content"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ workspace, project, query }) => {
      const documents = db.listDocuments({ workspace, project, q: query });
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
      const document = db.getDocument(slug);
      return result(docDetails(document), { document });
    },
  );

  server.registerTool(
    "create_document",
    {
      description:
        "Create a markdown document in a project; returns its slug. Docs are markdown: use headings, lists, tables, code blocks. Mention issues by identifier (e.g. BRD-2) and they auto-link and appear on the issue's page; link other docs with [Title](/doc/slug). The slug defaults to the title slugified (deduped) and never changes, even if the title does.",
      inputSchema: {
        project: projectKey,
        title: z.string().describe("Document title, e.g. \"Architecture\""),
        content: docContent,
        slug: z.string().optional().describe('URL-safe id (a-z, 0-9, dashes); default derived from the title'),
        position: z.number().optional().describe("Order within the project, ascending; default last"),
        author,
      },
    },
    ({ author, ...input }) => {
      const document = db.createDocument({ ...input, author: by(author) });
      return result(`Created document ${document.slug} · ${document.title} (/doc/${document.slug})`, docMeta(document));
    },
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
        project: projectKey.optional().describe("Move the doc to this project"),
        position: z.number().optional().describe("Order within the project, ascending"),
        baseUpdatedAt: z
          .string()
          .optional()
          .describe("The updatedAt you read with get_document. If the doc changed since, nothing is applied (reread and retry). Recommended with `content`."),
        author,
      },
    },
    ({ slug, author, ...patch }) => {
      const document = db.updateDocument(slug, { ...patch, author: by(author) });
      return result(`Updated document ${document.slug} · ${document.title}`, docMeta(document));
    },
  );

  server.registerTool(
    "comment_document",
    {
      description:
        "Add a markdown comment to a document, e.g. review notes, questions, or a summary of what you changed. Comments don't change the content.",
      inputSchema: {
        slug,
        body: z.string().describe("Markdown"),
        author,
      },
    },
    ({ slug, body, author }) => {
      const document = db.addDocumentComment(slug, body, by(author));
      return result(`Commented on document ${document.slug}`, docMeta(document));
    },
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
        "Edit one of your own comments (the author must match) on an issue or a document, e.g. to fix a typo or an outdated note. It shows as edited. For new information, add a new comment instead.",
      inputSchema: { ...commentTarget, body: z.string().describe("Markdown, replaces the whole comment"), author },
    },
    ({ comment, body, author, ...target }) =>
      commentOn(
        target,
        (id) => {
          const issue = db.updateIssueComment(id, comment, body, by(author));
          return result(`Edited comment #${comment} on ${issue.id}`, { issue });
        },
        (slug) => {
          const document = db.updateDocumentComment(slug, comment, body, by(author));
          return result(`Edited comment #${comment} on document ${document.slug}`, docMeta(document));
        },
      ),
  );

  server.registerTool(
    "delete_comment",
    {
      description: "Delete one of your own comments (the author must match) on an issue or a document. Only for comments posted by mistake.",
      inputSchema: { ...commentTarget, author },
      annotations: { destructiveHint: true },
    },
    ({ comment, author, ...target }) =>
      commentOn(
        target,
        (id) => {
          const issue = db.deleteIssueComment(id, comment, by(author));
          return result(`Deleted comment #${comment} on ${issue.id}`, { issue });
        },
        (slug) => {
          const document = db.deleteDocumentComment(slug, comment, by(author));
          return result(`Deleted comment #${comment} on document ${document.slug}`, docMeta(document));
        },
      ),
  );

  server.registerTool(
    "delete_document",
    {
      description:
        "Permanently delete a document with its versions and comments. Only when asked to, or to remove a duplicate you just created; otherwise edit it.",
      inputSchema: { slug },
      annotations: { destructiveHint: true },
    },
    ({ slug }) => {
      db.deleteDocument(slug);
      return result(`Deleted document ${slug}`, { ok: true });
    },
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
  const server = createServer(viewerOf(req));
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

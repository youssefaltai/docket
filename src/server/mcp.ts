import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  PRIORITIES,
  PRIORITY_LABELS,
  STATUSES,
  type Document,
  type DocumentSummary,
  type Issue,
  type IssueSummary,
} from "../shared/types.ts";
import * as db from "./db.ts";

const INSTRUCTIONS = `Docket is a small issue tracker shared by a human and agents.
- Workspace → project → issues and docs. A workspace (e.g. "default") groups related projects; call list_projects to see which workspace each project is in, and pass \`workspace\` to list_issues or list_documents to stay inside one.
- Projects have a 2–5 letter key (e.g. BRD), unique across all workspaces. Issues are identified as KEY-number, e.g. BRD-12.
- Statuses: backlog, todo, in_progress, in_review, done, canceled.
- Priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
- Working on an issue: get_issue, set status in_progress, post progress notes with comment_issue, then set in_review or done. There is no delete: set status canceled instead.
- Documents (specs, plans, notes) live in projects and are identified by a slug, e.g. "architecture". They are markdown: mention issues by identifier (BRD-2) and they auto-link; link other docs with [Title](/doc/slug). Change a long doc with update_document's \`edits\` rather than rewriting it.`;

const identifier = z.string().describe('Issue identifier: project key + number, e.g. "BRD-12" (case-insensitive)');
const projectKey = z.string().describe('Project key, e.g. "BRD"');
const workspaceKey = z.string().describe('Workspace key, e.g. "default" (see list_workspaces)');
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
const docAuthor = z.string().optional().describe('Default "claude"');

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
  if (issue.comments.length) {
    parts.push(`## Comments\n${issue.comments.map((c) => `**${c.author}** · ${c.createdAt}\n${c.body}`).join("\n\n")}`);
  }
  return parts.join("\n\n");
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
  if (doc.comments.length) {
    parts.push(`## Comments\n${doc.comments.map((c) => `**${c.author}** · ${c.createdAt}\n${c.body}`).join("\n\n")}`);
  }
  return parts.join("\n\n");
}

/** Mutations echo metadata only, so a long document isn't sent back on every edit. */
function docMeta({ content, ...meta }: Document) {
  return { document: meta };
}

function result(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function createServer(): McpServer {
  const server = new McpServer({ name: "docket", version: "1.0.0" }, { instructions: INSTRUCTIONS });

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
        key: z.string().optional().describe('URL-safe id (a-z, 0-9, dashes), e.g. "default"; default derived from the name'),
        name: z.string(),
      },
    },
    (input) => {
      const workspace = db.createWorkspace(input);
      return result(`Created workspace ${workspace.key} · ${workspace.name}`, { workspace });
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
        const open = db.OPEN_STATUSES.reduce((sum, s) => sum + p.counts[s], 0);
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
    "list_issues",
    {
      description:
        "List issues, one line each: identifier · status · priority · title · @assignee · #labels. Sorted by status, then priority (urgent first, none last), then most recently updated. Only open issues (backlog, todo, in_progress, in_review) unless you pass `status`. Use get_issue for the description, comments, sub-issues and blockers.",
      inputSchema: {
        workspace: workspaceKey.optional().describe("Only issues in this workspace's projects"),
        project: projectKey.optional(),
        status: z.array(status).optional().describe("Only these statuses. Default: all except done and canceled."),
        label: z.string().optional(),
        assignee: z.string().optional(),
        parent: identifier.optional().describe("Only sub-issues of this issue, e.g. BRD-12"),
        query: z.string().optional().describe("Text to find in identifier, title or description"),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum issues to return (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status, query, limit = 50, ...filter }) => {
      const all = db.listIssues({ ...filter, status: status ?? db.OPEN_STATUSES, q: query });
      const issues = all.slice(0, limit);
      const lines = issues.map(line);
      if (all.length > limit) lines.push(`…and ${all.length - limit} more (raise limit or narrow the filters)`);
      return result(lines.join("\n") || "No matching issues.", { issues, total: all.length });
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
        assignee: z.string().optional().describe("Who owns it, e.g. alice or claude"),
        parent: identifier.optional().describe("Parent issue identifier, making this a sub-issue"),
        blockedBy: blockedBy.optional(),
      },
    },
    (input) => {
      const issue = db.createIssue(input);
      return result(`Created ${issue.id}\n${line(issue)}`, { issue });
    },
  );

  server.registerTool(
    "update_issue",
    {
      description:
        "Update an issue; only the fields you pass change. Status flow: in_progress when you start, in_review when ready for review, done when finished, canceled instead of deleting (there is no delete). labels and blockedBy replace the whole list, so include existing entries you want to keep. Pass null for assignee or parent to clear it. Log progress with comment_issue rather than editing the description.",
      inputSchema: {
        id: identifier,
        title: title.optional(),
        description: description.optional(),
        status: status.optional(),
        priority: priority.optional(),
        labels: labels.optional(),
        assignee: z.string().nullable().optional().describe("Who owns it; null to unassign"),
        parent: identifier.nullable().optional().describe("Parent issue identifier; null to detach"),
        blockedBy: blockedBy.optional(),
      },
    },
    ({ id, ...patch }) => {
      const issue = db.updateIssue(id, patch);
      return result(`Updated ${issue.id}\n${line(issue)}`, { issue });
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
        author: z.string().optional().describe('Default "claude"'),
      },
    },
    ({ id, body, author = "claude" }) => {
      const issue = db.addComment(id, body, author);
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
        author: docAuthor,
      },
    },
    ({ author = "claude", ...input }) => {
      const document = db.createDocument({ ...input, author });
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
        author: docAuthor,
      },
    },
    ({ slug, author = "claude", ...patch }) => {
      const document = db.updateDocument(slug, { ...patch, author });
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
        author: docAuthor,
      },
    },
    ({ slug, body, author = "claude" }) => {
      const document = db.addDocumentComment(slug, body, author);
      return result(`Commented on document ${document.slug}`, docMeta(document));
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
  const server = createServer();
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

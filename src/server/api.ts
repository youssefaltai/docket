import type { BunRequest } from "bun";
import type { CustomViewInput, DocumentInput, IssueFilter, IssueInput, IssueTemplateInput, LabelInput, MilestoneInput, ProjectInput, TeamInput, WebhookInput, WorkflowStatusInput, WorkspaceInput } from "../shared/types.ts";
import * as access from "./access.ts";
import { actorOf, isJson } from "./auth.ts";
import { AppError } from "./db.ts";
import * as github from "./github.ts";
import { originOf } from "./http.ts";
import * as inbox from "./inbox.ts";
import * as push from "./push.ts";
import * as tracker from "./tracker.ts";
import * as webhooks from "./webhooks.ts";

/** Wraps a handler: its return value becomes the JSON body (unless it's a Response); errors become `{ error }`. */
function handle<Path extends string>(fn: (req: BunRequest<Path>) => unknown, status = 200) {
  return async (req: BunRequest<Path>) => {
    try {
      const data = await fn(req);
      return data instanceof Response ? data : Response.json(data ?? { ok: true }, { status });
    } catch (err) {
      if (err instanceof AppError) return Response.json({ error: err.message }, { status: err.status });
      console.error(err);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

/** The JSON object body. Its fields are unchecked: the data modules validate every one. */
async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  // JSON only: browsers can't send it cross-origin without a CORS preflight, which Docket never allows.
  if (!isJson(req)) throw new AppError("Expected Content-Type: application/json", 415);
  const data = await req.json().catch(() => {
    throw new AppError("Invalid JSON body");
  });
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new AppError("Expected a JSON object");
  return data as T;
}

/**
 * A PATCH body with only the fields that can change: anything else is 400 naming it, so a typo or an
 * unsupported change (moving a team to another workspace) doesn't pass as a silent 200.
 */
async function patch<T = Record<string, unknown>>(req: Request, what: string, fields: readonly string[], why: Record<string, string> = {}): Promise<T> {
  const data = await body(req);
  for (const field of Object.keys(data)) {
    if (!fields.includes(field)) {
      throw new AppError(Object.hasOwn(why, field) ? why[field]! : `Unknown field "${field}" for ${what}: use ${fields.join(", ")}`);
    }
  }
  return data as T;
}

const ISSUE_FIELDS = ["title", "description", "team", "status", "priority", "labels", "assignee", "delegate", "parent", "blockedBy", "relatedTo", "duplicateOf", "dueOn", "estimate", "project", "milestone", "cycle", "baseUpdatedAt"];
const TEAM_FIELDS = ["name", "description", "defaultStatus", "autoCloseParent", "autoCloseChildren", "autoArchiveDays", "estimateScale", "cycleWeeks", "upcomingCycles", "cycleStartsOn", "private"];
const DOCUMENT_FIELDS = ["title", "content", "edits", "team", "position", "checkpoint", "project", "baseUpdatedAt"];
const PROJECT_FIELDS = ["name", "description", "status", "lead", "targetDate", "teams", "baseUpdatedAt"];
const MILESTONE_FIELDS = ["name", "description", "targetDate", "position"];
const TEMPLATE_FIELDS = ["name", "title", "description", "status", "priority", "labels"];

const param = (req: Request, name: string) => new URL(req.url).searchParams.get(name) || undefined;

const issueFilter = (req: Request): IssueFilter => ({
  team: param(req, "team"),
  status: param(req, "status")?.split(","),
  category: param(req, "category")?.split(",") as IssueFilter["category"],
  label: param(req, "label"),
  assignee: param(req, "assignee"),
  delegate: param(req, "delegate"),
  creator: param(req, "creator"),
  parent: param(req, "parent"),
  project: param(req, "project"),
  cycle: param(req, "cycle"),
  q: param(req, "q"),
  subscribed: param(req, "subscribed") === "true" || undefined,
  due: param(req, "due") as IssueFilter["due"],
  sort: param(req, "sort") as IssueFilter["sort"],
  archived: param(req, "archived") === "true" || undefined,
});

const link = (req: Request, { code, expiresAt }: { code: string; expiresAt: string }) => ({
  code,
  url: `${originOf(req)}/login#${code}`,
  expiresAt,
});

export const apiRoutes = {
  // --- You ---
  "/api/me": {
    GET: handle((req) => access.me(actorOf(req))),
    PATCH: handle(async (req) => {
      const perWorkspace = "Your name and username are per workspace: PATCH /api/workspaces/:key/profile";
      return access.updateMe(actorOf(req), await patch(req, "your account", ["email"], { name: perWorkspace, username: perWorkspace }));
    }),
  },
  "/api/sessions": {
    GET: handle((req) => access.listSessions(actorOf(req))),
    DELETE: handle((req) => access.revokeOtherSessions(actorOf(req))),
  },
  "/api/sessions/:id": {
    DELETE: handle<"/api/sessions/:id">((req) => access.revokeSession(actorOf(req), req.params.id)),
  },
  "/api/sign-in-links": {
    POST: handle((req) => link(req, access.selfSignInLink(actorOf(req))), 201),
  },
  "/api/api-keys": {
    GET: handle((req) => access.listApiKeys(actorOf(req))),
    POST: handle(async (req) => access.createApiKey(actorOf(req), await body(req)), 201),
  },
  "/api/api-keys/:id": {
    DELETE: handle<"/api/api-keys/:id">((req) => access.revokeApiKey(actorOf(req), req.params.id)),
  },
  // Which of your workspaces a link made before URLs carried one points into.
  "/api/locate": {
    GET: handle((req) => tracker.locate(actorOf(req), { issue: param(req, "issue"), doc: param(req, "doc"), team: param(req, "team") })),
  },

  // --- Workspaces and members ---
  "/api/workspaces": {
    GET: handle((req) => access.listWorkspaces(actorOf(req))),
    POST: handle(async (req) => access.createWorkspace(actorOf(req), await body<WorkspaceInput>(req)), 201),
  },
  "/api/workspaces/:key": {
    PATCH: handle<"/api/workspaces/:key">(async (req) =>
      access.updateWorkspace(actorOf(req), req.params.key, await patch(req, "a workspace", ["name"], { key: "A workspace's key never changes" })),
    ),
  },
  "/api/workspaces/:key/profile": {
    PATCH: handle<"/api/workspaces/:key/profile">(async (req) =>
      access.updateProfile(actorOf(req), req.params.key, await patch(req, "your profile", ["name", "username"])),
    ),
  },
  "/api/workspaces/:key/members": {
    GET: handle<"/api/workspaces/:key/members">((req) => access.listMembers(actorOf(req), req.params.key)),
  },
  "/api/workspaces/:key/members/:username": {
    PATCH: handle<"/api/workspaces/:key/members/:username">(async (req) =>
      access.updateMember(actorOf(req), req.params.key, req.params.username, await patch(req, "a member", ["role", "suspended"])),
    ),
  },
  "/api/workspaces/:key/teams": {
    GET: handle<"/api/workspaces/:key/teams">((req) => access.listTeamListings(actorOf(req), req.params.key)),
  },
  "/api/workspaces/:key/invites": {
    POST: handle<"/api/workspaces/:key/invites">(async (req) => link(req, access.invite(actorOf(req), req.params.key, await body(req))), 201),
  },
  "/api/workspaces/:key/agents": {
    POST: handle<"/api/workspaces/:key/agents">(async (req) => access.createAgent(actorOf(req), req.params.key, await body(req)), 201),
  },
  "/api/workspaces/:key/agents/:username": {
    DELETE: handle<"/api/workspaces/:key/agents/:username">((req) =>
      access.removeAgent(actorOf(req), req.params.key, req.params.username),
    ),
  },
  "/api/workspaces/:key/agents/:username/token": {
    POST: handle<"/api/workspaces/:key/agents/:username/token">((req) =>
      access.rotateAgentToken(actorOf(req), req.params.key, req.params.username),
    ),
  },
  "/api/workspaces/:key/github": {
    GET: handle<"/api/workspaces/:key/github">((req) => github.connection(actorOf(req), req.params.key, req)),
    POST: handle<"/api/workspaces/:key/github">((req) => github.connect(actorOf(req), req.params.key, req), 201),
    DELETE: handle<"/api/workspaces/:key/github">((req) => github.disconnect(actorOf(req), req.params.key)),
  },
  "/api/workspaces/:key/webhooks": {
    GET: handle<"/api/workspaces/:key/webhooks">((req) => webhooks.listWebhooks(actorOf(req), req.params.key)),
    POST: handle<"/api/workspaces/:key/webhooks">(
      async (req) => webhooks.createWebhook(actorOf(req), req.params.key, await body<WebhookInput>(req)),
      201,
    ),
  },
  "/api/workspaces/:key/webhooks/:id": {
    PATCH: handle<"/api/workspaces/:key/webhooks/:id">(async (req) =>
      webhooks.updateWebhook(actorOf(req), req.params.key, req.params.id, await patch(req, "a webhook", ["url", "label", "resourceTypes", "enabled"])),
    ),
    DELETE: handle<"/api/workspaces/:key/webhooks/:id">((req) => webhooks.deleteWebhook(actorOf(req), req.params.key, req.params.id)),
  },
  "/api/workspaces/:key/webhooks/:id/secret": {
    POST: handle<"/api/workspaces/:key/webhooks/:id/secret">((req) => webhooks.rotateWebhookSecret(actorOf(req), req.params.key, req.params.id)),
  },
  "/api/workspaces/:key/webhooks/:id/deliveries": {
    GET: handle<"/api/workspaces/:key/webhooks/:id/deliveries">((req) => webhooks.listDeliveries(actorOf(req), req.params.key, req.params.id)),
  },

  // --- Teams and issues ---
  "/api/teams": {
    GET: handle((req) => tracker.listTeams(actorOf(req))),
    POST: handle(async (req) => tracker.createTeam(actorOf(req), await body<TeamInput>(req)), 201),
  },
  "/api/teams/:key": {
    PATCH: handle<"/api/teams/:key">(async (req) =>
      tracker.updateTeam(
        actorOf(req),
        req.params.key,
        await patch(req, "a team", TEAM_FIELDS, {
          workspace: "Teams can't move between workspaces",
          key: "A team's key never changes",
        }),
      ),
    ),
  },
  "/api/teams/:key/members": {
    GET: handle<"/api/teams/:key/members">((req) => tracker.listTeamMembers(actorOf(req), req.params.key)),
    POST: handle<"/api/teams/:key/members">(async (req) =>
      tracker.addTeamMember(actorOf(req), req.params.key, (await patch(req, "a team member", ["username"])).username),
    ),
  },
  "/api/teams/:key/members/:username": {
    DELETE: handle<"/api/teams/:key/members/:username">((req) => tracker.removeTeamMember(actorOf(req), req.params.key, req.params.username)),
  },
  "/api/teams/:key/statuses": {
    POST: handle<"/api/teams/:key/statuses">(
      async (req) => tracker.createStatus(actorOf(req), req.params.key, await body<WorkflowStatusInput>(req)),
      201,
    ),
  },
  "/api/teams/:key/statuses/:status": {
    PATCH: handle<"/api/teams/:key/statuses/:status">(async (req) =>
      tracker.updateStatus(
        actorOf(req),
        req.params.key,
        req.params.status,
        await patch(req, "a status", ["name", "color", "position"], {
          key: "A status's key never changes",
          category: "A status's category never changes: add one in the other category, then delete this one",
        }),
      ),
    ),
    DELETE: handle<"/api/teams/:key/statuses/:status">((req) =>
      tracker.deleteStatus(actorOf(req), req.params.key, req.params.status, param(req, "moveTo")),
    ),
  },
  "/api/teams/:key/cycles": {
    GET: handle<"/api/teams/:key/cycles">((req) => tracker.listCycles(actorOf(req), req.params.key)),
  },
  "/api/teams/:key/trash": {
    GET: handle<"/api/teams/:key/trash">((req) => tracker.listTrash(actorOf(req), req.params.key)),
  },
  "/api/issues": {
    // Without first/after, the whole list (as before); with them, a page: { issues, pageInfo }.
    GET: handle((req) => {
      const first = param(req, "first");
      const after = param(req, "after");
      if (first === undefined && after === undefined) return tracker.listIssues(actorOf(req), issueFilter(req));
      return tracker.listIssuesPage(actorOf(req), issueFilter(req), { first, after });
    }),
    POST: handle(async (req) => tracker.createIssue(actorOf(req), await body<IssueInput>(req)), 201),
  },
  "/api/issues/bulk": {
    POST: handle(async (req) => {
      const { ids, patch: change } = await patch(req, "a bulk edit", ["ids", "patch"]);
      return { results: tracker.bulkUpdateIssues(actorOf(req), ids, change) };
    }),
  },
  "/api/issues/:id": {
    GET: handle<"/api/issues/:id">((req) => tracker.getIssue(actorOf(req), req.params.id)),
    PATCH: handle<"/api/issues/:id">(async (req) =>
      tracker.updateIssue(actorOf(req), req.params.id, await patch(req, "an issue", ISSUE_FIELDS)),
    ),
    DELETE: handle<"/api/issues/:id">((req) => tracker.deleteIssue(actorOf(req), req.params.id)),
  },
  "/api/issues/:id/restore": {
    POST: handle<"/api/issues/:id/restore">((req) => tracker.restoreIssue(actorOf(req), req.params.id)),
  },
  "/api/issues/:id/archive": {
    POST: handle<"/api/issues/:id/archive">((req) => tracker.archiveIssue(actorOf(req), req.params.id)),
  },
  "/api/issues/:id/unarchive": {
    POST: handle<"/api/issues/:id/unarchive">((req) => tracker.unarchiveIssue(actorOf(req), req.params.id)),
  },
  "/api/issues/:id/claim": {
    POST: handle<"/api/issues/:id/claim">((req) => tracker.claimIssue(actorOf(req), req.params.id)),
  },
  "/api/issues/:id/comments": {
    POST: handle<"/api/issues/:id/comments">(async (req) => {
      const { body: text, parent } = await body(req);
      return tracker.addComment(actorOf(req), req.params.id, text, parent);
    }, 201),
  },
  "/api/issues/:id/comments/:cid": {
    PATCH: handle<"/api/issues/:id/comments/:cid">(async (req) =>
      tracker.updateIssueComment(actorOf(req), req.params.id, req.params.cid, (await patch(req, "a comment", ["body"])).body),
    ),
    DELETE: handle<"/api/issues/:id/comments/:cid">((req) => tracker.deleteIssueComment(actorOf(req), req.params.id, req.params.cid)),
  },
  "/api/issues/:id/comments/:cid/resolved": {
    PUT: handle<"/api/issues/:id/comments/:cid/resolved">((req) => tracker.resolveIssueThread(actorOf(req), req.params.id, req.params.cid, true)),
    DELETE: handle<"/api/issues/:id/comments/:cid/resolved">((req) => tracker.resolveIssueThread(actorOf(req), req.params.id, req.params.cid, false)),
  },
  "/api/issues/:id/reactions/:emoji": {
    PUT: handle<"/api/issues/:id/reactions/:emoji">((req) => tracker.reactToIssue(actorOf(req), req.params.id, req.params.emoji, true)),
    DELETE: handle<"/api/issues/:id/reactions/:emoji">((req) => tracker.reactToIssue(actorOf(req), req.params.id, req.params.emoji, false)),
  },
  "/api/issues/:id/comments/:cid/reactions/:emoji": {
    PUT: handle<"/api/issues/:id/comments/:cid/reactions/:emoji">((req) =>
      tracker.reactToIssueComment(actorOf(req), req.params.id, req.params.cid, req.params.emoji, true),
    ),
    DELETE: handle<"/api/issues/:id/comments/:cid/reactions/:emoji">((req) =>
      tracker.reactToIssueComment(actorOf(req), req.params.id, req.params.cid, req.params.emoji, false),
    ),
  },
  "/api/issues/:id/subscription": {
    PUT: handle<"/api/issues/:id/subscription">((req) => tracker.subscribeIssue(actorOf(req), req.params.id, true)),
    DELETE: handle<"/api/issues/:id/subscription">((req) => tracker.subscribeIssue(actorOf(req), req.params.id, false)),
  },
  "/api/labels": {
    GET: handle((req) => tracker.listLabels(actorOf(req), { team: param(req, "team") })),
    POST: handle(async (req) => tracker.createLabel(actorOf(req), await body<LabelInput>(req)), 201),
  },
  "/api/labels/:id": {
    PATCH: handle<"/api/labels/:id">(async (req) =>
      tracker.updateLabel(
        actorOf(req),
        req.params.id,
        await patch(req, "a label", ["name", "color", "team", "group"], {
          isGroup: "A label can't become a group, or a group a label: create a new one",
          workspace: "Labels can't move between workspaces",
        }),
      ),
    ),
    DELETE: handle<"/api/labels/:id">((req) => tracker.deleteLabel(actorOf(req), req.params.id)),
  },
  "/api/templates": {
    GET: handle((req) => tracker.listTemplates(actorOf(req), { team: param(req, "team") })),
    POST: handle(async (req) => tracker.createTemplate(actorOf(req), await body<IssueTemplateInput>(req)), 201),
  },
  "/api/templates/:id": {
    PATCH: handle<"/api/templates/:id">(async (req) => tracker.updateTemplate(actorOf(req), req.params.id, await patch(req, "a template", TEMPLATE_FIELDS))),
    DELETE: handle<"/api/templates/:id">((req) => tracker.deleteTemplate(actorOf(req), req.params.id)),
  },

  // --- Projects ---
  "/api/projects": {
    GET: handle((req) => tracker.listProjects(actorOf(req), { team: param(req, "team"), status: param(req, "status")?.split(",") })),
    POST: handle(async (req) => tracker.createProject(actorOf(req), await body<ProjectInput>(req)), 201),
  },
  "/api/projects/:slug": {
    GET: handle<"/api/projects/:slug">((req) => tracker.getProject(actorOf(req), req.params.slug)),
    PATCH: handle<"/api/projects/:slug">(async (req) =>
      tracker.updateProject(
        actorOf(req),
        req.params.slug,
        await patch(req, "a project", PROJECT_FIELDS, { slug: "A project's slug never changes", workspace: "Projects can't move between workspaces" }),
      ),
    ),
  },
  "/api/projects/:slug/milestones": {
    POST: handle<"/api/projects/:slug/milestones">(
      async (req) => tracker.createMilestone(actorOf(req), req.params.slug, await body<MilestoneInput>(req)),
      201,
    ),
  },
  "/api/projects/:slug/milestones/:id": {
    PATCH: handle<"/api/projects/:slug/milestones/:id">(async (req) =>
      tracker.updateMilestone(actorOf(req), req.params.slug, req.params.id, await patch(req, "a milestone", MILESTONE_FIELDS)),
    ),
    DELETE: handle<"/api/projects/:slug/milestones/:id">((req) => tracker.deleteMilestone(actorOf(req), req.params.slug, req.params.id)),
  },
  // --- Views ---
  "/api/views": {
    GET: handle((req) => tracker.listViews(actorOf(req))),
    POST: handle(async (req) => tracker.createView(actorOf(req), await patch<CustomViewInput>(req, "a view", ["name", "workspace", "filter", "display"])), 201),
  },
  "/api/views/:id": {
    GET: handle<"/api/views/:id">((req) => tracker.getView(actorOf(req), req.params.id)),
    PATCH: handle<"/api/views/:id">(async (req) =>
      tracker.updateView(actorOf(req), req.params.id, await patch(req, "a view", ["name", "filter", "display"], { workspace: "Views can't move between workspaces" })),
    ),
    DELETE: handle<"/api/views/:id">((req) => tracker.deleteView(actorOf(req), req.params.id)),
  },
  "/api/views/:id/favorite": {
    PUT: handle<"/api/views/:id/favorite">((req) => tracker.favoriteView(actorOf(req), req.params.id, true)),
    DELETE: handle<"/api/views/:id/favorite">((req) => tracker.favoriteView(actorOf(req), req.params.id, false)),
  },

  // --- Inbox ---
  "/api/notifications": {
    GET: handle((req) => inbox.listInbox(actorOf(req), { unread: param(req, "unread") === "true" })),
    PATCH: handle(async (req) => inbox.markRead(actorOf(req), await patch(req, "notifications", ["ids", "read"]))),
    DELETE: handle((req) =>
      inbox.deleteNotifications(actorOf(req), { ids: param(req, "ids")?.split(",").map(Number), read: param(req, "read") === "true" }),
    ),
  },

  "/api/push": {
    GET: handle((req) => push.pushKey(actorOf(req))),
    PUT: handle(async (req) => push.addDevice(actorOf(req), await patch(req, "push", ["endpoint", "keys", "expirationTime"]))),
    DELETE: handle(async (req) => push.removeDevice(actorOf(req), (await body(req)).endpoint)),
  },
  "/api/push/test": {
    POST: handle((req) => push.testPush(actorOf(req))),
  },

  // --- Documents ---
  "/api/documents": {
    GET: handle((req) =>
      tracker.listDocuments(actorOf(req), { team: param(req, "team"), project: param(req, "project"), q: param(req, "q") }),
    ),
    POST: handle(async (req) => tracker.createDocument(actorOf(req), await body<DocumentInput>(req)), 201),
  },
  "/api/documents/:slug": {
    GET: handle<"/api/documents/:slug">((req) => tracker.getDocument(actorOf(req), req.params.slug)),
    PATCH: handle<"/api/documents/:slug">(async (req) =>
      tracker.updateDocument(actorOf(req), req.params.slug, await patch(req, "a document", DOCUMENT_FIELDS, { slug: "A document's slug never changes" })),
    ),
    DELETE: handle<"/api/documents/:slug">((req) => tracker.deleteDocument(actorOf(req), req.params.slug)),
  },
  "/api/documents/:slug/restore": {
    POST: handle<"/api/documents/:slug/restore">((req) => tracker.restoreDocument(actorOf(req), req.params.slug)),
  },
  "/api/documents/:slug/raw": {
    GET: handle<"/api/documents/:slug/raw">(
      (req) =>
        new Response(tracker.getDocument(actorOf(req), req.params.slug).content, {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        }),
    ),
  },
  "/api/documents/:slug/comments": {
    POST: handle<"/api/documents/:slug/comments">(async (req) => {
      const { body: text, parent } = await body(req);
      return tracker.addDocumentComment(actorOf(req), req.params.slug, text, parent);
    }, 201),
  },
  "/api/documents/:slug/comments/:cid": {
    PATCH: handle<"/api/documents/:slug/comments/:cid">(async (req) =>
      tracker.updateDocumentComment(actorOf(req), req.params.slug, req.params.cid, (await patch(req, "a comment", ["body"])).body),
    ),
    DELETE: handle<"/api/documents/:slug/comments/:cid">((req) =>
      tracker.deleteDocumentComment(actorOf(req), req.params.slug, req.params.cid),
    ),
  },
  "/api/documents/:slug/comments/:cid/resolved": {
    PUT: handle<"/api/documents/:slug/comments/:cid/resolved">((req) =>
      tracker.resolveDocumentThread(actorOf(req), req.params.slug, req.params.cid, true),
    ),
    DELETE: handle<"/api/documents/:slug/comments/:cid/resolved">((req) =>
      tracker.resolveDocumentThread(actorOf(req), req.params.slug, req.params.cid, false),
    ),
  },
  "/api/documents/:slug/comments/:cid/reactions/:emoji": {
    PUT: handle<"/api/documents/:slug/comments/:cid/reactions/:emoji">((req) =>
      tracker.reactToDocumentComment(actorOf(req), req.params.slug, req.params.cid, req.params.emoji, true),
    ),
    DELETE: handle<"/api/documents/:slug/comments/:cid/reactions/:emoji">((req) =>
      tracker.reactToDocumentComment(actorOf(req), req.params.slug, req.params.cid, req.params.emoji, false),
    ),
  },
  "/api/documents/:slug/subscription": {
    PUT: handle<"/api/documents/:slug/subscription">((req) => tracker.subscribeDocument(actorOf(req), req.params.slug, true)),
    DELETE: handle<"/api/documents/:slug/subscription">((req) => tracker.subscribeDocument(actorOf(req), req.params.slug, false)),
  },
  "/api/documents/:slug/versions": {
    GET: handle<"/api/documents/:slug/versions">((req) => tracker.listDocumentVersions(actorOf(req), req.params.slug)),
  },
  "/api/documents/:slug/versions/:id": {
    GET: handle<"/api/documents/:slug/versions/:id">((req) => tracker.getDocumentVersion(actorOf(req), req.params.slug, req.params.id)),
  },
  "/api/*": () => Response.json({ error: "Not found" }, { status: 404 }),
};

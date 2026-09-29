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

/** Wraps a handler, given the request's actor: its return value becomes the JSON body (unless it's a Response); errors become `{ error }`. */
function handle<Path extends string>(fn: (req: BunRequest<Path>, a: access.Actor) => unknown, status = 200) {
  return async (req: BunRequest<Path>) => {
    try {
      const data = await fn(req, actorOf(req));
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
  const field = Object.keys(data).find((f) => !fields.includes(f));
  if (field !== undefined) throw new AppError(Object.hasOwn(why, field) ? why[field]! : `Unknown field "${field}" for ${what}: use ${fields.join(", ")}`);
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

const link = (req: Request, { code, expiresAt }: { code: string; expiresAt: string }) => ({ code, url: `${originOf(req)}/login#${code}`, expiresAt });

export const apiRoutes = {
  // --- You ---
  "/api/me": {
    GET: handle((_, a) => access.me(a)),
    PATCH: handle(async (req, a) => {
      const perWorkspace = "Your name and username are per workspace: PATCH /api/workspaces/:key/profile";
      return access.updateMe(a, await patch(req, "your account", ["email"], { name: perWorkspace, username: perWorkspace }));
    }),
  },
  "/api/sessions": {
    GET: handle((_, a) => access.listSessions(a)),
    DELETE: handle((_, a) => access.revokeOtherSessions(a)),
  },
  "/api/sessions/:id": {
    DELETE: handle<"/api/sessions/:id">((req, a) => access.revokeSession(a, req.params.id)),
  },
  "/api/sign-in-links": {
    POST: handle((req, a) => link(req, access.selfSignInLink(a)), 201),
  },
  "/api/api-keys": {
    GET: handle((_, a) => access.listApiKeys(a)),
    POST: handle(async (req, a) => access.createApiKey(a, await body(req)), 201),
  },
  "/api/api-keys/:id": {
    DELETE: handle<"/api/api-keys/:id">((req, a) => access.revokeApiKey(a, req.params.id)),
  },
  // Which of your workspaces a link made before URLs carried one points into.
  "/api/locate": {
    GET: handle((req, a) => tracker.locate(a, { issue: param(req, "issue"), doc: param(req, "doc"), team: param(req, "team") })),
  },

  // --- Workspaces and members ---
  "/api/workspaces": {
    GET: handle((_, a) => access.listWorkspaces(a)),
    POST: handle(async (req, a) => access.createWorkspace(a, await body<WorkspaceInput>(req)), 201),
  },
  "/api/workspaces/:key": {
    PATCH: handle<"/api/workspaces/:key">(async (req, a) =>
      access.updateWorkspace(a, req.params.key, await patch(req, "a workspace", ["name"], { key: "A workspace's key never changes" })),
    ),
  },
  "/api/workspaces/:key/profile": {
    PATCH: handle<"/api/workspaces/:key/profile">(async (req, a) => access.updateProfile(a, req.params.key, await patch(req, "your profile", ["name", "username"]))),
  },
  "/api/workspaces/:key/members": {
    GET: handle<"/api/workspaces/:key/members">((req, a) => access.listMembers(a, req.params.key)),
  },
  "/api/workspaces/:key/members/:username": {
    PATCH: handle<"/api/workspaces/:key/members/:username">(async (req, a) =>
      access.updateMember(a, req.params.key, req.params.username, await patch(req, "a member", ["role", "suspended"])),
    ),
  },
  "/api/workspaces/:key/teams": {
    GET: handle<"/api/workspaces/:key/teams">((req, a) => access.listTeamListings(a, req.params.key)),
  },
  "/api/workspaces/:key/invites": {
    POST: handle<"/api/workspaces/:key/invites">(async (req, a) => link(req, access.invite(a, req.params.key, await body(req))), 201),
  },
  "/api/workspaces/:key/agents": {
    POST: handle<"/api/workspaces/:key/agents">(async (req, a) => access.createAgent(a, req.params.key, await body(req)), 201),
  },
  "/api/workspaces/:key/agents/:username": {
    DELETE: handle<"/api/workspaces/:key/agents/:username">((req, a) => access.removeAgent(a, req.params.key, req.params.username)),
  },
  "/api/workspaces/:key/agents/:username/token": {
    POST: handle<"/api/workspaces/:key/agents/:username/token">((req, a) => access.rotateAgentToken(a, req.params.key, req.params.username)),
  },
  "/api/workspaces/:key/github": {
    GET: handle<"/api/workspaces/:key/github">((req, a) => github.connection(a, req.params.key, req)),
    POST: handle<"/api/workspaces/:key/github">((req, a) => github.connect(a, req.params.key, req), 201),
    DELETE: handle<"/api/workspaces/:key/github">((req, a) => github.disconnect(a, req.params.key)),
  },
  "/api/workspaces/:key/webhooks": {
    GET: handle<"/api/workspaces/:key/webhooks">((req, a) => webhooks.listWebhooks(a, req.params.key)),
    POST: handle<"/api/workspaces/:key/webhooks">(async (req, a) => webhooks.createWebhook(a, req.params.key, await body<WebhookInput>(req)), 201),
  },
  "/api/workspaces/:key/webhooks/:id": {
    PATCH: handle<"/api/workspaces/:key/webhooks/:id">(async (req, a) =>
      webhooks.updateWebhook(a, req.params.key, req.params.id, await patch(req, "a webhook", ["url", "label", "resourceTypes", "enabled"])),
    ),
    DELETE: handle<"/api/workspaces/:key/webhooks/:id">((req, a) => webhooks.deleteWebhook(a, req.params.key, req.params.id)),
  },
  "/api/workspaces/:key/webhooks/:id/secret": {
    POST: handle<"/api/workspaces/:key/webhooks/:id/secret">((req, a) => webhooks.rotateWebhookSecret(a, req.params.key, req.params.id)),
  },
  "/api/workspaces/:key/webhooks/:id/deliveries": {
    GET: handle<"/api/workspaces/:key/webhooks/:id/deliveries">((req, a) => webhooks.listDeliveries(a, req.params.key, req.params.id)),
  },

  // --- Teams and issues ---
  "/api/teams": {
    GET: handle((_, a) => tracker.listTeams(a)),
    POST: handle(async (req, a) => tracker.createTeam(a, await body<TeamInput>(req)), 201),
  },
  "/api/teams/:key": {
    PATCH: handle<"/api/teams/:key">(async (req, a) =>
      tracker.updateTeam(a, req.params.key, await patch(req, "a team", TEAM_FIELDS, { workspace: "Teams can't move between workspaces", key: "A team's key never changes" })),
    ),
  },
  "/api/teams/:key/members": {
    GET: handle<"/api/teams/:key/members">((req, a) => tracker.listTeamMembers(a, req.params.key)),
    POST: handle<"/api/teams/:key/members">(async (req, a) => tracker.addTeamMember(a, req.params.key, (await patch(req, "a team member", ["username"])).username)),
  },
  "/api/teams/:key/members/:username": {
    DELETE: handle<"/api/teams/:key/members/:username">((req, a) => tracker.removeTeamMember(a, req.params.key, req.params.username)),
  },
  "/api/teams/:key/statuses": {
    POST: handle<"/api/teams/:key/statuses">(async (req, a) => tracker.createStatus(a, req.params.key, await body<WorkflowStatusInput>(req)), 201),
  },
  "/api/teams/:key/statuses/:status": {
    PATCH: handle<"/api/teams/:key/statuses/:status">(async (req, a) =>
      tracker.updateStatus(
        a,
        req.params.key,
        req.params.status,
        await patch(req, "a status", ["name", "color", "position"], {
          key: "A status's key never changes",
          category: "A status's category never changes: add one in the other category, then delete this one",
        }),
      ),
    ),
    DELETE: handle<"/api/teams/:key/statuses/:status">((req, a) => tracker.deleteStatus(a, req.params.key, req.params.status, param(req, "moveTo"))),
  },
  "/api/teams/:key/cycles": {
    GET: handle<"/api/teams/:key/cycles">((req, a) => tracker.listCycles(a, req.params.key)),
  },
  "/api/teams/:key/trash": {
    GET: handle<"/api/teams/:key/trash">((req, a) => tracker.listTrash(a, req.params.key)),
  },
  "/api/issues": {
    // Without first/after, the whole list (as before); with them, a page: { issues, pageInfo }.
    GET: handle((req, a) => {
      const first = param(req, "first");
      const after = param(req, "after");
      if (first === undefined && after === undefined) return tracker.listIssues(a, issueFilter(req));
      return tracker.listIssuesPage(a, issueFilter(req), { first, after });
    }),
    POST: handle(async (req, a) => tracker.createIssue(a, await body<IssueInput>(req)), 201),
  },
  "/api/issues/bulk": {
    POST: handle(async (req, a) => {
      const { ids, patch: change } = await patch(req, "a bulk edit", ["ids", "patch"]);
      return { results: tracker.bulkUpdateIssues(a, ids, change) };
    }),
  },
  "/api/issues/:id": {
    GET: handle<"/api/issues/:id">((req, a) => tracker.getIssue(a, req.params.id)),
    PATCH: handle<"/api/issues/:id">(async (req, a) => tracker.updateIssue(a, req.params.id, await patch(req, "an issue", ISSUE_FIELDS))),
    DELETE: handle<"/api/issues/:id">((req, a) => tracker.deleteIssue(a, req.params.id)),
  },
  "/api/issues/:id/restore": {
    POST: handle<"/api/issues/:id/restore">((req, a) => tracker.restoreIssue(a, req.params.id)),
  },
  "/api/issues/:id/archive": {
    POST: handle<"/api/issues/:id/archive">((req, a) => tracker.archiveIssue(a, req.params.id)),
  },
  "/api/issues/:id/unarchive": {
    POST: handle<"/api/issues/:id/unarchive">((req, a) => tracker.unarchiveIssue(a, req.params.id)),
  },
  "/api/issues/:id/claim": {
    POST: handle<"/api/issues/:id/claim">((req, a) => tracker.claimIssue(a, req.params.id)),
  },
  "/api/issues/:id/comments": {
    POST: handle<"/api/issues/:id/comments">(async (req, a) => {
      const { body: text, parent } = await body(req);
      return tracker.addComment(a, req.params.id, text, parent);
    }, 201),
  },
  "/api/issues/:id/comments/:cid": {
    PATCH: handle<"/api/issues/:id/comments/:cid">(async (req, a) =>
      tracker.updateIssueComment(a, req.params.id, req.params.cid, (await patch(req, "a comment", ["body"])).body),
    ),
    DELETE: handle<"/api/issues/:id/comments/:cid">((req, a) => tracker.deleteIssueComment(a, req.params.id, req.params.cid)),
  },
  "/api/issues/:id/comments/:cid/resolved": {
    PUT: handle<"/api/issues/:id/comments/:cid/resolved">((req, a) => tracker.resolveIssueThread(a, req.params.id, req.params.cid, true)),
    DELETE: handle<"/api/issues/:id/comments/:cid/resolved">((req, a) => tracker.resolveIssueThread(a, req.params.id, req.params.cid, false)),
  },
  "/api/issues/:id/reactions/:emoji": {
    PUT: handle<"/api/issues/:id/reactions/:emoji">((req, a) => tracker.reactToIssue(a, req.params.id, req.params.emoji, true)),
    DELETE: handle<"/api/issues/:id/reactions/:emoji">((req, a) => tracker.reactToIssue(a, req.params.id, req.params.emoji, false)),
  },
  "/api/issues/:id/comments/:cid/reactions/:emoji": {
    PUT: handle<"/api/issues/:id/comments/:cid/reactions/:emoji">((req, a) => tracker.reactToIssue(a, req.params.id, req.params.emoji, true, req.params.cid)),
    DELETE: handle<"/api/issues/:id/comments/:cid/reactions/:emoji">((req, a) => tracker.reactToIssue(a, req.params.id, req.params.emoji, false, req.params.cid)),
  },
  "/api/issues/:id/subscription": {
    PUT: handle<"/api/issues/:id/subscription">((req, a) => tracker.subscribeIssue(a, req.params.id, true)),
    DELETE: handle<"/api/issues/:id/subscription">((req, a) => tracker.subscribeIssue(a, req.params.id, false)),
  },
  "/api/labels": {
    GET: handle((req, a) => tracker.listLabels(a, { team: param(req, "team") })),
    POST: handle(async (req, a) => tracker.createLabel(a, await body<LabelInput>(req)), 201),
  },
  "/api/labels/:id": {
    PATCH: handle<"/api/labels/:id">(async (req, a) =>
      tracker.updateLabel(
        a,
        req.params.id,
        await patch(req, "a label", ["name", "color", "team", "group"], {
          isGroup: "A label can't become a group, or a group a label: create a new one",
          workspace: "Labels can't move between workspaces",
        }),
      ),
    ),
    DELETE: handle<"/api/labels/:id">((req, a) => tracker.deleteLabel(a, req.params.id)),
  },
  "/api/templates": {
    GET: handle((req, a) => tracker.listTemplates(a, { team: param(req, "team") })),
    POST: handle(async (req, a) => tracker.createTemplate(a, await body<IssueTemplateInput>(req)), 201),
  },
  "/api/templates/:id": {
    PATCH: handle<"/api/templates/:id">(async (req, a) => tracker.updateTemplate(a, req.params.id, await patch(req, "a template", TEMPLATE_FIELDS))),
    DELETE: handle<"/api/templates/:id">((req, a) => tracker.deleteTemplate(a, req.params.id)),
  },

  // --- Projects ---
  "/api/projects": {
    GET: handle((req, a) => tracker.listProjects(a, { team: param(req, "team"), status: param(req, "status")?.split(",") })),
    POST: handle(async (req, a) => tracker.createProject(a, await body<ProjectInput>(req)), 201),
  },
  "/api/projects/:slug": {
    GET: handle<"/api/projects/:slug">((req, a) => tracker.getProject(a, req.params.slug)),
    PATCH: handle<"/api/projects/:slug">(async (req, a) =>
      tracker.updateProject(
        a,
        req.params.slug,
        await patch(req, "a project", PROJECT_FIELDS, { slug: "A project's slug never changes", workspace: "Projects can't move between workspaces" }),
      ),
    ),
  },
  "/api/projects/:slug/milestones": {
    POST: handle<"/api/projects/:slug/milestones">(async (req, a) => tracker.createMilestone(a, req.params.slug, await body<MilestoneInput>(req)), 201),
  },
  "/api/projects/:slug/milestones/:id": {
    PATCH: handle<"/api/projects/:slug/milestones/:id">(async (req, a) =>
      tracker.updateMilestone(a, req.params.slug, req.params.id, await patch(req, "a milestone", MILESTONE_FIELDS)),
    ),
    DELETE: handle<"/api/projects/:slug/milestones/:id">((req, a) => tracker.deleteMilestone(a, req.params.slug, req.params.id)),
  },
  // --- Views ---
  "/api/views": {
    GET: handle((_, a) => tracker.listViews(a)),
    POST: handle(async (req, a) => tracker.createView(a, await patch<CustomViewInput>(req, "a view", ["name", "workspace", "filter", "display"])), 201),
  },
  "/api/views/:id": {
    GET: handle<"/api/views/:id">((req, a) => tracker.getView(a, req.params.id)),
    PATCH: handle<"/api/views/:id">(async (req, a) =>
      tracker.updateView(a, req.params.id, await patch(req, "a view", ["name", "filter", "display"], { workspace: "Views can't move between workspaces" })),
    ),
    DELETE: handle<"/api/views/:id">((req, a) => tracker.deleteView(a, req.params.id)),
  },
  "/api/views/:id/favorite": {
    PUT: handle<"/api/views/:id/favorite">((req, a) => tracker.favoriteView(a, req.params.id, true)),
    DELETE: handle<"/api/views/:id/favorite">((req, a) => tracker.favoriteView(a, req.params.id, false)),
  },

  // --- Inbox ---
  "/api/notifications": {
    GET: handle((req, a) => inbox.listInbox(a, { unread: param(req, "unread") === "true" })),
    PATCH: handle(async (req, a) => inbox.markRead(a, await patch(req, "notifications", ["ids", "read"]))),
    DELETE: handle((req, a) => inbox.deleteNotifications(a, { ids: param(req, "ids")?.split(",").map(Number), read: param(req, "read") === "true" })),
  },

  "/api/push": {
    GET: handle((_, a) => push.pushKey(a)),
    PUT: handle(async (req, a) => push.addDevice(a, await patch(req, "push", ["endpoint", "keys", "expirationTime"]))),
    DELETE: handle(async (req, a) => push.removeDevice(a, (await body(req)).endpoint)),
  },
  "/api/push/test": {
    POST: handle((_, a) => push.testPush(a)),
  },

  // --- Documents ---
  "/api/documents": {
    GET: handle((req, a) => tracker.listDocuments(a, { team: param(req, "team"), project: param(req, "project"), q: param(req, "q") })),
    POST: handle(async (req, a) => tracker.createDocument(a, await body<DocumentInput>(req)), 201),
  },
  "/api/documents/:slug": {
    GET: handle<"/api/documents/:slug">((req, a) => tracker.getDocument(a, req.params.slug)),
    PATCH: handle<"/api/documents/:slug">(async (req, a) =>
      tracker.updateDocument(a, req.params.slug, await patch(req, "a document", DOCUMENT_FIELDS, { slug: "A document's slug never changes" })),
    ),
    DELETE: handle<"/api/documents/:slug">((req, a) => tracker.deleteDocument(a, req.params.slug)),
  },
  "/api/documents/:slug/restore": {
    POST: handle<"/api/documents/:slug/restore">((req, a) => tracker.restoreDocument(a, req.params.slug)),
  },
  "/api/documents/:slug/raw": {
    GET: handle<"/api/documents/:slug/raw">(
      (req, a) => new Response(tracker.getDocument(a, req.params.slug).content, { headers: { "Content-Type": "text/markdown; charset=utf-8" } }),
    ),
  },
  "/api/documents/:slug/comments": {
    POST: handle<"/api/documents/:slug/comments">(async (req, a) => {
      const { body: text, parent } = await body(req);
      return tracker.addDocumentComment(a, req.params.slug, text, parent);
    }, 201),
  },
  "/api/documents/:slug/comments/:cid": {
    PATCH: handle<"/api/documents/:slug/comments/:cid">(async (req, a) =>
      tracker.updateDocumentComment(a, req.params.slug, req.params.cid, (await patch(req, "a comment", ["body"])).body),
    ),
    DELETE: handle<"/api/documents/:slug/comments/:cid">((req, a) => tracker.deleteDocumentComment(a, req.params.slug, req.params.cid)),
  },
  "/api/documents/:slug/comments/:cid/resolved": {
    PUT: handle<"/api/documents/:slug/comments/:cid/resolved">((req, a) => tracker.resolveDocumentThread(a, req.params.slug, req.params.cid, true)),
    DELETE: handle<"/api/documents/:slug/comments/:cid/resolved">((req, a) => tracker.resolveDocumentThread(a, req.params.slug, req.params.cid, false)),
  },
  "/api/documents/:slug/comments/:cid/reactions/:emoji": {
    PUT: handle<"/api/documents/:slug/comments/:cid/reactions/:emoji">((req, a) =>
      tracker.reactToDocumentComment(a, req.params.slug, req.params.cid, req.params.emoji, true),
    ),
    DELETE: handle<"/api/documents/:slug/comments/:cid/reactions/:emoji">((req, a) =>
      tracker.reactToDocumentComment(a, req.params.slug, req.params.cid, req.params.emoji, false),
    ),
  },
  "/api/documents/:slug/subscription": {
    PUT: handle<"/api/documents/:slug/subscription">((req, a) => tracker.subscribeDocument(a, req.params.slug, true)),
    DELETE: handle<"/api/documents/:slug/subscription">((req, a) => tracker.subscribeDocument(a, req.params.slug, false)),
  },
  "/api/documents/:slug/versions": {
    GET: handle<"/api/documents/:slug/versions">((req, a) => tracker.listDocumentVersions(a, req.params.slug)),
  },
  "/api/documents/:slug/versions/:id": {
    GET: handle<"/api/documents/:slug/versions/:id">((req, a) => tracker.getDocumentVersion(a, req.params.slug, req.params.id)),
  },
  "/api/*": () => Response.json({ error: "Not found" }, { status: 404 }),
};

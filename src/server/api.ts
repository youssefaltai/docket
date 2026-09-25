import type { BunRequest } from "bun";
import type { DocumentInput, IssueFilter, IssueInput, Status, TeamInput, WorkspaceInput } from "../shared/types.ts";
import * as access from "./access.ts";
import { actorOf, isJson } from "./auth.ts";
import { AppError } from "./db.ts";
import * as tracker from "./tracker.ts";

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

const param = (req: Request, name: string) => new URL(req.url).searchParams.get(name) || undefined;

const issueFilter = (req: Request): IssueFilter => ({
  workspace: param(req, "workspace"),
  team: param(req, "team"),
  status: param(req, "status")?.split(",") as Status[] | undefined,
  label: param(req, "label"),
  assignee: param(req, "assignee"),
  delegate: param(req, "delegate"),
  parent: param(req, "parent"),
  q: param(req, "q"),
});

/** Where links point: the origin the browser used (the proxy's, behind one). */
function originOf(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host}`;
}

const link = (req: Request, { code, expiresAt }: { code: string; expiresAt: string }) => ({
  code,
  url: `${originOf(req)}/login#${code}`,
  expiresAt,
});

export const apiRoutes = {
  // --- You ---
  "/api/me": {
    GET: handle((req) => access.me(actorOf(req))),
    PATCH: handle(async (req) => access.updateMe(actorOf(req), await body(req))),
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

  // --- Workspaces and members ---
  "/api/workspaces": {
    GET: handle((req) => access.listWorkspaces(actorOf(req))),
    POST: handle(async (req) => access.createWorkspace(actorOf(req), await body<WorkspaceInput>(req)), 201),
  },
  "/api/workspaces/:key": {
    PATCH: handle<"/api/workspaces/:key">(async (req) => access.updateWorkspace(actorOf(req), req.params.key, await body(req))),
  },
  "/api/workspaces/:key/members": {
    GET: handle<"/api/workspaces/:key/members">((req) => access.listMembers(actorOf(req), req.params.key)),
  },
  "/api/workspaces/:key/members/:username": {
    PATCH: handle<"/api/workspaces/:key/members/:username">(async (req) =>
      access.updateMember(actorOf(req), req.params.key, req.params.username, await body(req)),
    ),
  },
  "/api/workspaces/:key/members/:username/sign-in-links": {
    POST: handle<"/api/workspaces/:key/members/:username/sign-in-links">(
      (req) => link(req, access.memberSignInLink(actorOf(req), req.params.key, req.params.username)),
      201,
    ),
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

  // --- Teams and issues ---
  "/api/teams": {
    GET: handle((req) => tracker.listTeams(actorOf(req), { workspace: param(req, "workspace") })),
    POST: handle(async (req) => tracker.createTeam(actorOf(req), await body<TeamInput>(req)), 201),
  },
  "/api/teams/:key": {
    PATCH: handle<"/api/teams/:key">(async (req) => tracker.updateTeam(actorOf(req), req.params.key, await body(req))),
  },
  "/api/issues": {
    GET: handle((req) => tracker.listIssues(actorOf(req), issueFilter(req))),
    POST: handle(async (req) => tracker.createIssue(actorOf(req), await body<IssueInput>(req)), 201),
  },
  "/api/issues/:id": {
    GET: handle<"/api/issues/:id">((req) => tracker.getIssue(actorOf(req), req.params.id)),
    PATCH: handle<"/api/issues/:id">(async (req) => tracker.updateIssue(actorOf(req), req.params.id, await body(req))),
    DELETE: handle<"/api/issues/:id">((req) => tracker.deleteIssue(actorOf(req), req.params.id)),
  },
  "/api/issues/:id/claim": {
    POST: handle<"/api/issues/:id/claim">((req) => tracker.claimIssue(actorOf(req), req.params.id)),
  },
  "/api/issues/:id/comments": {
    POST: handle<"/api/issues/:id/comments">(async (req) => tracker.addComment(actorOf(req), req.params.id, (await body(req)).body), 201),
  },
  "/api/issues/:id/comments/:cid": {
    PATCH: handle<"/api/issues/:id/comments/:cid">(async (req) =>
      tracker.updateIssueComment(actorOf(req), req.params.id, req.params.cid, (await body(req)).body),
    ),
    DELETE: handle<"/api/issues/:id/comments/:cid">((req) => tracker.deleteIssueComment(actorOf(req), req.params.id, req.params.cid)),
  },
  "/api/labels": {
    GET: handle((req) => tracker.listLabels(actorOf(req), { workspace: param(req, "workspace") }).map((l) => l.label)),
  },

  // --- Documents ---
  "/api/documents": {
    GET: handle((req) =>
      tracker.listDocuments(actorOf(req), { workspace: param(req, "workspace"), team: param(req, "team"), q: param(req, "q") }),
    ),
    POST: handle(async (req) => tracker.createDocument(actorOf(req), await body<DocumentInput>(req)), 201),
  },
  "/api/documents/:slug": {
    GET: handle<"/api/documents/:slug">((req) => tracker.getDocument(actorOf(req), req.params.slug)),
    PATCH: handle<"/api/documents/:slug">(async (req) => tracker.updateDocument(actorOf(req), req.params.slug, await body(req))),
    DELETE: handle<"/api/documents/:slug">((req) => tracker.deleteDocument(actorOf(req), req.params.slug)),
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
    POST: handle<"/api/documents/:slug/comments">(
      async (req) => tracker.addDocumentComment(actorOf(req), req.params.slug, (await body(req)).body),
      201,
    ),
  },
  "/api/documents/:slug/comments/:cid": {
    PATCH: handle<"/api/documents/:slug/comments/:cid">(async (req) =>
      tracker.updateDocumentComment(actorOf(req), req.params.slug, req.params.cid, (await body(req)).body),
    ),
    DELETE: handle<"/api/documents/:slug/comments/:cid">((req) =>
      tracker.deleteDocumentComment(actorOf(req), req.params.slug, req.params.cid),
    ),
  },
  "/api/documents/:slug/versions": {
    GET: handle<"/api/documents/:slug/versions">((req) => tracker.listDocumentVersions(actorOf(req), req.params.slug)),
  },
  "/api/documents/:slug/versions/:id": {
    GET: handle<"/api/documents/:slug/versions/:id">((req) => tracker.getDocumentVersion(actorOf(req), req.params.slug, req.params.id)),
  },
  "/api/*": () => Response.json({ error: "Not found" }, { status: 404 }),
};

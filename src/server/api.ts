import type { BunRequest } from "bun";
import type {
  DocumentInput,
  IssueFilter,
  IssueInput,
  ProjectInput,
  Status,
  WorkspaceInput,
} from "../shared/types.ts";
import { isJson } from "./auth.ts";
import * as db from "./db.ts";

/** Wraps a handler: its return value becomes the JSON body (unless it's a Response); errors become `{ error }`. */
function handle<Path extends string>(fn: (req: BunRequest<Path>) => unknown, status = 200) {
  return async (req: BunRequest<Path>) => {
    try {
      const data = await fn(req);
      return data instanceof Response ? data : Response.json(data, { status });
    } catch (err) {
      if (err instanceof db.AppError) return Response.json({ error: err.message }, { status: err.status });
      console.error(err);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

/** The JSON object body. Its fields are unchecked: db validates every one. */
async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  // JSON only: browsers can't send it cross-origin without a CORS preflight, which Docket never allows.
  if (!isJson(req)) {
    throw new db.AppError("Expected Content-Type: application/json", 415);
  }
  const data = await req.json().catch(() => {
    throw new db.AppError("Invalid JSON body");
  });
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new db.AppError("Expected a JSON object");
  }
  return data as T;
}

/** Writes without an author (e.g. curl) are credited to "anonymous"; the web UI sends the viewer's name. */
const authored = async <T = Record<string, unknown>>(req: Request) => ({ author: "anonymous", ...(await body<T>(req)) });

const param = (req: Request, name: string) => new URL(req.url).searchParams.get(name) || undefined;

const issueFilter = (req: Request): IssueFilter => ({
  workspace: param(req, "workspace"),
  project: param(req, "project"),
  status: param(req, "status")?.split(",") as Status[] | undefined,
  label: param(req, "label"),
  assignee: param(req, "assignee"),
  parent: param(req, "parent"),
  q: param(req, "q"),
});

export const apiRoutes = {
  "/api/workspaces": {
    GET: handle(() => db.listWorkspaces()),
    POST: handle(async (req) => db.createWorkspace(await body<WorkspaceInput>(req)), 201),
  },
  "/api/workspaces/:key": {
    PATCH: handle<"/api/workspaces/:key">(async (req) => db.updateWorkspace(req.params.key, await body(req))),
  },
  "/api/projects": {
    GET: handle((req) => db.listProjects({ workspace: param(req, "workspace") })),
    POST: handle(async (req) => db.createProject(await body<ProjectInput>(req)), 201),
  },
  "/api/projects/:key": {
    PATCH: handle<"/api/projects/:key">(async (req) => db.updateProject(req.params.key, await body(req))),
  },
  "/api/issues": {
    GET: handle((req) => db.listIssues(issueFilter(req))),
    POST: handle(async (req) => db.createIssue(await body<IssueInput>(req)), 201),
  },
  "/api/issues/:id": {
    GET: handle<"/api/issues/:id">((req) => db.getIssue(req.params.id)),
    PATCH: handle<"/api/issues/:id">(async (req) => db.updateIssue(req.params.id, await body(req))),
    DELETE: handle<"/api/issues/:id">((req) => {
      db.deleteIssue(req.params.id);
      return { ok: true };
    }),
  },
  "/api/issues/:id/comments": {
    POST: handle<"/api/issues/:id/comments">(async (req) => {
      const { body: text, author } = await authored(req);
      return db.addComment(req.params.id, text, author);
    }, 201),
  },
  "/api/documents": {
    GET: handle((req) =>
      db.listDocuments({ workspace: param(req, "workspace"), project: param(req, "project"), q: param(req, "q") }),
    ),
    POST: handle(async (req) => db.createDocument(await authored<DocumentInput>(req)), 201),
  },
  "/api/documents/:slug": {
    GET: handle<"/api/documents/:slug">((req) => db.getDocument(req.params.slug)),
    PATCH: handle<"/api/documents/:slug">(async (req) =>
      db.updateDocument(req.params.slug, await authored(req)),
    ),
    DELETE: handle<"/api/documents/:slug">((req) => {
      db.deleteDocument(req.params.slug);
      return { ok: true };
    }),
  },
  "/api/documents/:slug/raw": {
    GET: handle<"/api/documents/:slug/raw">(
      (req) =>
        new Response(db.getDocument(req.params.slug).content, {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        }),
    ),
  },
  "/api/documents/:slug/comments": {
    POST: handle<"/api/documents/:slug/comments">(async (req) => {
      const { body: text, author } = await authored(req);
      return db.addDocumentComment(req.params.slug, text, author);
    }, 201),
  },
  "/api/documents/:slug/versions": {
    GET: handle<"/api/documents/:slug/versions">((req) => db.listDocumentVersions(req.params.slug)),
  },
  "/api/documents/:slug/versions/:id": {
    GET: handle<"/api/documents/:slug/versions/:id">((req) =>
      db.getDocumentVersion(req.params.slug, req.params.id),
    ),
  },
  "/api/labels": {
    GET: handle(() => db.listLabels()),
  },
  "/api/*": () => Response.json({ error: "Not found" }, { status: 404 }),
};

import type { BunRequest } from "bun";
import type {
  DocumentInput,
  IssueFilter,
  IssueInput,
  ProjectInput,
  Status,
  WorkspaceInput,
} from "../shared/types.ts";
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

async function body(req: Request): Promise<Record<string, unknown>> {
  const data = await req.json().catch(() => {
    throw new db.AppError("Invalid JSON body");
  });
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new db.AppError("Expected a JSON object");
  }
  return data as Record<string, unknown>;
}

function issueFilter(url: string): IssueFilter {
  const params = new URL(url).searchParams;
  const get = (name: string) => params.get(name) || undefined;
  return {
    workspace: get("workspace"),
    project: get("project"),
    status: get("status")?.split(",") as Status[] | undefined,
    label: get("label"),
    assignee: get("assignee"),
    parent: get("parent"),
    q: get("q"),
  };
}

const param = (req: Request, name: string) => new URL(req.url).searchParams.get(name) || undefined;

export const apiRoutes = {
  "/api/workspaces": {
    GET: handle(() => db.listWorkspaces()),
    POST: handle(async (req) => db.createWorkspace((await body(req)) as unknown as WorkspaceInput), 201),
  },
  "/api/workspaces/:key": {
    PATCH: handle<"/api/workspaces/:key">(async (req) => db.updateWorkspace(req.params.key, await body(req))),
  },
  "/api/projects": {
    GET: handle((req) => db.listProjects({ workspace: param(req, "workspace") })),
    POST: handle(async (req) => db.createProject((await body(req)) as unknown as ProjectInput), 201),
  },
  "/api/projects/:key": {
    PATCH: handle<"/api/projects/:key">(async (req) => db.updateProject(req.params.key, await body(req))),
  },
  "/api/issues": {
    GET: handle((req) => db.listIssues(issueFilter(req.url))),
    POST: handle(async (req) => db.createIssue((await body(req)) as unknown as IssueInput), 201),
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
      const { body: text, author = "anonymous" } = await body(req);
      return db.addComment(req.params.id, text, author);
    }, 201),
  },
  "/api/documents": {
    GET: handle((req) =>
      db.listDocuments({ workspace: param(req, "workspace"), project: param(req, "project"), q: param(req, "q") }),
    ),
    POST: handle(async (req) => db.createDocument({ author: "anonymous", ...(await body(req)) } as DocumentInput), 201),
  },
  "/api/documents/:slug": {
    GET: handle<"/api/documents/:slug">((req) => db.getDocument(req.params.slug)),
    PATCH: handle<"/api/documents/:slug">(async (req) =>
      db.updateDocument(req.params.slug, { author: "anonymous", ...(await body(req)) }),
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
      const { body: text, author = "anonymous" } = await body(req);
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

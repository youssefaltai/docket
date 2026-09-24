// Typed wrappers for the REST API and the /ws event stream (see SPEC.md).
import type {
  ApiError,
  Document,
  DocumentInput,
  DocumentPatch,
  DocumentSummary,
  DocumentVersion,
  DocumentVersionSummary,
  Issue,
  IssueFilter,
  IssueInput,
  IssuePatch,
  IssueSummary,
  Project,
  ProjectInput,
  ServerEvent,
} from "../shared/types";

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError((data as ApiError | null)?.error || `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

function query(filter: IssueFilter | Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

const enc = encodeURIComponent;

export const api = {
  projects: () => request<Project[]>("GET", "/api/projects"),
  createProject: (input: ProjectInput) => request<Project>("POST", "/api/projects", input),
  updateProject: (key: string, patch: { name?: string; description?: string }) =>
    request<Project>("PATCH", `/api/projects/${enc(key)}`, patch),

  issues: (filter: IssueFilter = {}) => request<IssueSummary[]>("GET", `/api/issues${query(filter)}`),
  issue: (id: string) => request<Issue>("GET", `/api/issues/${enc(id)}`),
  createIssue: (input: IssueInput) => request<Issue>("POST", "/api/issues", input),
  updateIssue: (id: string, patch: IssuePatch) => request<Issue>("PATCH", `/api/issues/${enc(id)}`, patch),
  deleteIssue: (id: string) => request<{ ok: true }>("DELETE", `/api/issues/${enc(id)}`),
  comment: (id: string, body: string, author?: string) =>
    request<Issue>("POST", `/api/issues/${enc(id)}/comments`, { body, author }),

  labels: () => request<string[]>("GET", "/api/labels"),

  documents: (filter: { project?: string; q?: string } = {}) =>
    request<DocumentSummary[]>("GET", `/api/documents${query(filter)}`),
  document: (slug: string) => request<Document>("GET", `/api/documents/${enc(slug)}`),
  createDocument: (input: DocumentInput) => request<Document>("POST", "/api/documents", input),
  updateDocument: (slug: string, patch: DocumentPatch) => request<Document>("PATCH", `/api/documents/${enc(slug)}`, patch),
  deleteDocument: (slug: string) => request<{ ok: true }>("DELETE", `/api/documents/${enc(slug)}`),
  commentDocument: (slug: string, body: string, author?: string) =>
    request<Document>("POST", `/api/documents/${enc(slug)}/comments`, { body, author }),
  versions: (slug: string) => request<DocumentVersionSummary[]>("GET", `/api/documents/${enc(slug)}/versions`),
  version: (slug: string, id: number) => request<DocumentVersion>("GET", `/api/documents/${enc(slug)}/versions/${id}`),
};

/**
 * Subscribe to server events. Reconnects with backoff; after a reconnect it
 * emits `null` so callers can resync whatever they may have missed.
 */
export function subscribe(onEvent: (event: ServerEvent | null) => void): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const connect = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => {
      if (attempt > 0) onEvent(null);
      attempt = 0;
    };
    ws.onmessage = (e) => {
      try {
        onEvent(JSON.parse(String(e.data)) as ServerEvent);
      } catch {
        onEvent(null);
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt++));
    };
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}

// Typed wrappers for the REST API and the /ws event stream (see SPEC.md).
import type {
  ApiError,
  Document,
  DocumentFilter,
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
  Team,
  TeamInput,
  TeamPatch,
  ServerEvent,
  Trash,
  Workspace,
  WorkspaceInput,
  WorkspaceMember,
  WorkspacePatch,
} from "../shared/types";

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Called on any 401, so the app can show the login screen. */
let onUnauthorized = () => {};
export const setOnUnauthorized = (fn: () => void) => (onUnauthorized = fn);

/** Called when the server closes the socket because this user lost access (suspended, signed out elsewhere). */
let onAccessLost = () => {};
export const setOnAccessLost = (fn: () => void) => (onAccessLost = fn);

// ---------- Connection ----------

/** "reconnecting": the live connection dropped and the retry hasn't landed yet. */
export type Connection = "online" | "offline" | "reconnecting";
let connection: Connection = navigator.onLine ? "online" : "offline";
const connectionListeners = new Set<() => void>();
function setConnection(c: Connection) {
  if (c === connection) return;
  connection = c;
  connectionListeners.forEach((l) => l());
}
export const connectionStore = {
  subscribe: (l: () => void) => (connectionListeners.add(l), () => void connectionListeners.delete(l)),
  get: () => connection,
};

/** A network failure says so in words, instead of the browser's "Failed to fetch". */
export const unreachable = () =>
  new HttpError(navigator.onLine ? "Can’t reach Docket. Check your connection and try again." : "You’re offline.", 0);

/** Per-browser preferences; storage can be unavailable (private mode, blocked site data). */
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`docket.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`docket.${key}`, value);
    } catch {}
  },
};

/**
 * Who this tab believes is signed in, sent with every request. Tabs share one cookie, so if another tab
 * signs in as someone else, the server refuses this tab's requests and it reloads as the new account
 * rather than acting as them under the old name.
 */
let signedInAs: string | null = null;
export const setSignedInAs = (username: string) => (signedInAs = username);

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (signedInAs) headers["x-docket-user"] = signedInAs;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => {
    throw unreachable();
  });
  const data: unknown = await res.json().catch(() => null);
  if (res.status === 401 && (data as { switched?: boolean } | null)?.switched) location.reload();
  else if (res.status === 401) onUnauthorized();
  if (!res.ok) throw new HttpError((data as ApiError | null)?.error || `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

function query(filter: IssueFilter | DocumentFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export const enc = encodeURIComponent;

/**
 * One request per issue at a time, in the order they were made. Each edit sends whole fields (all its
 * labels, say), so two in flight could land out of order and the older one would win.
 */
const queues = new Map<string, Promise<unknown>>();
function inOrder<T>(key: string, send: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(send);
  queues.set(key, next);
  const done = () => void (queues.get(key) === next && queues.delete(key));
  next.then(done, done);
  return next;
}

export const api = {
  workspaces: () => request<Workspace[]>("GET", "/api/workspaces"),
  createWorkspace: (input: WorkspaceInput) => request<Workspace>("POST", "/api/workspaces", input),
  updateWorkspace: (key: string, patch: WorkspacePatch) =>
    request<Workspace>("PATCH", `/api/workspaces/${enc(key)}`, patch),
  members: (workspace: string) => request<WorkspaceMember[]>("GET", `/api/workspaces/${enc(workspace)}/members`),

  teams: () => request<Team[]>("GET", "/api/teams"),
  createTeam: (input: TeamInput) => request<Team>("POST", "/api/teams", input),
  updateTeam: (key: string, patch: TeamPatch) =>
    request<Team>("PATCH", `/api/teams/${enc(key)}`, patch),

  issues: (filter: IssueFilter = {}) => request<IssueSummary[]>("GET", `/api/issues${query(filter)}`),
  issue: (id: string) => request<Issue>("GET", `/api/issues/${enc(id)}`),
  createIssue: (input: IssueInput) => request<Issue>("POST", "/api/issues", input),
  updateIssue: (id: string, patch: IssuePatch) => inOrder(id, () => request<Issue>("PATCH", `/api/issues/${enc(id)}`, patch)),
  claimIssue: (id: string) => inOrder(id, () => request<Issue>("POST", `/api/issues/${enc(id)}/claim`, {})),
  /** Moves it to the trash; `restoreIssue` brings it back (for 30 days). */
  deleteIssue: (id: string) => request<Issue>("DELETE", `/api/issues/${enc(id)}`),
  restoreIssue: (id: string) => request<Issue>("POST", `/api/issues/${enc(id)}/restore`),
  comment: (id: string, body: string) => request<Issue>("POST", `/api/issues/${enc(id)}/comments`, { body }),
  editComment: (id: string, cid: number, body: string) =>
    request<Issue>("PATCH", `/api/issues/${enc(id)}/comments/${cid}`, { body }),
  deleteComment: (id: string, cid: number) =>
    request<Issue>("DELETE", `/api/issues/${enc(id)}/comments/${cid}`),

  labels: (workspace?: string) => request<string[]>("GET", `/api/labels${query({ workspace })}`),

  documents: (filter: DocumentFilter = {}) =>
    request<DocumentSummary[]>("GET", `/api/documents${query(filter)}`),
  document: (slug: string) => request<Document>("GET", `/api/documents/${enc(slug)}`),
  createDocument: (input: DocumentInput) => request<Document>("POST", "/api/documents", input),
  updateDocument: (slug: string, patch: DocumentPatch) =>
    request<Document>("PATCH", `/api/documents/${enc(slug)}`, patch),
  deleteDocument: (slug: string) => request<Document>("DELETE", `/api/documents/${enc(slug)}`),
  restoreDocument: (slug: string) => request<Document>("POST", `/api/documents/${enc(slug)}/restore`),
  trash: (team: string) => request<Trash>("GET", `/api/teams/${enc(team)}/trash`),
  commentDocument: (slug: string, body: string) =>
    request<Document>("POST", `/api/documents/${enc(slug)}/comments`, { body }),
  editDocumentComment: (slug: string, cid: number, body: string) =>
    request<Document>("PATCH", `/api/documents/${enc(slug)}/comments/${cid}`, { body }),
  deleteDocumentComment: (slug: string, cid: number) =>
    request<Document>("DELETE", `/api/documents/${enc(slug)}/comments/${cid}`),
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
    // Only ever one socket: detach the old one first, so its late onclose can't start a second retry chain.
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.close();
    }
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => {
      if (attempt > 0) onEvent(null);
      attempt = 0;
      setConnection("online");
    };
    ws.onmessage = (e) => {
      try {
        onEvent(JSON.parse(String(e.data)) as ServerEvent);
      } catch {
        onEvent(null);
      }
    };
    ws.onclose = (e) => {
      if (stopped) return;
      if (e.code === 4401) onAccessLost();
      // A single quick reconnect isn't worth a banner; say so once a retry has failed.
      if (!navigator.onLine) setConnection("offline");
      else if (attempt > 0) setConnection("reconnecting");
      timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt++));
    };
  };

  // Back online: retry now rather than after the backoff.
  const online = () => {
    if (ws?.readyState === WebSocket.OPEN) return setConnection("online");
    if (ws?.readyState === WebSocket.CONNECTING) return; // its onopen or onclose follows
    setConnection("reconnecting");
    clearTimeout(timer);
    connect();
  };
  const offline = () => setConnection("offline");
  addEventListener("online", online);
  addEventListener("offline", offline);

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    removeEventListener("online", online);
    removeEventListener("offline", offline);
    ws?.close();
  };
}

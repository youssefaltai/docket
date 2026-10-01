// The server's routes (/api, /mcp, /ws) and where change events go, shared by both entrypoints: Bun (index.ts) and the
// Durable Object on Workers (src/worker). Each serves the web app its own way.
import { type Actor, heardTeams } from "./access.ts";
import { MAX_UPLOAD_BYTES, type ServerEvent } from "../shared/types.ts";
import { apiRoutes } from "./api.ts";
import { attachmentRoutes } from "./attachments.ts";
import { actorOf, authRoutes, guard } from "./auth.ts";
import { receive as receiveGitHub } from "./github.ts";
import { http, secure, type Server } from "./http.ts";
import { handleMcp } from "./mcp.ts";
import { eventTeams, memberAudience } from "./tracker.ts";

/** Whose credentials each socket rides on, so signing out, revoking or suspending closes it; and what it hears. */
export interface SocketData {
  userId: number;
  sessionId: number | null;
  keyId: number | null;
  topics: string[];
}

// What isn't about a team (the workspace, workspace labels): everyone in the workspace.
const topic = (workspace: string) => `workspace:${workspace}`;
// Public teams' events: everyone in the workspace but guests, who hear only their teams.
const publicTopic = (workspace: string) => `public:${workspace}`;
// One team's events: a private team's members, and a public team's guests.
const teamTopic = (teamId: number) => `team:${teamId}`;
// Events for one user (their inbox, their subscriptions), per workspace: a key's socket hears only its own.
const userTopic = (userId: number, workspace: string) => `user:${userId}:${workspace}`;

/** A socket's topics as of when it opens; any change to what its user sees closes it (revokeAccess), and it reconnects. */
const topicsOf = (a: Actor) =>
  [...a.workspaces].flatMap(([workspace, role]) => [
    topic(workspace),
    userTopic(a.id, workspace),
    ...(role === "guest" ? [] : [publicTopic(workspace)]),
    ...heardTeams(a, workspace).map(teamTopic),
  ]);

/** Where a change goes: a team's to those who see it (see eventTeams), anything else to the whole workspace. */
function topicsFor(event: ServerEvent): string[] {
  // A member: everyone but guests, who hear only of those sharing a team with them (their member list shows no one else),
  // and of themselves.
  if (event.entity === "member") {
    const { teams, alone } = memberAudience(event.workspace, event.id);
    return [publicTopic(event.workspace), ...teams.map(teamTopic), ...(alone === null ? [] : [userTopic(alone, event.workspace)])];
  }
  // A view: everyone but guests, who can't use them.
  if (event.entity === "view") return [publicTopic(event.workspace)];
  const teams = eventTeams(event);
  if (teams === null) return [topic(event.workspace)];
  return [...new Set(teams.flatMap((t) => (t.private ? [teamTopic(t.id)] : [publicTopic(event.workspace), teamTopic(t.id)])))];
}

/** The topics a change event (db.ts's onChange) goes to. */
export const eventTopics = (event: ServerEvent, to?: number | string) =>
  to === undefined ? topicsFor(event) : typeof to === "number" ? [userTopic(to, event.workspace)] : topicsFor({ ...event, entity: "team", id: to });

/** Whether a socket rides on credentials that were revoked (onRevoke): a session or key of the user, or all of theirs. */
export const revokes = (r: { userId: number; sessionId?: number; keyId?: number }, s: SocketData) =>
  s.userId === r.userId && (r.sessionId !== undefined ? s.sessionId === r.sessionId : r.keyId !== undefined ? s.keyId === r.keyId : true);

type Handler = (req: Request & { params: Record<string, string> }, server: Server) => Response | undefined | Promise<Response | undefined>;
type Route = Handler | Partial<Record<string, Handler>>;

const routes: Record<string, Route> = {
  ...Object.fromEntries(Object.entries(authRoutes).map(([path, route]) => [path, http(route)])),
  ...Object.fromEntries(Object.entries(apiRoutes).map(([path, route]) => [path, http(guard(route), { guarded: true })])),
  ...Object.fromEntries(Object.entries(attachmentRoutes).map(([path, route]) => [path, http(guard(route), { guarded: true, maxBody: MAX_UPLOAD_BYTES })])),
  // GitHub's webhook: public, signed with the workspace's secret; rate-limited per IP, as every unguarded route.
  "/api/github/:workspace": http({ POST: receiveGitHub }),
  "/mcp": http(guard(handleMcp, { mcp: true }), { guarded: true }),
  "/ws": http(
    guard((req: Request, server: Server) => {
      const a = actorOf(req);
      const data: SocketData = { userId: a.id, sessionId: a.sessionId, keyId: a.keyId, topics: topicsOf(a) };
      return server.upgrade(req, { data }) ? undefined : new Response("Expected a WebSocket", { status: 400 });
    }),
    { guarded: true },
  ),
} as never;

/** The paths routes serve: what the web app's own paths must leave to `route`. */
export const SERVER_PATHS = ["/api/*", "/mcp", "/ws"];

// Most specific first, as Bun.serve matches: per segment, a literal before a :param before a *.
const table = Object.entries(routes)
  .map(([path, route]) => {
    const segments = path.split("/").slice(1);
    const rank = segments.map((s) => (s === "*" ? 2 : s.startsWith(":") ? 1 : 0)).join("");
    return { segments, rank, route };
  })
  .sort((x, y) => (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : 0));

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function match(segments: string[], path: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (const [i, s] of segments.entries()) {
    if (s === "*") return path.length > i ? params : null;
    const p = path[i];
    if (p === undefined || p === "") return null;
    if (s.startsWith(":")) params[s.slice(1)] = decode(p);
    else if (s !== p) return null;
  }
  return segments.length === path.length ? params : null;
}

/**
 * Serves a request from the routes, as Bun.serve matches: the most specific path whose route takes the method (HEAD as GET),
 * else the next; none, a plain 404 with the headers. Undefined: it upgraded to a WebSocket.
 */
export async function route(req: Request, server: Server): Promise<Response | undefined> {
  const path = new URL(req.url).pathname.split("/").slice(1);
  for (const { segments, route } of table) {
    const params = match(segments, path);
    if (!params) continue;
    const handler = typeof route === "function" ? route : (route[req.method] ?? (req.method === "HEAD" ? route.GET : undefined));
    if (handler) return handler(Object.defineProperty(req, "params", { value: params }) as never, server);
  }
  return secure(req, new Response("Not found", { status: 404 }));
}

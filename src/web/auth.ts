// Who's signed in, and the account and workspace-admin calls (see SPEC.md, Access).
import type {
  ApiKey,
  ApiKeyScope,
  CodeInfo,
  CodeLink,
  Me,
  Session,
  SetupInput,
  User,
  UserRef,
  WorkspaceMember,
} from "../shared/types";
import { request } from "./api";

let me: Me | null = null;

/** The signed-in user and their workspaces. Loaded before the app renders; signing in or out reloads the page. */
export function getMe(): Me {
  if (!me) throw new Error("getMe() before loadMe()");
  return me;
}
export const loadMe = () => request<Me>("GET", "/api/me").then((m) => (me = m));

const enc = encodeURIComponent;
const ws = (key: string) => `/api/workspaces/${enc(key)}`;

export const auth = {
  needsSetup: () => request<{ needed: boolean }>("GET", "/api/setup").then((r) => r.needed),
  setup: (input: SetupInput) => request<{ user: User }>("POST", "/api/setup", input),
  peek: (code: string) => request<CodeInfo>("POST", "/api/auth/peek", { code }),
  redeem: (code: string, profile: { name?: string; username?: string } = {}) =>
    request<{ user: User }>("POST", "/api/auth/redeem", { code, ...profile }),
  logout: () => request<{ ok: true }>("POST", "/api/logout", {}),

  updateMe: (patch: { name?: string; username?: string; email?: string }) => request<Me>("PATCH", "/api/me", patch),
  sessions: () => request<Session[]>("GET", "/api/sessions"),
  revokeSession: (id: number) => request<unknown>("DELETE", `/api/sessions/${id}`),
  revokeOtherSessions: () => request<unknown>("DELETE", "/api/sessions"),
  signInLink: () => request<CodeLink>("POST", "/api/sign-in-links"),
  apiKeys: () => request<ApiKey[]>("GET", "/api/api-keys"),
  createApiKey: (name: string, scope: ApiKeyScope) => request<{ apiKey: ApiKey; token: string }>("POST", "/api/api-keys", { name, scope }),
  revokeApiKey: (id: number) => request<unknown>("DELETE", `/api/api-keys/${id}`),

  members: (workspace: string) => request<WorkspaceMember[]>("GET", `${ws(workspace)}/members`),
  updateMember: (workspace: string, username: string, patch: { role?: "admin" | "member"; suspended?: boolean }) =>
    request<WorkspaceMember>("PATCH", `${ws(workspace)}/members/${enc(username)}`, patch),
  memberSignInLink: (workspace: string, username: string) =>
    request<CodeLink>("POST", `${ws(workspace)}/members/${enc(username)}/sign-in-links`),
  invite: (workspace: string, email: string, role: "admin" | "member") => request<CodeLink>("POST", `${ws(workspace)}/invites`, { email, role }),
  createAgent: (workspace: string, name: string, username: string) =>
    request<{ agent: UserRef; token: string }>("POST", `${ws(workspace)}/agents`, { name, username }),
  rotateAgentToken: (workspace: string, username: string) => request<{ token: string }>("POST", `${ws(workspace)}/agents/${enc(username)}/token`),
  removeAgent: (workspace: string, username: string) => request<unknown>("DELETE", `${ws(workspace)}/agents/${enc(username)}`),
};

/** The command that connects an MCP client with a token. */
export const mcpCommand = (token: string) =>
  `claude mcp add --transport http --scope user docket ${location.origin}/mcp --header "Authorization: Bearer ${token}"`;

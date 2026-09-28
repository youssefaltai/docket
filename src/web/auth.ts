// Who's signed in, and the account and workspace-admin calls (see SPEC.md, Access).
import type {
  ApiKey,
  ApiKeyScope,
  CodeInfo,
  CodeLink,
  GitHubConnection,
  Me,
  Role,
  Session,
  SetupInput,
  User,
  UserRef,
  Webhook,
  WebhookDelivery,
  WebhookInput,
  WebhookPatch,
  WorkspaceMember,
} from "../shared/types";
import { enc, getCurrentWorkspace, request, setSignedInAs } from "./api";

let me: Me | null = null;

/** The signed-in user and their workspaces. Loaded before the app renders; signing in or out reloads the page. */
export function getMe(): Me {
  if (!me) throw new Error("getMe() before loadMe()");
  return me;
}
const setMe = (m: Me) => {
  me = m;
  setSignedInAs(m.user.id);
  return m;
};
export const loadMe = () => request<Me>("GET", "/api/me").then(setMe);

/** How you're known in the current workspace (usernames and names are per workspace). */
export function getYou(): UserRef {
  const m = getMe();
  return m.workspaces.find((w) => w.key === getCurrentWorkspace())?.you ?? m.user;
}

const ws = (key: string) => `/api/workspaces/${enc(key)}`;

export const auth = {
  needsSetup: () => request<{ needed: boolean }>("GET", "/api/setup").then((r) => r.needed),
  setup: (input: SetupInput) => request<{ user: User }>("POST", "/api/setup", input),
  peek: (code: string) => request<CodeInfo>("POST", "/api/auth/peek", { code }),
  redeem: (code: string, profile: { name?: string; username?: string } = {}) =>
    request<{ user: User }>("POST", "/api/auth/redeem", { code, ...profile }),
  logout: () => request<{ ok: true }>("POST", "/api/logout", {}),

  /** Saves your email, and what getMe() returns with it. */
  updateMe: (patch: { email?: string }) => request<Me>("PATCH", "/api/me", patch).then(setMe),
  /** Saves how you're known in one workspace, then what getMe() returns with it. */
  updateProfile: (workspace: string, patch: { name?: string; username?: string }) =>
    request<WorkspaceMember>("PATCH", `${ws(workspace)}/profile`, patch).then((member) => loadMe().then(() => member)),
  sessions: () => request<Session[]>("GET", "/api/sessions"),
  revokeSession: (id: number) => request<unknown>("DELETE", `/api/sessions/${id}`),
  revokeOtherSessions: () => request<unknown>("DELETE", "/api/sessions"),
  signInLink: () => request<CodeLink>("POST", "/api/sign-in-links"),
  apiKeys: () => request<ApiKey[]>("GET", "/api/api-keys"),
  createApiKey: (name: string, scope: ApiKeyScope, workspace: string) =>
    request<{ apiKey: ApiKey; token: string }>("POST", "/api/api-keys", { name, scope, workspace }),
  revokeApiKey: (id: number) => request<unknown>("DELETE", `/api/api-keys/${id}`),

  updateMember: (workspace: string, username: string, patch: { role?: Exclude<Role, "agent">; suspended?: boolean }) =>
    request<WorkspaceMember>("PATCH", `${ws(workspace)}/members/${enc(username)}`, patch),
  invite: (workspace: string, role: Exclude<Role, "agent">) => request<CodeLink>("POST", `${ws(workspace)}/invites`, { role }),
  createAgent: (workspace: string, name: string, username: string) =>
    request<{ agent: UserRef; token: string }>("POST", `${ws(workspace)}/agents`, { name, username }),
  rotateAgentToken: (workspace: string, username: string) => request<{ token: string }>("POST", `${ws(workspace)}/agents/${enc(username)}/token`),
  removeAgent: (workspace: string, username: string) => request<unknown>("DELETE", `${ws(workspace)}/agents/${enc(username)}`),

  webhooks: (workspace: string) => request<Webhook[]>("GET", `${ws(workspace)}/webhooks`),
  createWebhook: (workspace: string, input: WebhookInput) => request<{ webhook: Webhook; secret: string }>("POST", `${ws(workspace)}/webhooks`, input),
  updateWebhook: (workspace: string, id: number, patch: WebhookPatch) => request<Webhook>("PATCH", `${ws(workspace)}/webhooks/${id}`, patch),
  deleteWebhook: (workspace: string, id: number) => request<unknown>("DELETE", `${ws(workspace)}/webhooks/${id}`),
  rotateWebhookSecret: (workspace: string, id: number) => request<{ secret: string }>("POST", `${ws(workspace)}/webhooks/${id}/secret`),
  webhookDeliveries: (workspace: string, id: number) => request<WebhookDelivery[]>("GET", `${ws(workspace)}/webhooks/${id}/deliveries`),

  github: (workspace: string) => request<GitHubConnection>("GET", `${ws(workspace)}/github`),
  connectGitHub: (workspace: string) => request<{ url: string; secret: string }>("POST", `${ws(workspace)}/github`),
  disconnectGitHub: (workspace: string) => request<unknown>("DELETE", `${ws(workspace)}/github`),
};

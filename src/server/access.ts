// Identity and access: accounts (people and agents), sessions, API keys, one-time codes (setup, invites,
// sign-in links), and workspace membership. An account is a login; its username and name belong to each
// membership. Every request acts as an Actor built here.
import type { SQLQueryBindings } from "bun:sqlite";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  API_KEY_SCOPES,
  RESERVED_WORKSPACE_KEYS,
  type ApiKey,
  type ApiKeyScope,
  type CodeInfo,
  type Me,
  type Role,
  type Session,
  type SetupInput,
  type TeamListing,
  type User,
  type UserKind,
  type UserRef,
  type Workspace,
  type WorkspaceInput,
  type WorkspaceMember,
  type WorkspacePatch,
} from "../shared/types.ts";
import { AppError, SYSTEM_USER, changed, checkOneOf, db, exists, now, pickSlug, requireText } from "./db.ts";

/** Who a request acts as. Built fresh per request, so role and suspension changes apply at once. */
export interface Actor {
  id: number;
  renewCookie?: boolean; // a session in use: re-send its cookie so the browser's copy slides with the idle window
  kind: UserKind;
  workspaces: Map<string, Role>; // active memberships (a key's: just its own workspace)
  workspace: string | null; // the request's: a key's own, else X-Docket-Workspace or a session's only one (see requestWorkspace)
  scope: ApiKeyScope; // an API key's scope; sessions can write
  sessionId: number | null;
  keyId: number | null;
  chat?: boolean; // a chat key: the chat proxy's, for one browser session
}

// --- Secrets ---

/** Only SHA-256 hashes of tokens and codes are stored, so the database holds nothing that signs in. */
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

// Codes are typed or pasted, so they skip look-alikes (0/O, 1/I): 10 of 32 symbols is 50 bits,
// enough for something that's single-use, expires in 15 minutes and is rate-limited per IP.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 15 * 60 * 1000;
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const formatCode = (code: string) => {
  const c = normalizeCode(code);
  return c.length === 10 ? `${c.slice(0, 5)}-${c.slice(5)}` : c;
};
const newCode = () => formatCode(Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(""));

export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_MS = 60 * 1000; // last_seen_at / last_used_at are written at most once a minute

let revoked: (r: { userId: number; sessionId?: number; keyId?: number }) => void = () => {};

/** Called when credentials stop working (sign out, revoke, suspend), so the server can close their sockets. */
export function onRevoke(fn: typeof revoked) {
  revoked = fn;
}

/** What these accounts see changed (team membership, a team made private or public): their sockets reconnect with it. */
export function revokeAccess(userIds: Iterable<number>) {
  for (const userId of new Set(userIds)) revoked({ userId });
}

// --- Accounts and profiles ---

/** An account: a login (people and agents). How it's known, its username and name, is per membership. */
interface AccountRow {
  id: number;
  kind: UserKind;
  email: string | null;
  created_at: string;
}

const toRef = (row: { username: string; name: string; kind: UserKind }): UserRef => ({
  username: row.username,
  name: row.name,
  kind: row.kind,
});

const PROFILE_SELECT = "SELECT m.username, m.name, u.kind FROM workspace_members m JOIN users u ON u.id = m.user_id";

/**
 * Who an account is in `workspace`; without one (or not a member there), its default profile: the
 * membership it joined most recently, whatever its status.
 */
export function profileOf(userId: number, workspace?: string | null): UserRef {
  const there = workspace
    ? db.query<UserRef, [number, string]>(`${PROFILE_SELECT} WHERE m.user_id = ? AND m.workspace = ?`).get(userId, workspace)
    : null;
  const row =
    there ?? db.query<UserRef, [number]>(`${PROFILE_SELECT} WHERE m.user_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`).get(userId)!;
  return toRef(row);
}

/** An account as a `User`: its profile in `workspace` (else its default one). */
function toUser(userId: number, workspace?: string | null): User {
  const account = db.query<AccountRow, [number]>("SELECT * FROM users WHERE id = ?").get(userId)!;
  return { ...profileOf(userId, workspace), email: account.email, createdAt: account.created_at };
}

/** The request's workspace if you're an active member there, else null. */
const activeWorkspace = (a: Actor) => (a.workspace && a.workspaces.has(a.workspace) ? a.workspace : null);

/** Your username in the request's workspace, or null (MCP marks "you" by it). */
export function usernameOf(a: Actor): string | null {
  const workspace = activeWorkspace(a);
  return workspace ? profileOf(a.id, workspace).username : null;
}

// "me" means the caller wherever a username is taken; "docket" is Docket's own account, in every workspace.
const RESERVED = ["me", SYSTEM_USER.username];

/** A username free in `workspace` (`self` may keep their own); unique among its people and agents. */
function checkUsername(value: unknown, workspace: string, self = -1): string {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(username)) {
    throw new AppError('username must be 2–32 characters of a-z, 0-9, ".", "_" and "-", starting with a letter or digit');
  }
  if (RESERVED.includes(username)) throw new AppError(`"${username}" is reserved`);
  const taken = db.query("SELECT 1 FROM workspace_members WHERE workspace = ? AND username = ? AND user_id != ?").get(workspace, username, self);
  if (taken) {
    const { name } = db.query<{ name: string }, [string]>("SELECT name FROM workspaces WHERE key = ?").get(workspace)!;
    throw new AppError(`Username "${username}" is taken in ${name}`, 409);
  }
  return username;
}

function checkName(value: unknown): string {
  const name = requireText(value, "name");
  if (name.length > 60 || /[\r\n]/.test(name)) throw new AppError("name must be one line of at most 60 characters");
  return name;
}

/**
 * Optional contact info, unique across accounts (stored lowercased, so case-insensitively). Never
 * verified yet (there's no mail) and never used to find an account. `self` is the account keeping it.
 */
function checkEmail(value: unknown, self?: number): string | null {
  if (value == null || value === "") return null;
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(`Invalid email "${value}"`);
  const taken = db.query("SELECT 1 FROM users WHERE email = ? AND id != ?").get(email, self ?? -1);
  if (taken) throw new AppError("That email is already used by another account", 409);
  return email;
}

function insertAccount(kind: UserKind, email?: unknown): number {
  return db
    .query<{ id: number }, [UserKind, string | null, string]>("INSERT INTO users (kind, email, created_at) VALUES (?, ?, ?) RETURNING id")
    .get(kind, kind === "person" ? checkEmail(email) : null, now())!.id;
}

const PERSON_ROLES = ["admin", "member", "guest"] as const;

/**
 * Adds an account to a workspace as `profile` (its username and name there). It joins every public team there (so its
 * sidebar shows them), unless it's a guest, and the teams in `teams` (a guest invite's), by id.
 */
function addMember(workspace: string, userId: number, role: Role, profile: { username?: unknown; name?: unknown }, time = now(), teams: number[] = []) {
  const username = checkUsername(profile.username, workspace);
  const name = checkName(profile.name);
  db.query("INSERT INTO workspace_members (workspace, user_id, username, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    workspace,
    userId,
    username,
    name,
    role,
    time,
  );
  const join = (where: string, ...params: SQLQueryBindings[]) =>
    db.query(`INSERT OR IGNORE INTO team_members (team_id, user_id, created_at) SELECT id, ?, ? FROM teams WHERE workspace = ? AND ${where}`).run(userId, time, workspace, ...params);
  if (role !== "guest") join("private = 0");
  for (const id of teams) join("id = ?", id);
}

const setSuspended = (workspace: string, userId: number, at: string | null) =>
  db.query("UPDATE workspace_members SET suspended_at = ? WHERE workspace = ? AND user_id = ?").run(at, workspace, userId);

export function me(a: Actor): Me {
  type Row = { key: string; name: string; role: Role; username: string; member_name: string; kind: UserKind };
  const workspaces = db
    .query<Row, [number]>(
      `SELECT w.key, w.name, m.role, m.username, m.name AS member_name, u.kind
       FROM workspace_members m JOIN workspaces w ON w.key = m.workspace JOIN users u ON u.id = m.user_id
       WHERE m.user_id = ? AND m.suspended_at IS NULL ORDER BY w.name COLLATE NOCASE`,
    )
    .all(a.id)
    .filter((w) => a.workspaces.has(w.key))
    .map((w) => ({ key: w.key, name: w.name, role: w.role, you: toRef({ ...w, name: w.member_name }) }));
  const credential = a.sessionId !== null ? "session" : a.chat ? "chat" : "key";
  return { user: { ...toUser(a.id, activeWorkspace(a)), id: a.id }, workspaces, credential, chat: !!process.env.CHAT_URL };
}

/** Your account's email; your name and username are per workspace (`updateProfile`). */
export function updateMe(a: Actor, patch: { email?: unknown }): Me {
  requireSession(a);
  if (patch.email !== undefined) db.query("UPDATE users SET email = ? WHERE id = ?").run(checkEmail(patch.email, a.id), a.id);
  for (const workspace of a.workspaces.keys()) changed("member", workspace, profileOf(a.id, workspace).username);
  return me(a);
}

/** How you appear in one workspace: your name and username there, unique within it. */
export function updateProfile(a: Actor, workspace: unknown, patch: { name?: unknown; username?: unknown }): WorkspaceMember {
  requireSession(a);
  const key = requireMember(a, workspace);
  const current = profileOf(a.id, key);
  const username = patch.username === undefined ? current.username : checkUsername(patch.username, key, a.id);
  const name = patch.name === undefined ? current.name : checkName(patch.name);
  db.query("UPDATE workspace_members SET username = ?, name = ? WHERE workspace = ? AND user_id = ?").run(username, name, key, a.id);
  changed("member", key, username);
  return memberFor(a, key, username);
}

// --- Actors ---

/** An actor with the user's active memberships: all of them for a session, only `workspace`'s for a key. */
function actorFor(user: AccountRow, credential: { scope: ApiKeyScope; sessionId?: number; keyId?: number }, workspace?: string): Actor {
  const memberships = db
    .query<{ workspace: string; role: Role }, [number, string | null]>(
      "SELECT workspace, role FROM workspace_members WHERE user_id = ?1 AND suspended_at IS NULL AND (?2 IS NULL OR workspace = ?2)",
    )
    .all(user.id, workspace ?? null);
  return {
    id: user.id,
    kind: user.kind,
    workspaces: new Map(memberships.map((m) => [m.workspace, m.role])),
    workspace: workspace ?? (memberships.length === 1 ? memberships[0]!.workspace : null),
    scope: credential.scope,
    sessionId: credential.sessionId ?? null,
    keyId: credential.keyId ?? null,
  };
}

/** The actor behind a session cookie, or null if it's unknown or idle for 30 days. */
export function sessionActor(token: string): Actor | null {
  const row = db
    .query<AccountRow & { session_id: number; last_seen_at: string }, [string]>(
      `SELECT u.*, s.id AS session_id, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND u.system = 0`,
    )
    .get(hash(token));
  if (!row) return null;
  const idle = Date.now() - Date.parse(row.last_seen_at);
  if (idle > SESSION_IDLE_MS) {
    db.query("DELETE FROM sessions WHERE id = ?").run(row.session_id);
    return null;
  }
  const actor = actorFor(row, { scope: "write", sessionId: row.session_id });
  if (idle > TOUCH_MS) {
    db.query("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now(), row.session_id);
    actor.renewCookie = true;
  }
  return actor;
}

/**
 * The actor behind an API key (`dk_…`), or null if it's unknown, revoked or expired, or its owner isn't an
 * active member of the key's workspace. A key acts only in its own workspace.
 */
export function keyActor(token: string): Actor | null {
  type Row = AccountRow & { key_id: number; scope: ApiKeyScope; last_used_at: string | null; session_id: number | null; key_workspace: string };
  const row = db
    .query<Row, [string, string]>(
      `SELECT u.*, k.id AS key_id, k.scope, k.last_used_at, k.session_id, k.workspace AS key_workspace
       FROM api_keys k JOIN users u ON u.id = k.user_id
       JOIN workspace_members m ON m.user_id = k.user_id AND m.workspace = k.workspace AND m.suspended_at IS NULL
       WHERE k.token_hash = ? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)`,
    )
    .get(hash(token), now());
  if (!row) return null;
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > TOUCH_MS) {
    db.query("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), row.key_id);
  }
  return { ...actorFor(row, { scope: row.scope, keyId: row.key_id }, row.key_workspace), chat: row.session_id !== null };
}

// --- Access checks (used by every data module) ---

/** The workspace key if the actor is an active member; otherwise 404, so its existence doesn't leak. */
export function requireMember(a: Actor, workspace: unknown): string {
  const key = typeof workspace === "string" ? workspace.trim().toLowerCase() : "";
  if (!a.workspaces.has(key)) throw new AppError(`Workspace ${workspace} not found`, 404);
  return key;
}

/**
 * The workspace this request acts in: a key's own, or a session's X-Docket-Workspace (else its only
 * workspace). 404 if you aren't an active member there; 400 if a session in several names none.
 */
export function requestWorkspace(a: Actor): string {
  if (a.workspace === null) throw new AppError("Pick a workspace: send X-Docket-Workspace", 400);
  if (!a.workspaces.has(a.workspace)) throw new AppError(`Workspace ${a.workspace} not found`, 404);
  return a.workspace;
}

// --- Team visibility: the one rule every team-scoped read and write goes through ---

/**
 * SQL: whether account `u` (an SQL expression) sees team `t` (an alias of `teams`), Linear's private teams and guests:
 * as an active member of its workspace who is in the team, or, unless a guest, when the team is public. Admins are no
 * exception: they see a private team once they join it.
 */
export const SEES_TEAM = (u: string, t: string) =>
  `EXISTS (SELECT 1 FROM workspace_members sm WHERE sm.user_id = ${u} AND sm.workspace = ${t}.workspace AND sm.suspended_at IS NULL
     AND ((${t}.private = 0 AND sm.role != 'guest') OR EXISTS (SELECT 1 FROM team_members st WHERE st.team_id = ${t}.id AND st.user_id = ${u})))`;

/** The ids of the teams you see in `workspace` (default: the request's). Anything outside them is 404, like another workspace's. */
export function visibleTeamIds(a: Actor, workspace = requestWorkspace(a)): number[] {
  if (!a.workspaces.has(workspace)) return [];
  return db
    .query<{ id: number }, [string, number]>(`SELECT t.id FROM teams t WHERE t.workspace = ?1 AND ${SEES_TEAM("?2", "t")} ORDER BY t.id`)
    .all(workspace, a.id)
    .map((r) => r.id);
}

/** Whether account `userId` sees team `teamId`. */
export const seesTeam = (userId: number, teamId: number) => db.query(`SELECT 1 FROM teams t WHERE t.id = ?1 AND ${SEES_TEAM("?2", "t")}`).get(teamId, userId) !== null;

/** A guest sees only the teams they're in: nothing workspace-wide (views, other people, settings beyond their account). */
export const isGuest = (a: Actor, workspace = requestWorkspace(a)) => a.workspaces.get(workspace) === "guest";

/**
 * The teams whose events a socket hears on each team's own topic: a guest's teams; for anyone else, the private teams
 * they see (every non-guest hears public teams' events on the workspace's).
 */
export function heardTeams(a: Actor, workspace: string): number[] {
  const seen = visibleTeamIds(a, workspace);
  if (isGuest(a, workspace)) return seen;
  return db
    .query<{ id: number }, []>(`SELECT id FROM teams WHERE private = 1 AND id IN (${seen.join(", ") || "NULL"})`)
    .all()
    .map((t) => t.id);
}

function requireAdmin(a: Actor, workspace: unknown): string {
  const key = requireMember(a, workspace);
  if (a.workspaces.get(key) !== "admin") throw new AppError("Only workspace admins can do that", 403);
  return key;
}

export function requirePerson(a: Actor, message = "Only people can do that") {
  if (a.kind !== "person") throw new AppError(message, 403);
}

/**
 * Managing access (keys, sessions, codes, invites, members, agents, webhooks, your profile) takes a signed-in
 * session: an API key that could mint credentials would outlive its own revocation.
 */
export function requireSession(a: Actor) {
  if (a.sessionId === null) throw new AppError("Sign in to the web app to manage access; API keys can't", 403);
}

/** Managing a workspace's members, invites, agents and webhooks: an admin, signed in. */
export function requireAdminSession(a: Actor, workspace: unknown): string {
  requireSession(a);
  return requireAdmin(a, workspace);
}

/**
 * The user id for a username in `workspace` (or "me") who is an active member there of the given kind:
 * assignees are people, delegates are agents.
 */
export function activeMemberId(a: Actor, workspace: string, value: string, kind: UserKind, field: string): number {
  const given = value.trim().toLowerCase();
  const me = given === "me";
  const row = db
    .query<{ id: number; username: string; kind: UserKind; integration: number }, [string, string | number]>(
      `SELECT m.user_id AS id, m.username, u.kind, ${isIntegration("m.user_id")} AS integration
       FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace = ? AND m.${me ? "user_id" : "username"} = ? AND m.suspended_at IS NULL`,
    )
    .get(workspace, me ? a.id : given);
  const username = row?.username ?? given;
  if (!row) throw new AppError(`${field}: ${username} isn't an active member of this workspace`);
  if (row.integration) throw new AppError(`${field}: ${username} is an integration`);
  if (row.kind !== kind) {
    const hint = field === "assignee" ? "; set it as the delegate" : ", not a person";
    throw new AppError(kind === "person" ? `${field}: ${username} is an agent${hint}` : `${field}: ${username} isn't an agent`);
  }
  return row.id;
}

/**
 * Docket's own account (SYSTEM_USER), made the first time Docket changes something itself. It's never a member,
 * so it can't be assigned, delegated to or mentioned, and it never signs in: nothing issues it a session, key or
 * code, a key only works for a member, and `sessionActor` refuses a session naming it.
 */
export function systemUserId(): number {
  const row =
    db.query<{ id: number }, []>("SELECT id FROM users WHERE system = 1").get() ??
    db.query<{ id: number }, [string]>("INSERT INTO users (kind, system, created_at) VALUES ('agent', 1, ?) RETURNING id").get(now());
  return row!.id;
}

// --- Setup (first run) ---

/** The first-run setup code: DOCKET_SETUP_CODE if set, else random; only usable while there are no users. */
export const setupCode = normalizeCode(process.env.DOCKET_SETUP_CODE || newCode());
export const needsSetup = () => db.query("SELECT 1 FROM users LIMIT 1").get() === null;

/** Creates the first account (admin of a new workspace) and signs it in. */
export function setup(input: SetupInput, client: Client): { user: User; workspace: Workspace; token: string } {
  if (!needsSetup()) throw new AppError("Docket is already set up", 409);
  const given = normalizeCode(typeof input.code === "string" ? input.code : "");
  if (!timingSafeEqual(Buffer.from(hash(given)), Buffer.from(hash(setupCode)))) throw new AppError("Wrong setup code", 403);
  return db.transaction(() => {
    const userId = insertAccount("person", input.email);
    const key = insertWorkspace(input.workspace ?? {}, userId, input);
    const token = startSession(userId, client);
    return { user: toUser(userId, key), workspace: workspaceFor(userId, key), token };
  }).immediate();
}

// --- Sessions ---

export interface Client {
  userAgent: string;
  ip: string;
}

function startSession(userId: number, client: Client): string {
  const token = randomBytes(32).toString("hex");
  const time = now();
  db.query("INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)").run(
    userId,
    hash(token),
    time,
    time,
    client.userAgent.slice(0, 300),
    client.ip,
  );
  return token;
}

export function endSession(token: string) {
  const row = db.query<{ id: number; user_id: number }, [string]>("DELETE FROM sessions WHERE token_hash = ? RETURNING id, user_id").get(hash(token));
  if (row) revoked({ userId: row.user_id, sessionId: row.id });
}

export function listSessions(a: Actor): Session[] {
  requireSession(a);
  return db
    .query<{ id: number; created_at: string; last_seen_at: string; user_agent: string; ip: string }, [number]>(
      "SELECT id, created_at, last_seen_at, user_agent, ip FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC",
    )
    .all(a.id)
    .map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      userAgent: s.user_agent,
      ip: s.ip,
      current: s.id === a.sessionId,
    }));
}

export function revokeSession(a: Actor, id: unknown) {
  requireSession(a);
  const row = db.query("DELETE FROM sessions WHERE id = ? AND user_id = ? RETURNING id").get(Number(id), a.id);
  if (!row) throw new AppError(`Session ${id} not found`, 404);
  revoked({ userId: a.id, sessionId: Number(id) });
}

/** Signs out everywhere else: every session but the current one. */
export function revokeOtherSessions(a: Actor) {
  requireSession(a);
  const gone = db
    .query<{ id: number }, [number, number]>("DELETE FROM sessions WHERE user_id = ? AND id != ? RETURNING id")
    .all(a.id, a.sessionId ?? -1);
  for (const { id } of gone) revoked({ userId: a.id, sessionId: id });
}

// --- API keys ---

interface ApiKeyRow {
  id: number;
  name: string;
  scope: ApiKeyScope;
  workspace: string;
  created_at: string;
  last_used_at: string | null;
}

const toApiKey = (row: ApiKeyRow): ApiKey => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  workspace: row.workspace,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

const newApiToken = () => `dk_${randomBytes(32).toString("hex")}`;

function insertApiKey(userId: number, workspace: string, name: string, scope: ApiKeyScope): { apiKey: ApiKey; token: string } {
  const token = newApiToken();
  const row = db
    .query<ApiKeyRow, [number, string, string, ApiKeyScope, string, string]>(
      `INSERT INTO api_keys (user_id, workspace, name, scope, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id, name, scope, workspace, created_at, last_used_at`,
    )
    .get(userId, workspace, name, scope, hash(token), now())!;
  return { apiKey: toApiKey(row), token };
}

export function listApiKeys(a: Actor): ApiKey[] {
  requireSession(a);
  return db
    .query<ApiKeyRow, [number]>(
      "SELECT id, name, scope, workspace, created_at, last_used_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL AND session_id IS NULL ORDER BY id",
    )
    .all(a.id)
    .map(toApiKey);
}

/** A key for one workspace, the given one or else the request's; it acts only there. */
export function createApiKey(a: Actor, input: { name?: unknown; scope?: unknown; workspace?: unknown }) {
  requireSession(a);
  const name = requireText(input.name, "name");
  const scope = input.scope === undefined ? "write" : checkOneOf(input.scope, API_KEY_SCOPES, "scope");
  const workspace = input.workspace === undefined ? requestWorkspace(a) : requireMember(a, input.workspace);
  return insertApiKey(a.id, workspace, name, scope);
}

export function revokeApiKey(a: Actor, id: unknown) {
  requireSession(a);
  const row = db
    .query("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND session_id IS NULL RETURNING id")
    .get(now(), Number(id), a.id);
  if (!row) throw new AppError(`API key ${id} not found`, 404);
  revoked({ userId: a.id, keyId: Number(id) });
}

// --- Chat keys: what the chat proxy hands the chat service to read Docket as this person ---

const CHAT_KEY_TTL_MS = Number(process.env.DOCKET_CHAT_KEY_TTL_MS) || 30 * 60 * 1000;
// Tokens are stored only hashed, so the one in use lives here, by `${session}:${workspace}`; a restart just mints another.
const chatKeys = new Map<string, { token: string; expiresAt: number }>();

/** Deletes keys past their expiry (and forgets chat keys for sessions that are gone). */
export function purgeExpiredKeys() {
  db.query("DELETE FROM api_keys WHERE expires_at <= ?").run(now());
  for (const [slot, held] of chatKeys) if (held.expiresAt <= Date.now()) chatKeys.delete(slot);
}
purgeExpiredKeys();

/**
 * A read key for the chat service, bound to this browser session and the request's workspace: reused while
 * it has most of its life left (so a long answer never outlives it), then replaced. It dies with the session
 * (sign-out, revoke) or with suspension from that workspace.
 */
export function chatKey(a: Actor): string {
  if (a.sessionId === null) throw new AppError("The assistant works from the web app, not with an API key", 403);
  const workspace = requestWorkspace(a);
  const slot = `${a.sessionId}:${workspace}`;
  const held = chatKeys.get(slot);
  if (held && held.expiresAt - Date.now() > (CHAT_KEY_TTL_MS * 2) / 3) {
    // Still ours? Session ids can be reused after a delete, and the key goes with its session.
    const live = db
      .query("SELECT 1 FROM api_keys WHERE token_hash = ? AND session_id = ? AND user_id = ? AND workspace = ? AND expires_at > ?")
      .get(hash(held.token), a.sessionId, a.id, workspace, now());
    if (live) return held.token;
  }
  const { token, expiresAt } = mintChatKey(a, workspace, "read", CHAT_KEY_TTL_MS);
  chatKeys.set(slot, { token, expiresAt });
  return token;
}

const CHAT_WRITE_KEY_TTL_MS = 5 * 60 * 1000;

/**
 * A write key for one change the person just confirmed in the assistant: minted for that request alone, and
 * `drop` deletes it when the answer ends. Its 5 minutes are only a backstop; it never outlives the session.
 */
export function chatWriteKey(a: Actor): { token: string; drop: () => void } {
  if (a.sessionId === null) throw new AppError("The assistant works from the web app, not with an API key", 403);
  const { token, id } = mintChatKey(a, requestWorkspace(a), "write", CHAT_WRITE_KEY_TTL_MS);
  return {
    token,
    drop: () => {
      db.query("DELETE FROM api_keys WHERE id = ?").run(id);
      revoked({ userId: a.id, keyId: id }); // and any socket opened with it
    },
  };
}

function mintChatKey(a: Actor, workspace: string, scope: ApiKeyScope, ttl: number) {
  purgeExpiredKeys();
  const token = newApiToken();
  const expiresAt = Date.now() + ttl;
  const { id } = db
    .query<{ id: number }, [number, string, ApiKeyScope, string, string, string, number]>(
      `INSERT INTO api_keys (user_id, workspace, name, scope, token_hash, created_at, expires_at, session_id)
       VALUES (?, ?, 'Chat (automatic)', ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(a.id, workspace, scope, hash(token), now(), new Date(expiresAt).toISOString(), a.sessionId!)!;
  return { token, expiresAt, id };
}

// --- One-time codes: invites and sign-in links ---

interface CodeRow {
  id: number;
  purpose: CodeInfo["kind"];
  user_id: number | null;
  workspace: string | null;
  role: Role | null;
  teams: string | null; // an invite's teams: JSON array of team ids
  expires_at: string;
  used_at: string | null;
}

function issueCode(fields: { purpose: CodeInfo["kind"]; userId?: number; workspace?: string; role?: Role; teams?: number[]; by?: number }) {
  const code = newCode();
  const time = Date.now();
  const expiresAt = new Date(time + CODE_TTL_MS).toISOString();
  db.query(
    `INSERT INTO codes (code_hash, purpose, user_id, workspace, role, teams, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hash(normalizeCode(code)),
    fields.purpose,
    fields.userId ?? null,
    fields.workspace ?? null,
    fields.role ?? null,
    fields.teams?.length ? JSON.stringify(fields.teams) : null,
    fields.by ?? null,
    new Date(time).toISOString(),
    expiresAt,
  );
  return { code, expiresAt };
}

/** A live code, or 401 (unknown, used or expired all look the same). */
function codeRow(code: unknown): CodeRow {
  const row =
    typeof code === "string"
      ? db.query<CodeRow, [string]>("SELECT * FROM codes WHERE code_hash = ?").get(hash(normalizeCode(code)))
      : null;
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) {
    throw new AppError("This code is invalid or has expired", 401);
  }
  return row;
}

/** Who's signed in on the request redeeming or peeking a code: their account and this session. */
export type SignedIn = { userId: number; sessionId: number } | null;

export function peekCode(code: unknown, signedIn: SignedIn): CodeInfo {
  const row = codeRow(code);
  const workspace = row.workspace
    ? db.query<{ name: string }, [string]>("SELECT name FROM workspaces WHERE key = ?").get(row.workspace)?.name ?? null
    : null;
  const username = row.user_id ? profileOf(row.user_id, row.workspace).username : null;
  const invite = row.purpose === "invite";
  // Who's signed in (their default profile): an invite would add that account, a sign-in link for someone
  // else would replace it, so the page asks first either way. A link to yourself replaces no one.
  const you = signedIn && (invite || signedIn.userId !== row.user_id) ? profileOf(signedIn.userId) : null;
  return { kind: row.purpose, workspace, username, you, needsProfile: invite && signedIn === null };
}

/**
 * Uses a code and signs in. A sign-in link opens the account it was made for; if this browser was signed
 * in as someone else, that session ends, so no tab keeps acting as them. An invite is a code the admin
 * hands over, never tied to an email: redeemed while signed in, it adds you to the workspace as `profile`
 * (by default, your default profile); signed out, it creates a new account and membership from `profile`.
 */
export function redeemCode(
  code: unknown,
  profile: { name?: unknown; username?: unknown; email?: unknown },
  client: Client,
  signedIn: SignedIn,
): { user: User; token: string } {
  return db.transaction(() => {
    const row = codeRow(code);
    let userId = row.user_id;
    if (row.purpose === "sign-in" && signedIn && signedIn.userId !== userId) {
      db.query("DELETE FROM sessions WHERE id = ?").run(signedIn.sessionId);
      revoked(signedIn);
    }
    if (row.purpose === "invite") {
      userId = signedIn?.userId ?? insertAccount("person", profile.email);
      const member = db
        .query<{ suspended_at: string | null }, [string, number]>(
          "SELECT suspended_at FROM workspace_members WHERE workspace = ? AND user_id = ?",
        )
        .get(row.workspace!, userId);
      if (member?.suspended_at) throw new AppError("You were suspended from this workspace; ask an admin to reinstate you", 403);
      const usual: Partial<UserRef> = signedIn ? profileOf(userId) : {};
      const there = { username: profile.username ?? usual.username, name: profile.name ?? usual.name };
      if (!member) addMember(row.workspace!, userId, row.role!, there, now(), JSON.parse(row.teams ?? "[]"));
    }
    db.query("UPDATE codes SET used_at = ? WHERE id = ?").run(now(), row.id);
    const user = toUser(userId!, row.workspace);
    if (row.purpose === "invite") changed("member", row.workspace!, user.username);
    return { user, token: startSession(userId!, client) };
  }).immediate();
}

/** A sign-in link for yourself, to sign in on another device; it records the workspace you're in. */
export function selfSignInLink(a: Actor) {
  requireSession(a);
  return issueCode({ purpose: "sign-in", userId: a.id, workspace: activeWorkspace(a) ?? undefined, by: a.id });
}

/**
 * For `bun run sign-in-link <username> [workspace]` on the server: shell access is the proof, so there's no
 * HTTP route. It finds the person holding that username (in `workspace`, else in any); 409 listing where
 * if several people do.
 */
export function recoverySignInLink(username: string, workspace?: string) {
  const held = db
    .query<{ user_id: number; workspace: string; name: string; kind: UserKind }, [string, string | null]>(
      `SELECT m.user_id, m.workspace, m.name, u.kind FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.username = ?1 AND (?2 IS NULL OR m.workspace = ?2) ORDER BY m.workspace`,
    )
    .all(username.trim().toLowerCase(), workspace?.trim().toLowerCase() || null);
  const people = held.filter((m) => m.kind === "person");
  if (people.length === 0) {
    if (held.length) throw new AppError("Agents sign in with their token, not a link");
    throw new AppError(`User ${username} not found${workspace ? ` in ${workspace}` : ""}`, 404);
  }
  if (new Set(people.map((m) => m.user_id)).size > 1) {
    throw new AppError(`Several people are ${username}:\n${people.map((m) => `${m.workspace} · ${m.name}`).join("\n")}`, 409);
  }
  return issueCode({ purpose: "sign-in", userId: people[0]!.user_id, workspace: people.length === 1 ? people[0]!.workspace : undefined });
}

/**
 * An invite: a one-time code the admin hands to someone, who joins with it (new account or existing). Redeeming it
 * joins `teams` (keys of the workspace; an admin can join a private team anyway) besides every public team; a guest
 * joins only `teams`, so a guest invite needs at least one.
 */
export function invite(a: Actor, workspace: unknown, input: { role?: unknown; teams?: unknown }) {
  const key = requireAdminSession(a, workspace);
  const role = checkOneOf(input.role ?? "member", PERSON_ROLES, "role");
  if (input.teams !== undefined && (!Array.isArray(input.teams) || !input.teams.every((t) => typeof t === "string"))) {
    throw new AppError('teams must be an array of team keys, e.g. ["BRD"]');
  }
  const teams = [...new Set(((input.teams ?? []) as string[]).map((k) => teamIdIn(key, k)))];
  if (role === "guest" && !teams.length) throw new AppError("Pick at least one team for a guest");
  return issueCode({ purpose: "invite", workspace: key, role, teams, by: a.id });
}

/** A team of `workspace`, by key (400 otherwise). */
function teamIdIn(workspace: string, key: string): number {
  const row = db.query<{ id: number }, [string, string]>("SELECT id FROM teams WHERE workspace = ? AND key = ?").get(workspace, key.trim().toUpperCase());
  if (!row) throw new AppError(`Unknown team "${key}"`);
  return row.id;
}

// --- Workspaces and members ---

interface WorkspaceRow {
  key: string;
  name: string;
  role: Role;
  team_count: number;
  created_at: string;
  updated_at: string;
}

const toWorkspace = (row: WorkspaceRow): Workspace => ({
  key: row.key,
  name: row.name,
  role: row.role,
  teamCount: row.team_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const WORKSPACE_SELECT = `
  SELECT w.*, m.role, (SELECT COUNT(*) FROM teams t WHERE t.workspace = w.key AND ${SEES_TEAM("m.user_id", "t")}) AS team_count
  FROM workspaces w JOIN workspace_members m ON m.workspace = w.key AND m.user_id = ? AND m.suspended_at IS NULL`;

const workspaceFor = (userId: number, key: string) =>
  toWorkspace(db.query<WorkspaceRow, [number, string]>(`${WORKSPACE_SELECT} WHERE w.key = ?`).get(userId, key)!);

export function listWorkspaces(a: Actor): Workspace[] {
  return db
    .query<WorkspaceRow, [number]>(`${WORKSPACE_SELECT} ORDER BY w.name COLLATE NOCASE, w.key`)
    .all(a.id)
    .filter((w) => a.workspaces.has(w.key))
    .map(toWorkspace);
}

/** A new workspace with its first admin, known there as `profile`. */
function insertWorkspace(input: WorkspaceInput, adminId: number, profile: { username?: unknown; name?: unknown }): string {
  const name = requireText(input.name, "workspace name");
  // Keys are the first segment of app URLs (/acme/issue/BRD-1), so the app's own paths can't be one.
  const given = typeof input.key === "string" ? input.key.trim().toLowerCase() : undefined;
  if (given && RESERVED_WORKSPACE_KEYS.includes(given)) throw new AppError(`Workspace key "${given}" is reserved`);
  const taken = (k: string) => RESERVED_WORKSPACE_KEYS.includes(k) || exists("workspaces", "key", k);
  const key = pickSlug(input.key, name, taken, { label: "workspace key", fallback: "workspace" });
  const time = now();
  db.query("INSERT INTO workspaces (key, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(key, name, time, time);
  addMember(key, adminId, "admin", profile, time);
  return key;
}

/** A new workspace, where you start as your default profile. */
export function createWorkspace(a: Actor, input: WorkspaceInput): Workspace {
  // Only people have sessions; a key couldn't reach the new workspace anyway.
  if (a.sessionId === null) throw new AppError("Sign in to the web app to create a workspace; API keys work in one workspace", 403);
  const key = db.transaction(() => insertWorkspace(input, a.id, profileOf(a.id)))();
  changed("workspace", key, key);
  return workspaceFor(a.id, key);
}

export function updateWorkspace(a: Actor, workspace: unknown, patch: WorkspacePatch): Workspace {
  const key = requireAdmin(a, workspace);
  if (patch.name !== undefined) {
    db.query("UPDATE workspaces SET name = ?, updated_at = ? WHERE key = ?").run(requireText(patch.name, "name"), now(), key);
  }
  changed("workspace", key, key);
  return workspaceFor(a.id, key);
}

interface MemberRow {
  id: number;
  kind: UserKind;
  username: string;
  name: string;
  email: string | null;
  role: Role;
  joined_at: string;
  suspended_at: string | null;
  integration: number;
}

const MEMBER_SELECT = `
  SELECT m.user_id AS id, u.kind, m.username, m.name, u.email, m.role, m.created_at AS joined_at, m.suspended_at,
    ${isIntegration("m.user_id")} AS integration
  FROM workspace_members m JOIN users u ON u.id = m.user_id`;

const toMember = (row: MemberRow, teams: Map<number, string[]>): WorkspaceMember => ({
  user: toRef(row),
  email: row.email,
  role: row.role,
  joinedAt: row.joined_at,
  suspendedAt: row.suspended_at,
  integration: row.integration === 1,
  teams: teams.get(row.id) ?? [],
});

/** Everyone's teams in `workspace`, by key: only the teams `a` sees. */
function memberTeams(a: Actor, workspace: string): Map<number, string[]> {
  const byMember = new Map<number, string[]>();
  const rows = db
    .query<{ user_id: number; key: string }, [string]>(
      `SELECT tm.user_id, t.key FROM team_members tm JOIN teams t ON t.id = tm.team_id
       WHERE t.workspace = ? AND t.id IN (${visibleTeamIds(a, workspace).join(", ") || "NULL"}) ORDER BY t.key`,
    )
    .all(workspace);
  for (const r of rows) byMember.set(r.user_id, [...(byMember.get(r.user_id) ?? []), r.key]);
  return byMember;
}

const memberFor = (a: Actor, workspace: string, username: string) => toMember(memberRow(workspace, username), memberTeams(a, workspace));

function memberRow(workspace: string, username: unknown): MemberRow {
  const row =
    typeof username === "string"
      ? db
          .query<MemberRow, [string, string]>(`${MEMBER_SELECT} WHERE m.workspace = ? AND m.username = ?`)
          .get(workspace, username.trim().toLowerCase())
      : null;
  if (!row) throw new AppError(`${username} isn't a member of this workspace`, 404);
  return row;
}

/**
 * The workspace's people, then agents. A guest sees only those who share a team with them: who see a team they're in
 * (themselves included), so nobody else in the workspace shows.
 */
export function listMembers(a: Actor, workspace: unknown): WorkspaceMember[] {
  const key = requireMember(a, workspace);
  const shares = `EXISTS (SELECT 1 FROM team_members g JOIN teams t ON t.id = g.team_id WHERE g.user_id = ${a.id} AND t.workspace = m.workspace
    AND ${SEES_TEAM("m.user_id", "t")})`;
  const teams = memberTeams(a, key);
  return db
    .query<MemberRow, [string]>(`${MEMBER_SELECT} WHERE m.workspace = ?${isGuest(a, key) ? ` AND ${shares}` : ""} ORDER BY u.kind DESC, m.name COLLATE NOCASE`)
    .all(key)
    .map((row) => toMember(row, teams));
}

/**
 * Every team of the workspace, for an admin to find one to join (Linear's admins see private teams in settings): its
 * key, name, whether it's private, whether you're in it, and how many active members it has. Nothing inside it.
 */
export function listTeamListings(a: Actor, workspace: unknown): TeamListing[] {
  const key = requireAdminSession(a, workspace);
  type Row = { key: string; name: string; private: number; member: number; members: number };
  return db
    .query<Row, [string, number]>(
      `SELECT t.key, t.name, t.private, EXISTS (SELECT 1 FROM team_members WHERE team_id = t.id AND user_id = ?2) AS member,
         (SELECT COUNT(*) FROM team_members tm JOIN workspace_members m ON m.user_id = tm.user_id AND m.workspace = t.workspace AND m.suspended_at IS NULL
          WHERE tm.team_id = t.id) AS members
       FROM teams t WHERE t.workspace = ?1 ORDER BY t.key`,
    )
    .all(key, a.id)
    .map((t) => ({ key: t.key, name: t.name, private: t.private === 1, member: t.member === 1, memberCount: t.members }));
}

const activeAdmins = (workspace: string) =>
  db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace = ? AND role = 'admin' AND suspended_at IS NULL")
    .get(workspace)!.n;

/**
 * Suspends a membership. Access to this workspace ends at once (membership is checked on every request,
 * and their sockets reconnect without it), and their keys here die: API keys, agent token, chat keys.
 * If it was their last active membership, their sessions and unused sign-in codes go too, so reinstating
 * gives a clean account that signs in again. Other workspaces' keys are never touched, so one workspace's
 * admin can't cut anyone off from the others.
 */
function suspend(key: string, row: MemberRow) {
  setSuspended(key, row.id, row.suspended_at ?? now());
  db.query("DELETE FROM api_keys WHERE user_id = ? AND workspace = ?").run(row.id, key);
  const active = db.query("SELECT 1 FROM workspace_members WHERE user_id = ? AND suspended_at IS NULL LIMIT 1").get(row.id);
  if (!active) {
    db.query("DELETE FROM sessions WHERE user_id = ?").run(row.id);
    db.query("DELETE FROM codes WHERE user_id = ? AND used_at IS NULL").run(row.id);
  }
  revoked({ userId: row.id });
}

export function updateMember(a: Actor, workspace: unknown, username: unknown, patch: { role?: unknown; suspended?: unknown }): WorkspaceMember {
  const key = requireAdminSession(a, workspace);
  const row = memberRow(key, username);
  if (row.integration) throw new AppError(INTEGRATION_MANAGED);
  const role = patch.role === undefined ? row.role : checkOneOf(patch.role, PERSON_ROLES, "role");
  if (row.kind === "agent" && patch.role !== undefined) throw new AppError("Agents have no role to change");
  if (patch.suspended !== undefined && typeof patch.suspended !== "boolean") throw new AppError("suspended must be true or false");
  const suspending = patch.suspended === true && !row.suspended_at;
  const reinstating = patch.suspended === false && !!row.suspended_at;
  const losesAdmin = row.role === "admin" && !row.suspended_at && (suspending || role !== "admin");
  db.transaction(() => {
    if (losesAdmin && activeAdmins(key) === 1) throw new AppError("Add another admin first", 409);
    if (role !== row.role) db.query("UPDATE workspace_members SET role = ? WHERE workspace = ? AND user_id = ?").run(role, key, row.id);
    // Invites an admin made die with their admin rights, so no one can pre-mint a way back in.
    if (losesAdmin) db.query("DELETE FROM codes WHERE created_by = ? AND workspace = ? AND used_at IS NULL").run(row.id, key);
    if (suspending) suspend(key, row);
    if (reinstating) setSuspended(key, row.id, null);
  }).immediate();
  if (role !== row.role) revoked({ userId: row.id }); // a guest sees other teams than a member: sockets reconnect with what's current
  changed("member", key, row.username);
  return memberFor(a, key, row.username);
}

// --- Agents ---

/**
 * Adds an agent to a workspace: its own account (kind "agent") with this one membership, and a token, shown
 * once. Its username need only be free here: two workspaces can each have their own @claude.
 */
export function createAgent(a: Actor, workspace: unknown, input: { name?: unknown; username?: unknown }) {
  const key = requireAdminSession(a, workspace);
  const { agent, token } = db.transaction(() => {
    const id = insertAccount("agent");
    addMember(key, id, "agent", input);
    const { token } = insertApiKey(id, key, "agent token", "write");
    return { agent: profileOf(id, key), token };
  })();
  changed("member", key, agent.username);
  return { agent, token };
}

function agentRow(a: Actor, workspace: unknown, username: unknown): { key: string; row: MemberRow } {
  const key = requireAdminSession(a, workspace);
  const row = memberRow(key, username);
  if (row.kind !== "agent") throw new AppError(`${row.username} isn't an agent`, 404);
  if (row.integration) throw new AppError(INTEGRATION_MANAGED);
  return { key, row };
}

/** A new token for an agent; its old ones in this workspace stop working. Reinstates a removed agent. */
export function rotateAgentToken(a: Actor, workspace: unknown, username: unknown): { token: string } {
  const { key, row } = agentRow(a, workspace, username);
  const token = db.transaction(() => {
    db.query("DELETE FROM api_keys WHERE user_id = ? AND workspace = ?").run(row.id, key);
    setSuspended(key, row.id, null);
    return insertApiKey(row.id, key, "agent token", "write").token;
  })();
  revoked({ userId: row.id });
  changed("member", key, row.username);
  return { token };
}

/** Removes an agent: suspending it, so its token dies and it leaves the workspace; its history keeps its name. */
export function removeAgent(a: Actor, workspace: unknown, username: unknown) {
  const { key, row } = agentRow(a, workspace, username);
  db.transaction(() => suspend(key, row))();
  changed("member", key, row.username);
}

// --- Integrations: the GitHub integration's agent account ---

/** SQL: whether the account with id `column` is an integration's (GitHub's). */
function isIntegration(column: string) {
  return `EXISTS (SELECT 1 FROM github_integrations g WHERE g.user_id = ${column})`;
}

const INTEGRATION_MANAGED = "This is the GitHub integration's account: connect or disconnect GitHub in workspace settings";

/**
 * The account an integration acts as in `workspace`: `userId`'s membership reinstated, else a new agent account with
 * this one membership, as `username` (deduped in the workspace: github-2, github-3…) and `name`. It never gets a key.
 */
export function ensureIntegrationAgent(workspace: string, username: string, name: string, userId?: number): number {
  if (userId !== undefined) {
    setSuspended(workspace, userId, null);
    return userId;
  }
  const taken = (u: string) => !!db.query("SELECT 1 FROM workspace_members WHERE workspace = ? AND username = ?").get(workspace, u);
  let free = username;
  for (let n = 2; taken(free); n++) free = `${username}-${n}`;
  const id = insertAccount("agent");
  addMember(workspace, id, "agent", { username: free, name });
  return id;
}

/** Disconnecting suspends the integration's account: it can't act, and history keeps its name. */
export function suspendIntegrationAgent(workspace: string, userId: number) {
  setSuspended(workspace, userId, now());
  revoked({ userId });
}

/** The actor an integration's changes are made as: its account, writing, in `workspace` only, with no session or key. */
export function integrationActor(userId: number, workspace: string): Actor {
  return actorFor(db.query<AccountRow, [number]>("SELECT * FROM users WHERE id = ?").get(userId)!, { scope: "write" }, workspace);
}

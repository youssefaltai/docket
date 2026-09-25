// Identity and access: accounts (people and agents), sessions, API keys, one-time codes (setup, invites,
// sign-in links), and workspace membership. Every request acts as an Actor built here.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  API_KEY_SCOPES,
  type ApiKey,
  type ApiKeyScope,
  type CodeInfo,
  type Me,
  type Role,
  type Session,
  type SetupInput,
  type User,
  type UserKind,
  type UserRef,
  type Workspace,
  type WorkspaceInput,
  type WorkspaceMember,
  type WorkspacePatch,
} from "../shared/types.ts";
import { AppError, changed, checkOneOf, db, exists, now, pickSlug, requireText } from "./db.ts";

/** Who a request acts as. Built fresh per request, so role and suspension changes apply at once. */
export interface Actor {
  id: number;
  renewCookie?: boolean; // a session in use: re-send its cookie so the browser's copy slides with the idle window
  username: string;
  kind: UserKind;
  workspaces: Map<string, Role>; // active memberships
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

// --- Users ---

interface UserRow {
  id: number;
  kind: UserKind;
  username: string;
  name: string;
  email: string | null;
  created_at: string;
}

const toRef = (row: { username: string; name: string; kind: UserKind }): UserRef => ({
  username: row.username,
  name: row.name,
  kind: row.kind,
});

const toUser = (row: UserRow): User => ({ ...toRef(row), email: row.email, createdAt: row.created_at });
const userById = (id: number) => db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ?").get(id)!;

// "me" means the caller wherever a username is taken.
const RESERVED = ["me"];

function checkUsername(value: unknown): string {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(username)) {
    throw new AppError('username must be 2–32 characters of a-z, 0-9, ".", "_" and "-", starting with a letter or digit');
  }
  if (RESERVED.includes(username)) throw new AppError(`"${username}" is reserved`);
  if (exists("users", "username", username)) throw new AppError(`Username "${username}" is taken`, 409);
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

function userRow(username: unknown): UserRow {
  const row =
    typeof username === "string"
      ? db.query<UserRow, [string]>("SELECT * FROM users WHERE username = ?").get(username.trim().toLowerCase())
      : null;
  if (!row) throw new AppError(`User ${username} not found`, 404);
  return row;
}

function insertUser(kind: UserKind, input: { username?: unknown; name?: unknown; email?: unknown }): number {
  const username = checkUsername(input.username);
  const name = checkName(input.name);
  const email = kind === "person" ? checkEmail(input.email) : null;
  return db
    .query<{ id: number }, [UserKind, string, string, string | null, string]>(
      "INSERT INTO users (kind, username, name, email, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .get(kind, username, name, email, now())!.id;
}

const PERSON_ROLES = ["admin", "member"] as const;

const addMember = (workspace: string, userId: number, role: Role, time = now()) =>
  db.query("INSERT INTO workspace_members (workspace, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(workspace, userId, role, time);

const setSuspended = (workspace: string, userId: number, at: string | null) =>
  db.query("UPDATE workspace_members SET suspended_at = ? WHERE workspace = ? AND user_id = ?").run(at, workspace, userId);

export function me(a: Actor): Me {
  const workspaces = db
    .query<{ key: string; name: string; role: Role }, [number]>(
      `SELECT w.key, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.key = m.workspace
       WHERE m.user_id = ? AND m.suspended_at IS NULL ORDER BY w.name COLLATE NOCASE`,
    )
    .all(a.id);
  const credential = a.sessionId !== null ? "session" : a.chat ? "chat" : "key";
  return { user: { ...toUser(userById(a.id)), id: a.id }, workspaces, credential, chat: !!process.env.CHAT_URL };
}

export function updateMe(a: Actor, patch: { name?: unknown; username?: unknown; email?: unknown }): Me {
  requireSession(a);
  const row = userById(a.id);
  const username =
    patch.username === undefined || String(patch.username).trim().toLowerCase() === row.username
      ? row.username
      : checkUsername(patch.username);
  const name = patch.name === undefined ? row.name : checkName(patch.name);
  const email = patch.email === undefined ? row.email : checkEmail(patch.email, a.id);
  db.query("UPDATE users SET username = ?, name = ?, email = ? WHERE id = ?").run(username, name, email, a.id);
  for (const workspace of a.workspaces.keys()) changed("member", workspace, username);
  return me(a);
}

// --- Actors ---

function actorFor(user: UserRow, credential: { scope: ApiKeyScope; sessionId?: number; keyId?: number }): Actor {
  const memberships = db
    .query<{ workspace: string; role: Role }, [number]>(
      "SELECT workspace, role FROM workspace_members WHERE user_id = ? AND suspended_at IS NULL",
    )
    .all(user.id);
  return {
    id: user.id,
    username: user.username,
    kind: user.kind,
    workspaces: new Map(memberships.map((m) => [m.workspace, m.role])),
    scope: credential.scope,
    sessionId: credential.sessionId ?? null,
    keyId: credential.keyId ?? null,
  };
}

/** The actor behind a session cookie, or null if it's unknown or idle for 30 days. */
export function sessionActor(token: string): Actor | null {
  const row = db
    .query<UserRow & { session_id: number; last_seen_at: string }, [string]>(
      `SELECT u.*, s.id AS session_id, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
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

/** The actor behind an API key (`dk_…`), or null if it's unknown, revoked or expired. */
export function keyActor(token: string): Actor | null {
  const row = db
    .query<UserRow & { key_id: number; scope: ApiKeyScope; last_used_at: string | null; session_id: number | null }, [string, string]>(
      `SELECT u.*, k.id AS key_id, k.scope, k.last_used_at, k.session_id FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.token_hash = ? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)`,
    )
    .get(hash(token), now());
  if (!row) return null;
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > TOUCH_MS) {
    db.query("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), row.key_id);
  }
  return { ...actorFor(row, { scope: row.scope, keyId: row.key_id }), chat: row.session_id !== null };
}

// --- Access checks (used by every data module) ---

/** The workspace key if the actor is an active member; otherwise 404, so its existence doesn't leak. */
export function requireMember(a: Actor, workspace: unknown): string {
  const key = typeof workspace === "string" ? workspace.trim().toLowerCase() : "";
  if (!a.workspaces.has(key)) throw new AppError(`Workspace ${workspace} not found`, 404);
  return key;
}

function requireAdmin(a: Actor, workspace: unknown): string {
  const key = requireMember(a, workspace);
  if (a.workspaces.get(key) !== "admin") throw new AppError("Only workspace admins can do that", 403);
  return key;
}

function requirePerson(a: Actor) {
  if (a.kind !== "person") throw new AppError("Only people can do that", 403);
}

/**
 * Managing access (keys, sessions, codes, invites, members, agents, your profile) takes a signed-in
 * session: an API key that could mint credentials would outlive its own revocation.
 */
function requireSession(a: Actor) {
  if (a.sessionId === null) throw new AppError("Sign in to the web app to manage access; API keys can't", 403);
}

/** Managing a workspace's members, invites and agents: an admin, signed in. */
function requireAdminSession(a: Actor, workspace: unknown): string {
  requireSession(a);
  return requireAdmin(a, workspace);
}

/**
 * The user id for a username (or "me") who is an active member of `workspace` of the given kind:
 * assignees are people, delegates are agents.
 */
export function activeMemberId(a: Actor, workspace: string, value: string, kind: UserKind, field: string): number {
  const username = value.trim().toLowerCase() === "me" ? a.username : value.trim().toLowerCase();
  const row = db
    .query<{ id: number; kind: UserKind }, [string, string]>(
      `SELECT u.id, u.kind FROM users u JOIN workspace_members m ON m.user_id = u.id
       WHERE u.username = ? AND m.workspace = ? AND m.suspended_at IS NULL`,
    )
    .get(username, workspace);
  if (!row) throw new AppError(`${field}: ${username} isn't an active member of this workspace`);
  if (row.kind !== kind) {
    throw new AppError(kind === "person" ? `${field}: ${username} is an agent; set it as the delegate` : `${field}: ${username} isn't an agent`);
  }
  return row.id;
}

// --- Setup (first run) ---

/** The first-run setup code: DOCKET_SETUP_CODE if set, else random; only usable while there are no users. */
export const setupCode = normalizeCode(process.env.DOCKET_SETUP_CODE || newCode());
export const needsSetup = () => db.query("SELECT 1 FROM users LIMIT 1").get() === null;

/** Creates the first account (admin of a new workspace) and signs it in. */
export function setup(input: SetupInput, client: Client): { user: User; workspace: Workspace; token: string } {
  if (!needsSetup()) throw new AppError("Docket is already set up", 409);
  const given = normalizeCode(typeof input.code === "string" ? input.code : "");
  const a = Buffer.from(hash(given));
  const b = Buffer.from(hash(setupCode));
  if (!timingSafeEqual(a, b)) throw new AppError("Wrong setup code", 403);
  return db.transaction(() => {
    const userId = insertUser("person", input);
    const key = insertWorkspace(input.workspace ?? {}, userId);
    const token = startSession(userId, client);
    const user = toUser(userById(userId));
    const workspace = workspaceFor(userId, key);
    return { user, workspace, token };
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
  created_at: string;
  last_used_at: string | null;
}

const toApiKey = (row: ApiKeyRow): ApiKey => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

function insertApiKey(userId: number, name: string, scope: ApiKeyScope): { apiKey: ApiKey; token: string } {
  const token = `dk_${randomBytes(32).toString("hex")}`;
  const row = db
    .query<ApiKeyRow, [number, string, ApiKeyScope, string, string]>(
      `INSERT INTO api_keys (user_id, name, scope, token_hash, created_at) VALUES (?, ?, ?, ?, ?)
       RETURNING id, name, scope, created_at, last_used_at`,
    )
    .get(userId, name, scope, hash(token), now())!;
  return { apiKey: toApiKey(row), token };
}

export function listApiKeys(a: Actor): ApiKey[] {
  requireSession(a);
  return db
    .query<ApiKeyRow, [number]>(
      "SELECT id, name, scope, created_at, last_used_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL AND session_id IS NULL ORDER BY id",
    )
    .all(a.id)
    .map(toApiKey);
}

export function createApiKey(a: Actor, input: { name?: unknown; scope?: unknown }) {
  requireSession(a);
  const name = requireText(input.name, "name");
  const scope = input.scope === undefined ? "write" : checkOneOf(input.scope, API_KEY_SCOPES, "scope");
  return insertApiKey(a.id, name, scope);
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
// Tokens are stored only hashed, so the one in use lives here, by session; a restart just mints another.
const chatKeys = new Map<number, { token: string; expiresAt: number }>();

/** Deletes keys past their expiry (and forgets chat keys for sessions that are gone). */
export function purgeExpiredKeys() {
  db.query("DELETE FROM api_keys WHERE expires_at <= ?").run(now());
  for (const [sessionId, held] of chatKeys) if (held.expiresAt <= Date.now()) chatKeys.delete(sessionId);
}
purgeExpiredKeys();

/**
 * A read key for the chat service, bound to this browser session: reused while it has most of its life left
 * (so a long answer never outlives it), then replaced. It dies with the session: sign-out, revoke, suspension.
 */
export function chatKey(a: Actor): string {
  if (a.sessionId === null) throw new AppError("The assistant works from the web app, not with an API key", 403);
  const held = chatKeys.get(a.sessionId);
  if (held && held.expiresAt - Date.now() > (CHAT_KEY_TTL_MS * 2) / 3) {
    // Still ours? Session ids can be reused after a delete, and the key goes with its session.
    const live = db
      .query("SELECT 1 FROM api_keys WHERE token_hash = ? AND session_id = ? AND user_id = ? AND expires_at > ?")
      .get(hash(held.token), a.sessionId, a.id, now());
    if (live) return held.token;
  }
  purgeExpiredKeys();
  const token = `dk_${randomBytes(32).toString("hex")}`;
  const expiresAt = Date.now() + CHAT_KEY_TTL_MS;
  db.query(
    "INSERT INTO api_keys (user_id, name, scope, token_hash, created_at, expires_at, session_id) VALUES (?, 'Chat (automatic)', 'read', ?, ?, ?, ?)",
  ).run(a.id, hash(token), now(), new Date(expiresAt).toISOString(), a.sessionId);
  chatKeys.set(a.sessionId, { token, expiresAt });
  return token;
}

/** Revokes every session, key and unused sign-in code of a user. */
function signOutEverywhere(userId: number) {
  db.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.query("DELETE FROM codes WHERE user_id = ? AND used_at IS NULL").run(userId);
  db.query("DELETE FROM api_keys WHERE user_id = ?").run(userId);
  revoked({ userId });
}

// --- One-time codes: invites and sign-in links ---

interface CodeRow {
  id: number;
  purpose: CodeInfo["kind"];
  user_id: number | null;
  workspace: string | null;
  role: Role | null;
  expires_at: string;
  used_at: string | null;
}

function issueCode(fields: { purpose: CodeInfo["kind"]; userId?: number; workspace?: string; role?: Role; by?: number }) {
  const code = newCode();
  const time = Date.now();
  const expiresAt = new Date(time + CODE_TTL_MS).toISOString();
  db.query(
    `INSERT INTO codes (code_hash, purpose, user_id, workspace, role, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hash(normalizeCode(code)),
    fields.purpose,
    fields.userId ?? null,
    fields.workspace ?? null,
    fields.role ?? null,
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

/** `signedIn`: the user whose session came with the request, if any (an invite joins them). */
/** Who's signed in on the request redeeming or peeking a code: their account and this session. */
export type SignedIn = { userId: number; sessionId: number } | null;

export function peekCode(code: unknown, signedIn: SignedIn): CodeInfo {
  const row = codeRow(code);
  const workspace = row.workspace
    ? db.query<{ name: string }, [string]>("SELECT name FROM workspaces WHERE key = ?").get(row.workspace)?.name ?? null
    : null;
  const username = row.user_id ? db.query<{ username: string }, [number]>("SELECT username FROM users WHERE id = ?").get(row.user_id)!.username : null;
  const invite = row.purpose === "invite";
  // Who's signed in: an invite would add that account, a sign-in link for someone else would replace it,
  // so the page asks first either way.
  const you = signedIn ? toRef(userById(signedIn.userId)) : null;
  return { kind: row.purpose, workspace, username, you, needsProfile: invite && signedIn === null };
}

/**
 * Uses a code and signs in. A sign-in link opens the account it was made for; if this browser was signed
 * in as someone else, that session ends, so no tab keeps acting as them. An invite is a code the admin
 * hands over, never tied to an email: redeemed while signed in, it adds you to the workspace; signed
 * out, it creates a new account from `profile`.
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
      userId = signedIn?.userId ?? insertUser("person", profile);
      const member = db
        .query<{ suspended_at: string | null }, [string, number]>(
          "SELECT suspended_at FROM workspace_members WHERE workspace = ? AND user_id = ?",
        )
        .get(row.workspace!, userId);
      if (member?.suspended_at) throw new AppError("You were suspended from this workspace; ask an admin to reinstate you", 403);
      if (!member) addMember(row.workspace!, userId, row.role!);
    }
    db.query("UPDATE codes SET used_at = ? WHERE id = ?").run(now(), row.id);
    const user = userById(userId!);
    if (row.workspace) changed("member", row.workspace, user.username);
    return { user: toUser(user), token: startSession(user.id, client) };
  }).immediate();
}

/** A sign-in link for yourself, to sign in on another device. */
export function selfSignInLink(a: Actor) {
  requireSession(a);
  return issueCode({ purpose: "sign-in", userId: a.id, by: a.id });
}

/** For `bun run sign-in-link <username>` on the server: shell access is the proof, so there's no HTTP route. */
export function recoverySignInLink(username: string) {
  const user = userRow(username);
  if (user.kind !== "person") throw new AppError("Agents sign in with their token, not a link");
  return issueCode({ purpose: "sign-in", userId: user.id });
}

/** An invite: a one-time code the admin hands to someone, who joins with it (new account or existing). */
export function invite(a: Actor, workspace: unknown, input: { role?: unknown }) {
  const key = requireAdminSession(a, workspace);
  const role = checkOneOf(input.role ?? "member", PERSON_ROLES, "role");
  return issueCode({ purpose: "invite", workspace: key, role, by: a.id });
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
  SELECT w.*, m.role, (SELECT COUNT(*) FROM teams WHERE workspace = w.key) AS team_count
  FROM workspaces w JOIN workspace_members m ON m.workspace = w.key AND m.user_id = ? AND m.suspended_at IS NULL`;

const workspaceFor = (userId: number, key: string) =>
  toWorkspace(db.query<WorkspaceRow, [number, string]>(`${WORKSPACE_SELECT} WHERE w.key = ?`).get(userId, key)!);

export function listWorkspaces(a: Actor): Workspace[] {
  return db
    .query<WorkspaceRow, [number]>(`${WORKSPACE_SELECT} ORDER BY w.name COLLATE NOCASE, w.key`)
    .all(a.id)
    .map(toWorkspace);
}

function insertWorkspace(input: WorkspaceInput, adminId: number): string {
  const name = requireText(input.name, "workspace name");
  const key = pickSlug(input.key, name, (k) => exists("workspaces", "key", k), { label: "workspace key", fallback: "workspace" });
  const time = now();
  db.query("INSERT INTO workspaces (key, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(key, name, time, time);
  addMember(key, adminId, "admin", time);
  return key;
}

export function createWorkspace(a: Actor, input: WorkspaceInput): Workspace {
  requirePerson(a);
  const key = db.transaction(() => insertWorkspace(input, a.id))();
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

interface MemberRow extends UserRow {
  role: Role;
  joined_at: string;
  suspended_at: string | null;
}

const MEMBER_SELECT = `
  SELECT u.*, m.role, m.created_at AS joined_at, m.suspended_at
  FROM workspace_members m JOIN users u ON u.id = m.user_id`;

const toMember = (row: MemberRow): WorkspaceMember => ({
  user: toRef(row),
  email: row.email,
  role: row.role,
  joinedAt: row.joined_at,
  suspendedAt: row.suspended_at,
});

function memberRow(workspace: string, username: unknown): MemberRow {
  const row =
    typeof username === "string"
      ? db
          .query<MemberRow, [string, string]>(`${MEMBER_SELECT} WHERE m.workspace = ? AND u.username = ?`)
          .get(workspace, username.trim().toLowerCase())
      : null;
  if (!row) throw new AppError(`${username} isn't a member of this workspace`, 404);
  return row;
}

export function listMembers(a: Actor, workspace: unknown): WorkspaceMember[] {
  const key = requireMember(a, workspace);
  return db
    .query<MemberRow, [string]>(`${MEMBER_SELECT} WHERE m.workspace = ? ORDER BY u.kind DESC, u.name COLLATE NOCASE`)
    .all(key)
    .map(toMember);
}

const activeAdmins = (workspace: string) =>
  db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace = ? AND role = 'admin' AND suspended_at IS NULL")
    .get(workspace)!.n;

/** Suspends a membership; if it was the user's last active one, their sessions and keys go too. */
/**
 * Suspends a membership. Access to this workspace ends at once (membership is checked on every request,
 * and their sockets reconnect without it). If it was their last active membership, their credentials
 * go too (sessions, API keys, unused codes), so reinstating gives a clean account that signs in again.
 * While they're active elsewhere their credentials stay: otherwise any admin of any workspace they
 * joined could sign them out of the others and kill their keys there.
 */
function suspend(key: string, row: MemberRow) {
  setSuspended(key, row.id, now());
  const elsewhere = db.query("SELECT 1 FROM workspace_members WHERE user_id = ? AND suspended_at IS NULL LIMIT 1").get(row.id);
  if (elsewhere) revoked({ userId: row.id });
  else signOutEverywhere(row.id);
}

export function updateMember(a: Actor, workspace: unknown, username: unknown, patch: { role?: unknown; suspended?: unknown }): WorkspaceMember {
  const key = requireAdminSession(a, workspace);
  const row = memberRow(key, username);
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
  changed("member", key, row.username);
  return toMember(memberRow(key, row.username));
}

// --- Agents ---

/** Adds an agent to a workspace: its own account (kind "agent") and a token, shown once. */
export function createAgent(a: Actor, workspace: unknown, input: { name?: unknown; username?: unknown }) {
  const key = requireAdminSession(a, workspace);
  const { agent, token } = db.transaction(() => {
    const id = insertUser("agent", input);
    addMember(key, id, "agent");
    const { token } = insertApiKey(id, "agent token", "write");
    return { agent: toRef(userById(id)), token };
  })();
  changed("member", key, agent.username);
  return { agent, token };
}

function agentRow(a: Actor, workspace: unknown, username: unknown): { key: string; row: MemberRow } {
  const key = requireAdminSession(a, workspace);
  const row = memberRow(key, username);
  if (row.kind !== "agent") throw new AppError(`${row.username} isn't an agent`, 404);
  return { key, row };
}

/** A new token for an agent; the old one stops working. Reinstates a removed agent. */
export function rotateAgentToken(a: Actor, workspace: unknown, username: unknown): { token: string } {
  const { key, row } = agentRow(a, workspace, username);
  const token = db.transaction(() => {
    signOutEverywhere(row.id);
    setSuspended(key, row.id, null);
    return insertApiKey(row.id, "agent token", "write").token;
  })();
  changed("member", key, row.username);
  return { token };
}

/** Removes an agent: its token dies and it leaves the workspace; its history keeps its name. */
export function removeAgent(a: Actor, workspace: unknown, username: unknown) {
  const { key, row } = agentRow(a, workspace, username);
  db.transaction(() => {
    setSuspended(key, row.id, row.suspended_at ?? now());
    signOutEverywhere(row.id);
  })();
  changed("member", key, row.username);
}

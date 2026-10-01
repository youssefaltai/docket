// The SQLite connection (its schema is in schema.ts), change events and the validation helpers the data modules share.
import { marked, type Token } from "marked";
import { migrate } from "./schema.ts";
import type { Store } from "./store.ts";
import { MENTION_PATTERN, mentionOf, type ServerEvent } from "../shared/types.ts";

/** An error with an HTTP status; REST returns it as `{ error }`, MCP as a tool error. */
export class AppError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// --- Connection and schema ---

/** The database, once `open` has run: on Bun a SQLite file (local.ts), on Workers the Durable Object's (src/worker). */
export let db: Store;

/** Brings `store`'s schema up to date and makes it the database. `durable`: a Durable Object's (see migrate). */
export function open(store: Store, durable = false) {
  migrate(store, undefined, durable);
  db = store;
}

// --- Change events ---

let listener: (event: ServerEvent, to?: number | string) => void = () => {};

/**
 * Called after every committed mutation: the server sends it over /ws to the workspace's members, or with `to` only
 * to a user's sockets in the workspace (a user id: an inbox, a subscription) or to those who see a team (its key:
 * for a change whose own row is gone, like a deleted label's). Who hears it is decided when this is called, so a change
 * that takes someone's access away (removeTeamMember) calls it first.
 */
export function onChange(fn: typeof listener) {
  listener = fn;
}

export function changed(entity: ServerEvent["entity"], workspace: string, id: string, to?: number | string) {
  listener({ type: "changed", entity, workspace, id }, to);
}

// --- Docket's own account ---

/**
 * Docket itself (`users.system = 1`): what its automated changes (auto-close) are attributed to. It has no
 * membership, so this is how it's known in every workspace, and its username is reserved in all of them.
 */
export const SYSTEM_USER = { username: "docket", name: "Docket" } as const;

/** SQL for how a user is known: their membership's `field` (alias `m`), else Docket's own for the system account (alias `u`). */
export const knownAs = (m: string, u: string, field: keyof typeof SYSTEM_USER) =>
  `COALESCE(${m}.${field}, CASE WHEN ${u}.system = 1 THEN '${SYSTEM_USER[field]}' END)`;

// --- Validation ---

export const now = () => new Date().toISOString();

/**
 * updated_at doubles as a version token (baseUpdatedAt), so every change moves it strictly forward, even
 * within a millisecond. One rule, two forms that must agree: `bumpedAt(prev)` for a value computed in JS,
 * and `BUMPED_AT`, a SET clause for rows bumped in SQL (bind the current time to both `?`).
 */
export const bumpedAt = (prev: string, time = now()) => (time > prev ? time : new Date(Date.parse(prev) + 1).toISOString());
export const BUMPED_AT = "updated_at = CASE WHEN updated_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') ELSE ? END";

export const exists = (table: string, column: string, value: string) => db.query(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(value) !== null;

/** The longest text a field takes, in characters (a huge comment would freeze every viewer's page). */
const MAX_LENGTH: Record<string, number> = { title: 500, name: 200, label: 200, body: 100_000, description: 100_000, content: 500_000 };

export function capLength(text: string, field: string): string {
  const max = MAX_LENGTH[field];
  if (max && text.length > max) throw new AppError(`${field} is too long: at most ${max.toLocaleString("en-US")} characters`);
  return text;
}

export function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError(`${field} is required`);
  return capLength(value.trim(), field);
}

export function optionalText(value: unknown, field: string): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new AppError(`${field} must be a string`);
  return capLength(value.trim(), field);
}

export function checkOneOf<T extends string | number>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new AppError(`Invalid ${field} "${value}". Use one of: ${allowed.join(", ")}`);
  return value as T;
}

/** "Q3 Roadmap: Café!" → "q3-roadmap-cafe"; "" when nothing Latin is left (e.g. an Arabic title). */
export const slugify = (title: string) =>
  title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "");

/**
 * An explicit slug must be valid and free; a derived one is deduped: base, base-2, base-3…
 * or `${fallback}-1`, `${fallback}-2`… when the name has nothing Latin in it.
 */
export function pickSlug(explicit: unknown, name: string, taken: (slug: string) => boolean, { label, fallback }: { label: string; fallback: string }): string {
  if (explicit !== undefined) {
    const slug = typeof explicit === "string" ? explicit.trim().toLowerCase() : "";
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new AppError(`Invalid ${label} "${explicit}": use a-z, 0-9 and single dashes, e.g. "api-design"`);
    if (taken(slug)) throw new AppError(`${label[0]!.toUpperCase()}${label.slice(1)} "${slug}" is already taken`, 409);
    return slug;
  }
  const base = slugify(name);
  for (let n = 1; ; n++) {
    const slug = base ? (n === 1 ? base : `${base}-${n}`) : `${fallback}-${n}`;
    if (!taken(slug)) return slug;
  }
}

// --- Mentions: tracker.ts records them on every save of a text ---

/** The @username candidates in markdown, as the renderer sees them: in prose, never in code or link text. */
function mentionCandidates(text: string): string[] {
  if (!text.includes("@")) return [];
  const found: string[] = [];
  const pattern = new RegExp(MENTION_PATTERN, "giu");
  const inLinks = new Set<Token>(); // walkTokens visits a parent before its children
  marked.walkTokens(marked.lexer(text), (t) => {
    const children = "tokens" in t ? (t.tokens as Token[] | undefined) : undefined;
    if (t.type === "link" || inLinks.has(t)) for (const child of children ?? []) inLinks.add(child);
    else if (t.type === "text" && !children) for (const m of t.raw.matchAll(pattern)) found.push(m[1]!);
  });
  return found;
}

/**
 * Who a text mentions: the ids of active members of `workspace` it names as @username (see MENTION_PATTERN).
 * `typing`: a doc autosaves mid-word, so a mention at the very end of the text doesn't count yet.
 */
export function mentionedIn(workspace: string, text: string, typing = false): Set<number> {
  if (typing) text = text.replace(/@[a-z0-9._-]*$/i, "");
  if (!text.includes("@")) return new Set();
  const members = new Map(
    db
      .query<{ username: string; user_id: number }, [string]>("SELECT username, user_id FROM workspace_members WHERE workspace = ? AND suspended_at IS NULL")
      .all(workspace)
      .map((m) => [m.username, m.user_id]),
  );
  // Parsing markdown is the costly part (a long doc autosaves often): only when some @username is in the text at all.
  const lower = text.toLowerCase();
  if (![...members.keys()].some((u) => lower.includes(`@${u}`))) return new Set();
  return new Set(mentionCandidates(text).map((c) => members.get(mentionOf(c, (u) => members.has(u)) ?? "")).filter((id) => id !== undefined));
}

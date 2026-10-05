// The GitHub integration (the core of Linear's): a workspace's signed incoming webhook links pull requests and commits to
// issues by identifier and moves them along, as the workspace's GitHub agent account, through the normal update path.
// No GitHub App or token: Docket only receives. Admins connect it in a browser session; the secret is shown once.
import type { BunRequest } from "bun";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { GitHubConnection } from "../shared/types.ts";
import * as access from "./access.ts";
import type { Actor } from "./access.ts";
import { hostAllowed, isJson } from "./auth.ts";
import { AppError, changed, db, now } from "./db.ts";
import { MAX_BODY, originOf } from "./http.ts";
import * as tracker from "./tracker.ts";

// --- Connecting (admins, in a browser session) ---

type Row = { workspace: string; user_id: number; secret: string | null };
const integrationOf = (workspace: string) =>
  db.query<Row, [string]>("SELECT workspace, user_id, secret FROM github_integrations WHERE workspace = ?").get(workspace);

const payloadUrl = (req: Request, workspace: string) => `${originOf(req)}/api/github/${workspace}`;

export function connection(a: Actor, workspace: unknown, req: Request): GitHubConnection {
  const key = access.requireIn(a, workspace, "github.manage");
  const row = integrationOf(key);
  return { connected: !!row?.secret, url: payloadUrl(req, key), account: row ? access.profileOf(row.user_id, key) : null };
}

/** Connects GitHub (making or reinstating its account), or issues a new secret: the old one stops at once. */
export function connect(a: Actor, workspace: unknown, req: Request): { url: string; secret: string } {
  const key = access.requireIn(a, workspace, "github.manage");
  const secret = `dkgh_${randomBytes(32).toString("hex")}`;
  const userId = db.transaction(() => {
    const userId = access.ensureIntegrationAgent(key, "github", "GitHub", integrationOf(key)?.user_id);
    db.query(
      `INSERT INTO github_integrations (workspace, user_id, secret, created_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace) DO UPDATE SET secret = excluded.secret`,
    ).run(key, userId, secret, a.id, now());
    return userId;
  }).immediate();
  changed("member", key, access.profileOf(userId, key).username);
  return { url: payloadUrl(req, key), secret };
}

/** Disconnects: deliveries are refused, and the account is suspended (history keeps "GitHub"). */
export function disconnect(a: Actor, workspace: unknown) {
  const key = access.requireIn(a, workspace, "github.manage");
  const row = integrationOf(key);
  if (!row?.secret) throw new AppError("GitHub isn't connected", 409);
  db.transaction(() => {
    db.query("UPDATE github_integrations SET secret = NULL WHERE workspace = ?").run(key);
    access.suspendIntegrationAgent(key, row.user_id);
  })();
  changed("member", key, access.profileOf(row.user_id, key).username);
}

// --- Linking: identifiers in branch names, titles and magic words ---

const ID = "[a-z]{2,5}-\\d+\\b";
const CLOSING = "close[sd]?|closing|fix(?:e[sd]|ing)?|resolve[sd]?|resolving|complete[sd]?|completing|implement(?:s|ed|ing)?";
const CONTRIBUTING = "refs?|references|part\\s+of|related\\s+to|contributes\\s+to|towards|updates";
// A statement: the word, an optional colon, then identifiers separated by ",", "&" or "and": "Fixes DKT-1, DKT-2 and DKT-3".
const statement = (words: string) => new RegExp(`\\b(?:${words})\\s*:?\\s*(${ID}(?:(?:\\s*[,&]\\s*(?:and\\s+)?|\\s+and\\s+)${ID})*)`, "gi");
const CLOSING_STATEMENT = statement(CLOSING);
const CONTRIBUTING_STATEMENT = statement(CONTRIBUTING);
const BRANCH_ID = /(?:^|[/_-])([a-z]{2,5}-\d+)(?=$|[/_-])/gi;
const TITLE_ID = /\b[A-Z]{2,5}-\d+\b/g; // a bare mention in a title: uppercase only, so "utf-8" or "node-18" isn't one
const MAX_REFS = 50; // identifiers taken from one PR or commit

const ids = (text: string, pattern: RegExp, group = 0) => [...text.matchAll(pattern)].map((m) => m[group]!.toUpperCase());
const statementIds = (text: string, pattern: RegExp) => ids(text, pattern, 1).flatMap((list) => list.match(/[a-z]{2,5}-\d+/gi)!.map((id) => id.toUpperCase()));

/**
 * The issues a PR or commit refers to, each closing or contributing: closing from the branch name, a bare mention in
 * the title and a closing word; contributing after a contributing word, which wins over any closing mention.
 */
function references({ branch = "", title = "", text }: { branch?: string; title?: string; text: string }): Map<string, boolean> {
  const contributing = new Set(statementIds(`${title}\n${text}`, CONTRIBUTING_STATEMENT));
  const closing = [...ids(branch, BRANCH_ID, 1), ...ids(title, TITLE_ID), ...statementIds(`${title}\n${text}`, CLOSING_STATEMENT)];
  const refs = new Map<string, boolean>();
  for (const id of [...closing, ...contributing]) if (!refs.has(id) && refs.size < MAX_REFS) refs.set(id, !contributing.has(id));
  return refs;
}

// Payloads are GitHub's, so every field is checked; titles and URLs are stored as plain text, URLs only if http(s).
const text = (value: unknown) => (typeof value === "string" ? value : "");
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 500);
function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

type Result = { linked: string[]; moved: Record<string, string> };

/** Links each referenced live issue; closing links move theirs along on `event` when the link is new or its state or closing changed (not a retitle). */
function apply(a: Actor, refs: Map<string, boolean>, link: Omit<tracker.LinkInput, "closes">, event: "draft" | "open" | "merged" | null, result: Result) {
  for (const [identifier, closes] of refs) {
    const linked = tracker.linkIssue(a, identifier, { ...link, closes });
    if (!linked) continue;
    if (!result.linked.includes(linked.id)) result.linked.push(linked.id);
    if (!closes || !event || !linked.moves) continue;
    const to = tracker.advanceIssue(a, linked.id, event, link.url);
    if (to) result.moved[linked.id] = to;
  }
}

const PR_ACTIONS = ["opened", "reopened", "edited", "ready_for_review", "converted_to_draft", "closed", "synchronize"];

function pullRequest(a: Actor, payload: Record<string, unknown>): Result | { ignored: string } {
  const pr = record(payload.pull_request);
  const url = httpUrl(pr.html_url);
  if (!PR_ACTIONS.includes(text(payload.action)) || !url) return { ignored: `pull_request ${text(payload.action)}`.trim() };
  const state = pr.merged === true ? "merged" : pr.state === "closed" ? "closed" : pr.draft === true ? "draft" : "open";
  const title = oneLine(text(pr.title));
  const refs = references({ branch: text(record(pr.head).ref), title, text: text(pr.body) });
  const number = Number.isSafeInteger(pr.number) ? (pr.number as number) : null;
  const result: Result = { linked: [], moved: {} };
  apply(a, refs, { url, kind: "pull_request", title, number, state }, state === "closed" ? null : state, result);
  return result;
}

/** Commits with a magic word link; on the default branch, closing ones close their issues, once: they're then `merged`, so a replay changes nothing. */
function push(a: Actor, payload: Record<string, unknown>): Result {
  const branch = text(record(payload.repository).default_branch);
  const onDefault = !!branch && payload.ref === `refs/heads/${branch}`;
  const commits = Array.isArray(payload.commits) ? payload.commits.slice(0, 100) : [];
  const result: Result = { linked: [], moved: {} };
  for (const commit of commits.map(record)) {
    const url = httpUrl(commit.url);
    const message = text(commit.message);
    if (!url) continue;
    const refs = references({ text: message });
    apply(a, refs, { url, kind: "commit", title: oneLine(message.split("\n")[0]!), number: null, state: onDefault ? "merged" : null }, onDefault ? "merged" : null, result);
  }
  return result;
}

// --- The webhook: POST /api/github/:workspace (public; the signature is the credential) ---

const json = (data: unknown, status = 200) => Response.json(data, { status });
// Unknown workspace, not connected, or a missing or wrong signature: all the same answer.
const invalid = () => json({ error: "Invalid signature" }, 401);
let decoy: string | undefined; // an unknown workspace takes as long to refuse as a wrong signature

/** Whether `header` is `sha256=` + the hex HMAC-SHA256 of the exact body bytes, compared in constant time. */
function signed(header: string | null, body: Uint8Array, secret: string): boolean {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function receive(req: BunRequest<"/api/github/:workspace">): Promise<Response> {
  if (!hostAllowed(req)) return json({ error: "Host not allowed (see DOCKET_HOSTS)" }, 403);
  if (!isJson(req)) return json({ error: "Set Content type to application/json in GitHub's webhook settings" }, 415);
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > MAX_BODY) return json({ error: "Request body too large (at most 1 MB)" }, 413);
  const row = integrationOf(req.params.workspace);
  const ok = signed(req.headers.get("x-hub-signature-256"), body, row?.secret ?? (decoy ??= randomBytes(32).toString("hex")));
  if (!row?.secret || !ok) return invalid();
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const event = req.headers.get("x-github-event") ?? "";
  try {
    const a = access.integrationActor(row.user_id, row.workspace);
    if (event === "ping") return json({ ok: true });
    if (event === "pull_request") return json(pullRequest(a, record(payload)));
    if (event === "push") return json(push(a, record(payload)));
    return json({ ignored: event });
  } catch (err) {
    if (err instanceof AppError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: "Internal server error" }, 500);
  }
}

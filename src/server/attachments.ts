// Attachments: files people and agents upload to a workspace (screenshots, logs) and link from markdown. The bytes
// live in attachments/<id> next to the database; a row holds the rest. Only the workspace's active members get
// them back (a file uploaded in a team: only those who see the team), as the type Docket sniffed (never the
// uploader's claim), and only raster images display inline.
import type { BunRequest } from "bun";
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_URL, INLINE_IMAGE_TYPES, MAX_UPLOAD_BYTES, type Attachment, type UserKind } from "../shared/types.ts";
import { type Actor, requestWorkspace, SEES_TEAM, seesTeam } from "./access.ts";
import { actorOf } from "./auth.ts";
import { AppError, db, now } from "./db.ts";
import { attachmentsDir } from "./paths.ts";

const dir = attachmentsDir();
mkdirSync(dir, { recursive: true });

interface Row {
  id: string;
  workspace: string;
  name: string;
  content_type: string;
  size: number;
  team_id: number | null;
  team_key: string | null;
  created_at: string;
  username: string;
  uploader_name: string;
  kind: UserKind;
}

// The uploader as they're known in the file's workspace, and the team it was uploaded in.
const SELECT = `SELECT a.*, t.key AS team_key, m.username, m.name AS uploader_name, u.kind FROM attachments a
  JOIN users u ON u.id = a.uploader_id JOIN workspace_members m ON m.user_id = a.uploader_id AND m.workspace = a.workspace
  LEFT JOIN teams t ON t.id = a.team_id`;

// encodeURIComponent leaves ! ' ( ) * alone; parentheses would end a markdown link early.
const encodeName = (name: string) => encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const toAttachment = (r: Row): Attachment => ({
  id: r.id,
  url: `/api/attachments/${r.id}/${encodeName(r.name)}`,
  name: r.name,
  contentType: r.content_type,
  size: r.size,
  uploader: { username: r.username, name: r.uploader_name, kind: r.kind },
  team: r.team_key,
  createdAt: r.created_at,
});

/**
 * A file name without path separators, control characters (bidi overrides too: "gnp.exe" shown as "exe.png") or
 * quotes; at most 200 characters; "file" if nothing's left.
 */
function cleanName(name: unknown): string {
  const clean = (typeof name === "string" ? name : "").replace(/[/\\"\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "").trim();
  return [...clean].slice(0, 200).join("").trim() || "file";
}

const startsWith = (bytes: Uint8Array, prefix: number[] | string, at = 0) =>
  [...(typeof prefix === "string" ? new TextEncoder().encode(prefix) : prefix)].every((b, i) => bytes[at + i] === b);

/** What a file is, from its first bytes: a raster image, a PDF, UTF-8 text, or opaque bytes. SVG and HTML are text. */
function sniff(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) return "image/gif";
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return "image/webp";
  if (startsWith(bytes, "%PDF-")) return "application/pdf";
  const head = bytes.subarray(0, 8192);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true }); // stream: a character cut at 8 KB is fine
    if (!head.includes(0)) return "text/plain; charset=utf-8";
  } catch {}
  return "application/octet-stream";
}

/**
 * Stores a file in the request's workspace, or with `team` (a key) in that team, which only those who see it can get
 * back: written to disk first, then its row (a failed insert removes the file). A team you don't see is 404.
 */
export function saveAttachment(a: Actor, name: unknown, bytes: Uint8Array, team?: string | null): Attachment {
  const workspace = requestWorkspace(a);
  const teamId = team
    ? db.query<{ id: number }, [string, string]>(`SELECT id FROM teams t WHERE t.workspace = ? AND t.key = ? AND ${SEES_TEAM(String(a.id), "t")}`).get(workspace, team.trim().toUpperCase())?.id
    : null;
  if (teamId === undefined) throw new AppError(`Team ${team} not found`, 404);
  if (bytes.length === 0) throw new AppError("The file is empty");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new AppError(`Files can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413);
  const id = randomBytes(16).toString("base64url");
  const path = join(dir, id);
  // Whole or not at all, so a backup running meanwhile never copies half a file: written aside, then renamed.
  try {
    writeFileSync(`${path}.part`, bytes, { flag: "wx" });
    renameSync(`${path}.part`, path);
  } catch (err) {
    rmSync(`${path}.part`, { force: true }); // e.g. the disk is full
    throw err;
  }
  try {
    db.query("INSERT INTO attachments (id, workspace, team_id, name, content_type, size, uploader_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      workspace,
      teamId,
      cleanName(name),
      sniff(bytes),
      bytes.length,
      a.id,
      now(),
    );
  } catch (err) {
    rmSync(path, { force: true });
    throw err;
  }
  return toAttachment(db.query<Row, [string]>(`${SELECT} WHERE a.id = ?`).get(id)!);
}

/**
 * An attachment and its file, by id or by its URL (as found in markdown: a path or a full URL). 404 unless you're an
 * active member of its workspace (a key: its own) and, if it was uploaded in a team, see that team. The id is looked
 * up, never joined into a path as given.
 */
export function getAttachment(a: Actor, idOrUrl: string): { attachment: Attachment; path: string } {
  const path = URL.parse(idOrUrl, "http://docket")?.pathname ?? "";
  const id = /^[A-Za-z0-9_-]{22}$/.test(idOrUrl) ? idOrUrl : ATTACHMENT_URL.exec(path)?.[1];
  const row = id ? db.query<Row, [string]>(`${SELECT} WHERE a.id = ?`).get(id) : null;
  if (!row || !a.workspaces.has(row.workspace) || (row.team_id !== null && !seesTeam(a.id, row.team_id))) {
    throw new AppError("Attachment not found", 404);
  }
  return { attachment: toAttachment(row), path: join(dir, row.id) };
}

/** `filename` for old clients (ASCII, no quotes), `filename*` for the real name. */
const disposition = (kind: string, name: string) =>
  `${kind}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeName(name)}`;

const error = (err: unknown) => {
  if (err instanceof AppError) return Response.json({ error: err.message }, { status: err.status });
  console.error(err);
  return Response.json({ error: "Internal server error" }, { status: 500 });
};

export const attachmentRoutes = {
  // Raw bytes, `Content-Type: application/octet-stream` exactly: like JSON, a browser can't send that cross-site
  // without a CORS preflight, which Docket never allows (and a cookie write still needs our Origin).
  "/api/attachments": {
    POST: async (req: Request) => {
      try {
        if (req.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase() !== "application/octet-stream") {
          throw new AppError("Expected Content-Type: application/octet-stream", 415);
        }
        const bytes = new Uint8Array(await req.arrayBuffer());
        const query = new URL(req.url).searchParams;
        return Response.json(saveAttachment(actorOf(req), query.get("name"), bytes, query.get("team")), { status: 201 });
      } catch (err) {
        return error(err);
      }
    },
  },
  // The name in the URL is cosmetic: the id finds the file.
  "/api/attachments/:id/:name": {
    GET: async (req: BunRequest<"/api/attachments/:id/:name">) => {
      try {
        const id = req.params.id;
        if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new AppError("Attachment not found", 404);
        const { attachment, path } = getAttachment(actorOf(req), id);
        const file = Bun.file(path);
        if (!(await file.exists())) throw new AppError("Attachment not found", 404); // e.g. a database restored without its files
        const inline = INLINE_IMAGE_TYPES.includes(attachment.contentType);
        return new Response(file, {
          headers: {
            "Content-Type": attachment.contentType,
            "Content-Disposition": disposition(inline ? "inline" : "attachment", attachment.name),
            "Cross-Origin-Resource-Policy": "same-origin",
            "Cache-Control": "private, max-age=31536000, immutable",
          },
        });
      } catch (err) {
        return error(err);
      }
    },
  },
};

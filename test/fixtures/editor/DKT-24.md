## Why

A bug report without a screenshot, or an agent's 5,000-line log pasted into a comment, is the norm today because there's nowhere to put a file. Linear lets you paste or drop files into any editor. Docket needs the same, stored next to its database, private to the workspace, safe to serve, backed up, and usable by agents over MCP (including seeing a pasted screenshot).

## Linear's behaviour

- Upload with drag and drop, `/file`, or Cmd/Ctrl+Shift+U in the editor: https://linear.app/docs/editor
- Comments: paperclip icon, Cmd/Ctrl+Shift+A, or drag and drop: https://linear.app/docs/comment-on-issues
- A documented size limit exists only for email intake (25 MB): https://linear.app/docs/creating-issues

**Deliberate differences.** Files are private to the workspace (served only to signed-in members), not public URLs. 10 MB per file. Only raster images display inline; everything else downloads. And, since agents write much of Docket's markdown, **markdown no longer loads remote images**: they render as links (an image URL in prompt-injected agent output could carry data out, or track readers, on page load with no click; see the chat fix in commit cee4644). Uploads become the way to show an image.

## Where things are today

- `src/server/db.ts:20` resolves the database path (`DATABASE_PATH` or `$XDG_DATA_HOME/docket/docket.db`); `src/server/paths.ts:10-12` `xdgDataHome()`. In Docker the data dir is `/app/data` (Dockerfile `DATABASE_PATH=/app/data/docket.db`).
- `src/server/http.ts:5-7` `MAX_BODY` 1 MB / `HARD_MAX_BODY` 8 MB; `10-21` CSP (`img-src 'self' data: https:`); `26-35` `secure()` sets `Cache-Control: no-store` on API answers, overwriting any handler value; `61-75` `http()` rejects `Content-Length` over 1 MB for every route (67).
- `src/server/index.ts:35` `maxRequestBodySize: HARD_MAX_BODY`; `48` wraps all `apiRoutes` in `http(guard(…))`.
- `src/server/api.ts:23-31` `body()` enforces JSON (415), the CSRF defence; `src/server/auth.ts:64-73` cookie writes also need our `Origin` (70).
- `src/web/markdown.tsx:15-19` `safeUrl`, `22` `isInternal`, `80-87` link renderer, `88-94` image renderer, `120-126` click handler routes every `/…` link client-side; `src/web/styles.css:1384` `.md img`.
- `src/web/api.ts:87-99` `request()` (always JSON). `public/sw.js:81-82` caches `/api/*` GETs network-first and clears them on sign-out.
- Editors: `src/web/comments.tsx:85-142` Composer (textarea 110-129, footer 130-139), `src/web/issue.tsx:316-362` description editor, `src/web/docs.tsx:760-778` DocEditor, `src/web/modals.tsx:114` new issue. DKT-10 may already have added `src/web/editor.tsx` (mention menu); extend it if so, create it if not.
- `backup.sh:12-27` snapshots only the SQLite file. `README.md:47` says data is "a single SQLite file".

## Design

### Rules that apply
Linear's features, nano implementation, no dependencies. Append the next migration (additive) + survival test. SPEC.md, README, types.ts in the same branch. Workspace isolation: files of other workspaces are 404. REST/MCP/UI parity. CSP stays strict (it gets stricter). Branch `feature/attachments`; tests/typecheck pass; merge, delete branch. Prod: rehearse on a DB copy and make sure the backup pull includes `backups/attachments`.

### Storage
- `paths.ts` gains `databasePath()` (moved from db.ts:20) and `attachmentsDir()` = `join(dirname(databasePath()), "attachments")`: next to the database, i.e. `$XDG_DATA_HOME/docket/attachments`, `/app/data/attachments` in Docker, a temp dir in tests. Created on startup.
- A file is stored as `attachments/<id>` where `id` is 16 random bytes, base64url. Written before its row is inserted (a failed insert removes it). Files are immutable.

### Schema (append the next migration)
```sql
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,                     -- random; also the file name on disk
  workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
  name TEXT NOT NULL,                      -- sanitized original file name
  content_type TEXT NOT NULL,              -- sniffed by Docket, never the client's claim
  size INTEGER NOT NULL,
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
```

### Contract (`types.ts`)
```ts
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export interface Attachment { id: string; url: string; name: string; contentType: string; size: number; uploader: UserRef; createdAt: string }
// url: "/api/attachments/<id>/<encoded name>", what markdown links to
```

### Server: new `src/server/attachments.ts`
- **Upload** `POST /api/attachments?workspace=<key>&name=<file name>`, raw bytes, `Content-Type: application/octet-stream` exactly (anything else 415: octet-stream is not a CORS-simple type, so browsers can't send it cross-site without a preflight; cookies still need our Origin). Needs write access and membership of `workspace` (404 otherwise). Empty → 400; over 10 MB → 413. Returns 201 `Attachment`.
- **Name**: strip path separators, control characters and `"`; trim; at most 200 characters; empty → `file`.
- **Sniff** the first bytes: PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, GIF `GIF87a`/`GIF89a`, WebP `RIFF….WEBP` → that image type; `%PDF-` → `application/pdf`; valid UTF-8 without NUL in the first 8 KB → `text/plain; charset=utf-8`; else `application/octet-stream`. SVG and HTML are therefore text or octet-stream, never renderable.
- **Serve** `GET /api/attachments/:id/:name` (the name is cosmetic; `id` must match `^[A-Za-z0-9_-]{22}$` and is looked up in the table, never joined into a path from the URL): guarded like any API route (session cookie or API key), 404 unless the caller is an active member of the file's workspace. Headers: the stored `Content-Type`; `Content-Disposition: inline` only for the four image types, else `attachment`, with `filename="<ASCII fallback>"; filename*=UTF-8''<encoded>`; `Cross-Origin-Resource-Policy: same-origin`; `Cache-Control: private, max-age=31536000, immutable`; plus the usual `secure()` headers (nosniff, CSP, no framing).
- `http.ts`: `http(route, { maxBody })` option; `HARD_MAX_BODY = MAX_UPLOAD_BYTES + MAX_BODY`; `secure()` keeps a `Cache-Control` the handler set. `index.ts` registers the attachment routes separately with `http(guard(routes), { maxBody: MAX_UPLOAD_BYTES })`.
- **CSP**: `img-src 'self' data:` (drop `https:`), comment updated.

### MCP (in `mcp.ts`, using `attachments.ts`)
- `attach_file`: `workspace?`, `name`, and exactly one of `text` (UTF-8) or `base64`. "Upload a file (a log, a report, a screenshot) to link from a comment, description or doc; returns the markdown to paste: `![name](url)` for images, `[name](url)` otherwise. Prefer this over pasting long logs into comments. At most about 700 KB per call over MCP." Returns that markdown plus `structuredContent.attachment`.
- `get_attachment` (read-only): `url` (an `/api/attachments/…` URL or path, as found in markdown). Text files come back as text (first 100,000 characters, noted when cut); PNG/JPEG/GIF/WebP up to 5 MB as MCP image content (`{ type: "image", data, mimeType }`) so vision models can see screenshots; anything else as metadata only. Same membership check.

### Markdown (`markdown.tsx`)
- Images: only same-origin attachment URLs (`/api/attachments/…`) render as `<img loading="lazy">`; any other image renders as a link `<a href target="_blank" rel="noopener noreferrer">{alt or URL}</a>`. `images={false}` (chat) keeps showing alt text only.
- Links to `/api/attachments/…` open in a new tab and are not routed client-side (the click handler skips `/api/`).

### UI
- `editor.tsx`: `useUploads(ref, setValue)`: paste (`clipboardData.files`) and drop (`dataTransfer.files`, with a dashed drop highlight) upload each file to the current workspace (`useApp().workspace`), inserting `![Uploading name…]()` at the caret, replaced by `![name](url)` (images) or `[name](url)` when done; on failure the placeholder goes and a toast says why (e.g. "photo.heic is over 10 MB"). Wire it into the four editors.
- A paperclip button in the Composer footer and the description editor footer opens a file picker (`multiple`); `⌘/Ctrl+Shift+A` in the comment box does the same (Linear's shortcut).
- `api.upload(workspace, file): Promise<Attachment>` in `src/web/api.ts`: its own `fetch` with `content-type: application/octet-stream` and `x-docket-user`, same error handling as `request()`.

### Backups
`backup.sh`: after the `VACUUM INTO`, copy files from `<data>/attachments` that are missing in `<data>/backups/attachments` (immutable, so copying new ones is enough; never pruned, since old DB snapshots reference them). Snapshot first, files second, so every snapshot's files exist. README: data is "a SQLite file and an `attachments` folder"; don't copy either live except via `backup.sh`.

### Interaction with DKT-3
Files belong to a workspace and are checked by membership; URLs are under `/api`, unaffected by the app's URL prefix. If DKT-3 has landed (requests act in one workspace), the upload's workspace is the request's: drop `?workspace` and the MCP `workspace` argument.

## Acceptance criteria

- [ ] Pasting or dropping a screenshot into a comment, description, new-issue description or doc uploads it and shows it inline; other files show as download links.
- [ ] Files over 10 MB are refused with a clear message; a non-octet-stream upload is 415; a cookie upload without our Origin is 403; a read-only key is 403.
- [ ] Files are served only to members of their workspace (others 404, signed out 401), with nosniff, CSP, CORP and the right disposition; HTML or SVG never render.
- [ ] Remote images in markdown show as links; the CSP no longer allows remote images.
- [ ] Agents can attach text or base64 files and read attachments (images as image content) over MCP.
- [ ] `./backup.sh` also copies new attachments.

## Tests

`test/attachments.test.ts` (new). Add a `raw(method, path, { body, headers })` to `Caller` in `test/server.ts` (auth + Origin, no JSON) so auth stays in the harness.
- ana uploads PNG bytes (`name=shot.png`) → 201 `contentType: "image/png"`; GET the url → same bytes, `image/png`, `inline`, `nosniff`, CSP with `img-src 'self' data:`, `Cross-Origin-Resource-Policy: same-origin`.
- `<script>alert(1)</script>` named `x.png` → `text/plain; charset=utf-8`, `attachment`; an SVG → `attachment`; random bytes → `application/octet-stream`.
- 10 MB + 1 → 413; empty → 400; `Content-Type: application/json`, `multipart/form-data`, `text/plain` → 415; unknown `workspace` → 404; cookie without Origin → 403; read key → 403.
- a member of another workspace → 404; `s.anon` → 401; unknown id → 404.
- file exists under `join(dirname(s.databasePath), "attachments")`.
- MCP: agent `attach_file { name: "log.txt", text }` → markdown with `/api/attachments/`; `get_attachment` returns the text; a PNG comes back as image content; a non-member agent → error.
- Raw paths: `GET /api/attachments/%2e%2e/x` via `node:http` (see `test/chat-proxy.test.ts:287`) → 404, never a file outside the directory.

`test/migrations.test.ts`: frozen pre-migration fixture survives; uploads work afterwards.

## SPEC.md

- **Access / HTTP layer**: the octet-stream exception to "bodies must be JSON", the 10 MB upload cap, the new CSP `img-src`.
- New **Attachments** section: storage location, sniffing and serving rules, REST, MCP tools, backups.
- **UI**: paste/drop/paperclip; "Everywhere markdown renders": only attachments load as images, other images are links.
- **Deploy**: `./data` holds the database and `attachments/`; README updated.

## Out of scope

- Deleting or garbage-collecting unreferenced files, quotas, image resizing/EXIF stripping, previews for PDFs or video, an attachments list on issues, link attachments (Linear's Ctrl+L).
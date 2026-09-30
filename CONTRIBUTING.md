# Contributing to Docket

## Get running

You need [Bun](https://bun.sh) 1.4+ (CI uses the version in `package.json`).

```sh
bun install
bun run dev          # http://localhost:7100, hot reload; setup code DEVEL-SETUP (dev only: never expose it)
DOCKET_API_KEY=dk_... bun run seed   # demo data, in another terminal; only into an empty Docket
bun test
bun run typecheck
```

Create the key in Settings → Account → API keys. The dev server keeps its data in `./dev.db` (gitignored; delete `dev.db*` for a clean slate). It listens on port 7100, like the Docker container: stop one before starting the other, or set `PORT`.

## Find your way around

[SPEC.md](SPEC.md) is the source of truth: the data model, REST API, MCP tools and UI. Read it first. The code is short:

```
src/shared/types.ts   the contract between server and UI
src/server/           Bun.serve, SQLite, REST, MCP
src/web/              React UI, no framework beyond React
test/                 bun test, black-box over HTTP
scripts/              seed (demo data over REST) and sign-in-link (recovery CLI)
```

## Tests

Tests start a real server in a subprocess against a temp database, set it up with an admin, then talk to it over REST, MCP and `/ws` (`test/server.ts`). They (almost) never import `src/`, so refactors don't break them. Only behaviour changes do. The exceptions: `test/rate-limit.test.ts` calls the limiter in `src/server/http.ts` directly, `test/migrations.test.ts` the schema runner in `src/server/schema.ts`, and these run under happy-dom: `test/editor.test.ts` checks the rich editor's markdown round-trip (`src/web/tiptapKit.ts`) on a real corpus (`test/fixtures/editor`), `test/markdown.test.ts` what the read view renders (`src/web/markdown.tsx`: which images load), `test/chord.test.ts` the G-chord's key handling (`src/web/hooks.ts`) and `test/new-issue.test.ts` the new-issue modal (`src/web/modals.tsx`).

- A behaviour change or a bug fix comes with a test.
- Tests sign in only through the harness: `s.api` (the admin), `s.user(name)`, `s.agent(name)`, `s.as(name)` and `s.anon`. A change to how auth works then touches `test/server.ts` alone.
- Migrations go at the end of `MIGRATIONS` in `src/server/schema.ts`; the baseline never changes. A migration that rewrites data needs a test; an additive one doesn't.

## What makes a PR easy to merge

Docket's one rule is **minimal, simple, clean, smooth**. In practice:

- **Small and focused.** One change per PR. Open an issue first for anything big.
- **No new dependencies** unless there's really no other way. The exception is the rich text editor, Tiptap, pinned to exact versions.
- **Keep SPEC.md in sync** when you change behaviour, the API or the data model.
- **Migrations never lose data; rebuilds follow SQLite's 12-step procedure.** People have real data in their SQLite files.
- **Match the UI.** Neutral, light, Linear-like. Check it on a phone width too.
- **`bun test` and `bun run typecheck` pass.** CI runs both (tests with `--rerun-each 3`), plus a Docker build, on every PR.

## Reporting bugs

[Open an issue](https://github.com/youssefaltai/docket/issues/new/choose) with what you did, what you expected and what happened. Security issues go through [SECURITY.md](SECURITY.md) instead.

# Contributing to Docket

Thanks for helping out! Bug reports, ideas, docs fixes and code are all welcome.

## Get running

You need [Bun](https://bun.sh) 1.4+ (CI uses the version in `package.json`).

```sh
bun install
bun run dev          # http://localhost:7100, hot reload; set it up with code DEVEL-SETUP
DOCKET_API_KEY=dk_... bun run seed   # demo data, in another terminal (create a key in Settings)
bun test
bun run typecheck
```

The dev server keeps its data in `./dev.db` (gitignored), so it never touches a real Docket install. Delete it for a clean slate. It listens on port 7100, like the Docker container: stop one before starting the other, or set `PORT`.

## Find your way around

[SPEC.md](SPEC.md) is the source of truth: the data model, REST API, MCP tools and UI. Read it first. The code is short:

```
src/shared/types.ts   the contract between server and UI
src/server/           Bun.serve, SQLite, REST, MCP
src/web/              React UI, no framework beyond React
test/                 bun test, black-box over HTTP
scripts/seed.ts       demo data, created over REST
```

## Tests

Tests start a real server in a subprocess against a temp database, set it up with an admin, then talk to it over REST, MCP and `/ws` (`test/server.ts`). They never import `src/`, so refactors don't break them. Only behaviour changes do.

- A behaviour change or a bug fix comes with a test.
- Tests sign in only through the harness: `s.api` (the admin), `s.user(name)`, `s.agent(name)`, `s.as(name)` and `s.anon`. A change to how auth works then touches `test/server.ts` alone.
- A new migration comes with a test that data written under the previous schema survives it. Freeze that schema in the test as a fixture; never edit it later.

## What makes a PR easy to merge

Docket's one rule is **minimal, simple, clean, smooth**. In practice:

- **Small and focused.** One change per PR. Open an issue first for anything big.
- **No new dependencies** unless there's really no other way.
- **Keep SPEC.md in sync** when you change behaviour, the API or the data model.
- **Migrations are additive.** People have real data in their SQLite files.
- **Match the UI.** Neutral, light, Linear-like. Check it on a phone width too.
- **`bun test` and `bun run typecheck` pass.** CI runs both, plus a Docker build, on every PR.

## Reporting bugs

[Open an issue](https://github.com/youssefaltai/docket/issues/new/choose) with what you did, what you expected and what happened. Security issues go through [SECURITY.md](SECURITY.md) instead.

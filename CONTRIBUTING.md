# Contributing to Docket

Thanks for helping out! Bug reports, ideas, docs fixes and code are all welcome.

## Get running

You need [Bun](https://bun.sh) 1.4+.

```sh
bun install
bun run dev          # http://localhost:7100, hot reload
bun run typecheck
```

The dev server uses its own SQLite file (`$XDG_DATA_HOME/docket/docket.db`). Point `DATABASE_PATH` somewhere else if you want a clean slate.

## Find your way around

[SPEC.md](SPEC.md) is the source of truth: the data model, REST API, MCP tools and UI. Read it first. The code is short:

```
src/shared/types.ts   the contract between server and UI
src/server/           Bun.serve, SQLite, REST, MCP
src/web/              React UI, no framework beyond React
```

## What makes a PR easy to merge

Docket's one rule is **minimal, simple, clean, smooth**. In practice:

- **Small and focused.** One change per PR. Open an issue first for anything big.
- **No new dependencies** unless there's really no other way.
- **Keep SPEC.md in sync** when you change behaviour, the API or the data model.
- **Migrations are additive.** People have real data in their SQLite files.
- **Match the UI.** Neutral, light, Linear-like. Check it on a phone width too.
- **`bun run typecheck` passes.**

## Reporting bugs

[Open an issue](https://github.com/youssefaltai/docket/issues/new) with what you did, what you expected and what happened. Include your browser or MCP client if it matters.

# Docket

A nano issue tracker: projects, issues, comments, and markdown docs. A web UI for humans and an MCP server for agents, on Bun + SQLite. It has no auth and is meant to be reachable only over Tailscale. See [SPEC.md](SPEC.md) for the data model, REST API and MCP tools.

It's installable as a PWA (Add to Home Screen / Add to Dock) on iPhone, iPad, Mac Safari and Chrome, with offline support for the last-seen issues and docs.

## Run locally

```sh
bun install
bun run dev        # http://localhost:7100, hot reload
```

Env: `PORT` (default `7100`), `DATABASE_PATH` (default `./data/docket.db`). `NODE_ENV=production bun run start` runs it like production: UI bundled once at startup, no hot reload.

## Deploy

on the server the app lives in `/srv/docket`, and SQLite data persists in `./data` there.

```sh
rsync -av --delete --exclude node_modules --exclude data --exclude .git ./ server:/srv/docket/
ssh server 'cd /srv/docket && docker compose up -d --build'
```

The container listens on `127.0.0.1:7100` only. Expose it to the tailnet once (the config persists across restarts):

```sh
ssh server 'sudo tailscale serve --bg --https=7100 http://127.0.0.1:7100'
```

It's then at `https://docket.<tailnet>.ts.net:7100`.

## Connect Claude Code

```sh
claude mcp add --transport http --scope user docket https://docket.<tailnet>.ts.net:7100/mcp
```

Tools: `list_projects`, `create_project`, `list_issues`, `get_issue`, `create_issue`, `update_issue`, `comment_issue`, `list_documents`, `get_document`, `create_document`, `update_document`, `comment_document`.

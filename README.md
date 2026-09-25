# Docket

A nano issue tracker: workspaces, projects, issues, comments, and markdown docs. A web UI for humans and an MCP server for agents, on Bun + SQLite. Self-hosted: one container, one SQLite file. See [SPEC.md](SPEC.md) for the data model, REST API and MCP tools.

It's installable as a PWA (Add to Home Screen / Add to Dock) on iPhone, iPad, Mac Safari and Chrome, with offline support for the last-seen issues and docs.

## Run locally

```sh
bun install
bun run dev        # http://localhost:7100, hot reload
```

Env: `PORT` (default `7100`), `DATABASE_PATH` (default `$XDG_DATA_HOME/docket/docket.db`, falling back to `./data/docket.db` if that already exists). `NODE_ENV=production bun run start` runs it like production: UI bundled once at startup, no hot reload.

Config file (optional, real env vars win): `$XDG_CONFIG_HOME/docket/config` or `$XDG_CONFIG_DIRS/docket/config`, `KEY=VALUE` lines (keep it `chmod 600` if it holds the token):

```
PORT=7100
DOCKET_TOKEN=secret
```

## Deploy

```sh
docker compose up -d --build
```

SQLite data persists in `./data`. The container listens on `127.0.0.1:7100` only; put it behind whatever you already use for HTTPS — a reverse proxy (Caddy, nginx, Traefik), a tunnel, or a private network like Tailscale or WireGuard. Back up with `./backup.sh` (nightly cron: a consistent snapshot into `data/backups/`, kept 14 days).

## Access

Docket has a single shared access token, off by default.

- **Private network only** (VPN, LAN): leave `DOCKET_TOKEN` unset. Anyone who can reach it can use it.
- **Anywhere else**: set `DOCKET_TOKEN` to a long random secret (e.g. `openssl rand -hex 32`), in the environment or a `.env` file next to `docker-compose.yml`. Then `/api`, `/mcp` and `/ws` need `Authorization: Bearer <token>`; the web UI asks for the token once and keeps it in an HttpOnly cookie. Always serve it over HTTPS.

## Connect Claude Code

```sh
claude mcp add --transport http --scope user docket https://docket.example.com/mcp
# with DOCKET_TOKEN set:
claude mcp add --transport http --scope user docket https://docket.example.com/mcp \
  --header "Authorization: Bearer $DOCKET_TOKEN"
```

Tools: `list_workspaces`, `create_workspace`, `list_projects`, `create_project`, `list_issues`, `get_issue`, `create_issue`, `update_issue`, `comment_issue`, `list_documents`, `get_document`, `create_document`, `update_document`, `comment_document`.

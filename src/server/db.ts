// The SQLite connection, the schema, change events and the validation helpers the data modules share.
import { Database } from "bun:sqlite";
import { marked, type Token } from "marked";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { databasePath } from "./paths.ts";
import { MENTION_PATTERN, mentionOf, type ServerEvent } from "../shared/types.ts";

/** An error with an HTTP status; REST returns it as `{ error }`, MCP as a tool error. */
export class AppError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// --- Connection and schema ---

const path = databasePath();
mkdirSync(dirname(path), { recursive: true });
export const db = new Database(path, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");

// Append-only: each entry upgrades the schema by one PRAGMA user_version: SQL, or a function for what SQL can't do.
const MIGRATIONS: (string | (() => void))[] = [
  `
  -- People and agents; the username is the identity. Email is unverified contact info (there's no mail),
  -- so it's never used to find an account. Agents sign in only with API keys.
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE workspace_members (
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'agent')),
    created_at TEXT NOT NULL,
    suspended_at TEXT,
    PRIMARY KEY (workspace, user_id)
  );
  CREATE INDEX workspace_members_user ON workspace_members(user_id);
  -- Secrets are stored only as SHA-256 hashes.
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    ip TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX api_keys_user ON api_keys(user_id);
  -- One-time codes: invites (workspace, role) and sign-in links (user).
  CREATE TABLE codes (
    id INTEGER PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'sign-in')),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    workspace TEXT REFERENCES workspaces(key) ON DELETE CASCADE,
    role TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE teams (
    key TEXT PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX teams_workspace ON teams(workspace);
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY,
    team_key TEXT NOT NULL REFERENCES teams(key),
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    labels TEXT NOT NULL DEFAULT '[]',
    assignee_id INTEGER REFERENCES users(id),
    delegate_id INTEGER REFERENCES users(id),
    creator_id INTEGER NOT NULL REFERENCES users(id),
    parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (team_key, number)
  );
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE TABLE issue_blocks (
    blocker_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    PRIMARY KEY (blocker_id, blocked_id)
  );
  CREATE INDEX issue_blocks_blocked ON issue_blocks(blocked_id);
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT
  );
  CREATE INDEX comments_issue ON comments(issue_id);
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    team_key TEXT NOT NULL REFERENCES teams(key),
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id)
  );
  CREATE INDEX documents_team ON documents(team_key, position);
  CREATE TABLE document_versions (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX document_versions_document ON document_versions(document_id);
  CREATE TABLE document_refs (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    PRIMARY KEY (document_id, issue_id)
  );
  CREATE INDEX document_refs_issue ON document_refs(issue_id);
  CREATE TABLE document_comments (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT
  );
  CREATE INDEX document_comments_document ON document_comments(document_id);
  `,
  // Trash: deleting an issue or doc sets deleted_at; it's restorable for 30 days, then purged.
  // Emails become unique in the schema too (the app already refused clashes); older duplicates lose theirs.
  `
  ALTER TABLE issues ADD COLUMN deleted_at TEXT;
  ALTER TABLE documents ADD COLUMN deleted_at TEXT;
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  UPDATE users SET email = NULL WHERE email IS NOT NULL
    AND id NOT IN (SELECT MIN(id) FROM users WHERE email IS NOT NULL GROUP BY lower(email));
  CREATE UNIQUE INDEX users_email ON users(lower(email)) WHERE email IS NOT NULL;
  `,
  // Short-lived keys: past expires_at a key is dead, then purged. A session-bound key belongs to one browser
  // session and goes with it (sign-out, revoke, suspension). Unused since migration 29.
  `
  ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
  ALTER TABLE api_keys ADD COLUMN session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE;
  CREATE INDEX api_keys_expires ON api_keys(expires_at) WHERE expires_at IS NOT NULL;
  CREATE INDEX api_keys_session ON api_keys(session_id) WHERE session_id IS NOT NULL;
  `,
  // Keys belong to one workspace, as in Linear: an API key, agent token or session-bound key acts only there.
  `
  ALTER TABLE api_keys ADD COLUMN workspace TEXT REFERENCES workspaces(key) ON DELETE CASCADE;
  DELETE FROM api_keys WHERE session_id IS NOT NULL; -- chat keys: short-lived, minted again per workspace
  UPDATE api_keys SET workspace = (SELECT m.workspace FROM workspace_members m
    WHERE m.user_id = api_keys.user_id AND m.suspended_at IS NULL ORDER BY m.created_at, m.workspace LIMIT 1);
  DELETE FROM api_keys WHERE workspace IS NULL; -- the owner has no active workspace left
  CREATE INDEX api_keys_workspace ON api_keys(user_id, workspace);
  `,
  // Usernames and names belong to each membership, unique within its workspace (as in Linear); an account
  // is the login. Rebuilds both tables (SQLite's 12-step ALTER), keeping every id and row. Guests fit the role.
  `
  CREATE TABLE members_new (
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest', 'agent')),
    created_at TEXT NOT NULL,
    suspended_at TEXT,
    PRIMARY KEY (workspace, user_id),
    UNIQUE (workspace, username)
  );
  INSERT INTO members_new SELECT m.workspace, m.user_id, u.username, u.name, m.role, m.created_at, m.suspended_at
    FROM workspace_members m JOIN users u ON u.id = m.user_id;
  DROP TABLE workspace_members;
  ALTER TABLE members_new RENAME TO workspace_members;
  CREATE INDEX workspace_members_user ON workspace_members(user_id);
  CREATE TABLE users_new (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
    email TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO users_new SELECT id, kind, email, created_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  CREATE UNIQUE INDEX users_email ON users(lower(email)) WHERE email IS NOT NULL;
  `,
  // Team keys and doc slugs are unique per workspace, as in Linear: teams get an internal id that issues and
  // docs point to. Rebuilds all three (SQLite's 12-step ALTER), keeping every id and row. LEFT JOIN, so a row
  // without its team fails NOT NULL (and the migration) instead of being dropped.
  `
  CREATE TABLE teams_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, key)
  );
  INSERT INTO teams_new (workspace, key, name, description, next_number, created_at, updated_at)
    SELECT workspace, key, name, description, next_number, created_at, updated_at FROM teams ORDER BY created_at, key;
  CREATE TABLE issues_new (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    labels TEXT NOT NULL DEFAULT '[]',
    assignee_id INTEGER REFERENCES users(id),
    delegate_id INTEGER REFERENCES users(id),
    creator_id INTEGER NOT NULL REFERENCES users(id),
    parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT,
    UNIQUE (team_id, number)
  );
  INSERT INTO issues_new SELECT i.id, t.id, i.number, i.title, i.description, i.status, i.priority, i.labels, i.assignee_id,
    i.delegate_id, i.creator_id, i.parent_id, i.created_at, i.updated_at, i.completed_at, i.deleted_at
    FROM issues i LEFT JOIN teams_new t ON t.key = i.team_key;
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_id INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT,
    UNIQUE (workspace, slug)
  );
  INSERT INTO documents_new SELECT d.id, t.workspace, t.id, d.slug, d.title, d.content, d.position, d.created_at,
    d.updated_at, d.updated_by_id, d.deleted_at FROM documents d LEFT JOIN teams_new t ON t.key = d.team_key;
  DROP TABLE documents;
  DROP TABLE issues;
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;
  ALTER TABLE issues_new RENAME TO issues;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE INDEX issues_parent ON issues(parent_id);
  CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX documents_team ON documents(team_id, position);
  CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
  // Issue history: one row per change, written in the same transaction as the change. kind has no CHECK, so
  // later kinds need no rebuild (the app validates it); values are JSON. on_behalf_of_id: for changes Docket
  // makes on its own, whose change set it off. History starts now: existing issues get their creation.
  `
  CREATE TABLE issue_activity (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    on_behalf_of_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX issue_activity_issue ON issue_activity(issue_id, id);
  INSERT INTO issue_activity (issue_id, actor_id, kind, created_at) SELECT id, creator_id, 'created', created_at FROM issues ORDER BY id;
  `,
  // Who is @mentioned where; recomputed on every save of the text, like document_refs. created_at: the save that
  // first mentioned them, so a mutation's new mentions are the rows it wrote. Existing texts count from their next save.
  `
  CREATE TABLE mentions (
    source TEXT NOT NULL, -- 'issue:<id>' (description), 'comment:<id>', 'document:<id>' (content), 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's in or on
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's in or on
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, user_id)
  );
  CREATE INDEX mentions_user ON mentions(user_id);
  `,
  // The inbox: who follows which issue or doc, and what they're told. Existing work is subscribed the way new
  // work will be. Texts written before migration 8 get their mentions now, so their next save doesn't announce
  // old mentions as new; whoever they mention is subscribed too. Nothing is notified.
  () => {
    db.run(`
    CREATE TABLE subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) != (document_id IS NULL))
    );
    CREATE UNIQUE INDEX subscriptions_issue ON subscriptions(issue_id, user_id) WHERE issue_id IS NOT NULL;
    CREATE UNIQUE INDEX subscriptions_document ON subscriptions(document_id, user_id) WHERE document_id IS NOT NULL;
    CREATE INDEX subscriptions_user ON subscriptions(user_id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id), -- the recipient
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- assigned | delegated | mentioned | commented | status
      actor_id INTEGER NOT NULL REFERENCES users(id),
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      comment_id INTEGER, -- in comments (issue) or document_comments (doc); no FK: two tables
      status TEXT, -- kind status: the new status
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, workspace, id);
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT creator_id, id, created_at FROM issues;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT assignee_id, id, updated_at FROM issues WHERE assignee_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT delegate_id, id, updated_at FROM issues WHERE delegate_id IS NOT NULL;
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at) SELECT author_id, issue_id, MIN(created_at) FROM comments GROUP BY author_id, issue_id;
    -- A doc's creator is the author of its first version.
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT v.author_id, v.document_id, v.created_at FROM document_versions v
      WHERE v.id = (SELECT MIN(id) FROM document_versions WHERE document_id = v.document_id);
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at) SELECT author_id, document_id, MIN(created_at) FROM document_comments GROUP BY author_id, document_id;
    `);
    backfillMentions();
    db.run(`
    INSERT OR IGNORE INTO subscriptions (user_id, issue_id, created_at)
      SELECT user_id, issue_id, MIN(created_at) FROM mentions WHERE issue_id IS NOT NULL GROUP BY user_id, issue_id;
    INSERT OR IGNORE INTO subscriptions (user_id, document_id, created_at)
      SELECT user_id, document_id, MIN(created_at) FROM mentions WHERE document_id IS NOT NULL GROUP BY user_id, document_id;
    `);
  },
  // Webhooks, and their outbox: deliveries are written in the same transaction as the change and sent by a
  // background loop. The secret signs deliveries, so it's kept in the clear (shown once).
  `
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    resource_types TEXT NOT NULL,         -- JSON array of Issue | Comment | Document | Notification
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,  -- deliveries in a row that failed for good; 10 disables the webhook
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhooks_workspace ON webhooks(workspace);
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,                   -- Docket-Delivery, the same on every attempt
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,                 -- identifier, slug, comment id or notification id
    payload TEXT NOT NULL,                -- JSON without webhookTimestamp (set per attempt)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    response_status INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  `,
  // Related and duplicate issues (Linear's other two relations; blocks keep issue_blocks). "related" is undirected:
  // one row per pair, from_id < to_id. "duplicate" is directional: from_id duplicates to_id, at most one per from_id.
  `
  CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
  `,
  // Due dates: a calendar date, "YYYY-MM-DD" (sorts and compares as text); NULL = none.
  `
  ALTER TABLE issues ADD COLUMN due_on TEXT;
  CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
  `,
  // Comment threads (Linear's replies): a reply points at its thread's root (one level); a root can be resolved.
  // Existing comments become roots.
  `
  ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;
  ALTER TABLE comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE;
  ALTER TABLE document_comments ADD COLUMN resolved_at TEXT;
  ALTER TABLE document_comments ADD COLUMN resolved_by_id INTEGER REFERENCES users(id);
  CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
  `,
  // Emoji reactions (Linear's): on an issue's description, a comment or a document comment. Never activity,
  // a notification or a webhook event, and never bumps updated_at; deleting a comment deletes its rows.
  `
  CREATE TABLE reactions (
    target TEXT NOT NULL,   -- 'issue:<id>' (the description), 'comment:<id>', 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's on (purge cascades)
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's on
    created_at TEXT NOT NULL,
    PRIMARY KEY (target, user_id, emoji)
  );
  `,
  // Attachments: uploaded files, private to a workspace. The bytes live in attachments/<id> next to the database.
  `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,           -- 16 random bytes, base64url; also the file's name on disk
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    name TEXT NOT NULL,            -- the uploaded file's name, sanitized
    content_type TEXT NOT NULL,    -- sniffed by Docket, never the client's claim
    size INTEGER NOT NULL,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  `,
  // Per-team workflows (Linear's workflow statuses): each team's ordered statuses in fixed categories. Issues keep
  // their status as the key (issues.status never changes here). Every team gets the six statuses teams always had,
  // same keys, plus Duplicate, so every issue keeps its status, icon and order; new issues still start in backlog.
  // Refused (rolled back) if any issue's status isn't one of them, rather than leaving it outside its workflow.
  () => {
    db.run(`
    CREATE TABLE workflow_statuses (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')),
      color TEXT NOT NULL,
      position REAL NOT NULL,
      UNIQUE (team_id, key)
    );
    CREATE UNIQUE INDEX workflow_statuses_triage ON workflow_statuses(team_id) WHERE category = 'triage';
    INSERT INTO workflow_statuses (team_id, key, name, category, color, position)
      SELECT t.id, d.key, d.name, d.category, d.color, d.position FROM teams t, (
                  SELECT 'backlog' AS key, 'Backlog' AS name, 'backlog' AS category, '#a3a3a3' AS color, 1 AS position
        UNION ALL SELECT 'todo', 'Todo', 'unstarted', '#8f8f8f', 2
        UNION ALL SELECT 'in_progress', 'In Progress', 'started', '#e8a800', 3
        UNION ALL SELECT 'in_review', 'In Review', 'started', '#30a46c', 4
        UNION ALL SELECT 'done', 'Done', 'completed', '#5e6ad2', 5
        UNION ALL SELECT 'canceled', 'Canceled', 'canceled', '#b4b4b4', 6
        UNION ALL SELECT 'duplicate', 'Duplicate', 'canceled', '#b4b4b4', 7
      ) d ORDER BY t.id, d.position;
    ALTER TABLE teams ADD COLUMN default_status TEXT NOT NULL DEFAULT 'backlog';
    `);
    const stray = db
      .query("SELECT i.id, i.status FROM issues i LEFT JOIN workflow_statuses w ON w.team_id = i.team_id AND w.key = i.status WHERE w.id IS NULL LIMIT 5")
      .all();
    if (stray.length) throw new Error(`Workflow statuses: issues whose status isn't in the default workflow: ${JSON.stringify(stray)}`);
  },
  // Auto-close (Linear's per-team settings), both off. users.system marks Docket's own account, which its automated
  // changes are attributed to: made on first use (so no row changes here), never a login and never a member.
  `
  ALTER TABLE teams ADD COLUMN auto_close_parent INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_parent IN (0, 1));
  ALTER TABLE teams ADD COLUMN auto_close_children INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_children IN (0, 1));
  ALTER TABLE users ADD COLUMN system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1));
  CREATE UNIQUE INDEX users_system ON users(system) WHERE system = 1;
  `,
  // Labels become entities (Linear's): a workspace's (team_id NULL) or one team's own, with a color, optionally in a
  // group (is_group, one level deep). Issues point to them through issue_labels; issues.labels (JSON names) stays but
  // is no longer read or written. Every name in use, trashed issues' too, becomes a workspace label ("Bug" and "bug"
  // merge into one), colored in turn from LABEL_COLORS; every issue keeps its names. Refused (rolled back) if any
  // issue's labels aren't an array of names, or if one would lose a name.
  () => {
    const odd = db
      .query("SELECT id FROM issues i WHERE NOT json_valid(i.labels) OR json_type(i.labels) <> 'array' OR EXISTS (SELECT 1 FROM json_each(i.labels) WHERE type <> 'text') LIMIT 5")
      .all();
    if (odd.length) throw new Error(`Labels: issues whose labels aren't an array of names: ${JSON.stringify(odd)}`);
    db.run(`
    CREATE TABLE labels (
      id INTEGER PRIMARY KEY,
      workspace TEXT NOT NULL REFERENCES workspaces(key),
      team_id INTEGER REFERENCES teams(id),    -- a team's own label, only on its issues; NULL: the workspace's
      parent_id INTEGER REFERENCES labels(id), -- its group
      name TEXT NOT NULL,
      color TEXT NOT NULL,                     -- #rrggbb
      is_group INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX labels_name ON labels(workspace, COALESCE(parent_id, 0), lower(name));
    CREATE TABLE issue_labels (
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (issue_id, label_id)
    );
    CREATE INDEX issue_labels_label ON issue_labels(label_id);
    INSERT INTO labels (workspace, name, color, created_at)
      SELECT t.workspace, MIN(trim(l.value)), '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM issues i JOIN teams t ON t.id = i.team_id, json_each(i.labels) l
      WHERE trim(l.value) <> '' GROUP BY t.workspace, lower(trim(l.value)) ORDER BY t.workspace, lower(trim(l.value));
    UPDATE labels SET color = CASE (id - 1) % 10
      WHEN 0 THEN '#357fd4' WHEN 1 THEN '#35d48a' WHEN 2 THEN '#d48a35' WHEN 3 THEN '#7f35d4' WHEN 4 THEN '#d43550'
      WHEN 5 THEN '#35c4d4' WHEN 6 THEN '#d4b435' WHEN 7 THEN '#354ad4' WHEN 8 THEN '#d45535' ELSE '#d435d4' END;
    INSERT OR IGNORE INTO issue_labels (issue_id, label_id)
      SELECT i.id, lb.id FROM issues i JOIN teams t ON t.id = i.team_id, json_each(i.labels) l
      JOIN labels lb ON lb.workspace = t.workspace AND lower(lb.name) = lower(trim(l.value))
      WHERE trim(l.value) <> '';
    `);
    const lost = db
      .query(
        `SELECT i.id, l.value FROM issues i, json_each(i.labels) l WHERE trim(l.value) <> '' AND NOT EXISTS (
           SELECT 1 FROM issue_labels x JOIN labels lb ON lb.id = x.label_id WHERE x.issue_id = i.id AND lower(lb.name) = lower(trim(l.value))) LIMIT 5`,
      )
      .all();
    if (lost.length) throw new Error(`Labels: issues that would lose a label: ${JSON.stringify(lost)}`);
  },
  // Moving an issue to another team of its workspace (Linear's): it takes that team's next number, and each identifier
  // it had before keeps resolving to it. Numbers are never reused, so an old identifier never names another issue.
  `
  CREATE TABLE issue_aliases (
    team_id INTEGER NOT NULL REFERENCES teams(id),
    number INTEGER NOT NULL,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, number)
  );
  CREATE INDEX issue_aliases_issue ON issue_aliases(issue_id);
  `,
  // Auto-archive (Linear's per-team setting, on top of the 30-day trash): a team may set a period after which its
  // completed/canceled issues are hidden from default views (still searchable and openable), independent of trash.
  // Both new columns default to "off"/unset, so no existing issue is affected until a team turns it on.
  `
  ALTER TABLE issues ADD COLUMN archived_at TEXT;
  CREATE INDEX issues_archived ON issues(archived_at) WHERE archived_at IS NOT NULL;
  ALTER TABLE teams ADD COLUMN auto_archive_days INTEGER; -- NULL = never (default); else days after completed_at
  `,
  // Estimates (Linear's, opt-in per team): a team's scale (NULL: off) and each issue's 1-5 position in it (NULL: none).
  // Turning estimates off or changing the scale never touches issues' positions.
  `
  ALTER TABLE teams ADD COLUMN estimate_scale TEXT CHECK (estimate_scale IN ('exponential', 'fibonacci', 'linear', 'tshirt'));
  ALTER TABLE issues ADD COLUMN estimate INTEGER CHECK (estimate BETWEEN 1 AND 5);
  `,
  // Projects (Linear's): a body of work in one workspace, spanning the teams in project_teams, with milestones (its
  // stages). An issue is in at most one project and one of its milestones; a doc can be attached to one. Existing
  // issues and docs are in none.
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'planned', 'in_progress', 'paused', 'completed', 'canceled')),
    lead_id INTEGER REFERENCES users(id),
    target_date TEXT, -- YYYY-MM-DD
    creator_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace, slug)
  );
  CREATE TABLE project_teams (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    PRIMARY KEY (project_id, team_id)
  );
  CREATE INDEX project_teams_team ON project_teams(team_id);
  CREATE TABLE milestones (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    target_date TEXT,
    position REAL NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX milestones_name ON milestones(project_id, lower(name));
  ALTER TABLE issues ADD COLUMN project_id INTEGER REFERENCES projects(id);
  ALTER TABLE issues ADD COLUMN milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL;
  CREATE INDEX issues_project ON issues(project_id) WHERE project_id IS NOT NULL;
  ALTER TABLE documents ADD COLUMN project_id INTEGER REFERENCES projects(id);
  CREATE INDEX documents_project ON documents(project_id) WHERE project_id IS NOT NULL;
  `,
  // Custom views (Linear's): a workspace's saved filters with display options, and who starred which into their sidebar.
  `
  CREATE TABLE custom_views (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    name TEXT NOT NULL,
    filter TEXT NOT NULL, -- JSON: IssueFilter's fields but sort (VIEW_FILTER_FIELDS)
    group_by TEXT NOT NULL DEFAULT 'status' CHECK (group_by IN ('status', 'assignee', 'priority', 'label')),
    order_by TEXT NOT NULL DEFAULT 'priority' CHECK (order_by IN ('priority', 'updated', 'created')),
    layout TEXT NOT NULL DEFAULT 'list' CHECK (layout IN ('list', 'board')),
    creator_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX custom_views_workspace ON custom_views(workspace);
  CREATE TABLE view_favorites (
    user_id INTEGER NOT NULL REFERENCES users(id),
    view_id INTEGER NOT NULL REFERENCES custom_views(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, view_id)
  );
  CREATE INDEX view_favorites_view ON view_favorites(view_id);
  `,
  // Cycles (Linear's, opt-in per team): repeating planning periods on UTC dates, numbered per team. Every team starts
  // with cycles off and every issue in none.
  `
  ALTER TABLE teams ADD COLUMN cycle_weeks INTEGER CHECK (cycle_weeks BETWEEN 1 AND 8); -- NULL: cycles off
  ALTER TABLE teams ADD COLUMN upcoming_cycles INTEGER NOT NULL DEFAULT 2 CHECK (upcoming_cycles BETWEEN 1 AND 15);
  CREATE TABLE cycles (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    number INTEGER NOT NULL,  -- 1, 2, 3… per team
    starts_at TEXT NOT NULL,  -- ISO, 00:00 UTC
    ends_at TEXT NOT NULL,    -- exclusive: the next cycle's starts_at (or when cycles were turned off)
    completed_at TEXT,        -- set when it ended and its unfinished issues rolled over
    UNIQUE (team_id, number)
  );
  ALTER TABLE issues ADD COLUMN cycle_id INTEGER REFERENCES cycles(id) ON DELETE SET NULL;
  CREATE INDEX issues_cycle ON issues(cycle_id) WHERE cycle_id IS NOT NULL;
  `,
  // Issue templates (Linear's, team-scoped only): a team's named prefills for new issues (title, description,
  // status, priority, labels). status is a key of the team's own workflow, checked when it's set; it's not a
  // foreign key, because a status later deleted from the workflow doesn't invalidate the template: applying it
  // then falls back to the team's default status at use time. Labels are entities (migration 18), so a
  // template's are a join table, like an issue's, rather than a JSON list. Hard-deleted: templates only ever
  // seed an IssueInput, so removing one never touches issues already created from it.
  `
  CREATE TABLE issue_templates (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT,    -- a status key of the team's workflow; NULL: the team's default status at use time
    priority INTEGER CHECK (priority BETWEEN 0 AND 4), -- NULL: default (0) at use time
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX issue_templates_team ON issue_templates(team_id);
  CREATE TABLE issue_template_labels (
    template_id INTEGER NOT NULL REFERENCES issue_templates(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (template_id, label_id)
  );
  CREATE INDEX issue_template_labels_label ON issue_template_labels(label_id);
  `,
  // The GitHub integration: a workspace's signed incoming webhook, whose changes are made as its own agent account, and
  // the pull requests and commits it links to issues. The secret verifies deliveries, so it's kept in the clear (shown once).
  `
  CREATE TABLE github_integrations (
    workspace TEXT PRIMARY KEY REFERENCES workspaces(key) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id), -- the GitHub agent account
    secret TEXT,                                   -- verifies X-Hub-Signature-256; NULL: disconnected
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE issue_links (
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pull_request', 'commit')),
    title TEXT NOT NULL,          -- the PR's title, or the commit's first line
    number INTEGER,               -- the PR's number
    state TEXT CHECK (state IN ('draft', 'open', 'merged', 'closed')), -- PRs only
    closes INTEGER NOT NULL CHECK (closes IN (0, 1)), -- 1: closing (branch, title or closing word); 0: contributing
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (issue_id, url)
  );
  `,
  // Team membership, private teams and guests (Linear's): who is in which team, and teams only their members see. A
  // guest invite names its teams. An attachment may belong to the team it was uploaded in (NULL: the workspace's).
  // Everyone is in every team today, so nothing changes for anyone: every workspace member (people, agents and
  // integrations; suspended ones too, for when they're reinstated) joins every team of their workspace, all public.
  `
  CREATE TABLE team_members (
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id)
  );
  CREATE INDEX team_members_user ON team_members(user_id);
  ALTER TABLE teams ADD COLUMN private INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1));
  ALTER TABLE codes ADD COLUMN teams TEXT; -- an invite's teams: JSON array of team ids
  ALTER TABLE attachments ADD COLUMN team_id INTEGER REFERENCES teams(id);
  INSERT INTO team_members (team_id, user_id, created_at)
    SELECT t.id, m.user_id, MAX(t.created_at, m.created_at) FROM teams t JOIN workspace_members m ON m.workspace = t.workspace;
  `,
  // Push notifications (Web Push): a device's browser subscription, made in a signed-in session and gone with it
  // (sign-out, revoke), and the server's VAPID key pair, made on first use. Changes no row.
  `
  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE, -- the push service's URL for this device
    p256dh TEXT NOT NULL,          -- the device's public key (base64url): payloads are encrypted to it
    auth TEXT NOT NULL,            -- the device's auth secret (base64url)
    created_at TEXT NOT NULL
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
  CREATE INDEX push_subscriptions_session ON push_subscriptions(session_id);
  CREATE TABLE vapid_keys (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // Docket no longer mints session-bound keys (migration 3's): delete any left. api_keys keeps the expires_at and
  // session_id columns, unused (dropping a foreign-key column means rebuilding the table).
  `
  DELETE FROM api_keys WHERE session_id IS NOT NULL;
  `,
];

db.run("PRAGMA foreign_keys = OFF"); // a migration may rebuild a table (SQLite's 12-step ALTER); checked before each commit
const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
MIGRATIONS.slice(user_version).forEach((step, i) =>
  db.transaction(() => {
    if (typeof step === "string") db.run(step);
    else step();
    const broken = db.query("PRAGMA foreign_key_check").all();
    if (broken.length) throw new Error(`Migration ${user_version + i + 1} broke foreign keys: ${JSON.stringify(broken.slice(0, 5))}`);
    db.run(`PRAGMA user_version = ${user_version + i + 1}`);
  })(),
);
db.run("PRAGMA foreign_keys = ON");

// --- Change events ---

let listener: (event: ServerEvent, userId?: number) => void = () => {};

/**
 * Called after every committed mutation: the server sends it over /ws to the workspace's members, or with
 * `userId` (an inbox, a subscription) only to that user's sockets in the workspace.
 */
export function onChange(fn: typeof listener) {
  listener = fn;
}

export function changed(entity: ServerEvent["entity"], workspace: string, id: string, userId?: number) {
  listener({ type: "changed", entity, workspace, id }, userId);
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
const MAX_LENGTH: Record<string, number> = { title: 500, name: 200, "workspace name": 200, label: 200, body: 100_000, description: 100_000, content: 500_000 };

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

// --- Mentions: tracker.ts records them on every save of a text; migration 9 backfilled older texts the same way ---

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
  const candidates = mentionCandidates(typing ? text.replace(/@[a-z0-9._-]*$/i, "") : text);
  if (!candidates.length) return new Set();
  const members = new Map(
    db
      .query<{ username: string; user_id: number }, [string]>("SELECT username, user_id FROM workspace_members WHERE workspace = ? AND suspended_at IS NULL")
      .all(workspace)
      .map((m) => [m.username, m.user_id]),
  );
  return new Set(candidates.map((c) => members.get(mentionOf(c, (u) => members.has(u)) ?? "")).filter((id) => id !== undefined));
}

/**
 * Records every text's mentions as its last save would have (migration 9): by its last author (a description's
 * last editor, else the issue's creator; a doc's last version's author), at that save's time, never the author
 * themselves. Mentions already recorded stay as they are.
 */
function backfillMentions() {
  type Text = { source: string; issue_id: number | null; document_id: number | null; workspace: string; text: string; author_id: number; time: string; typing: number };
  const texts = db
    .query<Text, []>(
      `SELECT 'issue:' || i.id AS source, i.id AS issue_id, NULL AS document_id, t.workspace, i.description AS text,
         COALESCE((SELECT actor_id FROM issue_activity x WHERE x.issue_id = i.id AND x.kind = 'description' ORDER BY x.id DESC LIMIT 1), i.creator_id) AS author_id,
         i.updated_at AS time, 0 AS typing
       FROM issues i JOIN teams t ON t.id = i.team_id
       UNION ALL
       SELECT 'comment:' || c.id, c.issue_id, NULL, t.workspace, c.body, c.author_id, COALESCE(c.edited_at, c.created_at), 0
       FROM comments c JOIN issues i ON i.id = c.issue_id JOIN teams t ON t.id = i.team_id
       UNION ALL
       SELECT 'document:' || d.id, NULL, d.id, d.workspace, d.content,
         COALESCE((SELECT author_id FROM document_versions v WHERE v.document_id = d.id ORDER BY v.id DESC LIMIT 1), d.updated_by_id), d.updated_at, 1
       FROM documents d
       UNION ALL
       SELECT 'document_comment:' || c.id, NULL, c.document_id, d.workspace, c.body, c.author_id, COALESCE(c.edited_at, c.created_at), 0
       FROM document_comments c JOIN documents d ON d.id = c.document_id`,
    )
    .all();
  const insert = db.query("INSERT OR IGNORE INTO mentions (source, user_id, issue_id, document_id, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const t of texts) {
    for (const id of mentionedIn(t.workspace, t.text, t.typing === 1)) {
      if (id !== t.author_id) insert.run(t.source, id, t.issue_id, t.document_id, t.author_id, t.time);
    }
  }
}

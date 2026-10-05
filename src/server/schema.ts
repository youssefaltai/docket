// The schema: the baseline a new database starts from, the migrations since, and the runner that applies them.
import type { Store } from "./store.ts";

/** A step up by one schema version: SQL, or a function for what SQL can't do (backfills, checks). */
export type Migration = string | ((db: Store) => void);

/**
 * The schema at user_version 29, as migrations 1-29 left it: their sqlite_master, verbatim, so a new database
 * is identical to one they upgraded (hence the columns tacked onto the end of some tables). A database at 1-28
 * upgrades through the release tagged `migrations-v29` first, the last one that has them.
 */
const BASELINE_VERSION = 29;
const BASELINE = `
CREATE TABLE workspaces (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
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
  , expires_at TEXT, session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE, workspace TEXT REFERENCES workspaces(key) ON DELETE CASCADE);
CREATE INDEX api_keys_user ON api_keys(user_id);
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
  , teams TEXT);
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
  , parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE, resolved_at TEXT, resolved_by_id INTEGER REFERENCES users(id));
CREATE INDEX comments_issue ON comments(issue_id);
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
  , parent_id INTEGER REFERENCES document_comments(id) ON DELETE CASCADE, resolved_at TEXT, resolved_by_id INTEGER REFERENCES users(id));
CREATE INDEX document_comments_document ON document_comments(document_id);
CREATE INDEX api_keys_expires ON api_keys(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX api_keys_session ON api_keys(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX api_keys_workspace ON api_keys(user_id, workspace);
CREATE TABLE "workspace_members" (
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
CREATE INDEX workspace_members_user ON workspace_members(user_id);
CREATE TABLE "users" (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
    email TEXT,
    created_at TEXT NOT NULL
  , system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)));
CREATE UNIQUE INDEX users_email ON users(lower(email)) WHERE email IS NOT NULL;
CREATE TABLE "teams" (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(key),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, default_status TEXT NOT NULL DEFAULT 'backlog', auto_close_parent INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_parent IN (0, 1)), auto_close_children INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_children IN (0, 1)), auto_archive_days INTEGER, estimate_scale TEXT CHECK (estimate_scale IN ('exponential', 'fibonacci', 'linear', 'tshirt')), cycle_weeks INTEGER CHECK (cycle_weeks BETWEEN 1 AND 8), upcoming_cycles INTEGER NOT NULL DEFAULT 2 CHECK (upcoming_cycles BETWEEN 1 AND 15), private INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
    UNIQUE (workspace, key)
  );
CREATE TABLE "issues" (
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
    deleted_at TEXT, due_on TEXT, archived_at TEXT, estimate INTEGER CHECK (estimate BETWEEN 1 AND 5), project_id INTEGER REFERENCES projects(id), milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL, cycle_id INTEGER REFERENCES cycles(id) ON DELETE SET NULL,
    UNIQUE (team_id, number)
  );
CREATE TABLE "documents" (
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
    deleted_at TEXT, project_id INTEGER REFERENCES projects(id),
    UNIQUE (workspace, slug)
  );
CREATE INDEX issues_parent ON issues(parent_id);
CREATE INDEX issues_deleted ON issues(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX documents_team ON documents(team_id, position);
CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
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
CREATE TABLE issue_relations (
    from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('related', 'duplicate')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
CREATE INDEX issue_relations_to ON issue_relations(to_id, kind);
CREATE INDEX issues_due ON issues(due_on) WHERE due_on IS NOT NULL;
CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX document_comments_parent ON document_comments(parent_id) WHERE parent_id IS NOT NULL;
CREATE TABLE reactions (
    target TEXT NOT NULL,   -- 'issue:<id>' (the description), 'comment:<id>', 'document_comment:<id>'
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,       -- the issue it's on (purge cascades)
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, -- the doc it's on
    created_at TEXT NOT NULL,
    PRIMARY KEY (target, user_id, emoji)
  );
CREATE TABLE attachments (
    id TEXT PRIMARY KEY,           -- 16 random bytes, base64url; also the file's name on disk
    workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
    name TEXT NOT NULL,            -- the uploaded file's name, sanitized
    content_type TEXT NOT NULL,    -- sniffed by Docket, never the client's claim
    size INTEGER NOT NULL,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  , team_id INTEGER REFERENCES teams(id));
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
CREATE UNIQUE INDEX users_system ON users(system) WHERE system = 1;
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
CREATE TABLE issue_aliases (
    team_id INTEGER NOT NULL REFERENCES teams(id),
    number INTEGER NOT NULL,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, number)
  );
CREATE INDEX issue_aliases_issue ON issue_aliases(issue_id);
CREATE INDEX issues_archived ON issues(archived_at) WHERE archived_at IS NOT NULL;
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
CREATE INDEX issues_project ON issues(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX documents_project ON documents(project_id) WHERE project_id IS NOT NULL;
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
CREATE TABLE cycles (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    number INTEGER NOT NULL,  -- 1, 2, 3… per team
    starts_at TEXT NOT NULL,  -- ISO, 00:00 UTC
    ends_at TEXT NOT NULL,    -- exclusive: the next cycle's starts_at (or when cycles were turned off)
    completed_at TEXT,        -- set when it ended and its unfinished issues rolled over
    UNIQUE (team_id, number)
  );
CREATE INDEX issues_cycle ON issues(cycle_id) WHERE cycle_id IS NOT NULL;
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
    state TEXT CHECK (state IN ('draft', 'open', 'merged', 'closed')), -- PRs; commits: merged once pushed to the default branch
    closes INTEGER NOT NULL CHECK (closes IN (0, 1)), -- 1: closing (branch, title or closing word); 0: contributing
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (issue_id, url)
  );
CREATE TABLE team_members (
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id)
  );
CREATE INDEX team_members_user ON team_members(user_id);
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
`;

// Migration 30's built-in roles and what a write API key could do, as they were then: later changes to the defaults
// (shared/types.ts) mustn't change what this migration did.
const CONTENT_30 = ["issues.write", "comments.write", "docs.write", "files.upload", "projects.write", "inbox.manage"];
const MEMBER_30 = [
  "workspace.browse", "teams.create", "teams.join", "team.members", "team.settings", "team.workflow", "team.templates",
  "labels.create", "labels.workspace", "labels.team", "views.create", ...CONTENT_30, "trash.purge",
];
const ROLES_30: [key: string, name: string, permissions: string[]][] = [
  ["admin", "Admin", [
    "workspace.browse", "workspace.rename", "workspace.delete", "roles.manage", "members.assign_role", "members.suspend", "members.invite",
    "agents.manage", "webhooks.manage", "github.manage", "teams.create", "teams.join", "teams.manage_any", "team.members", "team.privacy",
    "team.roles", "team.delete", "team.settings", "team.workflow", "team.templates", "labels.create", "labels.workspace", "labels.team",
    "views.create", "views.manage_any", ...CONTENT_30, "trash.purge",
  ]],
  ["member", "Member", MEMBER_30],
  ["guest", "Guest", ["labels.team", ...CONTENT_30]],
  ["agent", "Agent", ["workspace.browse", "teams.create", "team.settings", "labels.create", "views.create", ...CONTENT_30]],
];
const WRITE_KEY_30 = [
  "workspace.browse", "workspace.rename", "teams.create", "team.settings", "team.workflow", "team.templates", "labels.create",
  "labels.workspace", "labels.team", "views.create", "views.manage_any", ...CONTENT_30,
];

// Append-only: each entry upgrades the schema by one user_version past the baseline (the first to 30).
const MIGRATIONS: Migration[] = [
  // 30: roles, sets of permissions per workspace. Each workspace gets the built-in four; members and invites point at
  // theirs (role stays, as the built-in key, for one release). A key gets a cap: a read key nothing, a person's write key
  // what write keys could do; an agent's token (NULL) all its role's. team_members.role_id: a team's own role (none yet).
  (db) => {
    db.run(`CREATE TABLE roles (
      id INTEGER PRIMARY KEY,
      workspace TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      builtin TEXT CHECK (builtin IN ('admin', 'member', 'guest', 'agent')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace, key)
    )`);
    db.run(`CREATE TABLE role_permissions (
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      PRIMARY KEY (role_id, permission)
    ) WITHOUT ROWID`);
    db.run("ALTER TABLE workspace_members ADD COLUMN role_id INTEGER REFERENCES roles(id)");
    db.run("ALTER TABLE team_members ADD COLUMN role_id INTEGER REFERENCES roles(id)");
    db.run("ALTER TABLE codes ADD COLUMN role_id INTEGER REFERENCES roles(id)");
    db.run("ALTER TABLE api_keys ADD COLUMN permissions TEXT"); // JSON array; NULL: the role's
    const time = new Date().toISOString();
    const role = db.query<{ id: number }, [string, string, string, string, string, string]>(
      "INSERT INTO roles (workspace, key, name, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    );
    const grant = db.query("INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)");
    for (const { key } of db.query<{ key: string }, []>("SELECT key FROM workspaces").all()) {
      for (const [builtin, name, permissions] of ROLES_30) {
        const { id } = role.get(key, builtin, name, builtin, time, time)!;
        for (const p of permissions) grant.run(id, p);
      }
    }
    const roleOf = (table: string) => `(SELECT r.id FROM roles r WHERE r.workspace = ${table}.workspace AND r.key = ${table}.role)`;
    db.run(`UPDATE workspace_members SET role_id = ${roleOf("workspace_members")}`);
    db.run(`UPDATE codes SET role_id = ${roleOf("codes")} WHERE role IS NOT NULL`);
    db.run("UPDATE api_keys SET permissions = '[]' WHERE scope = 'read'");
    db.query("UPDATE api_keys SET permissions = ? WHERE scope = 'write' AND user_id IN (SELECT id FROM users WHERE kind = 'person')").run(JSON.stringify(WRITE_KEY_30));
  },
];

/**
 * Brings the schema up to date, or throws and changes nothing it hasn't committed. A new database (version 0)
 * gets the baseline, then every migration; an existing one the migrations it lacks. Each runs in its own transaction
 * with foreign keys off (it may rebuild a table: SQLite's 12-step ALTER), and PRAGMA foreign_key_check must pass
 * before it commits, else it rolls back. Foreign keys are on afterwards.
 *
 * `durable`: a Durable Object's database, which refuses PRAGMA user_version and turning foreign keys off. Its version
 * is in a `docket_meta` row, and a migration runs with foreign keys deferred to the commit instead: still checked,
 * but a dropped table's ON DELETE actions fire, so a table rebuild there must not drop a referenced table.
 */
export function migrate(db: Store, migrations = MIGRATIONS, durable = false) {
  if (durable) db.run("CREATE TABLE IF NOT EXISTS docket_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  const user_version = durable
    ? (db.query<{ value: number }>("SELECT value FROM docket_meta WHERE key = 'schema_version'").get()?.value ?? 0)
    : db.query<{ user_version: number }>("PRAGMA user_version").get()!.user_version;
  if (user_version < 0) throw new Error(`This database's schema version is ${user_version}: not one Docket wrote. Refusing to start.`);
  if (user_version > 0 && user_version < BASELINE_VERSION) {
    throw new Error(
      `This database is at schema version ${user_version}; this Docket starts from ${BASELINE_VERSION}. ` +
        `Upgrade through the release tagged migrations-v29 first (start it once on this database), then run this one.`,
    );
  }
  const steps = [BASELINE, ...migrations]; // steps[i] brings the schema to BASELINE_VERSION + i
  const done = user_version === 0 ? 0 : user_version - BASELINE_VERSION + 1;
  if (!durable) db.run("PRAGMA foreign_keys = OFF");
  steps.slice(done).forEach((step, i) => {
    const version = BASELINE_VERSION + done + i;
    db.transaction(() => {
      if (durable) db.run("PRAGMA defer_foreign_keys = ON");
      if (typeof step === "string") db.run(step);
      else step(db);
      const broken = db.query("PRAGMA foreign_key_check").all();
      if (broken.length) throw new Error(`Migration ${version} broke foreign keys: ${JSON.stringify(broken.slice(0, 5))}`);
      if (durable) db.query("INSERT OR REPLACE INTO docket_meta (key, value) VALUES ('schema_version', ?)").run(version);
      else db.run(`PRAGMA user_version = ${version}`);
    })();
  });
  if (!durable) db.run("PRAGMA foreign_keys = ON");
}

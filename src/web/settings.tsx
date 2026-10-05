// Settings: your account (profile, devices, API keys) and the workspace (members, roles, invites, agents, webhooks, GitHub),
// each part for those whose role lets them manage it.
import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  CATEGORY_COLORS,
  DUPLICATE_STATUS,
  ESTIMATE_SCALES,
  BROWSER_ONLY,
  ESTIMATE_VALUES,
  LEGACY_WRITE_KEY,
  PERMISSIONS,
  PRIORITY_LABELS,
  TEAM_PERMISSIONS,
  STATUS_CATEGORIES,
  type ApiKey,
  type ApiKeyScope,
  type CodeLink,
  type EstimateScale,
  type IssueTemplate,
  type Label,
  type LabelPatch,
  type Permission,
  type Priority,
  type Session,
  type StatusCategory,
  type Team,
  type TeamPatch,
  type Webhook,
  type WebhookDelivery,
  type WebhookResource,
  type WorkflowStatusPatch,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceRole,
} from "../shared/types";
import { api, getCurrentWorkspace } from "./api";
import { auth, can, getMe, getYou, managesWorkspace } from "./auth";
import { disablePush, enablePush, pushState, testPush, type PushState } from "./push";
import { TeamMembers } from "./teams";
import { LabelsPicker, Picker, PriorityPicker, RowMenu, StatusPicker, statusOptions } from "./pickers";
import {
  ask,
  Avatar,
  CopyIcon,
  EmptyState,
  Field,
  InlineInput,
  LabelDot,
  ListHeader,
  MenuButton,
  PlusIcon,
  PriorityIcon,
  Section,
  StatusIcon,
  Switch,
  Tabs,
  TagIcon,
  TeamMark,
  TeamNotFound,
  ago,
  cls,
  copyText,
  errorToast,
  statusOf,
  teamStatuses,
  toast,
  useApp,
  useDebounced,
  useCan,
  useFetch,
  useLive,
  useTitle,
  useRun,
  type StatusLook,
  navigate,
} from "./ui";

export function SettingsPage({ section: asked }: { section: "account" | "workspace" }) {
  const { workspace } = useApp();
  const browse = useCan("workspace.browse"); // else (a guest) their settings are their account's alone
  const section = browse ? asked : "account";
  useTitle("Settings");
  return (
    <>
      <header className="header">
        <MenuButton />
        <div className="header-title">
          <span>Settings</span>
        </div>
        <Tabs
          label="Settings"
          tabs={[
            ["/settings/account", "Account", section === "account"],
            ...(!browse ? [] : [["/settings/workspace", "Workspace", section === "workspace"] as [string, string, boolean]]),
          ]}
        />
      </header>
      <div className="content">
        <div className="settings">
          {section === "account" ? (
            <AccountSettings />
          ) : workspace ? (
            <WorkspaceSettings key={workspace.key} workspace={workspace} />
          ) : (
            <EmptyState title="No workspace">Pick a workspace in the sidebar first.</EmptyState>
          )}
        </div>
      </div>
    </>
  );
}

// ---------- Shared bits ----------

/** Connects an MCP client to one workspace; the server's name says which. Local scope: the project it's run in. */
const mcpCommand = (token: string, workspace: string) =>
  `claude mcp add --transport http docket-${workspace} ${location.origin}/mcp --header "Authorization: Bearer ${token}"`;

interface Shown {
  lead?: ReactNode;
  value: string;
  note: string;
  copies: [label: string, text: string][];
}

const LINK_NOTE = "Expires in 15 minutes, works once.";
const TOKEN_NOTE = "Shown once. Treat it like a password.";
const COMMAND_NOTE = `${TOKEN_NOTE} Run it in the project folder the agent works in. Add --scope user to use it everywhere.`;
const linkSecret = (link: CodeLink, lead?: ReactNode, note = LINK_NOTE): Shown => ({ lead, value: link.url, note, copies: [["link", link.url]] });

/** A secret shown this one time: a link or a token, with copy buttons. */
function Secret({ lead, value, note, copies, onDone }: Shown & { onDone: () => void }) {
  return (
    <div className="secret">
      {lead && <p className="secret-lead">{lead}</p>}
      <div className="secret-box mono">{value}</div>
      <div className="secret-foot">
        <span className="secret-note">{note}</span>
        <span className="grow" />
        {copies.map(([what, text]) => (
          <button key={what} className="btn btn-sm" onClick={() => copyText(text, "Copied")}>
            <CopyIcon />
            Copy {what}
          </button>
        ))}
        <button className="btn btn-sm btn-ghost" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/** One secret at a time: `secret` renders it (null when there's none), `show` sets it. */
function useSecret() {
  const [shown, setShown] = useState<Shown | null>(null);
  return { secret: shown && <Secret {...shown} onDone={() => setShown(null)} />, show: setShown };
}

function Row({ icon, title, meta, dim, children }: { icon?: ReactNode; title: ReactNode; meta?: ReactNode; dim?: boolean; children?: ReactNode }) {
  return (
    <div className={cls("settings-row", dim && "dim")}>
      {icon}
      <div className="settings-row-main">
        <div className="settings-row-title">{title}</div>
        {meta && <div className="settings-row-meta">{meta}</div>}
      </div>
      {children}
    </div>
  );
}

/** A member's row: avatar, "name @username", dimmed when suspended or removed. */
function MemberRow({ m, meta, children }: { m: WorkspaceMember; meta: string; children?: ReactNode }) {
  return (
    <Row
      dim={!!m.suspendedAt}
      icon={<Avatar user={m.user} />}
      title={
        <>
          <span dir="auto">{m.user.name}</span> <span className="muted">@{m.user.username}</span>
        </>
      }
      meta={meta}
    >
      {children}
    </Row>
  );
}

const AddButton = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button className="btn btn-sm" onClick={onClick}>
    <PlusIcon />
    {children}
  </button>
);

const FormError = ({ error }: { error: string }) =>
  error && (
    <p className="settings-error" role="alert" dir="auto">
      {error}
    </p>
  );

const SaveButton = ({ disabled }: { disabled: boolean }) => (
  <div>
    <button className="btn btn-primary" disabled={disabled}>
      Save
    </button>
  </div>
);

const meta = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" · ");

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={cls("tab", v === value && "on")} aria-pressed={v === value} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

// ---------- Account ----------

function AccountSettings() {
  const { workspace } = useApp();
  return (
    <>
      {workspace && <Profile key={workspace.key} workspace={workspace} />}
      <Email />
      <SignInLink />
      <PushNotifications />
      <Sessions />
      {workspace && <ApiKeys key={workspace.key} workspace={workspace} />}
    </>
  );
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How you're known in the current workspace: each has its own name and username. */
function Profile({ workspace }: { workspace: Workspace }) {
  const [saved, setSaved] = useState(getYou);
  const [name, setName] = useState(saved.name);
  const [username, setUsername] = useState(saved.username);
  const [error, setError] = useState("");
  const { busy, run } = useRun();
  const patch = {
    name: name.trim() !== saved.name ? name.trim() : undefined,
    username: username.trim() !== saved.username ? username.trim() : undefined,
  };
  const dirty = patch.name !== undefined || patch.username !== undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || !name.trim() || !username.trim()) return;
    setError("");
    run(
      async () => {
        setSaved((await auth.updateProfile(workspace.key, patch)).user);
        toast("Profile saved");
      },
      (e) => setError(errorText(e)),
    );
  };
  return (
    <Section title={`Profile in ${workspace.name}`}>
      <p className="settings-hint" dir="auto">
        How people in {workspace.name} see you. Each workspace has its own.
      </p>
      <form className="settings-form" onSubmit={submit}>
        <Field label="Name">
          <input className="input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Username" hint="Used to assign issues and to mention you. Lowercase letters, digits, “.”, “_” and “-”.">
          <input className="input" autoCapitalize="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
        </Field>
        <FormError error={error} />
        <SaveButton disabled={!dirty || busy || !name.trim() || !username.trim()} />
      </form>
    </Section>
  );
}

/** Your account's email: contact info, the same in every workspace. */
function Email() {
  const [saved, setSaved] = useState(() => getMe().user.email ?? "");
  const [email, setEmail] = useState(saved);
  const [error, setError] = useState("");
  const { busy, run } = useRun();
  const dirty = email.trim() !== saved;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setError("");
    run(
      async () => {
        setSaved((await auth.updateMe({ email: email.trim() })).user.email ?? "");
        toast("Email saved");
      },
      (e) => setError(errorText(e)),
    );
  };
  return (
    <Section title="Email">
      <form className="settings-form" onSubmit={submit}>
        <Field label="Email" hint="Contact info, the same in all your workspaces.">
          <input className="input" type="email" autoCapitalize="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <FormError error={error} />
        <SaveButton disabled={!dirty || busy} />
      </form>
    </Section>
  );
}

function SignInLink() {
  const { secret, show } = useSecret();
  const { busy, run } = useRun();
  const create = () => run(async () => show(linkSecret(await auth.signInLink())));
  return (
    <Section title="Sign in on another device">
      <p className="settings-hint">Open the link on your phone or another computer to sign in there as you.</p>
      {secret ?? (
        <button className="btn" disabled={busy} onClick={create}>
          Get a sign-in link
        </button>
      )}
    </Section>
  );
}

const PUSH_HINTS: Record<PushState, string> = {
  unsupported: "This browser can't get push notifications.",
  install: "On iPhone and iPad, add Docket to your Home Screen (Share, then Add to Home Screen) and open it from there to turn them on.",
  blocked: "Notifications are blocked for Docket: allow them in this browser's or device's settings.",
  off: "Get a notification on this device for everything that reaches your inbox.",
  on: "This device gets a notification for everything that reaches your inbox.",
};

/** Push notifications on this device: your inbox, on its lock screen. */
function PushNotifications() {
  const [state, setState] = useState<PushState | null>(null);
  const { busy, run } = useRun();
  useEffect(() => {
    pushState().then(setState, () => setState("unsupported"));
  }, []);
  if (!state) return null;
  return (
    <Section title="Notifications">
      <p className="settings-hint">{PUSH_HINTS[state]}</p>
      {state === "off" && (
        <button className="btn" disabled={busy} onClick={() => run(async () => setState(await enablePush()))}>
          Turn on for this device
        </button>
      )}
      {state === "on" && (
        <div className="settings-inline">
          <button className="btn" disabled={busy} onClick={() => run(() => testPush().then(() => toast("Test notification sent")))}>
            Send a test
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => run(async () => setState(await disablePush()))}>
            Turn off
          </button>
        </div>
      )}
    </Section>
  );
}

// Edge also says Chrome and Safari, iPhones say "Mac OS X" and Android says "Linux": the first match wins.
const BROWSERS: [RegExp, string][] = [[/Edg\//, "Edge"], [/Firefox\/|FxiOS/, "Firefox"], [/Chrome\/|CriOS/, "Chrome"], [/Safari\//, "Safari"]];
const SYSTEMS: [RegExp, string][] = [[/iPhone/, "iPhone"], [/iPad/, "iPad"], [/Android/, "Android"], [/Mac OS X|Macintosh/, "Mac"], [/Windows/, "Windows"], [/Linux/, "Linux"]];
const find = (ua: string, list: [RegExp, string][]) => list.find(([re]) => re.test(ua))?.[1];

/** "Safari on iPhone" from a user agent, else the raw string, shortened. */
function device(ua: string): string {
  const browser = find(ua, BROWSERS);
  const os = find(ua, SYSTEMS);
  if (browser && os) return `${browser} on ${os}`;
  if (!ua) return "Unknown device";
  return ua.length > 60 ? `${ua.slice(0, 59)}…` : ua;
}

function Sessions() {
  const sessions = useFetch(() => auth.sessions(), []);
  const { busy, run } = useRun();
  const list = [...(sessions.data ?? [])].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt));
  const others = list.some((s) => !s.current);
  const revoke = (s: Session) => run(() => auth.revokeSession(s.id).then(sessions.reload));
  const revokeOthers = () => run(() => auth.revokeOtherSessions().then(sessions.reload));
  return (
    <Section
      title="Sessions"
      action={
        others && (
          <button className="btn btn-sm" disabled={busy} onClick={revokeOthers}>
            Sign out other devices
          </button>
        )
      }
    >
      <div className="settings-list">
        {list.map((s) => (
          <Row key={s.id} title={device(s.userAgent)} meta={meta(s.current && "This device", s.ip, `Active ${ago(s.lastSeenAt)}`)}>
            {!s.current && (
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => revoke(s)}>
                Revoke
              </button>
            )}
          </Row>
        ))}
      </div>
    </Section>
  );
}

type KeyAccess = ApiKeyScope | "custom";
const ACCESS_CHOICES: [KeyAccess, string][] = [
  ["read", "Read"],
  ["write", "Write"],
  ["custom", "Custom"],
];
/** What a key may do, in short: read only, what write keys do (everything but managing access), or its own list. */
const keyAccess = (k: ApiKey) =>
  k.scope === "read"
    ? "Read"
    : k.permissions === null
      ? "Everything your role allows"
      : k.permissions.length === LEGACY_WRITE_KEY.length && LEGACY_WRITE_KEY.every((p) => k.permissions!.includes(p))
        ? "Read & write"
        : `Custom: ${k.permissions.length === 1 ? "1 permission" : `${k.permissions.length} permissions`}`;
/** What a key can hold: nothing that's for the web app only. */
const KEYABLE = PERMISSIONS.filter((p) => !BROWSER_ONLY.includes(p));

/** This workspace's API keys: each acts only in the workspace it was made in. */
function ApiKeys({ workspace }: { workspace: Workspace }) {
  const keys = useFetch(() => auth.apiKeys().then((all) => all.filter((k) => k.workspace === workspace.key)), []);
  const [adding, setAdding] = useState(false);
  const { secret, show } = useSecret();
  const revoke = async (id: number, name: string) => {
    if (await ask(`Revoke the API key “${name}”? Anything using it stops working.`, "Revoke")) auth.revokeApiKey(id).then(keys.reload, errorToast);
  };
  const created = (token: string) => {
    setAdding(false);
    const command = mcpCommand(token, workspace.key);
    show({
      lead: "Connect an MCP client with this command, or copy the token for scripts.",
      value: command,
      note: COMMAND_NOTE,
      copies: [["command", command], ["token", token]],
    });
    keys.reload();
  };
  return (
    <Section
      title="API keys"
      action={!adding && <AddButton onClick={() => setAdding(true)}>New API key</AddButton>}
    >
      <p className="settings-hint" dir="auto">For scripts and MCP clients that act as you in {workspace.name}.</p>
      {secret}
      {adding && <NewApiKey workspace={workspace.key} onCancel={() => setAdding(false)} onCreated={created} />}
      {!!keys.data?.length && (
        <div className="settings-list">
          {keys.data.map((k) => (
            <Row
              key={k.id}
              title={<span dir="auto">{k.name}</span>}
              meta={meta(keyAccess(k), `Created ${ago(k.createdAt)}`, k.lastUsedAt ? `Last used ${ago(k.lastUsedAt)}` : "Never used")}
            >
              <button className="btn btn-sm btn-ghost" onClick={() => revoke(k.id, k.name)}>
                Revoke
              </button>
            </Row>
          ))}
        </div>
      )}
    </Section>
  );
}

function NewApiKey({ workspace, onCancel, onCreated }: { workspace: string; onCancel: () => void; onCreated: (token: string) => void }) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<KeyAccess>("read");
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const { busy, run } = useRun();
  const custom = access === "custom";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim())
      run(async () => onCreated((await auth.createApiKey(name.trim(), custom ? "write" : access, workspace, custom ? permissions : undefined)).token));
  };
  return (
    <form className="settings-form settings-card" onSubmit={submit}>
      <Field label="Name">
        <input className="input" autoFocus dir="auto" placeholder="Laptop scripts" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="field">
        <span>Access</span>
        <Choice label="Access" value={access} options={ACCESS_CHOICES} onChange={setAccess} />
      </div>
      {custom && <PermissionChecks value={permissions} onChange={setPermissions} list={KEYABLE} />}
      <FormButtons label="Create key" disabled={!name.trim() || busy} onCancel={onCancel} />
    </form>
  );
}

function FormButtons({ label, disabled, onCancel }: { label: string; disabled: boolean; onCancel: () => void }) {
  return (
    <div className="settings-buttons">
      <button type="button" className="btn" onClick={onCancel}>
        Cancel
      </button>
      <button className="btn btn-primary" disabled={disabled}>
        {label}
      </button>
    </div>
  );
}

// ---------- Workspace ----------

/** Renames the workspace (admins); its key, in every URL, never changes. */
function WorkspaceName({ workspace }: { workspace: Workspace }) {
  const { reloadTeams } = useApp();
  const [name, setName] = useState(workspace.name);
  const { busy, run } = useRun();
  const dirty = !!name.trim() && name.trim() !== workspace.name;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    run(async () => {
      await api.updateWorkspace(workspace.key, { name: name.trim() });
      reloadTeams(); // refetches the workspace list too
      toast("Saved");
    });
  };
  return (
    <Section title="Workspace">
      <form className="settings-form" onSubmit={submit}>
        <Field label="Name" hint={`Its key, ${workspace.key}, stays in every link.`}>
          <input className="input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <SaveButton disabled={!dirty || busy} />
      </form>
    </Section>
  );
}

/** Deleting a team or workspace for good: type its key to unlock the button. */
function DeleteZone({ what, name, gone, remove }: { what: "team" | "workspace"; name: string; gone: string; remove: () => Promise<unknown> }) {
  const [typed, setTyped] = useState("");
  const { busy, run } = useRun();
  return (
    <Section title={`Delete ${what}`}>
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim().toLowerCase() === name.toLowerCase()) run(remove);
        }}
      >
        <Field label={`Type ${name} to confirm`} hint={`Deletes the ${what} and ${gone}, for good. There is no undo; back up first if unsure.`}>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        <button className="btn btn-danger" disabled={busy || typed.trim().toLowerCase() !== name.toLowerCase()}>
          Delete {what}
        </button>
      </form>
    </Section>
  );
}

function WorkspaceSettings({ workspace }: { workspace: Workspace }) {
  const { members, teams, loadDirectory } = useApp();
  const live = useLive();
  const roles = useFetch(() => auth.roles(), [workspace.key, live]);
  const reload = () => {
    loadDirectory();
    roles.reload();
  };
  const people = members.filter((m) => m.user.kind === "person");
  const agents = members.filter((m) => m.user.kind === "agent");
  return (
    <>
      {!managesWorkspace() && <p className="settings-note">Only admins manage the workspace.</p>}
      {can("workspace.rename") && <WorkspaceName key={workspace.name} workspace={workspace} />}
      <Members workspace={workspace.key} members={people} roles={roles.data} reload={reload} />
      {can("roles.manage") && roles.data && <Roles roles={roles.data} reload={reload} />}
      <Labels team={null} />
      {can("members.invite") && roles.data && <Invite workspace={workspace.key} teams={teams ?? []} roles={roles.data} />}
      {(can("agents.manage") || can("members.assign_role")) && <Agents workspace={workspace.key} agents={agents} roles={roles.data} reload={reload} />}
      {can("webhooks.manage") && <Webhooks workspace={workspace.key} />}
      {can("github.manage") && <GitHub workspace={workspace.key} reload={loadDirectory} />}
      {can("workspace.delete") && (
        <DeleteZone
          what="workspace"
          name={workspace.key}
          gone="everything in it: teams, issues, docs, projects, members’ access, agents and files"
          remove={() => api.deleteWorkspace(workspace.key).then(() => location.assign("/"), errorToast)}
        />
      )}
    </>
  );
}

/** Whether you could give a role: you hold everything it does (in `team`, its team permissions). */
const grantable = (r: WorkspaceRole) => r.permissions.every((p) => can(p));

/** A role picker: roles you can't give are there but disabled. */
function RoleSelect({ label, roles, value, onChange, disabled }: { label: string; roles: WorkspaceRole[]; value: string; onChange: (key: string) => void; disabled?: boolean }) {
  return (
    <select className="input settings-select" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {roles.map((r) => (
        <option key={r.key} value={r.key} disabled={r.key !== value && !grantable(r)}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

/**
 * A member's role (members.assign_role), person or agent: not yours, not an integration's, nor one with more than you hold.
 * Moving someone to a role that doesn't browse the workspace (a guest's) asks first.
 */
function MemberRole({ m, roles, reload }: { m: WorkspaceMember; roles: WorkspaceRole[]; reload: () => void }) {
  const browses = m.permissions.includes("workspace.browse");
  const pick = async (key: string) => {
    const role = roles.find((r) => r.key === key)!;
    if (browses && !role.permissions.includes("workspace.browse")) {
      const note = `They'll see only the teams they're in${m.teams.length ? ` (${m.teams.join(", ")})` : ": none yet"}, and nothing workspace-wide.`;
      if (!(await ask(`Make ${m.user.name} ${role.name}? ${note}`, `Make ${role.name}`))) return;
    }
    auth.updateMember(getCurrentWorkspace()!, m.user.username, { role: key }).then(reload, errorToast);
  };
  return (
    <RoleSelect
      label={`${m.user.name}'s role`}
      roles={roles}
      value={m.roleKey}
      disabled={m.integration || m.user.username === getYou().username || !m.permissions.every((p) => can(p))}
      onChange={pick}
    />
  );
}

function Members({ workspace, members, roles, reload }: { workspace: string; members: WorkspaceMember[]; roles: WorkspaceRole[] | null; reload: () => void }) {
  const picker = can("members.assign_role") && roles;
  const update = (m: WorkspaceMember, patch: { suspended: boolean }) => auth.updateMember(workspace, m.user.username, patch).then(reload, errorToast);
  const suspend = async (m: WorkspaceMember) => {
    const note =
      "They lose access to this workspace and its API keys stop working; if it's their only workspace, they're signed out everywhere. What they wrote stays theirs.";
    if (await ask(`Suspend ${m.user.name}? ${note}`, "Suspend")) update(m, { suspended: true });
  };
  return (
    <Section title="Members" count={members.length}>
      <div className="settings-list">
        {members.map((m) => (
          <MemberRow
            key={m.user.username}
            m={m}
            meta={meta(
              m.email,
              !picker && m.roleName,
              !m.permissions.includes("workspace.browse") && (m.teams.join(", ") || "No teams"),
              m.suspendedAt && "Suspended",
            )}
          >
            {picker && <MemberRole m={m} roles={picker} reload={reload} />}
            {can("members.suspend") && (
              <RowMenu
                label={`Manage ${m.user.name}`}
                actions={[m.suspendedAt ? ["Reinstate", () => update(m, { suspended: false })] : ["Suspend", () => suspend(m)]]}
              />
            )}
          </MemberRow>
        ))}
      </div>
    </Section>
  );
}

// ---------- Roles ----------

const PERMISSION_LABELS: Record<Permission, string> = {
  "workspace.browse": "See the workspace: its public teams, people and views",
  "workspace.rename": "Rename the workspace",
  "workspace.delete": "Delete the workspace",
  "roles.manage": "Create and edit roles",
  "members.assign_role": "Change members' roles",
  "members.suspend": "Suspend members",
  "members.invite": "Invite people",
  "agents.manage": "Add agents and issue their tokens",
  "webhooks.manage": "Manage webhooks",
  "github.manage": "Connect GitHub",
  "teams.create": "Create teams",
  "teams.join": "Join public teams",
  "teams.manage_any": "Manage any team, private ones too",
  "team.members": "Add and remove a team's members",
  "team.privacy": "Make a team private or public",
  "team.roles": "Give roles in a team",
  "team.settings": "Change a team's settings",
  "team.workflow": "Change a team's workflow",
  "team.templates": "Manage a team's templates",
  "team.delete": "Delete a team",
  "labels.create": "Create workspace labels from an issue",
  "labels.workspace": "Manage workspace labels",
  "labels.team": "Manage a team's labels",
  "views.create": "Create views",
  "views.manage_any": "Edit and delete anyone's views",
  "issues.write": "Create and edit issues",
  "comments.write": "Comment",
  "docs.write": "Write docs",
  "files.upload": "Upload files",
  "projects.write": "Create and edit projects",
  "inbox.manage": "Use their inbox",
  "trash.purge": "Delete from the trash for good",
};

export const PERMISSION_GROUPS: [string, Permission[]][] = [
  ["Workspace", ["workspace.browse", "workspace.rename", "workspace.delete"]],
  ["Members and access", ["roles.manage", "members.assign_role", "members.suspend", "members.invite", "agents.manage", "webhooks.manage", "github.manage"]],
  [
    "Teams",
    ["teams.create", "teams.join", "teams.manage_any", "team.members", "team.privacy", "team.roles", "team.settings", "team.workflow", "team.templates", "team.delete"],
  ],
  ["Labels and views", ["labels.create", "labels.workspace", "labels.team", "views.create", "views.manage_any"]],
  ["Work", ["issues.write", "comments.write", "docs.write", "files.upload", "projects.write", "inbox.manage", "trash.purge"]],
];

/** Permissions as checkboxes by group (of `list`), tagged "per team" and "browser only"; those you don't hold are disabled. */
function PermissionChecks({ value, onChange, list = PERMISSIONS, readOnly }: { value: Permission[]; onChange: (v: Permission[]) => void; list?: readonly Permission[]; readOnly?: boolean }) {
  const toggle = (p: Permission) => onChange(value.includes(p) ? value.filter((x) => x !== p) : [...value, p]);
  return PERMISSION_GROUPS.map(([title, ps]) => {
    const shown = ps.filter((p) => list.includes(p));
    return (
      shown.length > 0 && (
        <div key={title} className="field">
          <span>{title}</span>
          <div className="permission-checks">
            {shown.map((p) => (
              <label key={p}>
                <input type="checkbox" checked={value.includes(p)} disabled={readOnly || !can(p)} onChange={() => toggle(p)} />
                {PERMISSION_LABELS[p]}
                {TEAM_PERMISSIONS.includes(p) && <span className="webhook-tag">per team</span>}
                {BROWSER_ONLY.includes(p) && <span className="webhook-tag">browser only</span>}
              </label>
            ))}
          </div>
        </div>
      )
    );
  });
}

type RoleDraft = Pick<WorkspaceRole, "name" | "description" | "permissions">;

/**
 * The workspace's roles (roles.manage): what each lets its members do, with how many hold it. You change a role only if you
 * hold everything it does and don't hold it yourself; Admin never changes: duplicate it. Deleting one moves its members on.
 */
function Roles({ roles, reload }: { roles: WorkspaceRole[]; reload: () => void }) {
  const [editing, setEditing] = useState<{ role: WorkspaceRole | null; from: RoleDraft; readOnly: boolean } | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceRole | null>(null);
  const yours = getMe().workspaces.find((w) => w.key === getCurrentWorkspace())?.roleKey;
  const editable = (r: WorkspaceRole) => r.builtin !== "admin" && r.key !== yours && grantable(r);
  const duplicate = (r: RoleDraft) => setEditing({ role: null, from: { ...r, name: `${r.name} copy`, permissions: r.permissions.filter((p) => can(p)) }, readOnly: false });
  const open = (r: WorkspaceRole) => setEditing({ role: r, from: r, readOnly: !editable(r) });
  const done = () => {
    setEditing(null);
    setDeleting(null);
    reload();
  };
  return (
    <Section
      title="Roles"
      count={roles.length}
      action={!editing && <AddButton onClick={() => setEditing({ role: null, from: { name: "", description: "", permissions: [] }, readOnly: false })}>New role</AddButton>}
    >
      <p className="settings-hint">A role is what its members may do. Give someone a role of their own in a team from the team's settings.</p>
      {editing && <RoleForm key={`${editing.role?.key}:${editing.from.name}`} {...editing} onCancel={() => setEditing(null)} onSaved={done} onDuplicate={duplicate} />}
      {deleting && <DeleteRole role={deleting} roles={roles} onCancel={() => setDeleting(null)} onDeleted={done} />}
      <div className="settings-list">
        {roles.map((r) => (
          <Row
            key={r.key}
            title={
              <>
                <span dir="auto">{r.name}</span> {r.builtin && <span className="webhook-tag">Built-in</span>}
              </>
            }
            meta={meta(r.description, r.members === 1 ? "1 member" : `${r.members} members`, `${r.permissions.length} of ${PERMISSIONS.length} permissions`)}
          >
            <RowMenu
              label={`Manage ${r.name}`}
              actions={[
                [editable(r) ? "Edit" : "View", () => open(r)],
                ["Duplicate", () => duplicate(r)],
                ...(!r.builtin && editable(r) ? [["Delete", () => setDeleting(r)] as [string, () => void]] : []),
              ]}
            />
          </Row>
        ))}
      </div>
    </Section>
  );
}

function RoleForm({
  role,
  from,
  readOnly,
  onCancel,
  onSaved,
  onDuplicate,
}: {
  role: WorkspaceRole | null;
  from: RoleDraft;
  readOnly: boolean;
  onCancel: () => void;
  onSaved: () => void;
  onDuplicate: (r: RoleDraft) => void;
}) {
  const [name, setName] = useState(from.name);
  const [description, setDescription] = useState(from.description);
  const [permissions, setPermissions] = useState(from.permissions);
  const [error, setError] = useState("");
  const { busy, run } = useRun();
  const ready = !readOnly && !!name.trim() && !busy;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const input = { name: name.trim(), description: description.trim(), permissions };
    run(
      async () => {
        await (role ? auth.updateRole(role.key, input) : auth.createRole(input));
        onSaved();
      },
      (e) => setError(errorText(e)),
    );
  };
  return (
    <form className="settings-form settings-card" onSubmit={submit}>
      <Field label="Name">
        <input className="input" autoFocus={!readOnly} dir="auto" placeholder="Contractor" readOnly={readOnly} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description">
        <input className="input" dir="auto" readOnly={readOnly} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <PermissionChecks value={permissions} onChange={setPermissions} readOnly={readOnly} />
      <FormError error={error} />
      {readOnly ? (
        <div className="settings-buttons">
          <button type="button" className="btn" onClick={() => onDuplicate(from)}>
            Duplicate
          </button>
          <button type="button" className="btn btn-primary" onClick={onCancel}>
            Done
          </button>
        </div>
      ) : (
        <FormButtons label={role ? "Save" : "Create role"} disabled={!ready} onCancel={onCancel} />
      )}
    </form>
  );
}

/** Deleting a role: whoever holds it, in the workspace or a team, and its unused invites move to another you could give. */
function DeleteRole({ role, roles, onCancel, onDeleted }: { role: WorkspaceRole; roles: WorkspaceRole[]; onCancel: () => void; onDeleted: () => void }) {
  const others = roles.filter((r) => r.key !== role.key);
  const [moveTo, setMoveTo] = useState(others.find((r) => r.key === "member" && grantable(r))?.key ?? others.find(grantable)?.key ?? "");
  const { busy, run } = useRun();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (moveTo) run(() => auth.deleteRole(role.key, moveTo).then(onDeleted));
  };
  return (
    <form className="settings-form settings-card" onSubmit={submit}>
      <Field label={`Delete ${role.name}`} hint={`${role.members ? `${role.members === 1 ? "Its 1 member" : `Its ${role.members} members`} and its` : "Its"} unused invites move to this role.`}>
        <RoleSelect label="Move to" roles={others} value={moveTo} onChange={setMoveTo} />
      </Field>
      <div className="settings-buttons">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-danger" disabled={!moveTo || busy}>
          Delete role
        </button>
      </div>
    </form>
  );
}

/**
 * An invite is a one-time link you hand over yourself: whoever opens it joins (there's no email to check) with the role
 * picked. One whose role doesn't browse the workspace (a guest's) names the teams they'll see (at least one): Linear's guests.
 */
function Invite({ workspace, teams, roles }: { workspace: string; teams: Team[]; roles: WorkspaceRole[] }) {
  const [role, setRole] = useState(roles.find((r) => r.key === "member" && grantable(r))?.key ?? roles.find(grantable)?.key ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const { secret, show } = useSecret();
  const { busy, run } = useRun();
  const chosen = roles.find((r) => r.key === role);
  const guest = !!chosen && !chosen.permissions.includes("workspace.browse");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const link = await auth.invite(workspace, role, guest ? picked : undefined);
      const who = guest ? <>{chosen.name} in {picked.join(", ")}</> : <>a new {chosen?.name}</>;
      show(linkSecret(link, <>Invite link for {who}.</>, "Send it to one person. Whoever opens it joins; it works once and expires in 15 minutes."));
    });
  };
  return (
    <Section title="Invite">
      {secret}
      <form className="settings-inline" onSubmit={submit}>
        <RoleSelect label="Role" roles={roles} value={role} onChange={setRole} />
        {guest && (
          <Picker
            label="Teams"
            multi
            options={teams.map((t) => ({ value: t.key, label: t.name, icon: <TeamMark id={t.key} /> }))}
            selected={picked}
            onPick={(key) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]))}
            className="btn btn-sm"
          >
            {picked.length ? picked.join(", ") : "Pick teams"}
          </Picker>
        )}
        <button className="btn btn-primary" disabled={busy || !chosen || (guest && !picked.length)}>
          Create invite link
        </button>
      </form>
    </Section>
  );
}

function Agents({ workspace, agents, roles, reload }: { workspace: string; agents: WorkspaceMember[]; roles: WorkspaceRole[] | null; reload: () => void }) {
  const [adding, setAdding] = useState(false);
  const { secret, show } = useSecret();
  const manage = can("agents.manage");
  const picker = can("members.assign_role") && roles;
  const showToken = (name: string, token: string) => {
    const command = mcpCommand(token, workspace);
    show({
      lead: <>Connect <strong dir="auto">{name}</strong> with this command.</>,
      value: command,
      note: COMMAND_NOTE,
      copies: [["command", command], ["token", token]],
    });
    reload();
  };
  const actions = (m: WorkspaceMember): [string, () => void][] => {
    const { name, username } = m.user;
    const newToken = async () => {
      // A removed agent comes back with a new token, so there's no old one to warn about.
      if (m.suspendedAt || (await ask(`Issue a new token for ${name}? The old token stops working.`, "New token")))
        auth.rotateAgentToken(workspace, username).then(({ token }) => showToken(name, token), errorToast);
    };
    const remove = async () => {
      if (await ask(`Remove ${name}? Its token stops working; what it wrote stays.`, "Remove")) auth.removeAgent(workspace, username).then(reload, errorToast);
    };
    return m.suspendedAt ? [["New token", newToken]] : [["New token", newToken], ["Remove", remove]];
  };
  return (
    <Section
      title="Agents"
      count={agents.length || undefined}
      action={manage && !adding && roles && <AddButton onClick={() => setAdding(true)}>Add agent</AddButton>}
    >
      <p className="settings-hint">Agents connect over MCP with their own token, and everything they write carries their name.</p>
      {secret}
      {adding && roles && (
        <NewAgent
          workspace={workspace}
          roles={roles}
          onCancel={() => setAdding(false)}
          onCreated={(name, token) => {
            setAdding(false);
            showToken(name, token);
          }}
        />
      )}
      {agents.length > 0 && (
        <div className="settings-list">
          {agents.map((m) =>
            m.integration ? (
              <MemberRow key={m.user.username} m={m} meta={meta("GitHub integration", m.suspendedAt && "Disconnected")} />
            ) : (
              <MemberRow key={m.user.username} m={m} meta={meta(!picker && m.roleName, m.suspendedAt ? "Removed" : `Added ${ago(m.joinedAt)}`)}>
                {picker && !m.suspendedAt && <MemberRole m={m} roles={picker} reload={reload} />}
                {manage && <RowMenu label={`Manage ${m.user.name}`} actions={actions(m)} />}
              </MemberRow>
            ),
          )}
        </div>
      )}
    </Section>
  );
}

function NewAgent({
  workspace,
  roles,
  onCancel,
  onCreated,
}: {
  workspace: string;
  roles: WorkspaceRole[];
  onCancel: () => void;
  onCreated: (name: string, token: string) => void;
}) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState(roles.find((r) => r.key === "agent" && grantable(r))?.key ?? roles.find(grantable)?.key ?? "");
  const { busy, run } = useRun();
  const ready = !!name.trim() && !!username.trim() && !!role && !busy;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    run(async () => {
      const { agent, token } = await auth.createAgent(workspace, name.trim(), username.trim(), role);
      onCreated(agent.name, token);
    });
  };
  return (
    <form className="settings-form settings-card" onSubmit={submit}>
      <Field label="Name">
        <input className="input" autoFocus dir="auto" placeholder="Claude (frontend)" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Username" hint="Used to delegate issues to it.">
        <input
          className="input"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="claude-frontend"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
        />
      </Field>
      <Field label="Role">
        <RoleSelect label="Role" roles={roles} value={role} onChange={setRole} />
      </Field>
      <FormButtons label="Add agent" disabled={!ready} onCancel={onCancel} />
    </form>
  );
}

// ---------- Webhooks ----------

const RESOURCES: [WebhookResource, string][] = [
  ["Issue", "Issues"],
  ["Comment", "Comments"],
  ["Document", "Documents"],
  ["Notification", "Agent notifications"],
];
const SIGNING_NOTE = "Shown once. Verify Docket-Signature (HMAC-SHA256 of the raw body) and reject a webhookTimestamp more than a minute off.";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const hookName = (h: Webhook) => h.label || hostOf(h.url);
const hookState = (h: Webhook) => (h.enabled ? "Enabled" : h.failures >= 10 ? "Disabled after 10 failed deliveries" : "Disabled");

/** "in 58m", "in 12s": how long until `iso`. */
function inTime(iso: string): string {
  const s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
  return s < 60 ? `in ${Math.ceil(s)}s` : s < 3600 ? `in ${Math.round(s / 60)}m` : `in ${Math.round(s / 3600)}h`;
}

function deliveryState(d: WebhookDelivery): string {
  if (d.status === "delivered") return `Delivered ${d.responseStatus}`;
  if (d.status === "failed") return `Failed: ${d.error}`;
  if (!d.nextAttemptAt) return "Pending";
  return d.attempts ? `${d.error}, retry ${inTime(d.nextAttemptAt)}` : `Pending, sends ${inTime(d.nextAttemptAt)}`;
}

/** Endpoints that get this workspace's changes as they happen, signed. */
function Webhooks({ workspace }: { workspace: string }) {
  const hooks = useFetch(() => auth.webhooks(workspace), [workspace]);
  const [editing, setEditing] = useState<Webhook | "new" | null>(null);
  const [log, setLog] = useState<number | null>(null);
  const { secret, show } = useSecret();
  const showSecret = (name: string, value: string) =>
    show({ lead: <>Signing secret for <strong dir="auto">{name}</strong>.</>, value, note: SIGNING_NOTE, copies: [["secret", value]] });
  const update = (h: Webhook, patch: { enabled: boolean }) => auth.updateWebhook(workspace, h.id, patch).then(hooks.reload, errorToast);
  const actions = (h: Webhook): [string, () => void][] => {
    const name = hookName(h);
    const rotate = async () => {
      if (await ask(`New signing secret for ${name}? The old one stops working at once.`, "New secret"))
        auth.rotateWebhookSecret(workspace, h.id).then(({ secret }) => showSecret(name, secret), errorToast);
    };
    const remove = async () => {
      if (await ask(`Delete the webhook ${name}? Its delivery log goes with it.`, "Delete")) auth.deleteWebhook(workspace, h.id).then(hooks.reload, errorToast);
    };
    return [
      ["Edit", () => setEditing(h)],
      [h.enabled ? "Disable" : "Enable", () => update(h, { enabled: !h.enabled })],
      ["New secret", rotate],
      [log === h.id ? "Hide deliveries" : "Deliveries", () => setLog(log === h.id ? null : h.id)],
      ["Delete", remove],
    ];
  };
  const saved = (h: Webhook, newSecret?: string) => {
    setEditing(null);
    if (newSecret) showSecret(hookName(h), newSecret);
    hooks.reload();
  };
  return (
    <Section
      title="Webhooks"
      count={hooks.data?.length || undefined}
      action={!editing && <AddButton onClick={() => setEditing("new")}>Add webhook</AddButton>}
    >
      <p className="settings-hint">
        Docket POSTs changes to your endpoint as they happen: issues, comments, docs, and your agents' notifications, so an agent can start when it's
        delegated an issue or mentioned.
      </p>
      {secret}
      {editing && <WebhookForm workspace={workspace} webhook={editing === "new" ? null : editing} onCancel={() => setEditing(null)} onSaved={saved} />}
      {!!hooks.data?.length && (
        <div className="settings-list">
          {hooks.data.map((h) => (
            <Fragment key={h.id}>
              <Row
                dim={!h.enabled}
                title={<span dir="auto">{hookName(h)}</span>}
                meta={
                  <>
                    <span className="mono">{h.url}</span>
                    <span className="webhook-tags">
                      <span className="webhook-tag">{hookState(h)}</span>
                      {RESOURCES.filter(([r]) => h.resourceTypes.includes(r)).map(([r, label]) => (
                        <span key={r} className="webhook-tag">
                          {label}
                        </span>
                      ))}
                    </span>
                  </>
                }
              >
                <RowMenu label={`Manage ${hookName(h)}`} actions={actions(h)} />
              </Row>
              {log === h.id && <Deliveries workspace={workspace} id={h.id} />}
            </Fragment>
          ))}
        </div>
      )}
    </Section>
  );
}

/** GitHub's webhook: PRs and commits link to issues by identifier and move them along, as the workspace's @github. */
function GitHub({ workspace, reload }: { workspace: string; reload: () => void }) {
  const github = useFetch(() => auth.github(workspace), [workspace]);
  const { secret, show } = useSecret();
  const { busy, run } = useRun();
  const done = () => {
    github.reload();
    reload(); // the members list: its account
  };
  const connect = () =>
    run(async () => {
      const { url, secret } = await auth.connectGitHub(workspace);
      show({
        lead: (
          <>
            In your GitHub repo or organization: Settings → Webhooks → Add webhook. Payload URL <span className="mono">{url}</span>, Content type
            application/json, this secret, and the events Pull requests and Pushes.
          </>
        ),
        value: secret,
        note: "Shown once.",
        copies: [
          ["URL", url],
          ["secret", secret],
        ],
      });
      done();
    });
  const actions: [string, () => void][] = [
    [
      "New secret",
      async () => {
        if (await ask("New secret for GitHub? The old one stops working at once: paste the new one into the webhook on GitHub.", "New secret")) connect();
      },
    ],
    [
      "Disconnect",
      async () => {
        if (await ask("Disconnect GitHub? Its deliveries are refused; issue history keeps what it did.", "Disconnect"))
          run(() => auth.disconnectGitHub(workspace).then(done));
      },
    ],
  ];
  const connection = github.data;
  return (
    <Section
      title="GitHub"
      action={
        connection &&
        !connection.connected && (
          <button className="btn btn-sm" disabled={busy} onClick={connect}>
            Connect GitHub
          </button>
        )
      }
    >
      <p className="settings-hint">
        Pull requests and commits that mention an issue (its branch name, title, or "Fixes BRD-12") are linked to it. Opening a PR moves the issue to
        In Review, and merging it to Done.
      </p>
      {secret}
      {connection?.connected && (
        <div className="settings-list">
          <Row
            icon={connection.account && <Avatar user={connection.account} />}
            title={<>Connected as @{connection.account?.username}</>}
            meta={<span className="mono">{connection.url}</span>}
          >
            <RowMenu label="Manage GitHub" actions={actions} />
          </Row>
        </div>
      )}
    </Section>
  );
}

function WebhookForm({
  workspace,
  webhook,
  onCancel,
  onSaved,
}: {
  workspace: string;
  webhook: Webhook | null;
  onCancel: () => void;
  onSaved: (h: Webhook, secret?: string) => void;
}) {
  const [url, setUrl] = useState(webhook?.url ?? "");
  const [label, setLabel] = useState(webhook?.label ?? "");
  const [types, setTypes] = useState<WebhookResource[]>(webhook?.resourceTypes ?? RESOURCES.map(([r]) => r));
  const [error, setError] = useState("");
  const { busy, run } = useRun();
  const ready = !!url.trim() && types.length > 0 && !busy;
  const toggle = (r: WebhookResource) => setTypes((t) => (t.includes(r) ? t.filter((x) => x !== r) : [...t, r]));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setError("");
    const input = { url: url.trim(), label: label.trim(), resourceTypes: types };
    run(
      async () => {
        if (webhook) onSaved(await auth.updateWebhook(workspace, webhook.id, input));
        else {
          const { webhook: created, secret } = await auth.createWebhook(workspace, input);
          onSaved(created, secret);
        }
      },
      (e) => setError(errorText(e)),
    );
  };
  return (
    <form className="settings-form settings-card" onSubmit={submit}>
      <Field label="URL" hint="Public https. Docket answers any 2xx as delivered, retries anything else, and never follows redirects.">
        <input
          className="input"
          autoFocus
          type="url"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://agents.example.com/docket"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <Field label="Label">
        <input className="input" dir="auto" placeholder="Agent runner" value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <div className="field">
        <span>Events</span>
        <div className="webhook-checks">
          {RESOURCES.map(([r, text]) => (
            <label key={r}>
              <input type="checkbox" checked={types.includes(r)} onChange={() => toggle(r)} />
              {text}
            </label>
          ))}
        </div>
      </div>
      <FormError error={error} />
      <FormButtons label={webhook ? "Save" : "Add webhook"} disabled={!ready} onCancel={onCancel} />
    </form>
  );
}

/** The newest 50 deliveries of one webhook. */
function Deliveries({ workspace, id }: { workspace: string; id: number }) {
  const log = useFetch(() => auth.webhookDeliveries(workspace, id), [workspace, id]);
  if (!log.data) return null;
  if (!log.data.length) return <div className="webhook-log settings-row settings-row-meta">No deliveries yet.</div>;
  return (
    <div className="webhook-log">
      {log.data.map((d) => (
        <Row
          key={d.id}
          dim={d.status === "failed"}
          title={
            <>
              {d.type} {d.action} <span className="mono">{d.entity}</span>
            </>
          }
          meta={meta(ago(d.createdAt), deliveryState(d), `${d.attempts} ${d.attempts === 1 ? "attempt" : "attempts"}`)}
        />
      ))}
    </div>
  );
}

// ---------- Templates ----------

/** A team's saved issue templates: named prefills for title, description, status, priority and labels. */
function Templates({ team }: { team: Team }) {
  const [templates, setTemplates] = useState<IssueTemplate[]>([]);
  const [adding, setAdding] = useState(false);
  const load = () => void api.templates(team.key).then(setTemplates, errorToast);
  useEffect(load, [team.key]);
  return (
    <Section
      title="Templates"
      count={templates.length || undefined}
      action={!adding && <AddButton onClick={() => setAdding(true)}>New template</AddButton>}
    >
      <p className="settings-hint">Prefill a new issue's title, description, status, priority and labels; picked from the Template control in the New issue modal.</p>
      {adding && <NewTemplate team={team} onDone={() => (setAdding(false), load())} />}
      {templates.length > 0 ? (
        <div className="settings-list">
          {templates.map((t) => (
            <TemplateRow key={t.id} team={team} template={t} onChange={load} />
          ))}
        </div>
      ) : (
        !adding && <p className="settings-note">No templates yet. Templates prefill a new issue's title, description, status, priority and labels.</p>
      )}
    </Section>
  );
}

/** One template: its inline-editable name, a summary of what it prefills, and Delete. */
function TemplateRow({ team, template, onChange }: { team: Team; template: IssueTemplate; onChange: () => void }) {
  const { teams } = useApp();
  const done = (p: Promise<unknown>) => p.then(onChange, errorToast);
  const status = statusOf(teams, team.key, template.status ?? team.defaultStatus);
  const summary = [
    template.title && `“${template.title}”`,
    status.name,
    template.priority ? PRIORITY_LABELS[template.priority] : null,
    template.labels.join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
  const remove = async () => {
    if (await ask(`Delete ${template.name}? Issues already created from it are unaffected.`, "Delete")) done(api.deleteTemplate(template.id));
  };
  return (
    <div className="settings-row workflow-row">
      <StatusIcon status={status} />
      <div className="settings-row-main">
        <InlineInput label="Template name" value={template.name} onSave={(name) => done(api.updateTemplate(template.id, { name }))} />
        {summary && <div className="muted">{summary}</div>}
      </div>
      <button className="btn btn-sm btn-ghost" onClick={remove}>
        Delete
      </button>
    </div>
  );
}

/** "New template": name, title, description, then status, priority and labels; Enter (in name) or the button adds it. */
function NewTemplate({ team, onDone }: { team: Team; onDone: () => void }) {
  const { teams } = useApp();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState(team.defaultStatus);
  const [priority, setPriority] = useState<Priority>(0);
  const [labels, setLabels] = useState<string[]>([]);
  const { busy, run } = useRun();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    run(async () => {
      await api.createTemplate({ team: team.key, name: name.trim(), title: title.trim(), description: description.trim(), status, priority, labels });
      onDone();
    });
  };
  return (
    <form className="settings-form" onSubmit={submit}>
      <Field label="Name">
        <input className="input" autoFocus dir="auto" placeholder="e.g. Bug report" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Title">
        <input className="input" dir="auto" placeholder="Prefilled title, e.g. Bug: " value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea className="input" dir="auto" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="settings-inline">
        <StatusPicker team={team.key} value={status} onChange={setStatus} className="btn btn-sm">
          <StatusIcon status={statusOf(teams, team.key, status)} />
          {statusOf(teams, team.key, status).name}
        </StatusPicker>
        <PriorityPicker value={priority} onChange={setPriority} className="btn btn-sm">
          <PriorityIcon priority={priority} />
          {priority ? PRIORITY_LABELS[priority] : "Priority"}
        </PriorityPicker>
        <LabelsPicker team={team.key} value={labels} onChange={setLabels} className="btn btn-sm">
          <TagIcon />
          {labels.length ? labels.join(", ") : "Labels"}
        </LabelsPicker>
      </div>
      <div className="settings-inline">
        <button className="btn btn-primary" disabled={!name.trim() || busy}>
          Add
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------- Labels ----------

const byName = (a: Label, b: Label) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * One scope's labels: the workspace's (workspace settings) or a team's own (team settings), each group's labels
 * under it. Everyone in the workspace manages them, as anyone creates one by naming it on an issue.
 */
function Labels({ team }: { team: string | null }) {
  const { labels } = useApp();
  const [adding, setAdding] = useState<"label" | "group" | null>(null);
  const scoped = labels.filter((l) => l.team === team);
  const top = scoped.filter((l) => l.group === null).sort(byName);
  const manage = useCan(team ? "labels.team" : "labels.workspace", team);
  return (
    <Section
      title="Labels"
      count={scoped.filter((l) => !l.isGroup).length || undefined}
      action={
        manage &&
        !adding && (
          <span className="settings-inline">
            <AddButton onClick={() => setAdding("group")}>New group</AddButton>
            <AddButton onClick={() => setAdding("label")}>New label</AddButton>
          </span>
        )
      }
    >
      <p className="settings-hint">
        {team
          ? `Only ${team}'s issues can use these; workspace labels are in workspace settings.`
          : "Every team's issues can use these; a team's own labels are in its settings. An issue takes one label per group."}
      </p>
      {adding && <NewLabel team={team} isGroup={adding === "group"} onDone={() => setAdding(null)} />}
      {top.length > 0 ? (
        <div className="settings-list">
          {top.map((l) => (
            <Fragment key={l.id}>
              <LabelRow label={l} />
              {l.isGroup && scoped.filter((c) => c.group === l.name).sort(byName).map((c) => <LabelRow key={c.id} label={c} />)}
            </Fragment>
          ))}
        </div>
      ) : (
        !adding && <p className="settings-note">No labels yet. Labels you add to issues show up here.</p>
      )}
    </Section>
  );
}

/** A label or group: its color (the dot opens a color input), inline-editable name, open count, and a menu. */
function LabelRow({ label }: { label: Label }) {
  const { labels, teams, loadDirectory } = useApp();
  const [color, setColor] = useState(label.color);
  const settled = useDebounced(color, 400); // a color input fires while dragging: save once it settles
  const [moving, setMoving] = useState<"group" | "scope" | null>(null);
  const done = (p: Promise<unknown>) => p.then(loadDirectory, errorToast);
  const update = (patch: LabelPatch) => done(api.updateLabel(label.id, patch));
  useEffect(() => setColor(label.color), [label.color]);
  useEffect(() => {
    if (settled !== label.color) update({ color: settled });
  }, [settled]);
  const groups = labels.filter((g) => g.isGroup && g.team === label.team && g.name !== label.group);
  const remove = async () => {
    const what = label.isGroup ? `the group ${label.name}` : label.path;
    if (await ask(`Delete ${what}? It comes off every issue that has it. This can't be undone.`, "Delete")) done(api.deleteLabel(label.id));
  };
  const actions: [string, () => void][] = [];
  if (!label.isGroup && (groups.length || label.group)) actions.push(["Move to group…", () => setMoving("group")]);
  if (!label.group) actions.push([label.team ? "Move to workspace or team…" : "Move to a team…", () => setMoving("scope")]);
  actions.push(["Delete", remove]);
  const options =
    moving === "group"
      ? [...(label.group ? [{ value: "", label: "No group" }] : []), ...groups.map((g) => ({ value: g.name, label: g.name, icon: <LabelDot color={g.color} /> }))]
      : [{ value: "", label: "Workspace" }, ...(teams ?? []).map((t) => ({ value: t.key, label: t.name, icon: <TeamMark id={t.key} /> }))].filter(
          (o) => o.value !== (label.team ?? ""),
        );
  return (
    <>
      <div className={cls("settings-row workflow-row", label.group && "label-child")}>
        <label className="status-color" title="Change color">
          <LabelDot color={color} />
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label={`${label.name} color`} />
        </label>
        <div className="settings-row-main">
          <InlineInput label={label.isGroup ? "Group name" : "Label name"} value={label.name} onSave={(name) => update({ name })} />
        </div>
        {label.isGroup && <span className="webhook-tag">Group</span>}
        <span className="muted workflow-key">{label.open} open</span>
        <RowMenu label={`${label.name} actions`} actions={actions} />
      </div>
      {moving && (
        <div className="settings-row settings-inline">
          <span className="grow">{moving === "group" ? "Move to group…" : "Move to…"}</span>
          <Picker
            label={moving === "group" ? "Move to group" : "Move to"}
            options={options}
            selected={[]}
            onPick={(to) => {
              setMoving(null);
              update(moving === "group" ? { group: to || null } : { team: to || null });
            }}
            className="btn btn-sm"
          >
            {moving === "group" ? "Pick a group" : "Pick a team"}
          </Picker>
          <button className="btn btn-sm btn-ghost" onClick={() => setMoving(null)}>
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

/** "New label" / "New group": a name (and a group for a label); Enter creates it in this section's scope. */
function NewLabel({ team, isGroup, onDone }: { team: string | null; isGroup: boolean; onDone: () => void }) {
  const { labels, loadDirectory } = useApp();
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const { busy, run } = useRun();
  const groups = isGroup ? [] : labels.filter((l) => l.isGroup && l.team === team).sort(byName);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    run(async () => {
      await api.createLabel({ name: name.trim(), team, isGroup, group: group || null });
      loadDirectory();
      onDone();
    });
  };
  return (
    <form className="settings-row settings-inline" onSubmit={submit}>
      <input
        className="input grow"
        autoFocus
        dir="auto"
        placeholder={isGroup ? "Group name, e.g. Type" : "Label name"}
        aria-label={isGroup ? "New group name" : "New label name"}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          onDone();
        }}
      />
      {groups.length > 0 && (
        <Picker
          label="Group"
          options={[{ value: "", label: "No group" }, ...groups.map((g) => ({ value: g.name, label: g.name, icon: <LabelDot color={g.color} /> }))]}
          selected={[group]}
          onPick={setGroup}
          className="btn btn-sm"
        >
          {group || "No group"}
        </Picker>
      )}
      <button className="btn btn-sm btn-primary" disabled={!name.trim() || busy}>
        Add
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

// ---------- Team ----------

const CATEGORY_NAMES: Record<StatusCategory, string> = {
  triage: "Triage",
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  completed: "Completed",
  canceled: "Canceled",
};

/** A team's settings (`/t/:key/settings`): its description, and its workflow. */
export function TeamSettingsPage({ teamKey }: { teamKey: string }) {
  const { teams, reloadTeams } = useApp();
  const team = teams?.find((t) => t.key === teamKey);
  // Each part for those whose role (in this team, if they have one of their own) lets them; anyone sees who's in it.
  const settings = useCan("team.settings", teamKey);
  useTitle(`Settings · ${team?.name ?? teamKey}`);
  return (
    <>
      <ListHeader team={team} title={teamKey} count={0} view="settings" />
      <div className="content">
        {teams && !team ? (
          <TeamNotFound teamKey={teamKey} back="/" backLabel="All issues" />
        ) : (
          team && (
            <div className="settings">
              {settings && <TeamGeneral key={team.key} team={team} />}
              <TeamMembers team={team} />
              {can("team.workflow", team.key) && <Workflow team={team} />}
              {settings && (
                <>
                  <Automations team={team} />
                  <Estimates team={team} />
                  <Cycles team={team} />
                </>
              )}
              {can("team.templates", team.key) && <Templates key={team.key} team={team} />}
              <Labels team={team.key} />
              {can("team.delete", team.key) && (
                <DeleteZone
                  what="team"
                  name={team.key}
                  gone="its issues, docs, cycles, workflow, templates and labels"
                  remove={() => api.deleteTeam(team.key).then(() => (navigate("/"), reloadTeams()), errorToast)}
                />
              )}
            </div>
          )
        )}
      </div>
    </>
  );
}

function TeamGeneral({ team }: { team: Team }) {
  const { reloadTeams } = useApp();
  const [description, setDescription] = useState(team.description);
  const { busy, run } = useRun();
  const dirty = description.trim() !== team.description;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    run(async () => {
      await api.updateTeam(team.key, { description: description.trim() });
      reloadTeams();
      toast("Saved");
    });
  };
  return (
    <Section title="General">
      <form className="settings-form" onSubmit={submit}>
        <Field label="Description">
          <textarea className="input" dir="auto" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <SaveButton disabled={!dirty || busy} />
      </form>
    </Section>
  );
}

/**
 * The team's statuses by category: add, rename, recolor, reorder, delete, make one the default; and the Triage
 * switch. Issues keep a status by its key, which never changes, so renaming touches no issue.
 */
function Workflow({ team }: { team: Team }) {
  const { teams, reloadTeams } = useApp();
  const statuses = teamStatuses(teams, team.key);
  const triage = statuses.find((s) => s.category === "triage");
  const [adding, setAdding] = useState<StatusCategory | null>(null);
  const toggleTriage = async () => {
    if (!triage) return api.createStatus(team.key, { category: "triage" }).then(reloadTeams, errorToast);
    const n = team.counts[triage.key] ?? 0;
    const to = statuses.find((s) => s.key === team.defaultStatus)?.name ?? team.defaultStatus;
    if (n && !(await ask(`Turn off Triage and move ${n} ${n === 1 ? "issue" : "issues"} to ${to}?`, "Turn off"))) return;
    api.deleteStatus(team.key, triage.key, team.defaultStatus).then(reloadTeams, errorToast);
  };
  return (
    <Section title="Workflow">
      <p className="settings-hint">New issues start in the default status. Renaming a status changes no issue.</p>
      <Switch checked={!!triage} onChange={toggleTriage} title="Triage">
        New issues from the Triage tab wait there until someone accepts them.
      </Switch>
      {STATUS_CATEGORIES.filter((c) => c !== "triage" || triage).map((category) => {
        const list = statuses.filter((s) => s.category === category);
        return (
          <div key={category} className="workflow-category">
            <div className="workflow-head">
              <h4>{CATEGORY_NAMES[category]}</h4>
              {category !== "triage" && (
                <button className="btn btn-ghost btn-sm" onClick={() => setAdding(category)}>
                  <PlusIcon />
                  Add status
                </button>
              )}
            </div>
            <div className="settings-list">
              {list.map((s, i) => (
                <StatusRow key={s.key} team={team} status={s} above={list.slice(Math.max(0, i - 2), i)} below={list.slice(i + 1, i + 3)} />
              ))}
              {adding === category && <NewStatus team={team} category={category} onDone={() => setAdding(null)} />}
            </div>
          </div>
        );
      })}
    </Section>
  );
}

// null (never, the default) or a number of days: after 1/3/6/12 months.
const ARCHIVE_OPTIONS: { label: string; days: number | null }[] = [
  { label: "Never", days: null },
  { label: "After 1 month", days: 30 },
  { label: "After 3 months", days: 90 },
  { label: "After 6 months", days: 180 },
  { label: "After 12 months", days: 365 },
];

/** Linear's auto-close switches, each saved as it's flipped; auto-archive's select likewise. */
function Automations({ team }: { team: Team }) {
  const { reloadTeams } = useApp();
  const toggle = (patch: { autoCloseParent: boolean } | { autoCloseChildren: boolean }) => api.updateTeam(team.key, patch).then(reloadTeams, errorToast);
  return (
    <Section title="Automations">
      <Switch checked={team.autoCloseParent} onChange={(autoCloseParent) => toggle({ autoCloseParent })} title="Auto-close parent issues">
        When all its sub-issues are done or canceled, a parent issue is marked done.
      </Switch>
      <Switch checked={team.autoCloseChildren} onChange={(autoCloseChildren) => toggle({ autoCloseChildren })} title="Auto-close sub-issues">
        When a parent issue is done or canceled, its open sub-issues follow.
      </Switch>
      <Field
        label="Auto-archive closed issues"
        hint="Completed and canceled issues are hidden from default views (still searchable, still open by link) once they've stayed closed this long."
      >
        <select
          className="input"
          value={team.autoArchiveDays ?? ""}
          onChange={(e) => api.updateTeam(team.key, { autoArchiveDays: e.target.value ? Number(e.target.value) : null }).then(reloadTeams, errorToast)}
        >
          {ARCHIVE_OPTIONS.map((o) => (
            <option key={o.label} value={o.days ?? ""}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    </Section>
  );
}

const SCALE_NAMES: Record<EstimateScale, string> = { exponential: "Exponential", fibonacci: "Fibonacci", linear: "Linear", tshirt: "T-shirt sizes" };

/** Linear's estimates, off by default: a switch, and the scale's select while it's on. Off hides issues' estimates but keeps them. */
function Estimates({ team }: { team: Team }) {
  const { reloadTeams } = useApp();
  const scale = team.estimateScale;
  const set = (estimateScale: EstimateScale | null) => api.updateTeam(team.key, { estimateScale }).then(reloadTeams, errorToast);
  return (
    <Section title="Estimates">
      <Switch checked={!!scale} onChange={(on) => set(on ? "fibonacci" : null)} title="Estimates">
        Size issues on a scale; lists and boards total them per status. Turning them off hides estimates without deleting them.
      </Switch>
      {scale && (
        <Field label="Scale">
          <select className="input" value={scale} onChange={(e) => set(e.target.value as EstimateScale)}>
            {ESTIMATE_SCALES.map((s) => (
              <option key={s} value={s}>
                {SCALE_NAMES[s]} ({ESTIMATE_VALUES[s].join(", ")})
              </option>
            ))}
          </select>
        </Field>
      )}
    </Section>
  );
}

const WEEKS = [1, 2, 3, 4, 5, 6, 7, 8];
const AHEAD = Array.from({ length: 15 }, (_, i) => i + 1);

/**
 * Linear's cycles, off by default. Switching them on asks where the first one starts and how long each lasts; while on,
 * the length and how many upcoming cycles to keep are saved as they're picked. Switching off asks first.
 */
function Cycles({ team }: { team: Team }) {
  const { reloadTeams } = useApp();
  const today = new Date().toISOString().slice(0, 10); // cycles run on UTC dates, as the server checks
  const [draft, setDraft] = useState<{ startsOn: string; weeks: number } | null>(null); // turning them on
  const save = (patch: TeamPatch) =>
    api.updateTeam(team.key, patch).then(() => {
      setDraft(null);
      reloadTeams();
    }, errorToast);
  const toggle = async (on: boolean) => {
    if (on) setDraft({ startsOn: today, weeks: 2 });
    else if (draft) setDraft(null);
    else if (await ask("Turn off cycles? The current cycle ends now and upcoming cycles are removed; their issues leave them.", "Turn off")) {
      save({ cycleWeeks: null });
    }
  };
  const weeks = (value: number, onChange: (weeks: number) => void) => (
    <select className="input" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {WEEKS.map((n) => (
        <option key={n} value={n}>
          {n === 1 ? "1 week" : `${n} weeks`}
        </option>
      ))}
    </select>
  );
  return (
    <Section title="Cycles">
      <Switch checked={!!team.cycleWeeks || !!draft} onChange={toggle} title="Use cycles">
        Plan work in repeating periods. When one ends, its unfinished issues move to the next.
      </Switch>
      {draft && (
        <>
          <Field label="Starts on" hint="Cycles start at 00:00 UTC, on this date's weekday.">
            <input className="input" type="date" min={today} value={draft.startsOn} onChange={(e) => setDraft({ ...draft, startsOn: e.target.value })} />
          </Field>
          <Field label="Length">{weeks(draft.weeks, (n) => setDraft({ ...draft, weeks: n }))}</Field>
          <div>
            <button className="btn btn-primary" disabled={!draft.startsOn} onClick={() => save({ cycleWeeks: draft.weeks, cycleStartsOn: draft.startsOn })}>
              Turn on cycles
            </button>
          </div>
        </>
      )}
      {team.cycleWeeks && (
        <>
          <Field label="Length" hint="Applies to cycles that haven't started; the current one keeps its dates.">
            {weeks(team.cycleWeeks, (cycleWeeks) => save({ cycleWeeks }))}
          </Field>
          <Field label="Plan ahead" hint="Upcoming cycles kept ready to plan into.">
            <select className="input" value={team.upcomingCycles} onChange={(e) => save({ upcomingCycles: Number(e.target.value) })}>
              {AHEAD.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "1 cycle" : `${n} cycles`}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
    </Section>
  );
}

/** One status: its color (the icon opens a color input), inline-editable name, key, and a menu. Duplicate is fixed. */
function StatusRow({ team, status, above, below }: { team: Team; status: StatusLook; above: StatusLook[]; below: StatusLook[] }) {
  const { teams, reloadTeams } = useApp();
  const [color, setColor] = useState(status.color);
  const settled = useDebounced(color, 400); // a color input fires while dragging: save once it settles
  const [moving, setMoving] = useState(false); // deleting a status in use: pick where its issues go
  const system = status.key === DUPLICATE_STATUS;
  const done = (p: Promise<unknown>) => p.then(reloadTeams, errorToast);
  const update = (patch: WorkflowStatusPatch) => done(api.updateStatus(team.key, status.key, patch));
  useEffect(() => setColor(status.color), [status.color]);
  useEffect(() => {
    if (settled !== status.color) update({ color: settled });
  }, [settled]);
  const inUse = team.counts[status.key] ?? 0;
  const remove = async () => {
    if (inUse) return setMoving(true);
    // Trashed issues can still be in it: they go to the default status.
    if (await ask(`Delete the status ${status.name}?`, "Delete")) done(api.deleteStatus(team.key, status.key, team.defaultStatus));
  };
  // Moving is to the midpoint between the two neighbours on that side, or one past the last.
  const [up1, up2, down1, down2] = [above.at(-1), above.at(-2), below[0], below[1]];
  const actions: [string, () => void][] = [];
  if (!system) {
    if ((status.category === "backlog" || status.category === "unstarted") && team.defaultStatus !== status.key) {
      actions.push(["Make default", () => done(api.updateTeam(team.key, { defaultStatus: status.key }))]);
    }
    if (up1) actions.push(["Move up", () => update({ position: up2 ? (up1.position + up2.position) / 2 : up1.position - 1 })]);
    if (down1) actions.push(["Move down", () => update({ position: down2 ? (down1.position + down2.position) / 2 : down1.position + 1 })]);
    actions.push(["Delete", remove]);
  }
  return (
    <>
      <div className="settings-row workflow-row">
        <label className={cls("status-color", system && "fixed")} title={system ? "Duplicate is a system status" : "Change color"}>
          <StatusIcon status={{ ...status, color }} />
          {!system && <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label={`${status.name} color`} />}
        </label>
        <div className="settings-row-main">
          {system ? <span dir="auto">{status.name}</span> : <InlineInput label="Status name" value={status.name} onSave={(name) => update({ name })} />}
        </div>
        {team.defaultStatus === status.key && <span className="webhook-tag">Default</span>}
        <span className="muted mono workflow-key">{status.key}</span>
        {actions.length > 0 ? <RowMenu label={`${status.name} actions`} actions={actions} /> : <span className="workflow-menu-space" />}
      </div>
      {moving && (
        <div className="settings-row settings-inline">
          <span className="grow">
            Move {inUse} {inUse === 1 ? "issue" : "issues"} to…
          </span>
          <Picker
            label="Move issues to"
            options={statusOptions(teamStatuses(teams, team.key).filter((s) => s.key !== status.key))}
            selected={[]}
            onPick={(to) => {
              setMoving(false);
              done(api.deleteStatus(team.key, status.key, to));
            }}
            className="btn btn-sm"
          >
            Pick a status
          </Picker>
          <button className="btn btn-sm btn-ghost" onClick={() => setMoving(false)}>
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

/** "+ Add status": an inline name field; Enter creates it, last in its category. */
function NewStatus({ team, category, onDone }: { team: Team; category: StatusCategory; onDone: () => void }) {
  const { reloadTeams } = useApp();
  const [name, setName] = useState("");
  const { busy, run } = useRun();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    run(async () => {
      await api.createStatus(team.key, { name: name.trim(), category });
      reloadTeams();
      onDone();
    });
  };
  return (
    <form className="settings-row settings-inline" onSubmit={submit}>
      <StatusIcon status={{ category, color: CATEGORY_COLORS[category] }} />
      <input
        className="input grow"
        autoFocus
        dir="auto"
        placeholder="Status name"
        aria-label="New status name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          onDone();
        }}
      />
      <button className="btn btn-sm btn-primary" disabled={!name.trim() || busy}>
        Add
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

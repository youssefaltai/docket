// Settings: your account (profile, devices, API keys) and, for admins, the workspace (members, invites, agents).
import { useState, type FormEvent, type ReactNode } from "react";
import type { ApiKeyScope, CodeLink, Session, WorkspaceMember } from "../shared/types";
import { auth, getMe, loadMe, mcpCommand } from "./auth";
import { Picker } from "./pickers";
import { Avatar, CopyIcon, EmptyState, Link, MenuButton, MoreIcon, PlusIcon, Section, ago, cls, errorToast, toast, useFetch } from "./ui";

type Tab = "account" | "workspace";

export function SettingsPage({ section, workspace }: { section: Tab; workspace: string | null }) {
  const tab = (t: Tab, label: string) => (
    <Link to={`/settings/${t}`} className={cls("tab", section === t && "on")} aria-current={section === t ? "page" : undefined}>
      {label}
    </Link>
  );
  return (
    <>
      <header className="header">
        <MenuButton />
        <div className="header-title">
          <span>Settings</span>
        </div>
        <nav className="tabs" aria-label="Settings">
          {tab("account", "Account")}
          {tab("workspace", "Workspace")}
        </nav>
      </header>
      <div className="content">
        <div className="settings">
          {section === "account" ? (
            <AccountSettings />
          ) : workspace ? (
            <WorkspaceSettings key={workspace} workspace={workspace} />
          ) : (
            <EmptyState title="No workspace">Pick a workspace in the sidebar first.</EmptyState>
          )}
        </div>
      </div>
    </>
  );
}

// ---------- Shared bits ----------

/** Runs one action at a time; failures toast unless `onError` handles them. */
function useRun() {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>, onError: (e: unknown) => void = errorToast) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`), errorToast);

interface Shown {
  lead?: ReactNode;
  value: string;
  note: string;
  copies: [label: string, text: string][];
}

const LINK_NOTE = "Expires in 15 minutes, works once.";
const TOKEN_NOTE = "Shown once. Treat it like a password.";
const linkSecret = (link: CodeLink, note = LINK_NOTE, lead?: ReactNode): Shown => ({ lead, value: link.url, note, copies: [["Link", link.url]] });

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
          <button key={what} className="btn btn-sm" onClick={() => copy(text, what)}>
            <CopyIcon />
            Copy {what.toLowerCase()}
          </button>
        ))}
        <button className="btn btn-sm btn-ghost" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
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

/** A row's "…" menu. */
function RowMenu({ label, actions, onPick }: { label: string; actions: [value: string, label: string][]; onPick: (value: string) => void }) {
  return (
    <Picker label={label} options={actions.map(([value, label]) => ({ value, label }))} selected={[]} onPick={onPick} className="icon-btn sm" align="end">
      <MoreIcon />
    </Picker>
  );
}

// ---------- Account ----------

function AccountSettings() {
  return (
    <>
      <Profile />
      <SignInLink />
      <Sessions />
      <ApiKeys />
    </>
  );
}

function Profile() {
  const [saved, setSaved] = useState(() => getMe().user);
  const [name, setName] = useState(saved.name);
  const [username, setUsername] = useState(saved.username);
  const [email, setEmail] = useState(saved.email ?? "");
  const [error, setError] = useState("");
  const { busy, run } = useRun();
  const patch = {
    name: name.trim() !== saved.name ? name.trim() : undefined,
    username: username.trim() !== saved.username ? username.trim() : undefined,
    email: email.trim() !== (saved.email ?? "") ? email.trim() : undefined,
  };
  const dirty = Object.values(patch).some((v) => v !== undefined);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || !name.trim() || !username.trim()) return;
    setError("");
    run(
      async () => {
        await auth.updateMe(patch);
        const me = await loadMe(); // refresh what getMe() returns elsewhere
        setSaved(me.user);
        toast("Profile saved");
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  };
  return (
    <Section title="Profile">
      <form className="settings-form" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input className="input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Username</span>
          <input className="input" autoCapitalize="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
          <small>Used to assign issues and to mention you. Lowercase letters, digits, “.”, “_” and “-”.</small>
        </label>
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" autoCapitalize="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {error && (
          <p className="settings-error" role="alert" dir="auto">
            {error}
          </p>
        )}
        <div>
          <button className="btn btn-primary" disabled={!dirty || busy || !name.trim() || !username.trim()}>
            Save
          </button>
        </div>
      </form>
    </Section>
  );
}

function SignInLink() {
  const [shown, setShown] = useState<Shown | null>(null);
  const { busy, run } = useRun();
  const create = () => run(async () => setShown(linkSecret(await auth.signInLink())));
  return (
    <Section title="Sign in on another device">
      <p className="settings-hint">Open the link on your phone or another computer to sign in there as you.</p>
      {shown ? (
        <Secret {...shown} onDone={() => setShown(null)} />
      ) : (
        <button className="btn" disabled={busy} onClick={create}>
          Get a sign-in link
        </button>
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

const SCOPES: [ApiKeyScope, string][] = [
  ["read", "Read"],
  ["write", "Read & write"],
];
const scopeLabel = (scope: ApiKeyScope) => SCOPES.find(([s]) => s === scope)![1];

function ApiKeys() {
  const keys = useFetch(() => auth.apiKeys(), []);
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const revoke = (id: number, name: string) => {
    if (confirm(`Revoke the API key “${name}”? Anything using it stops working.`)) auth.revokeApiKey(id).then(keys.reload, errorToast);
  };
  const created = (token: string) => {
    setAdding(false);
    setShown({ value: token, note: TOKEN_NOTE, copies: [["Token", token], ["MCP command", mcpCommand(token)]] });
    keys.reload();
  };
  return (
    <Section
      title="API keys"
      action={
        !adding && (
          <button className="btn btn-sm" onClick={() => setAdding(true)}>
            <PlusIcon />
            New API key
          </button>
        )
      }
    >
      <p className="settings-hint">For scripts and MCP clients that act as you.</p>
      {shown && <Secret {...shown} onDone={() => setShown(null)} />}
      {adding && <NewApiKey onCancel={() => setAdding(false)} onCreated={created} />}
      {!!keys.data?.length && (
        <div className="settings-list">
          {keys.data.map((k) => (
            <Row
              key={k.id}
              title={<span dir="auto">{k.name}</span>}
              meta={meta(scopeLabel(k.scope), `Created ${ago(k.createdAt)}`, k.lastUsedAt ? `Last used ${ago(k.lastUsedAt)}` : "Never used")}
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

function NewApiKey({ onCancel, onCreated }: { onCancel: () => void; onCreated: (token: string) => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiKeyScope>("read");
  const { busy, run } = useRun();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) run(async () => onCreated((await auth.createApiKey(name.trim(), scope)).token));
  };
  return (
    <form className="settings-form settings-card" onSubmit={submit}>
      <label className="field">
        <span>Name</span>
        <input className="input" autoFocus dir="auto" placeholder="Laptop scripts" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field">
        <span>Access</span>
        <Choice label="Access" value={scope} options={SCOPES} onChange={setScope} />
      </div>
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

function WorkspaceSettings({ workspace }: { workspace: string }) {
  const members = useFetch(() => auth.members(workspace), [workspace]);
  const admin = getMe().workspaces.find((w) => w.key === workspace)?.role === "admin";
  const all = members.data ?? [];
  const people = all.filter((m) => m.user.kind === "person");
  const agents = all.filter((m) => m.user.kind === "agent");
  if (!admin)
    return (
      <>
        <p className="settings-note">Only admins manage the workspace.</p>
        <Members workspace={workspace} members={people} reload={members.reload} readOnly />
      </>
    );
  return (
    <>
      <Members workspace={workspace} members={people} reload={members.reload} />
      <Invite workspace={workspace} />
      <Agents workspace={workspace} agents={agents} reload={members.reload} />
    </>
  );
}

function Members({ workspace, members, reload, readOnly }: { workspace: string; members: WorkspaceMember[]; reload: () => void; readOnly?: boolean }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const update = (m: WorkspaceMember, patch: { role?: "admin" | "member"; suspended?: boolean }) =>
    auth.updateMember(workspace, m.user.username, patch).then(reload, errorToast);
  const act = (m: WorkspaceMember, action: string) => {
    const { name, username } = m.user;
    if (action === "admin" || action === "member") update(m, { role: action });
    else if (action === "reinstate") update(m, { suspended: false });
    else if (action === "suspend") {
      if (confirm(`Suspend ${name}? They lose access to this workspace; what they wrote stays theirs.`)) update(m, { suspended: true });
    } else if (action === "link") {
      auth.memberSignInLink(workspace, username).then(
        (link) => setShown(linkSecret(link, LINK_NOTE, <>Sign-in link for <strong dir="auto">{name}</strong>. Send it to them.</>)),
        errorToast,
      );
    }
  };
  const actions = (m: WorkspaceMember): [string, string][] =>
    m.suspendedAt
      ? [["reinstate", "Reinstate"]]
      : [
          m.role === "admin" ? ["member", "Make member"] : ["admin", "Make admin"],
          ["link", "Sign-in link"],
          ["suspend", "Suspend"],
        ];
  return (
    <Section title="Members" count={members.length}>
      {shown && <Secret {...shown} onDone={() => setShown(null)} />}
      <div className="settings-list">
        {members.map((m) => (
          <Row
            key={m.user.username}
            dim={!!m.suspendedAt}
            icon={<Avatar name={m.user.name} />}
            title={
              <>
                <span dir="auto">{m.user.name}</span> <span className="muted">@{m.user.username}</span>
              </>
            }
            meta={meta(m.email, m.role === "admin" ? "Admin" : "Member", m.suspendedAt && "Suspended")}
          >
            {!readOnly && <RowMenu label={`Manage ${m.user.name}`} actions={actions(m)} onPick={(a) => act(m, a)} />}
          </Row>
        ))}
      </div>
    </Section>
  );
}

function Invite({ workspace }: { workspace: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [shown, setShown] = useState<Shown | null>(null);
  const { busy, run } = useRun();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    run(async () => {
      const link = await auth.invite(workspace, email.trim(), role);
      setShown(linkSecret(link, "Send this to them. It works once and expires in 15 minutes.", <>Invite for {email.trim()}.</>));
      setEmail("");
    });
  };
  return (
    <Section title="Invite">
      {shown && <Secret {...shown} onDone={() => setShown(null)} />}
      <form className="settings-inline" onSubmit={submit}>
        <input
          className="input grow"
          type="email"
          aria-label="Email"
          placeholder="name@example.com"
          autoCapitalize="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Choice
          label="Role"
          value={role}
          options={[
            ["member", "Member"],
            ["admin", "Admin"],
          ]}
          onChange={setRole}
        />
        <button className="btn btn-primary" disabled={!email.trim() || busy}>
          Invite
        </button>
      </form>
    </Section>
  );
}

function Agents({ workspace, agents, reload }: { workspace: string; agents: WorkspaceMember[]; reload: () => void }) {
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const showToken = (name: string, token: string) => {
    const command = mcpCommand(token);
    setShown({
      lead: <>Connect <strong dir="auto">{name}</strong> with this command.</>,
      value: command,
      note: TOKEN_NOTE,
      copies: [["Command", command], ["Token", token]],
    });
    reload();
  };
  const act = (m: WorkspaceMember, action: string) => {
    const { name, username } = m.user;
    if (action === "token") {
      // A removed agent comes back with a new token, so there's no old one to warn about.
      if (m.suspendedAt || confirm(`Issue a new token for ${name}? The old token stops working.`))
        auth.rotateAgentToken(workspace, username).then(({ token }) => showToken(name, token), errorToast);
    } else if (action === "remove") {
      if (confirm(`Remove ${name}? Its token stops working; what it wrote stays.`)) auth.removeAgent(workspace, username).then(reload, errorToast);
    }
  };
  return (
    <Section
      title="Agents"
      count={agents.length || undefined}
      action={
        !adding && (
          <button className="btn btn-sm" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add agent
          </button>
        )
      }
    >
      <p className="settings-hint">Agents connect over MCP with their own token, and everything they write carries their name.</p>
      {shown && <Secret {...shown} onDone={() => setShown(null)} />}
      {adding && (
        <NewAgent
          workspace={workspace}
          onCancel={() => setAdding(false)}
          onCreated={(name, token) => {
            setAdding(false);
            showToken(name, token);
          }}
        />
      )}
      {agents.length > 0 && (
        <div className="settings-list">
          {agents.map((m) => (
            <Row
              key={m.user.username}
              dim={!!m.suspendedAt}
              icon={<Avatar name={m.user.name} />}
              title={
                <>
                  <span dir="auto">{m.user.name}</span> <span className="muted">@{m.user.username}</span>
                </>
              }
              meta={meta(m.suspendedAt ? "Removed" : `Added ${ago(m.joinedAt)}`)}
            >
              <RowMenu
                label={`Manage ${m.user.name}`}
                actions={m.suspendedAt ? [["token", "New token"]] : [["token", "New token"], ["remove", "Remove"]]}
                onPick={(a) => act(m, a)}
              />
            </Row>
          ))}
        </div>
      )}
    </Section>
  );
}

function NewAgent({ workspace, onCancel, onCreated }: { workspace: string; onCancel: () => void; onCreated: (name: string, token: string) => void }) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const { busy, run } = useRun();
  const ready = !!name.trim() && !!username.trim() && !busy;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    run(async () => {
      const { agent, token } = await auth.createAgent(workspace, name.trim(), username.trim());
      onCreated(agent.name, token);
    });
  };
  return (
    <form className="settings-form settings-card" onSubmit={submit}>
      <label className="field">
        <span>Name</span>
        <input className="input" autoFocus dir="auto" placeholder="Claude (frontend)" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Username</span>
        <input
          className="input"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="claude-frontend"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
        />
        <small>Used to delegate issues to it.</small>
      </label>
      <FormButtons label="Add agent" disabled={!ready} onCancel={onCancel} />
    </form>
  );
}

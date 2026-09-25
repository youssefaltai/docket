// App shell: sidebar, routing, live updates, global shortcuts.
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IssueInput, Project, Workspace } from "../shared/types";
import { HttpError, api, getMe, getName, loadMe, setName, setOnUnauthorized, store, subscribe } from "./api";
import { DocPage, DocsView } from "./docs";
import { IssuePage } from "./issue";
import { IssuesView } from "./issues";
import { MembersModal } from "./members";
import { NewDocModal, NewIssueModal, NewProjectModal, NewWorkspaceModal, ProjectSettingsModal } from "./modals";
import { Picker } from "./pickers";
import {
  AppContext,
  Avatar,
  ChevronDownIcon,
  ComposeIcon,
  DocIcon,
  IssuesIcon,
  Kbd,
  Link,
  LiveContext,
  Logo,
  PlusIcon,
  ProjectMark,
  Toaster,
  cls,
  errorToast,
  isEditable,
  nav,
  navigate,
  openCount,
  parseRoute,
  setIssueIndex,
  useApp,
  useKeydown,
  usePath,
  type AppState,
  type Route,
} from "./ui";

type ModalState =
  | { kind: "issue"; defaults: Partial<IssueInput> }
  | { kind: "doc"; project: string }
  | { kind: "project" }
  | { kind: "workspace" }
  | { kind: "settings"; project: string }
  | { kind: "members" }
  | null;

function defaultPeople(name: string): string[] {
  return [...new Set([name, "claude"])];
}

function App({ name, onChangeName }: { name: string; onChangeName?: () => void }) {
  const path = usePath();
  const route = parseRoute(path);
  const [live, setLive] = useState(0);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceKey, setWorkspaceKey] = useState(() => store.get("workspace"));
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsTick, setProjectsTick] = useState(0);
  const [labels, setLabels] = useState<string[]>([]);
  const [people, setPeople] = useState<string[]>(() => defaultPeople(name));
  const [modal, setModal] = useState<ModalState>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [docProject, setDocProject] = useState<string | null>(null);

  // Live updates: coalesce bursts of server events into one refetch. The issue index
  // (statuses for identifier chips) only changes with issue and project events.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stale = true;
    let warned = false; // surface a failure once, not on every retry
    const loadIndex = () =>
      api.issues().then(
        (list) => {
          warned = false;
          setIssueIndex(list);
        },
        (e) => {
          if (warned) return;
          warned = true;
          errorToast(e);
        },
      );
    loadIndex();
    const stop = subscribe((event) => {
      if (event?.entity !== "document") stale = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        setLive((v) => v + 1);
        if (stale) loadIndex();
        stale = false;
      }, 100);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    api.workspaces().then(setWorkspaces, errorToast);
    api.projects().then(setProjects, errorToast);
  }, [live, projectsTick]);

  useEffect(() => setNavOpen(false), [path]);

  const workspace = workspaces?.find((w) => w.key === workspaceKey) ?? workspaces?.[0] ?? null;

  // Labels and assignees for pickers and filters, scoped to the current workspace. Once members
  // exist, only they can be assigned; before that, assignees come from the workspace's issues.
  const workspaceKeyForDirectory = workspace?.key;
  const loadDirectory = useCallback(() => {
    api.labels(workspaceKeyForDirectory).then(setLabels, () => {});
    Promise.all([
      api.members().catch(() => []),
      api.issues(workspaceKeyForDirectory ? { workspace: workspaceKeyForDirectory } : {}),
    ]).then(
      ([members, list]) => {
        const active = members.filter((m) => !m.revokedAt).map((m) => m.name);
        const names = active.length ? active : [...defaultPeople(name), ...list.map((i) => i.assignee).filter((a): a is string => !!a)];
        // You first, then everyone else alphabetically.
        const others = [...new Set(names)].filter((n) => n !== name).sort((a, b) => a.localeCompare(b));
        setPeople(names.includes(name) || !active.length ? [name, ...others] : others);
      },
      () => {},
    );
  }, [name, workspaceKeyForDirectory]);
  const workspaceProjects = projects && workspace ? projects.filter((p) => p.workspace === workspace.key) : null;
  const setWorkspace = useCallback((key: string) => {
    setWorkspaceKey(key);
    store.set("workspace", key);
  }, []);
  const switchWorkspace = (key: string) => {
    setWorkspace(key);
    navigate(route.view === "docs" || route.view === "doc" ? "/docs" : "/");
  };

  const currentProject = routeProject(route, docProject);

  // Opening a project, issue or doc from another workspace switches to that workspace.
  const owner = projects?.find((p) => p.key === currentProject)?.workspace;
  useEffect(() => {
    if (owner) setWorkspace(owner);
  }, [owner, setWorkspace]);

  const known = (key: string | null | undefined) =>
    key && workspaceProjects?.some((p) => p.key === key) ? key : undefined;
  const pickProject = (key?: string | null) => known(key) ?? known(currentProject) ?? workspaceProjects?.[0]?.key;

  const app: AppState = {
    workspaces,
    workspace,
    projects,
    workspaceProjects,
    labels,
    people,
    name,
    changeName: onChangeName,
    loadDirectory,
    reloadProjects: () => setProjectsTick((t) => t + 1),
    newIssue: (defaults = {}) => {
      const project = pickProject(defaults.project);
      if (!project) return setModal({ kind: "project" });
      loadDirectory();
      setModal({ kind: "issue", defaults: { ...defaults, project } });
    },
    newDoc: (key) => {
      const project = pickProject(key);
      setModal(project ? { kind: "doc", project } : { kind: "project" });
    },
    newProject: () => setModal({ kind: "project" }),
    newWorkspace: () => setModal({ kind: "workspace" }),
    projectSettings: (project) => setModal({ kind: "settings", project }),
    setDocProject,
    openNav: () => setNavOpen(true),
  };

  // Global shortcuts.
  useKeydown((e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || modal || isEditable(e.target)) return;
    if (document.querySelector(".pop")) return;
    const key = e.key;
    if (key === "c" || key === "C") {
      e.preventDefault();
      app.newIssue();
    } else if (key === "/") {
      e.preventDefault();
      focusSearch();
    } else if (key === "Escape") {
      if (navOpen) setNavOpen(false);
      else if (route.view === "issue") navigate(nav.lastList);
      else if (route.view === "doc") navigate(nav.lastDocs);
      else (document.activeElement as HTMLElement | null)?.blur?.();
    } else if ((route.view === "issues" || route.view === "docs") && (key === "j" || key === "k" || key === "ArrowDown" || key === "ArrowUp")) {
      if (moveFocus(key === "j" || key === "ArrowDown" ? 1 : -1)) e.preventDefault();
    }
  });

  return (
    <AppContext.Provider value={app}>
      <LiveContext.Provider value={live}>
        <div className={cls("app", navOpen && "nav-open")}>
          <Sidebar route={route} active={currentProject} onSwitch={switchWorkspace} onMembers={() => setModal({ kind: "members" })} />
          <div className="nav-backdrop" onClick={() => setNavOpen(false)} />
          <main className="main">
            {route.view === "issue" ? (
              <IssuePage key={route.id} id={route.id} />
            ) : route.view === "doc" ? (
              <DocPage key={route.slug} slug={route.slug} />
            ) : route.view === "docs" ? (
              <DocsView key={route.project ?? ""} projectKey={route.project} />
            ) : (
              <IssuesView key={route.project ?? ""} projectKey={route.project} />
            )}
          </main>
        </div>
        {modal?.kind === "issue" && <NewIssueModal defaults={modal.defaults} onClose={() => setModal(null)} />}
        {modal?.kind === "doc" && <NewDocModal project={modal.project} onClose={() => setModal(null)} />}
        {modal?.kind === "project" && <NewProjectModal onClose={() => setModal(null)} />}
        {modal?.kind === "settings" && <ProjectSettingsModal projectKey={modal.project} onClose={() => setModal(null)} />}
        {modal?.kind === "members" && <MembersModal onClose={() => setModal(null)} />}
        {modal?.kind === "workspace" && (
          <NewWorkspaceModal
            onCreate={(w) => {
              setWorkspaces((list) => list && [...list, w]);
              switchWorkspace(w.key);
            }}
            onClose={() => setModal(null)}
          />
        )}
        <Toaster />
      </LiveContext.Provider>
    </AppContext.Provider>
  );
}

function routeProject(route: Route, docProject: string | null): string | null {
  if (route.view === "issue") return route.id.replace(/-\d+$/, "");
  if (route.view === "doc") return docProject;
  return route.project;
}

function Sidebar({
  route,
  active,
  onSwitch,
  onMembers,
}: {
  route: Route;
  active: string | null;
  onSwitch: (key: string) => void;
  onMembers: () => void;
}) {
  const { workspaces, workspace, workspaceProjects: projects, newIssue, newProject, newWorkspace, name, changeName } = useApp();
  const total = projects?.reduce((n, p) => n + openCount(p), 0) ?? 0;
  const docs = projects?.reduce((n, p) => n + p.docCount, 0) ?? 0;
  const options = [
    ...(workspaces ?? []).map((w) => ({ value: w.key, label: w.name, icon: <ProjectMark id={w.name.toUpperCase()} /> })),
    { value: "", label: "New workspace", icon: <PlusIcon /> },
  ];
  return (
    <aside className="sidebar">
      <Picker
        label="Switch workspace"
        options={options}
        selected={workspace ? [workspace.key] : []}
        onPick={(key) => (key ? key !== workspace?.key && onSwitch(key) : newWorkspace())}
        className="brand"
      >
        <Logo />
        <span className="brand-name" dir="auto">
          {workspace?.name ?? "Docket"}
        </span>
        <ChevronDownIcon className="brand-chevron" />
      </Picker>
      <button className="new-issue" onClick={() => newIssue()}>
        <ComposeIcon />
        <span>New issue</span>
        <Kbd>C</Kbd>
      </button>
      <nav className="nav">
        <Link to="/" className={cls("nav-item", route.view === "issues" && !route.project && "active")}>
          <IssuesIcon />
          <span className="nav-label">All issues</span>
          {total > 0 && <span className="nav-count">{total}</span>}
        </Link>
        <Link to="/docs" className={cls("nav-item", route.view === "docs" && !route.project && "active")}>
          <DocIcon />
          <span className="nav-label">All docs</span>
          {docs > 0 && <span className="nav-count">{docs}</span>}
        </Link>
        <div className="nav-section">
          <span>Projects</span>
          <button className="icon-btn xs" onClick={newProject} aria-label="New project" title="New project">
            <PlusIcon />
          </button>
        </div>
        {projects?.map((p) => (
          <Link key={p.key} to={`/p/${p.key}`} className={cls("nav-item", active === p.key && "active")}>
            <ProjectMark id={p.key} />
            <span className="nav-label" dir="auto">
              {p.name}
            </span>
            {openCount(p) > 0 && <span className="nav-count">{openCount(p)}</span>}
          </Link>
        ))}
        {projects?.length === 0 && (
          <button className="nav-item nav-muted" onClick={newProject}>
            <PlusIcon />
            <span className="nav-label">Create a project</span>
          </button>
        )}
      </nav>
      <AccountMenu name={name} changeName={changeName} onMembers={onMembers} />
    </aside>
  );
}

/** The sidebar footer: who you are, and name, members and sign out as they apply. */
function AccountMenu({ name, changeName, onMembers }: { name: string; changeName?: () => void; onMembers: () => void }) {
  const me = getMe();
  const options = [
    ...(changeName ? [{ value: "name", label: "Change name" }] : []),
    ...(me.admin ? [{ value: "members", label: "Members" }] : []),
    // In open mode only a member cookie can be signed out of; root has nothing to leave.
    ...(me.member || !me.open ? [{ value: "signout", label: "Sign out" }] : []),
  ];
  const pick = (value: string) => {
    if (value === "name") changeName?.();
    else if (value === "members") onMembers();
    else api.logout().then(() => location.reload(), errorToast);
  };
  const who = (
    <>
      <Avatar name={name} />
      <span className="nav-label" dir="auto">
        {name}
      </span>
    </>
  );
  if (!options.length) return <div className="whoami">{who}</div>;
  return (
    <Picker label="Account" options={options} selected={[]} onPick={pick} className="whoami">
      {who}
    </Picker>
  );
}

function focusSearch() {
  const el = document.getElementById("search");
  if (el) return el.focus();
  navigate(nav.lastList);
  setTimeout(() => document.getElementById("search")?.focus(), 50);
}

/** j/k and arrows move focus between issue rows or cards. */
function moveFocus(delta: number): boolean {
  const items = [...document.querySelectorAll<HTMLElement>("[data-nav]")];
  if (!items.length) return false;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = i < 0 ? items[delta > 0 ? 0 : items.length - 1] : items[Math.max(0, Math.min(items.length - 1, i + delta))];
  next?.focus();
  next?.scrollIntoView({ block: "nearest" });
  return true;
}

/** A `#login=<token>` link signs in once. The token leaves the address bar before anything else runs. */
function takeLoginLink(): string | null {
  const match = /^#login=([^&]+)/.exec(location.hash);
  if (!match) return null;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null; // a mangled link is no link
  }
}
const loginLink = takeLoginLink();
// Pasting a login link into a tab already on Docket only changes the hash: reload to use it.
addEventListener("hashchange", () => location.hash.startsWith("#login=") && location.reload());

/**
 * Signs in from a login link, then asks who we are. The login screen shows on any 401;
 * a member goes straight in; otherwise the name screen shows until this browser has a name.
 */
function Root() {
  const [locked, setLocked] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [ready, setReady] = useState(false);
  const [name, setNameState] = useState(getName);
  useEffect(() => {
    setOnUnauthorized(() => setLocked(true));
    if (loginLink) {
      api.login(loginLink).then(
        () => location.reload(),
        (err) => {
          const revoked = err instanceof HttpError && err.status === 401;
          setLinkError(revoked ? "This sign-in link is invalid or was revoked." : String(err.message));
          setLocked(true);
        },
      );
      return;
    }
    // Offline with nothing cached, carry on as root: this browser's name, as before members existed.
    loadMe()
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  if (locked) return <Login initialError={linkError} />;
  if (!ready) return null;
  const member = getMe().member;
  if (member) return <App name={member.name} />;
  if (!name) return <NameScreen onDone={setNameState} />;
  return <App name={name} onChangeName={() => setNameState(null)} />;
}

function Login({ initialError }: { initialError: string }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState(initialError);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    api.login(token.trim()).then(
      () => location.reload(),
      (err) => setError(err instanceof HttpError && err.status === 401 ? "Wrong token" : String(err.message)),
    );
  };
  return (
    <form className="empty login" onSubmit={submit}>
      <Logo />
      <h2>Docket</h2>
      <p>Enter your access token: your own, or the server’s DOCKET_TOKEN.</p>
      <input
        className="input"
        type="password"
        autoFocus
        autoComplete="current-password"
        placeholder="Token"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      {error && <small className="login-error">{error}</small>}
      <button className="btn btn-primary" disabled={!token.trim()}>
        Sign in
      </button>
    </form>
  );
}

function NameScreen({ onDone }: { onDone: (name: string) => void }) {
  const [value, setValue] = useState(() => getName() ?? "");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = value.trim();
    if (!name) return;
    setName(name);
    onDone(name);
  };
  return (
    <form className="empty login" onSubmit={submit}>
      <Logo />
      <h2>What should we call you?</h2>
      <p>Your name is shown on comments and edits you make here.</p>
      <input
        className="input"
        type="text"
        autoFocus
        autoComplete="name"
        placeholder="Your name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button className="btn btn-primary" disabled={!value.trim()}>
        Continue
      </button>
    </form>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

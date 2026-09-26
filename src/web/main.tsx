// App shell: boot, sidebar, routing, live updates, global shortcuts.
import { StrictMode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { IssueInput, Team, Workspace, WorkspaceMember } from "../shared/types";
import { api, connectionStore, setOnAccessLost, setOnUnauthorized, store, subscribe } from "./api";
import { auth, getMe, loadMe } from "./auth";
import { DocPage, DocsView } from "./docs";
import { IssuePage } from "./issue";
import { IssuesView } from "./issues";
import { Login, Setup } from "./login";
import { NewDocModal, NewIssueModal, NewTeamModal, NewWorkspaceModal, TeamSettingsModal } from "./modals";
import { Picker } from "./pickers";
import { SettingsPage } from "./settings";
import { TrashView } from "./trash";
import {
  AppContext,
  Avatar,
  ChevronDownIcon,
  ComposeIcon,
  DocIcon,
  EmptyState,
  IssuesIcon,
  Kbd,
  Link,
  LiveContext,
  Logo,
  PlusIcon,
  TeamMark,
  Toaster,
  Confirm,
  cls,
  errorToast,
  isEditable,
  nav,
  navigate,
  openCount,
  parseRoute,
  setIssueIndex,
  toast,
  useApp,
  useKeydown,
  usePath,
  type AppState,
  type Route,
} from "./ui";

type ModalState =
  | { kind: "issue"; defaults: Partial<IssueInput> }
  | { kind: "doc"; team: string }
  | { kind: "team" }
  | { kind: "workspace" }
  | { kind: "team-settings"; team: string }
  | null;

function App() {
  const path = usePath();
  const route = parseRoute(path);
  const [live, setLive] = useState(0);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceKey, setWorkspaceKey] = useState(() => store.get("workspace"));
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [teamsTick, setTeamsTick] = useState(0);
  const [labels, setLabels] = useState<string[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [docTeam, setDocTeam] = useState<string | null>(null);

  // Live updates: coalesce bursts of server events into one refetch. The issue index
  // (statuses for identifier chips) only changes with issue and team events.
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
    api.teams().then(setTeams, errorToast);
  }, [live, teamsTick]);

  useEffect(() => setNavOpen(false), [path]);

  const workspace = workspaces?.find((w) => w.key === workspaceKey) ?? workspaces?.[0] ?? null;

  // Labels and members (assignees are people, delegates agents) of the current workspace, for pickers and filters.
  const currentKey = workspace?.key;
  const loadDirectory = useCallback(() => {
    if (!currentKey) return;
    api.labels(currentKey).then(setLabels, () => {});
    api.members(currentKey).then(setMembers, () => {});
  }, [currentKey]);
  useEffect(loadDirectory, [loadDirectory, live]);

  const workspaceTeams = teams && workspace ? teams.filter((t) => t.workspace === workspace.key) : null;
  const setWorkspace = useCallback((key: string) => {
    setWorkspaceKey(key);
    store.set("workspace", key);
  }, []);
  const switchWorkspace = (key: string) => {
    setWorkspace(key);
    navigate(route.view === "settings" ? path : route.view === "docs" || route.view === "doc" ? "/docs" : "/");
  };

  // Access changed under us (the socket closed with 4401): ask who we are now. A 401 goes to the sign-in
  // screen; losing just this workspace moves to another one and says why, instead of showing "not found".
  const current = useRef(workspace);
  current.current = workspace;
  useEffect(() => {
    setOnAccessLost(() =>
      loadMe().then((me) => {
        const lost = current.current;
        if (lost && !me.workspaces.some((w) => w.key === lost.key)) {
          toast(`You no longer have access to ${lost.name}`);
          if (me.workspaces[0]) setWorkspace(me.workspaces[0].key);
          navigate("/");
        }
        setLive((v) => v + 1);
      }, () => {}),
    );
  }, [setWorkspace]);

  const connection = useSyncExternalStore(connectionStore.subscribe, connectionStore.get);

  const currentTeam = routeTeam(route, docTeam);

  // Opening a team, issue or doc from another workspace switches to that workspace.
  const owner = teams?.find((t) => t.key === currentTeam)?.workspace;
  useEffect(() => {
    if (owner) setWorkspace(owner);
  }, [owner, setWorkspace]);

  const known = (key: string | null | undefined) => (key && workspaceTeams?.some((t) => t.key === key) ? key : undefined);
  const pickTeam = (key?: string | null) => known(key) ?? known(currentTeam) ?? workspaceTeams?.[0]?.key;

  const app: AppState = {
    workspaces,
    workspace,
    teams,
    workspaceTeams,
    labels,
    members,
    loadDirectory,
    reloadTeams: () => setTeamsTick((t) => t + 1),
    newIssue: (defaults = {}) => {
      const team = pickTeam(defaults.team);
      if (!team) return setModal({ kind: "team" });
      loadDirectory();
      setModal({ kind: "issue", defaults: { ...defaults, team } });
    },
    newDoc: (key) => {
      const team = pickTeam(key);
      setModal(team ? { kind: "doc", team } : { kind: "team" });
    },
    newTeam: () => setModal({ kind: "team" }),
    newWorkspace: () => setModal({ kind: "workspace" }),
    teamSettings: (team) => setModal({ kind: "team-settings", team }),
    setDocTeam,
    openNav: () => setNavOpen(true),
  };

  // Global shortcuts.
  useKeydown((e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || modal || isEditable(e.target)) return;
    if (document.querySelector(".pop, .backdrop")) return;
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

  const page = route.view === "settings" ? (
    <SettingsPage section={route.section} />
  ) : workspaces?.length === 0 ? (
    <EmptyState title="No workspace yet" action={<button className="btn btn-primary" onClick={app.newWorkspace}>Create a workspace</button>}>
      Create one to start, or ask an admin to invite you to theirs.
    </EmptyState>
  ) : route.view === "issue" ? (
    <IssuePage key={route.id} id={route.id} />
  ) : route.view === "doc" ? (
    <DocPage key={route.slug} slug={route.slug} />
  ) : route.view === "trash" ? (
    <TrashView key={route.team} teamKey={route.team} />
  ) : route.view === "docs" ? (
    <DocsView key={route.team ?? ""} teamKey={route.team} />
  ) : (
    <IssuesView key={route.team ?? ""} teamKey={route.team} />
  );

  return (
    <AppContext.Provider value={app}>
      <LiveContext.Provider value={live}>
        <div className={cls("app", navOpen && "nav-open")}>
          <Sidebar route={route} active={currentTeam} onSwitch={switchWorkspace} />
          <div className="nav-backdrop" onClick={() => setNavOpen(false)} />
          <main className="main">
            {connection !== "online" && (
              <div className="connection" role="status">
                {connection === "offline" ? "You’re offline. Changes won’t save until you reconnect." : "Reconnecting…"}
              </div>
            )}
            {page}
          </main>
        </div>
        {modal?.kind === "issue" && <NewIssueModal defaults={modal.defaults} onClose={() => setModal(null)} />}
        {modal?.kind === "doc" && <NewDocModal team={modal.team} onClose={() => setModal(null)} />}
        {modal?.kind === "team" && <NewTeamModal onClose={() => setModal(null)} />}
        {modal?.kind === "team-settings" && <TeamSettingsModal teamKey={modal.team} onClose={() => setModal(null)} />}
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
        <Confirm />
      </LiveContext.Provider>
    </AppContext.Provider>
  );
}

function routeTeam(route: Route, docTeam: string | null): string | null {
  if (route.view === "issue") return route.id.replace(/-\d+$/, "");
  if (route.view === "doc") return docTeam;
  return route.view === "settings" ? null : route.team;
}

function Sidebar({ route, active, onSwitch }: { route: Route; active: string | null; onSwitch: (key: string) => void }) {
  const { workspaces, workspace, workspaceTeams: teams, newIssue, newTeam, newWorkspace } = useApp();
  const total = teams?.reduce((n, t) => n + openCount(t), 0) ?? 0;
  const docs = teams?.reduce((n, t) => n + t.docCount, 0) ?? 0;
  const options = [
    ...(workspaces ?? []).map((w) => ({ value: w.key, label: w.name, icon: <TeamMark id={w.name.toUpperCase()} /> })),
    { value: "", label: "New workspace", icon: <PlusIcon /> },
  ];
  const on = (view: string) => route.view === view && !("team" in route && route.team);
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
        <Link to="/" className={cls("nav-item", on("issues") && "active")}>
          <IssuesIcon />
          <span className="nav-label">All issues</span>
          {total > 0 && <span className="nav-count">{total}</span>}
        </Link>
        <Link to="/docs" className={cls("nav-item", on("docs") && "active")}>
          <DocIcon />
          <span className="nav-label">All docs</span>
          {docs > 0 && <span className="nav-count">{docs}</span>}
        </Link>
        <div className="nav-section">
          <span>Teams</span>
          <button className="icon-btn xs" onClick={newTeam} aria-label="New team" title="New team">
            <PlusIcon />
          </button>
        </div>
        {teams?.map((t) => (
          <Link key={t.key} to={`/t/${t.key}`} className={cls("nav-item", active === t.key && "active")}>
            <TeamMark id={t.key} />
            <span className="nav-label" dir="auto">
              {t.name}
            </span>
            {openCount(t) > 0 && <span className="nav-count">{openCount(t)}</span>}
          </Link>
        ))}
        {teams?.length === 0 && (
          <button className="nav-item nav-muted" onClick={newTeam}>
            <PlusIcon />
            <span className="nav-label">Create a team</span>
          </button>
        )}
      </nav>
      <AccountMenu />
    </aside>
  );
}

/** The sidebar footer: who you are, with settings and sign-out. */
function AccountMenu() {
  const { workspace } = useApp();
  const { user } = getMe();
  const options = [
    { value: "/settings/account", label: "Settings" },
    ...(workspace?.role === "admin" ? [{ value: "/settings/workspace", label: "Workspace settings" }] : []),
    { value: "signout", label: "Sign out" },
  ];
  // Signing out forgets this browser's workspace too, so the next person doesn't start in yours.
  const signOut = () =>
    auth.logout().then(() => {
      store.set("workspace", "");
      location.replace("/login");
    }, errorToast);
  const pick = (value: string) => (value === "signout" ? signOut() : navigate(value));
  return (
    <Picker label="Account" options={options} selected={[]} onPick={pick} className="whoami">
      <Avatar user={user} />
      <span className="nav-label" dir="auto">
        {user.name}
      </span>
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

// Pasting a sign-in link into a tab already on /login only changes the hash: reload to use it.
addEventListener("hashchange", () => location.pathname === "/login" && location.hash && location.reload());

/**
 * Setup and sign-in live outside the app. Everything else needs a session: ask who we are,
 * and send any 401 (now or later, say a revoked session) to the sign-in screen.
 */
function Root() {
  const [state, setState] = useState<"loading" | "ready" | "offline">("loading");
  const path = location.pathname;
  const signedOut = path === "/setup" || path === "/login";
  useEffect(() => {
    if (signedOut) return;
    setOnUnauthorized(() => {
      try {
        sessionStorage.setItem("docket.signedOut", "1");
      } catch {}
      location.replace("/login");
    });
    loadMe().then(
      () => setState("ready"),
      () => setState((s) => (s === "loading" ? "offline" : s)),
    );
  }, []);
  if (path === "/setup") return <Setup />;
  if (path === "/login") return <Login />;
  if (state === "offline")
    return (
      <div className="empty login">
        <Logo />
        <h2>Can't reach Docket</h2>
        <p>Check your connection and try again.</p>
        <button className="btn btn-primary" onClick={() => location.reload()}>
          Retry
        </button>
      </div>
    );
  return state === "ready" ? <App /> : null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

// Here rather than inline in index.html, which the Content-Security-Policy doesn't allow.
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));

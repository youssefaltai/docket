// App shell: boot, sidebar, routing, live updates, global shortcuts.
import { Fragment, StrictMode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { CustomView, CustomViewInput, Inbox, IssueInput, Label, Team, Workspace, WorkspaceMember } from "../shared/types";
import { api, connectionStore, setCurrentWorkspace, setOnAccessLost, setOnUnauthorized, store, subscribe } from "./api";
import { auth, getMe, getYou, loadMe } from "./auth";
import { ChatDock, ChatNavItem } from "./chat";
import { CommandMenu, openCommandMenu } from "./commandmenu";
import { DocPage, DocsView } from "./docs";
import { InboxView } from "./inbox";
import { IssuePage } from "./issue";
import { CyclesView, IssuesView } from "./issues";
import { Login, Setup } from "./login";
import { MyIssuesView } from "./myissues";
import { NewDocModal, NewIssueModal, NewProjectModal, NewTeamModal, NewViewModal, NewWorkspaceModal } from "./modals";
import { Picker } from "./pickers";
import { ProjectPage, ProjectsView } from "./projects";
import { SettingsPage, TeamSettingsPage } from "./settings";
import { ShortcutsHelp } from "./shortcuts";
import { TeamsPage } from "./teams";
import { TrashView } from "./trash";
import { TriageView } from "./triage";
import { CustomViewPage, ViewsPage } from "./views";
import {
  AppContext,
  Avatar,
  ChevronDownIcon,
  ComposeIcon,
  DocIcon,
  EmptyState,
  InboxIcon,
  LockIcon,
  TeamsIcon,
  IssuesIcon,
  Kbd,
  Link,
  LiveContext,
  Logo,
  MOD,
  PlusIcon,
  ProjectIcon,
  SearchIcon,
  StarIcon,
  TeamMark,
  Toaster,
  ViewsIcon,
  Confirm,
  cls,
  errorToast,
  isEditable,
  nav,
  navigate,
  openCount,
  parseRoute,
  setChipStatuses,
  setIssueIndex,
  statusGroups,
  toast,
  useApp,
  moveFocus,
  useKeydown,
  usePath,
  type AppState,
  type Route,
} from "./ui";

type ModalState =
  | { kind: "issue"; defaults: Partial<IssueInput> }
  | { kind: "doc"; team: string; project?: string }
  | { kind: "project"; team?: string }
  | { kind: "team" }
  | { kind: "workspace" }
  | { kind: "view"; defaults: Omit<CustomViewInput, "name"> }
  | null;

function App() {
  const path = usePath();
  const route = parseRoute(path);
  const [live, setLive] = useState(0);
  const [listTick, setListTick] = useState(0);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [teams, setTeams] = useState<{ workspace: string; list: Team[] } | null>(null);
  const [teamsTick, setTeamsTick] = useState(0);
  const [labels, setLabels] = useState<Label[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [docTeam, setDocTeam] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // `G` arms a 900ms window for a chord's second key (G I / G M / G D / G S); anything else drops it.
  const chord = useRef<number | null>(null);

  // The URL says which workspace this is (/acme/…). Where it names none (/, or a link from before), it's the one
  // you used last, else your first. Until the list loads, your workspaces as of boot.
  const yours: { key: string }[] = workspaces ?? getMe().workspaces;
  const stored = store.get("workspace");
  const fallback = (yours.find((w) => w.key === stored) ?? yours[0])?.key ?? null;
  const member = !!route.workspace && yours.some((w) => w.key === route.workspace);
  const currentKey = member ? route.workspace : fallback;
  // Every request acts there. Set while rendering, not in an effect: children's effects run first.
  setCurrentWorkspace(currentKey);
  const shown = useRef(currentKey);
  shown.current = currentKey;

  // Remember the workspace; send a path without one to the right one, replacing it in history.
  useEffect(() => {
    if (member) return store.set("workspace", route.workspace!);
    if (route.workspace || !fallback) return; // not yours (the page says so), or you have none
    const go = (workspace: string) => navigate(`/${workspace}${path === "/" ? "" : path}${location.search}${location.hash}`, true);
    // A link from before (/issue/BRD-1, /doc/plan, /t/BRD…): find which workspace it meant. Not found: yours says so.
    const what =
      route.view === "issue" ? { issue: route.id } : route.view === "doc" ? { doc: route.slug } : "team" in route && route.team ? { team: route.team } : null;
    if (!what) return go(fallback);
    let stale = false;
    api.locate(what).then(
      (found) => !stale && go(found.workspace),
      () => !stale && go(fallback),
    );
    return () => void (stale = true);
  }, [path, member, fallback]);

  // The issue index (statuses for identifier chips) of the workspace shown; a failure is surfaced once, not on every retry.
  const warned = useRef(false);
  const loadIndex = useCallback(() => {
    const key = shown.current;
    api.issues().then(
      (list) => {
        warned.current = false;
        if (shown.current === key) setIssueIndex(list);
      },
      (e) => {
        if (warned.current) return;
        warned.current = true;
        errorToast(e);
      },
    );
  }, []);
  useEffect(() => {
    if (!currentKey) return;
    setIssueIndex([]);
    loadIndex();
  }, [currentKey, loadIndex]);

  // Your inbox in the workspace shown: its unread count is in the sidebar.
  const [inbox, setInbox] = useState<{ workspace: string; data: Inbox } | null>(null);
  const loadInbox = useCallback(() => {
    const key = shown.current;
    if (key) api.inbox().then((data) => shown.current === key && setInbox({ workspace: key, data }), () => {});
  }, []);
  useEffect(loadInbox, [currentKey, loadInbox]);

  // Live updates: coalesce bursts of server events into one refetch. The socket hears all your workspaces:
  // only the shown one's events refetch its data (the index only for issue and team events, the inbox only
  // for inbox events); workspace and member events refetch the workspace list.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let data = false;
    let index = false;
    let list = false;
    let mail = false;
    const stop = subscribe((event) => {
      const here = !event || event.workspace === shown.current; // null: reconnected, anything may have changed
      if (!event || event.entity === "workspace" || event.entity === "member") list = true;
      if (here && (!event || event.entity === "inbox")) mail = true;
      if (here && event?.entity !== "inbox") data = true;
      if (here && event?.entity !== "document" && event?.entity !== "inbox") index = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (data) setLive((v) => v + 1);
        if (list) setListTick((v) => v + 1);
        if (index) loadIndex();
        if (mail) loadInbox();
        data = index = list = mail = false;
      }, 100);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [loadIndex, loadInbox]);

  useEffect(() => {
    api.workspaces().then(setWorkspaces, errorToast);
  }, [listTick, teamsTick]);

  useEffect(() => {
    if (!currentKey) return;
    let stale = false;
    api.teams().then((list) => !stale && setTeams({ workspace: currentKey, list }), errorToast);
    return () => void (stale = true);
  }, [currentKey, live, teamsTick]);

  // The workspace's views: the sidebar lists the ones you starred.
  const [views, setViews] = useState<{ workspace: string; list: CustomView[] } | null>(null);
  const [viewsTick, setViewsTick] = useState(0);
  useEffect(() => {
    if (!currentKey) return;
    let stale = false;
    api.views().then((list) => !stale && setViews({ workspace: currentKey, list }), errorToast);
    return () => void (stale = true);
  }, [currentKey, live, viewsTick]);

  useEffect(() => setNavOpen(false), [path]);

  const workspace = workspaces?.find((w) => w.key === currentKey) ?? null;
  const workspaceTeams = teams?.workspace === currentKey ? teams.list : null;
  // Identifier chips in markdown draw a status by key: the workspace's teams say how.
  useEffect(() => void setChipStatuses(new Map(statusGroups(workspaceTeams ?? []).map((s) => [s.key, s]))), [workspaceTeams]);

  // Labels and members (assignees are people, delegates agents) of the current workspace, for pickers and filters.
  const loadDirectory = useCallback(() => {
    if (!currentKey) return;
    api.labels().then(setLabels, () => {});
    api.members(currentKey).then(setMembers, () => {});
  }, [currentKey]);
  useEffect(loadDirectory, [loadDirectory, live]);

  // Switching keeps you on the same kind of page: settings, docs, the inbox, my issues, or issues.
  const same =
    route.view === "settings"
      ? `/settings/${route.section}`
      : route.view === "docs" || route.view === "doc"
        ? "/docs"
        : route.view === "projects" || route.view === "project"
          ? "/projects"
        : route.view === "inbox"
          ? "/inbox"
          : route.view === "my"
            ? `/my/${route.tab}`
            : route.view === "views" || route.view === "customview"
              ? "/views"
              : "";
  const switchWorkspace = (key: string) => navigate(`/${key}${same}`);

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
          navigate(me.workspaces[0] ? `/${me.workspaces[0].key}` : "/");
        }
        setLive((v) => v + 1);
        setListTick((v) => v + 1);
      }, () => {}),
    );
  }, []);

  const connection = useSyncExternalStore(connectionStore.subscribe, connectionStore.get);

  const currentTeam = routeTeam(route, docTeam);

  const known = (key: string | null | undefined) => (key && workspaceTeams?.some((t) => t.key === key) ? key : undefined);
  const pickTeam = (key?: string | null) => known(key) ?? known(currentTeam) ?? workspaceTeams?.[0]?.key;

  const app: AppState = {
    workspaces,
    workspace,
    teams: workspaceTeams,
    labels,
    members,
    inbox: inbox?.workspace === currentKey ? inbox.data : null,
    setInbox: (data) => currentKey && setInbox({ workspace: currentKey, data }),
    reloadInbox: loadInbox,
    loadDirectory,
    reloadTeams: () => setTeamsTick((t) => t + 1),
    views: views?.workspace === currentKey ? views.list : null,
    reloadViews: () => setViewsTick((t) => t + 1),
    newView: (defaults = {}) => {
      loadDirectory();
      setModal({ kind: "view", defaults });
    },
    newIssue: (defaults = {}) => {
      const team = pickTeam(defaults.team);
      if (!team) return setModal({ kind: "team" });
      loadDirectory();
      // From the Triage tab, a new issue waits in Triage.
      const triage = route.view === "triage" ? workspaceTeams?.find((t) => t.key === team)?.statuses.find((s) => s.category === "triage") : undefined;
      // From a cycle's page, it goes in that cycle.
      const cycle = route.view === "cycle" && route.team === team ? route.number : undefined;
      setModal({ kind: "issue", defaults: { status: triage?.key, cycle, ...defaults, team } });
    },
    newDoc: (key, project) => {
      const team = pickTeam(key);
      setModal(team ? { kind: "doc", team, project } : { kind: "team" });
    },
    newProject: (key) => {
      const team = pickTeam(key);
      setModal(team ? { kind: "project", team } : { kind: "team" });
    },
    newTeam: () => setModal({ kind: "team" }),
    newWorkspace: () => setModal({ kind: "workspace" }),
    switchWorkspace,
    setDocTeam,
    openNav: () => setNavOpen(true),
  };

  // Global shortcuts.
  useKeydown((e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || modal || isEditable(e.target)) return;
    if (document.querySelector(".pop, .backdrop")) return;
    const key = e.key;

    // A G-chord's second key: consumed whether or not it's bound, so a stray "GX" never falls through to X's
    // own binding. Escape only cancels the chord — it still runs its own action below.
    if (chord.current !== null && Date.now() - chord.current < 900) {
      chord.current = null;
      if (key !== "Escape") {
        const k = key.toLowerCase();
        const to = ({ i: "/inbox", m: "/my", d: "/docs", v: "/views", s: "/settings/account" } as Record<string, string>)[k];
        if (to) {
          e.preventDefault();
          navigate(to);
        }
        return;
      }
    } else if (key === "g" || key === "G") {
      chord.current = Date.now();
      return; // no bare-G binding: wait for the next key, or let the window lapse
    } else {
      chord.current = null;
    }

    if (key === "c" || key === "C") {
      e.preventDefault();
      app.newIssue();
    } else if (key === "/") {
      e.preventDefault();
      focusSearch();
    } else if (key === "?") {
      e.preventDefault();
      setHelpOpen(true);
    } else if (key === "Escape") {
      if (navOpen) setNavOpen(false);
      else if (route.view === "issue") navigate(nav.lastList);
      else if (route.view === "doc") navigate(nav.lastDocs);
      else if (route.view === "project") navigate(nav.lastProjects);
      else (document.activeElement as HTMLElement | null)?.blur?.();
    } else if (["issues", "triage", "cycles", "cycle", "docs", "projects", "project", "inbox", "my", "views", "customview"].includes(route.view) && (key === "j" || key === "k" || key === "ArrowDown" || key === "ArrowUp")) {
      if (moveFocus(key === "j" || key === "ArrowDown" ? 1 : -1)) e.preventDefault();
    }
  });

  const page = !fallback ? (
    route.view === "settings" ? (
      <SettingsPage section={route.section} />
    ) : (
      <EmptyState title="No workspace yet" action={<button className="btn btn-primary" onClick={app.newWorkspace}>Create a workspace</button>}>
        Create one to start, or ask an admin to invite you to theirs.
      </EmptyState>
    )
  ) : !route.workspace ? null /* on its way to a workspace (see above) */ : !member ? (
    <EmptyState
      title={`No access to ${route.workspace}`}
      action={
        <Link className="btn btn-primary" to={`/${fallback}`}>
          Go to {workspace?.name ?? fallback}
        </Link>
      }
    >
      There’s no such workspace, or you aren’t a member of it.
    </EmptyState>
  ) : route.view === "settings" ? (
    <SettingsPage section={route.section} />
  ) : route.view === "inbox" ? (
    <InboxView />
  ) : route.view === "my" ? (
    <MyIssuesView key={route.tab} tab={route.tab} />
  ) : route.view === "teams" ? (
    <TeamsPage />
  ) : route.view === "views" ? (
    <ViewsPage />
  ) : route.view === "customview" ? (
    <CustomViewPage key={route.id} id={route.id} />
  ) : route.view === "issue" ? (
    <IssuePage key={route.id} id={route.id} />
  ) : route.view === "doc" ? (
    <DocPage key={route.slug} slug={route.slug} />
  ) : route.view === "trash" ? (
    <TrashView key={route.team} teamKey={route.team} />
  ) : route.view === "triage" ? (
    <TriageView key={route.team} teamKey={route.team} />
  ) : route.view === "cycles" ? (
    <CyclesView key={route.team} teamKey={route.team} />
  ) : route.view === "cycle" ? (
    <IssuesView key={`${route.team}/${route.number}`} teamKey={route.team} cycle={route.number} />
  ) : route.view === "team-settings" ? (
    <TeamSettingsPage key={route.team} teamKey={route.team} />
  ) : route.view === "project" ? (
    <ProjectPage key={route.slug} slug={route.slug} />
  ) : route.view === "projects" ? (
    <ProjectsView key={route.team ?? ""} teamKey={route.team} />
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
            <Fragment key={currentKey}>{page}</Fragment>
          </main>
          {getMe().chat && <ChatDock />}
        </div>
        {modal?.kind === "issue" && <NewIssueModal defaults={modal.defaults} onClose={() => setModal(null)} />}
        {modal?.kind === "doc" && <NewDocModal team={modal.team} project={modal.project} onClose={() => setModal(null)} />}
        {modal?.kind === "project" && <NewProjectModal team={modal.team} onClose={() => setModal(null)} />}
        {modal?.kind === "team" && <NewTeamModal onClose={() => setModal(null)} />}
        {modal?.kind === "view" && <NewViewModal defaults={modal.defaults} onClose={() => setModal(null)} />}
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
        <CommandMenu />
        {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
      </LiveContext.Provider>
    </AppContext.Provider>
  );
}

function routeTeam(route: Route, docTeam: string | null): string | null {
  if (route.view === "issue") return route.id.replace(/-\d+$/, "");
  if (route.view === "doc") return docTeam;
  return "team" in route ? route.team : null;
}

function Sidebar({ route, active, onSwitch }: { route: Route; active: string | null; onSwitch: (key: string) => void }) {
  const { workspaces, workspace, teams, views, inbox, newIssue, newTeam, newWorkspace } = useApp();
  const guest = workspace?.role === "guest"; // only their teams: no views, no new teams
  const favorites = views?.filter((v) => v.favorite) ?? [];
  // Your teams, and the one you're on if you aren't in it (a public team you opened from Browse teams).
  const mine = teams?.filter((t) => t.member || t.key === active);
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
      <button className="new-issue cmdk-trigger" onClick={openCommandMenu}>
        <SearchIcon />
        <span>Search</span>
        <Kbd>{MOD}K</Kbd>
      </button>
      <nav className="nav">
        <Link to="/inbox" className={cls("nav-item", on("inbox") && "active")}>
          <InboxIcon />
          <span className="nav-label">Inbox</span>
          {!!inbox?.unread && (
            <span className="nav-count nav-unread" aria-label={`${inbox.unread} unread`}>
              {inbox.unread}
            </span>
          )}
        </Link>
        <Link to="/my" className={cls("nav-item", on("my") && "active")}>
          <Avatar user={getYou()} />
          <span className="nav-label">My Issues</span>
        </Link>
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
        <Link to="/projects" className={cls("nav-item", on("projects") && "active")}>
          <ProjectIcon />
          <span className="nav-label">Projects</span>
        </Link>
        {!guest && (
          <Link
            to="/views"
            className={cls("nav-item", (on("views") || (route.view === "customview" && !favorites.some((v) => v.id === route.id))) && "active")}
          >
            <ViewsIcon />
            <span className="nav-label">Views</span>
          </Link>
        )}
        {getMe().chat && <ChatNavItem />}
        {favorites.length > 0 && (
          <div className="nav-section">
            <span>Favorites</span>
          </div>
        )}
        {favorites.map((v) => (
          <Link key={v.id} to={`/view/${v.id}`} className={cls("nav-item", route.view === "customview" && route.id === v.id && "active")}>
            <StarIcon className="nav-star" />
            <span className="nav-label" dir="auto">
              {v.name}
            </span>
          </Link>
        ))}
        <div className="nav-section">
          <span>Your teams</span>
          {!guest && (
            <button className="icon-btn xs" onClick={newTeam} aria-label="New team" title="New team">
              <PlusIcon />
            </button>
          )}
        </div>
        {mine?.map((t) => (
          <Link key={t.key} to={`/t/${t.key}`} className={cls("nav-item", active === t.key && "active")}>
            <TeamMark id={t.key} />
            <span className="nav-label" dir="auto">
              {t.name}
            </span>
            {t.private && <LockIcon className="team-lock" aria-label="Private" />}
            {openCount(t) > 0 && <span className="nav-count">{openCount(t)}</span>}
          </Link>
        ))}
        {teams?.length === 0 && !guest ? (
          <button className="nav-item nav-muted" onClick={newTeam}>
            <PlusIcon />
            <span className="nav-label">Create a team</span>
          </button>
        ) : (
          <Link to="/teams" className={cls("nav-item nav-muted", on("teams") && "active")}>
            <TeamsIcon />
            <span className="nav-label">Browse teams</span>
          </Link>
        )}
      </nav>
      <AccountMenu />
    </aside>
  );
}

/** The sidebar footer: who you are, with settings and sign-out. */
function AccountMenu() {
  const { workspace } = useApp();
  const user = getYou();
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

// Keys typed into an IME composition (Japanese or Chinese input, say) belong to the IME: Enter there
// confirms the text. Stop them before any app handler can submit, save or move focus.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.isComposing || e.keyCode === 229) e.stopImmediatePropagation();
  },
  true,
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

// Here rather than inline in index.html, which the Content-Security-Policy doesn't allow.
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));

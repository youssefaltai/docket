// App shell: sidebar, routing, live updates, global shortcuts.
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IssueInput, Project } from "../shared/types";
import { api, subscribe } from "./api";
import { DocPage, DocsView } from "./docs";
import { IssuePage } from "./issue";
import { IssuesView } from "./issues";
import { NewDocModal, NewIssueModal, NewProjectModal } from "./modals";
import {
  AppContext,
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
  usePath,
  type AppState,
  type Route,
} from "./ui";

type ModalState =
  | { kind: "issue"; defaults: Partial<IssueInput> }
  | { kind: "doc"; project: string }
  | { kind: "project" }
  | null;

const DEFAULT_PEOPLE = ["anonymous", "claude"];

function App() {
  const path = usePath();
  const route = parseRoute(path);
  const [live, setLive] = useState(0);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsTick, setProjectsTick] = useState(0);
  const [labels, setLabels] = useState<string[]>([]);
  const [people, setPeople] = useState<string[]>(DEFAULT_PEOPLE);
  const [modal, setModal] = useState<ModalState>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [docProject, setDocProject] = useState<string | null>(null);

  // Live updates: coalesce bursts of server events into one refetch. The issue index
  // (statuses for identifier chips) only changes with issue and project events.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stale = true;
    const loadIndex = () => api.issues().then(setIssueIndex, () => {});
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
    api.projects().then(setProjects, errorToast);
  }, [live, projectsTick]);

  useEffect(() => setNavOpen(false), [path]);

  const loadDirectory = useCallback(() => {
    api.labels().then(setLabels, () => {});
    api.issues().then(
      (list) => {
        const names = list.map((i) => i.assignee).filter((a): a is string => !!a);
        setPeople([...new Set([...DEFAULT_PEOPLE, ...names])].sort((a, b) => a.localeCompare(b)));
      },
      () => {},
    );
  }, []);

  const currentProject = routeProject(route, docProject);
  const known = (key: string | null | undefined) => (key && projects?.some((p) => p.key === key) ? key : undefined);
  const pickProject = (key?: string | null) => known(key) ?? known(currentProject) ?? projects?.[0]?.key;

  const app: AppState = {
    projects,
    labels,
    people,
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
    setDocProject,
    openNav: () => setNavOpen(true),
  };

  // Global shortcuts. Read the latest state through a ref so the listener is registered once.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
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
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey.current(e);
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  }, []);

  return (
    <AppContext.Provider value={app}>
      <LiveContext.Provider value={live}>
        <div className={cls("app", navOpen && "nav-open")}>
          <Sidebar route={route} active={currentProject} />
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

function Sidebar({ route, active }: { route: Route; active: string | null }) {
  const { projects, newIssue, newProject } = useApp();
  const total = projects?.reduce((n, p) => n + openCount(p), 0) ?? 0;
  const docs = projects?.reduce((n, p) => n + (p.docCount ?? 0), 0) ?? 0;
  return (
    <aside className="sidebar">
      <Link to="/" className="brand">
        <Logo />
        <span>Docket</span>
      </Link>
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
    </aside>
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Client-side routing: the URL <-> Route mapping, history, and the <Link> that keeps clicks in the app.
// App URLs start with the workspace (/acme/issue/BRD-1), as in Linear.
import type { AnchorHTMLAttributes, MouseEvent as ReactMouseEvent } from "react";
import { useSyncExternalStore } from "react";
import { RESERVED_WORKSPACE_KEYS } from "../shared/types";
import { getCurrentWorkspace } from "./api";

export const MY_TABS = ["assigned", "created", "delegated", "subscribed"] as const;
export type MyTab = (typeof MY_TABS)[number];

type Page =
  | { view: "issues"; team: string | null }
  | { view: "docs"; team: string | null }
  | { view: "projects"; team: string | null }
  | { view: "project"; slug: string }
  | { view: "trash"; team: string }
  | { view: "triage"; team: string }
  | { view: "team-settings"; team: string }
  | { view: "issue"; id: string }
  | { view: "doc"; slug: string }
  | { view: "settings"; section: "account" | "workspace" }
  | { view: "inbox" }
  | { view: "my"; tab: MyTab };

/** A page, and the workspace in the URL's first segment: null for a path from before URLs carried one (or "/"). */
export type Route = Page & { workspace: string | null };

export function parseRoute(path: string): Route {
  const first = /^\/([^/]+)/.exec(path)?.[1];
  const workspace = first && !RESERVED_WORKSPACE_KEYS.includes(first) ? decodeURIComponent(first).toLowerCase() : null;
  return { ...parsePage(workspace ? path.slice(first!.length + 1) || "/" : path), workspace };
}

function parsePage(path: string): Page {
  const settings = /^\/settings\/(account|workspace)\/?$/.exec(path);
  if (settings) return { view: "settings", section: settings[1] as "account" | "workspace" };
  if (/^\/inbox\/?$/.test(path)) return { view: "inbox" };
  const my = /^\/my(?:\/([^/]+))?\/?$/.exec(path);
  if (my) {
    const tab = my[1] as MyTab | undefined;
    return { view: "my", tab: tab && (MY_TABS as readonly string[]).includes(tab) ? tab : "assigned" };
  }
  const issue = /^\/issue\/([^/]+)/.exec(path);
  if (issue) return { view: "issue", id: decodeURIComponent(issue[1]!).toUpperCase() };
  const doc = /^\/doc\/([^/]+)/.exec(path);
  if (doc) return { view: "doc", slug: decodeURIComponent(doc[1]!) };
  const project = /^\/project\/([^/]+)/.exec(path);
  if (project) return { view: "project", slug: decodeURIComponent(project[1]!) };
  if (/^\/projects\/?$/.test(path)) return { view: "projects", team: null };
  const team = /^\/t\/([^/]+)(\/docs|\/projects|\/trash|\/triage|\/settings)?/.exec(path);
  const key = team ? decodeURIComponent(team[1]!).toUpperCase() : null;
  if (key && team?.[2] === "/trash") return { view: "trash", team: key };
  if (key && team?.[2] === "/triage") return { view: "triage", team: key };
  if (key && team?.[2] === "/settings") return { view: "team-settings", team: key };
  if (key && team?.[2] === "/projects") return { view: "projects", team: key };
  return { view: team?.[2] || /^\/docs\/?$/.test(path) ? "docs" : "issues", team: key };
}

const routeListeners = new Set<() => void>();
const emitRoute = () => routeListeners.forEach((l) => l());
window.addEventListener("popstate", emitRoute);

/** Where Esc / breadcrumbs go back to from an issue, doc or project page; a new doc opens in edit mode. */
export const nav = { lastList: "/", lastDocs: "/docs", lastProjects: "/projects", editDoc: "" };

// App pages written without a workspace: /, /issue/…, /doc/…, /docs, /project/…, /projects, /t/…, /settings/…, /inbox, /my
const PAGE = /^\/(?:$|(?:issue|doc|docs|project|projects|t|settings|inbox|my)(?:[/?#]|$))/;

/** An app path in the current workspace: "/issue/BRD-1" → "/acme/issue/BRD-1". Anything else stays as it is. */
export function wsPath(path: string): string {
  const workspace = getCurrentWorkspace();
  return workspace && PAGE.test(path) ? `/${workspace}${path === "/" ? "" : path}` : path;
}

/** Goes to an app path; one written without a workspace goes there in the current one. */
export function navigate(path: string, replace = false) {
  const to = wsPath(path);
  if (to !== location.pathname + location.search) history[replace ? "replaceState" : "pushState"](null, "", to);
  emitRoute();
}

export function usePath() {
  return useSyncExternalStore(
    (cb) => {
      routeListeners.add(cb);
      return () => void routeListeners.delete(cb);
    },
    () => location.pathname,
  );
}

/** A left click with no modifier keys, which should route client-side (others open tabs, windows…). */
export const isPlainClick = (e: ReactMouseEvent) =>
  !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** A link to an app path; one written without a workspace (`/issue/BRD-1`) points into the current one. */
export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={wsPath(to)}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (!isPlainClick(e)) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

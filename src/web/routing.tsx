// Client-side routing: the URL <-> Route mapping, history, and the <Link> that keeps clicks in the app.
import type { AnchorHTMLAttributes, MouseEvent as ReactMouseEvent } from "react";
import { useSyncExternalStore } from "react";

export type Route =
  | { view: "issues"; team: string | null }
  | { view: "docs"; team: string | null }
  | { view: "trash"; team: string }
  | { view: "issue"; id: string }
  | { view: "doc"; slug: string }
  | { view: "settings"; section: "account" | "workspace" };

export function parseRoute(path: string): Route {
  const settings = /^\/settings\/(account|workspace)\/?$/.exec(path);
  if (settings) return { view: "settings", section: settings[1] as "account" | "workspace" };
  const issue = /^\/issue\/([^/]+)/.exec(path);
  if (issue) return { view: "issue", id: decodeURIComponent(issue[1]!).toUpperCase() };
  const doc = /^\/doc\/([^/]+)/.exec(path);
  if (doc) return { view: "doc", slug: decodeURIComponent(doc[1]!) };
  const team = /^\/t\/([^/]+)(\/docs|\/trash)?/.exec(path);
  const key = team ? decodeURIComponent(team[1]!).toUpperCase() : null;
  if (key && team?.[2] === "/trash") return { view: "trash", team: key };
  return { view: team?.[2] || /^\/docs\/?$/.test(path) ? "docs" : "issues", team: key };
}

const routeListeners = new Set<() => void>();
const emitRoute = () => routeListeners.forEach((l) => l());
window.addEventListener("popstate", emitRoute);

/** Where Esc / breadcrumbs go back to from an issue or doc page; a new doc opens in edit mode. */
export const nav = { lastList: "/", lastDocs: "/docs", editDoc: "" };

export function navigate(to: string, replace = false) {
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

export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
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

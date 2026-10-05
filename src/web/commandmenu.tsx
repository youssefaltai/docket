// The ⌘K / Ctrl+K command menu: one combobox over global actions, issues and docs. Mounted once in
// <App>, alongside <Toaster>/<Confirm>, so it's reachable from anywhere. See SPEC.md's Keyboard table.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DocumentSummary, IssueSummary } from "../shared/types";
import { api } from "./api";
import { can, managesWorkspace } from "./auth";
import {
  BoardIcon,
  ComposeIcon,
  CycleIcon,
  DocIcon,
  InboxIcon,
  IssuesIcon,
  ListIcon,
  MY_TABS,
  PlusIcon,
  ProjectIcon,
  SettingsIcon,
  IssueStatusIcon,
  StarIcon,
  TeamMark,
  TeamsIcon,
  ViewsIcon,
  cls,
  navigate,
  parseRoute,
  useApp,
  useIssueIndex,
  useKeydown,
  usePath,
  type MyTab,
} from "./ui";

interface Item {
  key: string;
  label: string;
  prefix?: string;
  icon?: ReactNode;
  group: "Actions" | "Views" | "Issues" | "Docs";
  run: () => void;
}

const action = (key: string, label: string, icon: ReactNode, run: () => void): Item => ({ key, label, icon, group: "Actions", run });

const MY_TAB_LABEL: Record<MyTab, string> = { assigned: "Assigned", created: "Created", delegated: "Delegated", subscribed: "Subscribed" };

/** Property pickers on the issue page, opened by the menu's context-aware actions (see `[data-cmd]` in issue.tsx). */
const PROPS: [string, string][] = [
  ["status", "Set status"],
  ["priority", "Set priority"],
  ["estimate", "Set estimate"],
  ["assignee", "Set assignee"],
  ["delegate", "Set delegate"],
  ["team", "Move to team"],
  ["project", "Set project"],
  ["milestone", "Set milestone"],
  ["cycle", "Set cycle"],
];

/** One-off issue-page actions, same context-aware [data-cmd] click-through as PROPS above. */
const ISSUE_ACTIONS: [string, string][] = [["archive", "Archive issue"]];

/** Filters `items` on `q` against `fields`, exact matches first, capped at `cap`. Same substring+exact-boost
 * approach as `<Picker>` (`pickers.tsx`) — no fuzzy-matching library, per project rules. */
function pick<T>(items: T[], q: string, fields: (t: T) => string[], cap: number): T[] {
  if (!q) return items.slice(0, cap);
  return items
    .map((item) => {
      const fs = fields(item).map((f) => f.toLowerCase());
      return fs.some((f) => f.includes(q)) ? { item, exact: fs.some((f) => f === q) } : null;
    })
    .filter((x): x is { item: T; exact: boolean } => !!x)
    .sort((a, b) => Number(b.exact) - Number(a.exact))
    .slice(0, cap)
    .map((s) => s.item);
}

// Lets the sidebar's mobile-reachable button open the menu without lifting its state into AppState.
let requestOpen = () => {};
export const openCommandMenu = () => requestOpen();

export function CommandMenu() {
  const app = useApp();
  const path = usePath();
  const route = parseRoute(path);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const index = useIssueIndex();
  const opener = useRef<HTMLElement | null>(null);
  const pop = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) setTimeout(() => opener.current?.focus?.({ preventScroll: true }));
  };

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setActive(0);
  }, [open]);

  useEffect(() => {
    requestOpen = () => setOpen(true);
    return () => {
      requestOpen = () => {};
    };
  }, []);

  // Docs: fetched lazily on first open, cached for the session; refetched when the workspace changes.
  useEffect(() => setDocs(null), [app.workspace?.key]);
  useEffect(() => {
    if (open && docs === null) api.documents().then(setDocs, () => setDocs([]));
  }, [open, docs]);

  // ⌘K/Ctrl+K opens it from anywhere, even while typing — the one shortcut that wins over a text field —
  // except inside the rich editor (it keeps ⌘K for its own link shortcut) or another open popover/modal.
  useKeydown((e) => {
    if (e.defaultPrevented || open) return;
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k" || e.shiftKey || e.altKey) return;
    if ((document.activeElement as HTMLElement | null)?.closest(".rich-host")) return;
    if (document.querySelector(".pop, .backdrop")) return;
    e.preventDefault();
    setOpen(true);
  });

  const go = (to: string) => () => {
    close(false);
    navigate(to);
  };
  const act = (fn: () => void) => () => {
    close(false);
    fn();
  };

  const items = useMemo((): Item[] => {
    if (!open) return [];
    const q = query.trim().toLowerCase();
    const all: Item[] = [
      action("new-issue", "New issue", <ComposeIcon />, act(() => app.newIssue())),
      action("new-doc", "New doc", <DocIcon />, act(() => app.newDoc())),
      action("new-project", "New project", <ProjectIcon />, act(() => app.newProject())),
      action("new-team", "New team", <PlusIcon />, act(app.newTeam)),
      action("new-workspace", "New workspace", <PlusIcon />, act(app.newWorkspace)),
      action("new-view", "New view", <ViewsIcon />, act(() => app.newView())),
      action("go-inbox", "Go to Inbox", <InboxIcon />, go("/inbox")),
      action("go-my", "Go to My Issues", <IssuesIcon />, go("/my")),
      ...MY_TABS.map((t) => action(`go-my-${t}`, `Go to My Issues: ${MY_TAB_LABEL[t]}`, <IssuesIcon />, go(`/my/${t}`))),
      action("go-issues", "Go to All issues", <IssuesIcon />, go("/")),
      action("go-docs", "Go to All docs", <DocIcon />, go("/docs")),
      action("go-projects", "Go to Projects", <ProjectIcon />, go("/projects")),
      action("go-views", "Go to Views", <ViewsIcon />, go("/views")),
      action("go-teams", "Go to Teams", <TeamsIcon />, go("/teams")),
      action("go-settings", "Go to Settings", <SettingsIcon />, go("/settings/account")),
    ];
    // Without browsing the workspace (guests), no workspace views; without teams.create, no new teams.
    const hidden = [...(can("workspace.browse") ? [] : ["new-view", "go-views"]), ...(can("teams.create") ? [] : ["new-team"])];
    const actions = all.filter((a) => !hidden.includes(a.key));
    for (const t of app.teams ?? [])
      if (t.cycleWeeks) actions.push(action(`go-cycles-${t.key}`, `Go to Cycles: ${t.name}`, <CycleIcon />, go(`/t/${t.key}/cycles`)));
    if (managesWorkspace())
      actions.push(action("go-workspace-settings", "Go to Workspace settings", <SettingsIcon />, go("/settings/workspace")));
    for (const w of app.workspaces ?? [])
      if (w.key !== app.workspace?.key)
        actions.push(action(`switch-${w.key}`, `Switch workspace: ${w.name}`, <TeamMark id={w.name.toUpperCase()} />, act(() => app.switchWorkspace(w.key))));
    // Toggle List/Board: only where that segmented control is on screen and enabled (issues, My Issues and view pages).
    if (route.view === "issues" || route.view === "my" || route.view === "customview") {
      const seg = document.querySelector<HTMLElement>('.segmented[aria-label="Layout"]');
      const current = seg?.querySelector<HTMLButtonElement>("button.on");
      const other = seg?.querySelector<HTMLButtonElement>("button:not(.on):not(:disabled)");
      if (current && other) {
        const toBoard = current.title === "List";
        actions.push(action("toggle-view", toBoard ? "Switch to Board view" : "Switch to List view", toBoard ? <BoardIcon /> : <ListIcon />, act(() => other.click())));
      }
    }
    // Context-aware: on an issue page, open its existing property pickers, or run a one-off action, rather than
    // a new interaction. A picker's [data-cmd] wraps its trigger button; an action's is the button itself.
    if (route.view === "issue")
      for (const [prop, label] of [...PROPS, ...ISSUE_ACTIONS]) {
        const button = () => {
          const el = document.querySelector<HTMLElement>(`[data-cmd="${prop}"]`);
          return el instanceof HTMLButtonElement ? el : (el?.querySelector<HTMLButtonElement>("button") ?? null);
        };
        if (button())
          actions.push(
            action(`set-${prop}`, label, undefined, () => {
              close(false);
              setTimeout(() => button()?.click());
            }),
          );
      }

    const issues: IssueSummary[] = index ? [...new Set(index.values())].filter((i) => !i.deletedAt) : []; // once each, not per old identifier
    const issueItems = pick(issues, q, (i) => [i.id, i.title], q ? 8 : 0).map(
      (i): Item => ({ key: i.id, label: i.title, prefix: i.id, icon: <IssueStatusIcon issue={i} />, group: "Issues", run: go(`/issue/${i.id}`) }),
    );
    const docItems = pick(docs ?? [], q, (d) => [d.title], q ? 5 : 0).map(
      (d): Item => ({ key: d.slug, label: d.title, icon: <DocIcon />, group: "Docs", run: go(`/doc/${d.slug}`) }),
    );

    // Views: your starred ones up front; typing finds any of the workspace's by name.
    const views = app.views ?? [];
    const viewItems = (q ? pick(views, q, (v) => [v.name], 5) : views.filter((v) => v.favorite)).map(
      (v): Item => ({ key: `view-${v.id}`, label: v.name, icon: v.favorite ? <StarIcon /> : <ViewsIcon />, group: "Views", run: go(`/view/${v.id}`) }),
    );

    return [...pick(actions, q, (a) => [a.label], q ? 8 : actions.length), ...viewItems, ...issueItems, ...docItems];
  }, [open, query, app, route.view, index, docs]);

  const current = Math.min(active, items.length - 1);

  useLayoutEffect(() => {
    if (open) pop.current?.querySelector(`[data-i="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, current]);

  if (!open) return null;

  let lastGroup: string | null = null;
  return createPortal(
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div ref={pop} className="modal cmdk" role="dialog" aria-modal="true" aria-label="Command menu">
        <input
          className="pop-search cmdk-input"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={items[current] ? optionId(current) : undefined}
          autoFocus
          value={query}
          placeholder="Search actions, views, issues and docs…"
          dir="auto"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
              e.preventDefault();
              setActive(Math.min(current + 1, items.length - 1));
            } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
              e.preventDefault();
              setActive(Math.max(current - 1, 0));
            } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              items[current]?.run();
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "Tab") close(false);
          }}
        />
        <div className="pop-list cmdk-list" id={listId} role="listbox">
          {items.map((it, i) => {
            const header = it.group !== lastGroup;
            lastGroup = it.group;
            return (
              <div key={it.key}>
                {header && <div className="cmdk-group">{it.group}</div>}
                <div
                  id={optionId(i)}
                  data-i={i}
                  role="option"
                  aria-selected={i === current}
                  className={cls("pop-item", i === current && "active")}
                  onPointerMove={() => i !== current && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => it.run()}
                >
                  {it.icon && <span className="pop-icon">{it.icon}</span>}
                  {it.prefix && <span className="pop-prefix">{it.prefix}</span>}
                  <span className="pop-label" dir="auto">
                    {it.label}
                  </span>
                </div>
              </div>
            );
          })}
          {items.length === 0 && <div className="pop-empty">No results</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

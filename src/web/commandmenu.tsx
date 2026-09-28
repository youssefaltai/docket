// The ⌘K / Ctrl+K command menu: one combobox over global actions, issues and docs. Mounted once in
// <App>, alongside <Toaster>/<Confirm>, so it's reachable from anywhere. See SPEC.md's Keyboard table.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DocumentSummary, IssueSummary } from "../shared/types";
import { api } from "./api";
import {
  BoardIcon,
  ComposeIcon,
  DocIcon,
  InboxIcon,
  IssuesIcon,
  ListIcon,
  MY_TABS,
  PlusIcon,
  SettingsIcon,
  IssueStatusIcon,
  TeamMark,
  cls,
  navigate,
  parseRoute,
  useApp,
  useIssueIndex,
  useKeydown,
  usePath,
  visibleCmd,
  type MyTab,
} from "./ui";

interface Item {
  key: string;
  label: string;
  prefix?: string;
  icon?: ReactNode;
  group: "Actions" | "Issues" | "Docs";
  run: () => void;
}

const MY_TAB_LABEL: Record<MyTab, string> = { assigned: "Assigned", created: "Created", delegated: "Delegated", subscribed: "Subscribed" };

/** Property pickers on the issue page, opened by the menu's context-aware actions (see `[data-cmd]` in issue.tsx). */
const PROPS: [string, string][] = [
  ["status", "Set status"],
  ["priority", "Set priority"],
  ["assignee", "Set assignee"],
  ["delegate", "Set delegate"],
  ["team", "Move to team"],
];

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
    const actions: Item[] = [
      { key: "new-issue", label: "New issue", icon: <ComposeIcon />, group: "Actions", run: act(() => app.newIssue()) },
      { key: "new-doc", label: "New doc", icon: <DocIcon />, group: "Actions", run: act(() => app.newDoc()) },
      { key: "new-team", label: "New team", icon: <PlusIcon />, group: "Actions", run: act(app.newTeam) },
      { key: "new-workspace", label: "New workspace", icon: <PlusIcon />, group: "Actions", run: act(app.newWorkspace) },
      { key: "go-inbox", label: "Go to Inbox", icon: <InboxIcon />, group: "Actions", run: go("/inbox") },
      { key: "go-my", label: "Go to My Issues", icon: <IssuesIcon />, group: "Actions", run: go("/my") },
      ...MY_TABS.map((t): Item => ({
        key: `go-my-${t}`,
        label: `Go to My Issues: ${MY_TAB_LABEL[t]}`,
        icon: <IssuesIcon />,
        group: "Actions",
        run: go(`/my/${t}`),
      })),
      { key: "go-issues", label: "Go to All issues", icon: <IssuesIcon />, group: "Actions", run: go("/") },
      { key: "go-docs", label: "Go to All docs", icon: <DocIcon />, group: "Actions", run: go("/docs") },
      { key: "go-settings", label: "Go to Settings", icon: <SettingsIcon />, group: "Actions", run: go("/settings/account") },
    ];
    if (app.workspace?.role === "admin")
      actions.push({ key: "go-workspace-settings", label: "Go to Workspace settings", icon: <SettingsIcon />, group: "Actions", run: go("/settings/workspace") });
    for (const w of app.workspaces ?? [])
      if (w.key !== app.workspace?.key)
        actions.push({
          key: `switch-${w.key}`,
          label: `Switch workspace: ${w.name}`,
          icon: <TeamMark id={w.name.toUpperCase()} />,
          group: "Actions",
          run: act(() => app.switchWorkspace(w.key)),
        });
    // Toggle List/Board: only where that segmented control is on screen (issues and My Issues pages).
    if (route.view === "issues" || route.view === "my") {
      const seg = document.querySelector<HTMLElement>('.segmented[aria-label="Layout"]');
      const current = seg?.querySelector<HTMLButtonElement>("button.on");
      const other = seg?.querySelector<HTMLButtonElement>("button:not(.on)");
      if (current && other) {
        const toBoard = current.title === "List";
        actions.push({
          key: "toggle-view",
          label: toBoard ? "Switch to Board view" : "Switch to List view",
          icon: toBoard ? <BoardIcon /> : <ListIcon />,
          group: "Actions",
          run: act(() => other.click()),
        });
      }
    }
    // Context-aware: on an issue page, open its existing property pickers rather than a new interaction.
    if (route.view === "issue")
      for (const [prop, label] of PROPS) {
        const button = () => visibleCmd(document, prop)?.querySelector<HTMLButtonElement>("button");
        if (button())
          actions.push({
            key: `set-${prop}`,
            label,
            group: "Actions",
            run: () => {
              close(false);
              setTimeout(() => button()?.click());
            },
          });
      }

    const issues: IssueSummary[] = index ? [...new Set(index.values())].filter((i) => !i.deletedAt) : []; // once each, not per old identifier
    const issueItems = pick(issues, q, (i) => [i.id, i.title], q ? 8 : 0).map(
      (i): Item => ({ key: i.id, label: i.title, prefix: i.id, icon: <IssueStatusIcon issue={i} />, group: "Issues", run: go(`/issue/${i.id}`) }),
    );
    const docItems = pick(docs ?? [], q, (d) => [d.title], q ? 5 : 0).map(
      (d): Item => ({ key: d.slug, label: d.title, icon: <DocIcon />, group: "Docs", run: go(`/doc/${d.slug}`) }),
    );

    return [...pick(actions, q, (a) => [a.label], q ? 8 : actions.length), ...issueItems, ...docItems];
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
          placeholder="Search actions, issues and docs…"
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

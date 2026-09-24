// Shared primitives: routing, app context, toasts, icons, markdown, modal.
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  type SVGProps,
} from "react";
import { createPortal } from "react-dom";
import { Marked } from "marked";
import { api } from "./api";
import type { IssueInput, IssueSummary, Priority, Project, Status } from "../shared/types";

export const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");
export const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

// ---------- Routing ----------

export type Route =
  | { view: "issues"; project: string | null }
  | { view: "docs"; project: string | null }
  | { view: "issue"; id: string }
  | { view: "doc"; slug: string };

export function parseRoute(path: string): Route {
  const issue = /^\/issue\/([^/]+)/.exec(path);
  if (issue) return { view: "issue", id: decodeURIComponent(issue[1]!).toUpperCase() };
  const doc = /^\/doc\/([^/]+)/.exec(path);
  if (doc) return { view: "doc", slug: decodeURIComponent(doc[1]!) };
  const project = /^\/p\/([^/]+)(\/docs)?/.exec(path);
  const key = project ? decodeURIComponent(project[1]!).toUpperCase() : null;
  return { view: project?.[2] || /^\/docs\/?$/.test(path) ? "docs" : "issues", project: key };
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

export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

// ---------- App context ----------

export interface AppState {
  projects: Project[] | null;
  labels: string[];
  people: string[];
  /** Refresh labels + known assignees (called when a picker opens). */
  loadDirectory: () => void;
  reloadProjects: () => void;
  newIssue: (defaults?: Partial<IssueInput>) => void;
  newDoc: (project?: string) => void;
  newProject: () => void;
  /** The doc page reports its project so the sidebar and "new" defaults follow it. */
  setDocProject: (key: string | null) => void;
  openNav: () => void;
}

export const AppContext = createContext<AppState>(null!);
export const useApp = () => useContext(AppContext);

/** Bumped (debounced) on every server event; views refetch when it changes. */
export const LiveContext = createContext(0);
export const useLive = () => useContext(LiveContext);

// ---------- Hooks & helpers ----------

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  }, [ref, value]);
}

export const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export const openCount = (p: Project) => p.counts.backlog + p.counts.todo + p.counts.in_progress + p.counts.in_review;

const statusRank = (s: Status) => ["backlog", "todo", "in_progress", "in_review", "done", "canceled"].indexOf(s);
const priorityRank = (p: Priority) => (p === 0 ? 5 : p);

/** Server order: status, priority (1→4, none last), most recently updated. */
export function sortIssues<T extends IssueSummary>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      priorityRank(a.priority) - priorityRank(b.priority) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function timeAgo(iso: string): string {
  const date = new Date(iso);
  const s = (Date.now() - date.getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

/** Sentence form: "just now", "5m ago", "on Mar 4". */
export function ago(iso: string): string {
  const t = timeAgo(iso);
  return t === "now" ? "just now" : /^\d+[mhd]$/.test(t) ? `${t} ago` : `on ${t}`;
}

export const fullDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// A small set of distinct hues reads calmer than the whole wheel.
const HUES = [212, 152, 32, 268, 350, 186, 48, 232, 12, 300];

export function hue(s: string): number {
  let h = 2166136261;
  for (const c of s.toLowerCase()) h = Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0;
  return HUES[h % HUES.length]!;
}

const hueStyle = (s: string) => ({ "--h": hue(s) }) as CSSProperties;

// ---------- Toasts ----------

interface Toast {
  id: number;
  text: string;
  href?: string;
}
let toasts: Toast[] = [];
let toastId = 0;
const toastListeners = new Set<() => void>();
const emitToasts = () => toastListeners.forEach((l) => l());

export function toast(text: string, href?: string) {
  const t = { id: ++toastId, text, href };
  toasts = [...toasts.slice(-2), t];
  emitToasts();
  setTimeout(() => {
    toasts = toasts.filter((x) => x !== t);
    emitToasts();
  }, 4000);
}

export const errorToast = (e: unknown) => toast(e instanceof Error ? e.message : String(e));

export function Toaster() {
  const list = useSyncExternalStore(
    (cb) => {
      toastListeners.add(cb);
      return () => void toastListeners.delete(cb);
    },
    () => toasts,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div className="toast" key={t.id}>
          <span dir="auto">{t.text}</span>
          {t.href && (
            <Link to={t.href} className="toast-link">
              View
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- Icons ----------

type IconProps = SVGProps<SVGSVGElement>;
const icon = (d: string) => (props: IconProps) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <path d={d} />
  </svg>
);

export const PlusIcon = icon("M8 3.5v9M3.5 8h9");
export const CloseIcon = icon("M4.5 4.5l7 7M11.5 4.5l-7 7");
export const CheckIcon = icon("M3.5 8.5l3 3 6-7");
export const ChevronRightIcon = icon("M6.5 4l4 4-4 4");
export const ChevronDownIcon = icon("M4 6.5l4 4 4-4");
export const SearchIcon = icon("M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM13.5 13.5l-3-3");
export const MenuIcon = icon("M2.5 4.5h11M2.5 8h11M2.5 11.5h11");
export const ListIcon = icon("M2.5 4h11M2.5 8h11M2.5 12h11");
export const BoardIcon = icon("M3 2.5h2.5v11H3zM6.75 2.5h2.5v7h-2.5zM10.5 2.5H13v9h-2.5z");
export const IssuesIcon = icon("M2.5 6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM4.5 2.75h7");
export const TagIcon = icon("M2.5 3.5a1 1 0 0 1 1-1h4l6 6-5 5-6-6zM5.5 5.5h.01");
export const ParentIcon = icon("M4 2.5v6a2 2 0 0 0 2 2h6.5M10 8l2.5 2.5L10 13");
export const BlockedIcon = icon("M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM3.8 3.8l8.4 8.4");
export const TrashIcon = icon("M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6");
export const PencilIcon = icon("M10.5 2.5l3 3L6 13H3v-3z");
export const CopyIcon = icon("M5.5 5.5h7v7h-7zM10.5 5.5v-2h-7v7h2");
export const DocIcon = icon("M3.5 2.5a1 1 0 0 1 1-1h4.5l3.5 3.5v8.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1zM9 1.5V5h3.5M6 8.5h4M6 11h2.5");
export const HistoryIcon = icon("M2 8a6 6 0 1 0 6-6 6.5 6.5 0 0 0-4.5 1.8L2 5.3M2 2v3.3h3.3M8 4.7V8l2.7 1.3");
export const ComposeIcon = icon("M13.5 8.5v4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h4M11.5 2.5l2 2L8 10H6V8z");

export function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
      <rect width="16" height="16" rx="4" fill="currentColor" />
      <rect x="4" y="5" width="8" height="1.6" rx=".8" fill="#fff" />
      <rect x="4" y="9.4" width="5" height="1.6" rx=".8" fill="#fff" />
    </svg>
  );
}

/** Status icon markup, shared by <StatusIcon> and the issue chips inside rendered markdown. */
function statusBody(status: Status): string {
  const c = `var(--s-${status})`;
  const ring = `<circle cx="7" cy="7" r="6" stroke="${c}" stroke-width="1.5" fill="none"/>`;
  const pie = (f: number) =>
    `<circle cx="7" cy="7" r="2" fill="none" stroke="${c}" stroke-width="4" stroke-dasharray="${f * 4 * Math.PI} 100" transform="rotate(-90 7 7)"/>`;
  const disc = (mark: string) =>
    `<circle cx="7" cy="7" r="6.75" fill="${c}"/><path d="${mark}" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  return {
    backlog: `<circle cx="7" cy="7" r="6" stroke="${c}" stroke-width="1.5" fill="none" stroke-dasharray="2.1 1.67"/>`,
    todo: ring,
    in_progress: ring + pie(0.5),
    in_review: ring + pie(0.75),
    done: disc("M4.4 7.2l1.8 1.8 3.5-3.7"),
    canceled: disc("M5 5l4 4M9 5l-4 4"),
  }[status];
}

const statusSvg = (status: Status) =>
  `<svg class="status-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">${statusBody(status)}</svg>`;

export function StatusIcon({ status, size = 14 }: { status: Status; size?: number }) {
  return (
    <svg
      className="status-icon"
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: statusBody(status) }}
    />
  );
}

export function PriorityIcon({ priority }: { priority: Priority }) {
  if (priority === 1)
    return (
      <svg className="priority-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--urgent)" />
        <rect x="6.25" y="3.5" width="1.5" height="4.5" rx=".75" fill="#fff" />
        <circle cx="7" cy="10.1" r=".9" fill="#fff" />
      </svg>
    );
  if (priority === 0)
    return (
      <svg className="priority-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="var(--faint)">
        <rect x="1.5" y="6.25" width="2.5" height="1.5" rx=".75" />
        <rect x="5.75" y="6.25" width="2.5" height="1.5" rx=".75" />
        <rect x="10" y="6.25" width="2.5" height="1.5" rx=".75" />
      </svg>
    );
  const filled = 5 - priority; // high 3, medium 2, low 1
  return (
    <svg className="priority-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="currentColor">
      {[
        [1.5, 8, 4.5],
        [5.5, 5, 7.5],
        [9.5, 2, 10.5],
      ].map(([x, y, h], i) => (
        <rect key={i} x={x} y={y} width="3" height={h} rx="1" opacity={i < filled ? 1 : 0.25} />
      ))}
    </svg>
  );
}

// ---------- Small components ----------

export function Avatar({ name }: { name: string | null }) {
  if (!name)
    return (
      <span className="avatar avatar-none" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18">
          <circle cx="9" cy="9" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
        </svg>
      </span>
    );
  return (
    <span className="avatar" style={hueStyle(name)} aria-hidden="true">
      {[...name.trim()][0]?.toUpperCase()}
    </span>
  );
}

export const LabelDot = ({ name }: { name: string }) => <i className="label-dot" style={hueStyle(name)} />;

export function LabelChip({ name }: { name: string }) {
  return (
    <span className="label" dir="auto">
      <LabelDot name={name} />
      {name}
    </span>
  );
}

export function ProjectMark({ id }: { id: string }) {
  return (
    <span className="project-mark" style={hueStyle(id)} aria-hidden="true">
      {id[0]}
    </span>
  );
}

/** Project header: mark + inline-editable name, and the Issues / Docs tabs. */
export function ProjectTitle({ project }: { project: Project }) {
  const { reloadProjects } = useApp();
  return (
    <>
      <ProjectMark id={project.key} />
      <InlineInput
        label="Project name"
        value={project.name}
        onSave={(name) => api.updateProject(project.key, { name }).then(reloadProjects, errorToast)}
      />
    </>
  );
}

export function ProjectTabs({ project, view }: { project: string; view: "issues" | "docs" }) {
  const tab = (v: typeof view, to: string, label: string) => (
    <Link to={to} className={cls("tab", view === v && "on")} aria-current={view === v ? "page" : undefined}>
      {label}
    </Link>
  );
  return (
    <nav className="tabs" aria-label="Project views">
      {tab("issues", `/p/${project}`, "Issues")}
      {tab("docs", `/p/${project}/docs`, "Docs")}
    </nav>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;

export function MenuButton() {
  const { openNav } = useApp();
  return (
    <button className="icon-btn menu-btn" onClick={openNav} aria-label="Open menu">
      <MenuIcon />
    </button>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Single-line text that looks like text until focused. Enter saves, Esc reverts. */
export function InlineInput({
  value,
  onSave,
  className,
  label,
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  const skip = useRef(false);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className={cls("inline-input", className)}
      value={draft}
      dir="auto"
      aria-label={label}
      size={Math.max(4, [...draft].length)}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.preventDefault();
          skip.current = true;
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        const v = draft.trim();
        if (!skip.current && v && v !== value) onSave(v);
        else setDraft(value);
        skip.current = false;
      }}
    />
  );
}

// ---------- Issue index (for identifier chips in markdown) ----------

let issueIndex: Map<string, IssueSummary> | null = null;
const indexListeners = new Set<() => void>();

export function setIssueIndex(list: IssueSummary[]) {
  issueIndex = new Map(list.map((i) => [i.id, i]));
  indexListeners.forEach((l) => l());
}

const useIssueIndex = () =>
  useSyncExternalStore(
    (cb) => {
      indexListeners.add(cb);
      return () => void indexListeners.delete(cb);
    },
    () => issueIndex,
  );

// ---------- Markdown ----------

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Browsers strip whitespace/control chars when parsing URLs, so check the cleaned form. */
function safeUrl(href: string): string | null {
  const url = href.replace(/[\u0000- ]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
  return !scheme || /^(https?|mailto)$/i.test(scheme) ? url : null;
}

/** App paths and in-page anchors stay in the tab (and route client-side); everything else opens a new one. */
const isInternal = (url: string) => /^(\/(?!\/)|#)/.test(url);

// Set right before each parse: which identifiers resolve to real issues of known projects.
let chipKeys = new Set<string>();
let chipIndex: Map<string, IssueSummary> | null = null;
const chipFor = (id: string) => (chipKeys.has(id.slice(0, id.indexOf("-"))) ? chipIndex?.get(id) : undefined);
const IDENT = /\b[A-Z]{2,5}-\d+\b/g;

// Heading ids for the outline and #anchors; deduped per parse.
let headingIds = new Map<string, number>();
function headingId(text: string): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const n = headingIds.get(base) ?? 0;
  headingIds.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  hooks: {
    preprocess(md) {
      headingIds = new Map();
      return md;
    },
  },
  extensions: [
    {
      name: "issueRef",
      level: "inline",
      start(src) {
        for (const m of src.matchAll(IDENT)) if (chipFor(m[0])) return m.index;
      },
      tokenizer(src) {
        const m = /^[A-Z]{2,5}-\d+\b/.exec(src);
        if (m && !this.lexer.state.inLink && chipFor(m[0])) return { type: "issueRef", raw: m[0] };
      },
      renderer({ raw }) {
        const issue = chipFor(raw);
        if (!issue) return raw;
        return `<a class="issue-ref" href="/issue/${raw}" title="${escapeHtml(issue.title)}">${statusSvg(issue.status)}${raw}</a>`;
      },
    },
  ],
  renderer: {
    // Raw HTML is shown as text, never rendered.
    html: ({ text, block }) => (block ? `<p>${escapeHtml(text)}</p>` : escapeHtml(text)),
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${escapeHtml(headingId(text))}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const url = safeUrl(href);
      if (!url) return text;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      const target = isInternal(url) ? "" : ` target="_blank" rel="noopener noreferrer"`;
      return `<a href="${escapeHtml(url)}"${t}${target}>${text}</a>`;
    },
    image({ href, title, text }) {
      const url = safeUrl(href);
      if (!url) return escapeHtml(text);
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${t} loading="lazy">`;
    },
  },
});

export function Markdown({ text, className }: { text: string; className?: string }) {
  const { projects } = useApp();
  const index = useIssueIndex();
  const html = useMemo(() => {
    chipKeys = new Set(projects?.map((p) => p.key));
    chipIndex = index;
    return (marked.parse(text) as string).replace(/<(p|h[1-6]|ul|ol|blockquote|table|td|th)(?=[\s>])/g, '<$1 dir="auto"');
  }, [text, projects, index]);
  return (
    <div
      className={cls("md", className)}
      dir="auto"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        // Links to /doc/…, /issue/… etc. route client-side.
        const href = (e.target as Element).closest("a")?.getAttribute("href");
        if (!href?.startsWith("/") || href.startsWith("//")) return;
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
    />
  );
}

// ---------- Modal ----------

export function Modal({
  label,
  className,
  onClose,
  onSubmit,
  children,
}: {
  label: string;
  className?: string;
  onClose: () => void;
  onSubmit?: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.({ preventScroll: true });
  }, []);
  return createPortal(
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cls("modal", className)}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={(e) => {
          if (e.defaultPrevented) return;
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit?.();
          }
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

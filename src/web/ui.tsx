// Shared primitives: routing, app context, hooks, toasts, icons, markdown, modal, comments.
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
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type SVGProps,
} from "react";
import { createPortal } from "react-dom";
import { Marked } from "marked";
import { HttpError, api } from "./api";
import { getMe } from "./auth";
import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  STATUSES,
  type Comment,
  type IssueInput,
  type IssuePatch,
  type IssueSummary,
  type Priority,
  type Team,
  type Status,
  type UserRef,
  type Workspace,
  type WorkspaceMember,
} from "../shared/types";

// Keys typed into an IME composition (Japanese or Chinese input, say) belong to the IME: Enter there
// confirms the text. Stop them before any app handler can submit, save or move focus.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.isComposing || e.keyCode === 229) e.stopImmediatePropagation();
  },
  true,
);

export const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");
export const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

// ---------- Routing ----------

export type Route =
  | { view: "issues"; team: string | null }
  | { view: "docs"; team: string | null }
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
  const team = /^\/t\/([^/]+)(\/docs)?/.exec(path);
  const key = team ? decodeURIComponent(team[1]!).toUpperCase() : null;
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
const isPlainClick = (e: ReactMouseEvent) =>
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

// ---------- App context ----------

export interface AppState {
  workspaces: Workspace[] | null;
  /** The current workspace: remembered, following deep links, else the first. */
  workspace: Workspace | null;
  /** Every team, in any workspace (identifier chips, issue and doc pages). */
  teams: Team[] | null;
  /** Teams in the current workspace (sidebar, pickers, new issue/doc defaults). */
  workspaceTeams: Team[] | null;
  labels: string[];
  /** The current workspace's members (assignee and delegate pickers). */
  members: WorkspaceMember[];
  /** Refresh labels and members (called when a picker opens). */
  loadDirectory: () => void;
  /** Refetch teams and workspaces now, without waiting for the live update. */
  reloadTeams: () => void;
  newIssue: (defaults?: Partial<IssueInput>) => void;
  newDoc: (team?: string) => void;
  newTeam: () => void;
  newWorkspace: () => void;
  teamSettings: (key: string) => void;
  /** The doc page reports its team so the sidebar and "new" defaults follow it. */
  setDocTeam: (key: string | null) => void;
  openNav: () => void;
}

export const AppContext = createContext<AppState>(null!);
export const useApp = () => useContext(AppContext);

/** Bumped (debounced) on every server event; views refetch when it changes. */
export const LiveContext = createContext(0);
const useLive = () => useContext(LiveContext);

// ---------- Hooks & helpers ----------

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Loads data on mount, when `deps` change and on every live update; a `null` loader waits.
 * Only the latest request lands: `invalidate()` also drops any in flight (call it before
 * applying a local change) and returns a ticket that `isLatest` checks later.
 */
export function useFetch<T>(load: (() => Promise<T>) | null, deps: unknown[]) {
  const live = useLive();
  const [data, setData] = useState<T | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(""); // why the first load failed (offline, say), for the page to show
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const loaded = useRef(false);
  useEffect(() => {
    if (!load) return;
    const n = ++seq.current;
    load().then(
      (d) => {
        if (n !== seq.current) return;
        loaded.current = true;
        setData(d);
        setMissing(false);
        setFailed("");
      },
      (e) => {
        if (n !== seq.current) return;
        if (e instanceof HttpError && e.status === 404) setMissing(true);
        else if (loaded.current) errorToast(e);
        else setFailed(e instanceof Error ? e.message : String(e));
      },
    );
  }, [...deps, live, tick]);
  return {
    data,
    setData,
    missing,
    failed,
    reload: () => setTick((t) => t + 1),
    invalidate: () => ++seq.current,
    isLatest: (n: number) => n === seq.current,
  };
}

/** A document keydown listener that always sees the latest `handler`, registered once. */
export function useKeydown(handler: (e: KeyboardEvent) => void, capture = false) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => latest.current(e);
    addEventListener("keydown", listener, capture);
    return () => removeEventListener("keydown", listener, capture);
  }, [capture]);
}

export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  }, [ref, value]);
}

/** Runs one action at a time; failures toast unless `onError` handles them. */
export function useRun() {
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

export const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export const openCount = (t: Team) => OPEN_STATUSES.reduce((n, s) => n + t.counts[s], 0);

/** An issue edit as the UI shows it (users as refs), so it can be applied optimistically. */
export type IssueChange = Omit<IssuePatch, "assignee" | "delegate"> & { assignee?: UserRef | null; delegate?: UserRef | null };

/** The same edit as the API takes it (users by username). */
export function toPatch({ assignee, delegate, ...patch }: IssueChange): IssuePatch {
  if (assignee !== undefined) (patch as IssuePatch).assignee = assignee?.username ?? null;
  if (delegate !== undefined) (patch as IssuePatch).delegate = delegate?.username ?? null;
  return patch;
}

const statusRank = (s: Status) => STATUSES.indexOf(s);
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

function hue(s: string): number {
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

/** Copies `text` and toasts `done`. */
export const copyText = (text: string, done: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast(done),
    () => toast("Couldn’t copy to clipboard"),
  );

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

// ---------- Confirm ----------

interface Question {
  text: string;
  action: string;
  resolve: (ok: boolean) => void;
}
let question: Question | null = null;
const questionListeners = new Set<() => void>();
function setQuestion(q: Question | null) {
  question = q;
  questionListeners.forEach((l) => l());
}

/** The app's own confirm(): resolves true if the user confirms. `action` labels the button ("Delete"). */
export function ask(text: string, action: string): Promise<boolean> {
  question?.resolve(false);
  return new Promise((resolve) => setQuestion({ text, action, resolve }));
}

/** Renders the pending `ask`, if any; mounted once by the app. */
export function Confirm() {
  const q = useSyncExternalStore(
    (cb) => {
      questionListeners.add(cb);
      return () => void questionListeners.delete(cb);
    },
    () => question,
  );
  if (!q) return null;
  const answer = (ok: boolean) => {
    setQuestion(null);
    q.resolve(ok);
  };
  return (
    <Modal label={q.action} className="modal-sm" onClose={() => answer(false)} onSubmit={() => answer(true)}>
      <p className="confirm-text" dir="auto">
        {q.text}
      </p>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn" onClick={() => answer(false)}>
          Cancel
        </button>
        <button className="btn btn-danger" autoFocus onClick={() => answer(true)}>
          {q.action}
        </button>
      </div>
    </Modal>
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
const MenuIcon = icon("M2.5 4.5h11M2.5 8h11M2.5 11.5h11");
export const ListIcon = icon("M2.5 4h11M2.5 8h11M2.5 12h11");
export const BoardIcon = icon("M3 2.5h2.5v11H3zM6.75 2.5h2.5v7h-2.5zM10.5 2.5H13v9h-2.5z");
export const IssuesIcon = icon("M2.5 6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM4.5 2.75h7");
export const TagIcon = icon("M2.5 3.5a1 1 0 0 1 1-1h4l6 6-5 5-6-6zM5.5 5.5h.01");
export const ParentIcon = icon("M4 2.5v6a2 2 0 0 0 2 2h6.5M10 8l2.5 2.5L10 13");
export const BlockedIcon = icon("M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM3.8 3.8l8.4 8.4");
export const TrashIcon = icon("M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6");
export const PencilIcon = icon("M10.5 2.5l3 3L6 13H3v-3z");
const Dots = icon("M3.5 8h.01M8 8h.01M12.5 8h.01");
export const MoreIcon = (props: IconProps) => <Dots strokeWidth={2.4} {...props} />;
export const CopyIcon = icon("M5.5 5.5h7v7h-7zM10.5 5.5v-2h-7v7h2");
export const DocIcon = icon("M3.5 2.5a1 1 0 0 1 1-1h4.5l3.5 3.5v8.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1zM9 1.5V5h3.5M6 8.5h4M6 11h2.5");
export const HistoryIcon = icon("M2 8a6 6 0 1 0 6-6 6.5 6.5 0 0 0-4.5 1.8L2 5.3M2 2v3.3h3.3M8 4.7V8l2.7 1.3");
const SettingsIcon = icon("M2.5 4.5h6M12 4.5h1.5M2.5 11.5h1.5M7.5 11.5h6M10 3v3M6 10v3");
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

/** Whether the signed-in user is `user`, e.g. a comment's author (the server checks too). */
export const isMe = (user: UserRef | null) => user?.username === getMe().user.username;

export function Avatar({ user }: { user: UserRef | null }) {
  if (!user)
    return (
      <span className="avatar avatar-none" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18">
          <circle cx="9" cy="9" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
        </svg>
      </span>
    );
  return (
    <span className={cls("avatar", user.kind === "agent" && "avatar-agent")} style={hueStyle(user.username)} aria-hidden="true">
      {[...user.name.trim()][0]?.toUpperCase()}
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

export function TeamMark({ id }: { id: string }) {
  return (
    <span className="team-mark" style={hueStyle(id)} aria-hidden="true">
      {id[0]}
    </span>
  );
}

/** Team header: mark, inline-editable name and a settings button. */
function TeamTitle({ team }: { team: Team }) {
  const { reloadTeams, teamSettings } = useApp();
  return (
    <>
      <TeamMark id={team.key} />
      <InlineInput
        label="Team name"
        value={team.name}
        onSave={(name) => api.updateTeam(team.key, { name }).then(reloadTeams, errorToast)}
      />
      <button
        className="icon-btn sm"
        onClick={() => teamSettings(team.key)}
        aria-label="Team settings"
        title="Team settings"
      >
        <SettingsIcon />
      </button>
    </>
  );
}

/** Links as tabs: [to, label, whether it's the current one]. */
export function Tabs({ label, tabs }: { label: string; tabs: [to: string, label: string, on: boolean][] }) {
  return (
    <nav className="tabs" aria-label={label}>
      {tabs.map(([to, text, on]) => (
        <Link key={to} to={to} className={cls("tab", on && "on")} aria-current={on ? "page" : undefined}>
          {text}
        </Link>
      ))}
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

/** In place of a page whose first load failed: says why, with a retry. */
export function LoadFailed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <EmptyState title="Couldn’t load this" action={<button className="btn" onClick={retry}>Try again</button>}>
      {message}
    </EmptyState>
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

/** A labeled form field, with an optional hint below. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/**
 * A field that looks like text until focused: Enter (or leaving it) saves, Esc reverts.
 * A remote change to `value` never replaces what's being typed.
 */
function useInlineEdit<E extends HTMLInputElement | HTMLTextAreaElement>(value: string, onSave: (v: string) => void) {
  const ref = useRef<E>(null);
  const [draft, setDraft] = useState(value);
  const skip = useRef(false);
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(value);
  }, [value]);
  const props = {
    ref,
    value: draft,
    dir: "auto",
    onKeyDown: (e: ReactKeyboardEvent<E>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.currentTarget.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        skip.current = true;
        setDraft(value);
        e.currentTarget.blur();
      }
    },
    onBlur: () => {
      const v = draft.trim();
      if (!skip.current && v && v !== value) onSave(v);
      else setDraft(value);
      skip.current = false;
    },
  };
  return { draft, setDraft, props };
}

function InlineInput({ value, onSave, label }: { value: string; onSave: (v: string) => void; label: string }) {
  const { draft, setDraft, props } = useInlineEdit<HTMLInputElement>(value, onSave);
  return (
    <input
      {...props}
      className="inline-input"
      aria-label={label}
      size={Math.max(4, [...draft].length)}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

/** A large title that wraps: an issue's or a doc's. */
export function TitleEditor({
  value,
  onSave,
  className = "issue-title",
  placeholder = "Issue title",
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const { draft, setDraft, props } = useInlineEdit<HTMLTextAreaElement>(value, onSave);
  useAutosize(props.ref, draft);
  return (
    <textarea
      {...props}
      className={className}
      rows={1}
      aria-label="Title"
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
    />
  );
}

/** Header of the issues and docs lists: title, team tabs, search, then `children` (filters, buttons). */
export function ListHeader({
  team,
  title,
  count,
  view,
  onNew,
  search,
  onSearch,
  placeholder = "Search",
  children,
}: {
  team: Team | undefined;
  title: string;
  count: number;
  view: "issues" | "docs";
  onNew: () => void;
  search: string;
  onSearch: (q: string) => void;
  placeholder?: string;
  children?: ReactNode;
}) {
  return (
    <header className="header">
      <MenuButton />
      <div className="header-title">
        {team ? <TeamTitle team={team} /> : <span>{title}</span>}
        {count > 0 && <span className="header-count">{count}</span>}
      </div>
      {team && (
        <Tabs
          label="Team views"
          tabs={[
            [`/t/${team.key}`, "Issues", view === "issues"],
            [`/t/${team.key}/docs`, "Docs", view === "docs"],
          ]}
        />
      )}
      <button className="icon-btn mobile-only" onClick={onNew} aria-label={view === "docs" ? "New doc" : "New issue"}>
        <PlusIcon />
      </button>
      <div className="controls">
        <label className="search">
          <SearchIcon />
          <input
            id="search"
            type="search"
            placeholder={placeholder}
            value={search}
            autoComplete="off"
            dir="auto"
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (search) onSearch("");
                else e.currentTarget.blur();
              } else if (e.key === "ArrowDown" || e.key === "Enter") {
                e.preventDefault();
                document.querySelector<HTMLElement>("[data-nav]")?.focus();
              }
            }}
          />
          {!search && <Kbd>/</Kbd>}
        </label>
        {children}
      </div>
    </header>
  );
}

export function TeamNotFound({ teamKey, back, backLabel }: { teamKey: string; back: string; backLabel: string }) {
  return (
    <EmptyState title="Team not found" action={<Link className="btn" to={back}>{backLabel}</Link>}>
      There’s no team with the key {teamKey}.
    </EmptyState>
  );
}

/** A titled block: sub-issues, comments, a settings section… */
export function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h3>{title}</h3>
        {count !== undefined && <span className="count">{count}</span>}
        {action && (
          <>
            <span className="grow" />
            {action}
          </>
        )}
      </div>
      {children}
    </section>
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

/** Whether an issue is done or canceled, as far as the index knows (a resolved blocker no longer blocks). */
export function useResolved() {
  const index = useIssueIndex();
  return (id: string) => {
    const status = index?.get(id)?.status;
    return !!status && CLOSED_STATUSES.includes(status);
  };
}

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

// Set right before each parse: which identifiers resolve to real issues of known teams.
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
  const { teams } = useApp();
  const index = useIssueIndex();
  const html = useMemo(() => {
    chipKeys = new Set(teams?.map((t) => t.key));
    chipIndex = index;
    return (marked.parse(text) as string).replace(/<(p|h[1-6]|ul|ol|blockquote|table|td|th)(?=[\s>])/g, '<$1 dir="auto"');
  }, [text, teams, index]);
  return (
    <div
      className={cls("md", className)}
      dir="auto"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        // Links to /doc/…, /issue/… etc. route client-side.
        const href = (e.target as Element).closest("a")?.getAttribute("href");
        if (!href?.startsWith("/") || href.startsWith("//") || !isPlainClick(e)) return;
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
  const ref = useRef<HTMLDivElement>(null);
  // What had focus when it opened (read on first render: autofocus moves it before effects run).
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(
    () => () => {
      // After the close lands (StrictMode's rehearsal unmount remounts at once, so skip it then),
      // give focus back unless something else has taken it.
      setTimeout(() => {
        if (!ref.current && (document.activeElement === document.body || !document.activeElement)) opener?.focus?.({ preventScroll: true });
      });
    },
    [],
  );
  return createPortal(
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
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
          } else if (e.key === "Tab") {
            // Trap focus: cycle from the last focusable back to the first, and vice versa.
            const focusable = [
              ...ref.current!.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
              ),
            ].filter((el) => el.offsetParent !== null);
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!first || !last) return;
            if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
              e.preventDefault();
              (e.shiftKey ? last : first).focus();
            }
          }
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Comments ----------

export interface CommentActions {
  add: (body: string) => Promise<void>;
  edit: (id: number, body: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

/** A comment thread with composer, shared by issues and docs. `children` are extra timeline events. */
export function Comments({
  title = "Comments",
  comments,
  actions,
  children,
}: {
  title?: string;
  comments: Comment[];
  actions: CommentActions;
  children?: ReactNode;
}) {
  return (
    <Section title={title}>
      <ol className="timeline">
        {children}
        {comments.map((c) => (
          <CommentItem key={c.id} comment={c} actions={actions} />
        ))}
      </ol>
      <Composer onSubmit={actions.add} />
    </Section>
  );
}

function CommentItem({ comment: c, actions }: { comment: Comment; actions: CommentActions }) {
  const [editing, setEditing] = useState(false);
  const save = async (body: string) => {
    if (body !== c.body.trim()) await actions.edit(c.id, body);
    setEditing(false);
  };
  const remove = async () => {
    if (await ask("Delete this comment? This can’t be undone.", "Delete")) actions.remove(c.id).catch(errorToast);
  };
  return (
    <li className="comment">
      <div className="comment-head">
        <Avatar user={c.author} />
        <span className="comment-author" dir="auto" title={`@${c.author.username}`}>
          {c.author.name}
        </span>
        <time title={fullDate(c.createdAt)}>{ago(c.createdAt)}</time>
        {c.editedAt && (
          <span className="comment-edited" title={`Edited ${fullDate(c.editedAt)}`}>
            edited
          </span>
        )}
        {isMe(c.author) && !editing && (
          <span className="comment-actions">
            <button className="icon-btn xs" onClick={() => setEditing(true)} aria-label="Edit comment" title="Edit">
              <PencilIcon />
            </button>
            <button className="icon-btn xs" onClick={remove} aria-label="Delete comment" title="Delete">
              <TrashIcon />
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <Composer initial={c.body} action="Save" onSubmit={save} onCancel={() => setEditing(false)} />
      ) : (
        <Markdown text={c.body} />
      )}
    </li>
  );
}

/** Writes a new comment, or edits one when given `initial` and `onCancel`. */
function Composer({
  onSubmit,
  initial = "",
  action = "Comment",
  onCancel,
}: {
  onSubmit: (body: string) => Promise<void>;
  initial?: string;
  action?: string;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const { busy, run } = useRun();
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutosize(ref, body);
  const send = () => {
    const text = body.trim();
    if (text)
      run(async () => {
        await onSubmit(text);
        setBody("");
      });
  };
  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={2}
        dir="auto"
        placeholder="Leave a comment…"
        aria-label="Comment"
        autoFocus={!!onCancel}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (onCancel) onCancel();
            else e.currentTarget.blur();
          }
        }}
      />
      <div className="composer-foot">
        {onCancel && (
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn-primary btn-sm" disabled={!body.trim() || busy} onClick={send}>
          {action} <Kbd>{MOD}↵</Kbd>
        </button>
      </div>
    </div>
  );
}

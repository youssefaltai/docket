// General-purpose hooks and small data helpers used across pages: fetching, keybindings, sizing, issue order.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { HttpError } from "./api";
import { useApp, useLive } from "./context";
import { errorToast } from "./toast";
import {
  ACTIVE_CATEGORIES,
  CLOSED_CATEGORIES,
  DEFAULT_WORKFLOW,
  STATUS_CATEGORIES,
  type IssuePatch,
  type IssueSummary,
  type Priority,
  type StatusCategory,
  type Team,
  type UserRef,
  type WorkflowStatus,
} from "../shared/types";

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

/** j/k and arrows move focus between rows or cards (`[data-nav]`); false if there are none. */
export function moveFocus(delta: number): boolean {
  const items = [...document.querySelectorAll<HTMLElement>("[data-nav]")];
  if (!items.length) return false;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = i < 0 ? items[delta > 0 ? 0 : items.length - 1] : items[Math.max(0, Math.min(items.length - 1, i + delta))];
  next?.focus();
  next?.scrollIntoView({ block: "nearest" });
  return true;
}

export const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

const PROP_CMD: Record<string, string> = { s: "status", p: "priority", a: "assignee", d: "delegate", l: "labels", i: "claim" };

/**
 * `S`/`P`/`A`/`D`/`L` (set status/priority/assignee/delegate/labels), `I` (claim) and `⌘⌫`/`Ctrl⌫` (delete to
 * trash) on "the current issue": a focused list row/card, or the issue page. Each just clicks the matching
 * `data-cmd` trigger within `scope().root` (the same attribute DKT-15's command menu clicks by, extended with
 * `labels`, `claim` and `delete`); one a page doesn't render (a row has no Delegate or Labels picker, and no
 * Claim/trash button at all) is silently a no-op, unless `fallback` implements it directly (a row's `I`/`⌘⌫`,
 * which call the API itself — see `useListShortcuts` in issues.tsx).
 *
 * Guarded exactly like every other single-key shortcut (`isEditable`, an open popover/modal, IME composition),
 * and excludes Shift so Shift-S (subscribe) keeps working.
 */
export function useIssueShortcuts(
  scope: () => { root: ParentNode; id: string } | null,
  fallback?: { claim: (id: string) => void; delete: (id: string) => void },
) {
  useKeydown((e) => {
    if (e.defaultPrevented || e.shiftKey || e.altKey || isEditable(e.target)) return;
    if (document.querySelector(".pop, .backdrop")) return;
    const mod = e.metaKey || e.ctrlKey;
    const cmd = mod ? (e.key === "Backspace" ? "delete" : null) : (PROP_CMD[e.key.toLowerCase()] ?? null);
    if (!cmd) return;
    const current = scope();
    if (!current) return;
    e.preventDefault();
    const nodes = [...current.root.querySelectorAll<HTMLElement>(`[data-cmd="${cmd}"]`)];
    const target = nodes.find((n) => n.offsetParent !== null);
    const btn = target instanceof HTMLButtonElement ? target : target?.querySelector<HTMLButtonElement>("button");
    if (btn) btn.click();
    else if (cmd === "claim") fallback?.claim(current.id);
    else if (cmd === "delete") fallback?.delete(current.id);
  });
}

// --- Statuses: each team has its own workflow; issues name a status by key ---

/** A status as the UI shows it: its team's, plus its icon's fill (the team's k-th started status is 1 − ½^(k+1) full). */
export type StatusLook = WorkflowStatus & { fill: number };

const look = (statuses: WorkflowStatus[], s: WorkflowStatus): StatusLook => ({
  ...s,
  fill: 1 - 0.5 ** (Math.max(0, statuses.filter((x) => x.category === "started").indexOf(s)) + 1),
});

/** A team's statuses in workflow order (the default workflow while teams load). */
export function teamStatuses(teams: Team[] | null, team: string): StatusLook[] {
  const statuses = teams?.find((t) => t.key === team)?.statuses ?? DEFAULT_WORKFLOW;
  return statuses.map((s) => look(statuses, s));
}

/**
 * A team's status by key. While teams load, or for a key the team no longer has (old history), the default
 * workflow's, else a plain one named by its key in `category` (an issue's own statusCategory).
 */
export function statusOf(teams: Team[] | null, team: string, key: string, category?: StatusCategory): StatusLook {
  const statuses = teams?.find((t) => t.key === team)?.statuses;
  const own = statuses?.find((s) => s.key === key);
  if (own) return look(statuses!, own);
  const known = DEFAULT_WORKFLOW.find((s) => s.key === key);
  if (known) return look(DEFAULT_WORKFLOW, known);
  return { key, name: key, category: category ?? "unstarted", color: "#8f8f8f", position: 0, fill: 0.5 };
}

/** `statusOf` over the current workspace's teams. */
export function useStatusOf() {
  const { teams } = useApp();
  return (team: string, key: string, category?: StatusCategory) => statusOf(teams, team, key, category);
}

/** An issue's status look, by its team (so an optimistic change shows at once). */
export const issueStatus = (teams: Team[] | null, issue: Pick<IssueSummary, "team" | "status" | "statusCategory">) =>
  statusOf(teams, issue.team, issue.status, issue.statusCategory);

export const isClosedCategory = (category: StatusCategory) => CLOSED_CATEGORIES.includes(category);

const rank = (s: { category: StatusCategory }) => STATUS_CATEGORIES.indexOf(s.category);

/**
 * The status groups of a list or board over `teams`: every key they have (named by the first team that has it) and
 * any key only an issue has, ordered by category, then the smallest position.
 */
export function statusGroups(teams: Team[], issues: IssueSummary[] = []): StatusLook[] {
  const groups = new Map<string, StatusLook>();
  for (const t of teams) {
    for (const s of teamStatuses([t], t.key)) {
      const had = groups.get(s.key);
      if (had) had.position = Math.min(had.position, s.position);
      else groups.set(s.key, { ...s });
    }
  }
  for (const i of issues) if (!groups.has(i.status)) groups.set(i.status, issueStatus(teams, i));
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.position - b.position);
}

/** Open issues of a team: its active categories (not triage, completed or canceled). */
export const openCount = (t: Team) =>
  t.statuses.filter((s) => ACTIVE_CATEGORIES.includes(s.category)).reduce((n, s) => n + (t.counts[s.key] ?? 0), 0);

/** Issues waiting in a team's Triage. */
export const triageCount = (t: Team) => t.statuses.filter((s) => s.category === "triage").reduce((n, s) => n + (t.counts[s.key] ?? 0), 0);

/** An issue edit as the UI shows it (users as refs), so it can be applied optimistically. */
export type IssueChange = Omit<IssuePatch, "assignee" | "delegate"> & { assignee?: UserRef | null; delegate?: UserRef | null };

/** The same edit as the API takes it (users by username). */
export function toPatch({ assignee, delegate, ...patch }: IssueChange): IssuePatch {
  if (assignee !== undefined) (patch as IssuePatch).assignee = assignee?.username ?? null;
  if (delegate !== undefined) (patch as IssuePatch).delegate = delegate?.username ?? null;
  return patch;
}

const priorityRank = (p: Priority) => (p === 0 ? 5 : p);

/** Server order: status category, the team's status order, priority (1→4, none last), most recently updated. */
export function sortIssues<T extends IssueSummary>(list: T[], teams: Team[] | null): T[] {
  const status = new Map(list.map((i) => [i, issueStatus(teams, i)]));
  return [...list].sort((a, b) => {
    const [x, y] = [status.get(a)!, status.get(b)!];
    return rank(x) - rank(y) || x.position - y.position || priorityRank(a.priority) - priorityRank(b.priority) || b.updatedAt.localeCompare(a.updatedAt);
  });
}

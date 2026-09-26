// General-purpose hooks and small data helpers used across pages: fetching, keybindings, sizing, issue order.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { HttpError } from "./api";
import { useLive } from "./context";
import { errorToast } from "./toast";
import { OPEN_STATUSES, STATUSES, type IssuePatch, type IssueSummary, type Priority, type Status, type Team, type UserRef } from "../shared/types";

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

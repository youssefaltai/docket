// Small stateless helpers shared across the UI: class names, dates, and color hashing.
import type { CSSProperties } from "react";

export const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

/** A value outside React that components read with `useSyncExternalStore(store.subscribe, store.get)`. */
export function createStore<T>(value: T) {
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
  };
}

/**
 * The URL if it's a web or mail link, or a path in the app; null for anything else (javascript:, data:). Browsers strip
 * whitespace/control chars when parsing URLs, so this checks, and returns, the cleaned form.
 */
export function safeUrl(href: string): string | null {
  const url = href.replace(/[\u0000- ]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
  return !scheme || /^(https?|mailto)$/i.test(scheme) ? url : null;
}

export const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

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

// Due dates are calendar dates ("YYYY-MM-DD"), shown against the browser's own date so they match the viewer's
// calendar (the server's due filters use its UTC date).
const dayOf = (ymd: string) => new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));

/** Days from today (local) to `ymd`: 0 today, negative when past. */
export function daysUntil(ymd: string): number {
  const t = new Date();
  return Math.round((dayOf(ymd).getTime() - new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) / 86400000);
}

/** "Oct 1", with the year when it isn't this year's. */
export function dayLabel(ymd: string): string {
  const date = dayOf(ymd);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

// A small set of distinct hues reads calmer than the whole wheel.
const HUES = [212, 152, 32, 268, 350, 186, 48, 232, 12, 300];

function hue(s: string): number {
  let h = 2166136261;
  for (const c of s.toLowerCase()) h = Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0;
  return HUES[h % HUES.length]!;
}

export const hueStyle = (s: string) => ({ "--h": hue(s) }) as CSSProperties;

/**
 * The files a paste carries: a screenshot or a copied image comes as files without text. Copying from a spreadsheet
 * or a word processor also puts a picture of the selection in the files, but with its text, which is what's meant.
 */
export const pastedFiles = (data: DataTransfer | null): File[] => (data?.files.length && !data.getData("text/plain") ? [...data.files] : []);

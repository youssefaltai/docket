// Small stateless helpers shared across the UI: class names, dates, and color hashing.
import type { CSSProperties } from "react";

export const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");
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

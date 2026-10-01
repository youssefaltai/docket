// How background work is started. On Bun, timers; a Durable Object (src/worker), which sleeps between requests, replaces
// them: a kick runs in waitUntil, anything later wakes it with its alarm.

/** On Cloudflare Workers. */
export const workers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

let schedule: (fn: () => unknown, ms: number) => void = (fn, ms) => setTimeout(fn, ms);

/** Runs `fn` in the background after `ms`; by default once the current transaction is done. */
export const later = (fn: () => unknown, ms = 0) => schedule(fn, ms);

export const useScheduler = (fn: typeof schedule) => (schedule = fn);

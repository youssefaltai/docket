// Push notifications on this device (see server/push.ts): the browser's subscription, and Docket's copy of it.
import { request } from "./api";

export type PushState = "unsupported" | "install" | "blocked" | "off" | "on";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
/** On iPhone and iPad, only an app added to the Home Screen can get them. */
const needsInstall = () => /iPhone|iPad/.test(navigator.userAgent) && !matchMedia("(display-mode: standalone)").matches;
const subscription = async () => (await navigator.serviceWorker.ready).pushManager.getSubscription();

export async function pushState(): Promise<PushState> {
  if (!supported()) return needsInstall() ? "install" : "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return Notification.permission === "granted" && (await subscription()) ? "on" : "off";
}

/** Asks for permission (it must follow a tap), subscribes, and tells Docket. */
export async function enablePush(): Promise<PushState> {
  if ((await Notification.requestPermission()) !== "granted") return pushState();
  const { publicKey } = await request<{ publicKey: string }>("GET", "/api/push");
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  await request("PUT", "/api/push", sub.toJSON());
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const sub = await subscription();
  if (sub) {
    await request("DELETE", "/api/push", { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  return pushState();
}

export const testPush = () => request("POST", "/api/push/test");

/**
 * On every start: a subscription this browser has goes (back) to Docket, for this session. Signing out drops
 * Docket's copy; signing in again brings it back without asking again.
 */
export async function syncPush() {
  if (!supported() || Notification.permission !== "granted") return;
  const sub = await subscription();
  if (sub) await request("PUT", "/api/push", sub.toJSON());
}

// Transient feedback: toasts (with optional Undo/View) and the app's promise-based confirm() dialog.
import { useSyncExternalStore } from "react";
import { Link } from "./routing";
import { Modal } from "./modal";
import { createStore } from "./util";

interface Toast {
  id: number;
  text: string;
  href?: string; // a View link
  undo?: () => void; // an Undo button
}
const toasts = createStore<Toast[]>([]);
let toastId = 0;

const dismiss = (t: Toast) => toasts.set(toasts.get().filter((x) => x !== t));

export function toast(text: string, href?: string, undo?: () => void) {
  const t = { id: ++toastId, text, href, undo };
  toasts.set([...toasts.get().slice(-2), t]);
  setTimeout(() => dismiss(t), undo ? 8000 : 4000); // time to reach Undo
}

/** After a delete: "Moved … to trash", with an Undo that restores it and links back. */
export const trashToast = (label: string, restore: () => Promise<unknown>, href: string) =>
  toast(`Moved ${label} to trash`, undefined, () => restore().then(() => toast(`Restored ${label}`, href), errorToast));

export const errorToast = (e: unknown) => toast(e instanceof Error ? e.message : String(e));

/** Copies `text` and toasts `done`. */
export const copyText = (text: string, done: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast(done),
    () => toast("Couldn’t copy to clipboard"),
  );

export function Toaster() {
  const list = useSyncExternalStore(toasts.subscribe, toasts.get);
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
          {t.undo && (
            <button
              className="toast-link"
              onClick={() => {
                dismiss(t);
                t.undo!();
              }}
            >
              Undo
            </button>
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
const question = createStore<Question | null>(null);

/** The app's own confirm(): resolves true if the user confirms. `action` labels the button ("Delete"). */
export function ask(text: string, action: string): Promise<boolean> {
  question.get()?.resolve(false);
  return new Promise((resolve) => question.set({ text, action, resolve }));
}

/** Renders the pending `ask`, if any; mounted once by the app. */
export function Confirm() {
  const q = useSyncExternalStore(question.subscribe, question.get);
  if (!q) return null;
  const answer = (ok: boolean) => {
    question.set(null);
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

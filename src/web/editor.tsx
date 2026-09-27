// Editing markdown. RichEditor edits it as rich text (Tiptap, in tiptap.tsx: its own chunk, fetched on first edit)
// or as its markdown source. Both have @mention autocomplete: a small popover at the caret that inserts `@username `.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { UserRef } from "../shared/types";
import { Avatar, isMe } from "./components";
import { useApp } from "./context";
import { Markdown } from "./markdown";
import { cls } from "./util";

// An @ at the start, after a space or an opening bracket, then what's typed of a username, up to the caret.
export const MENTION_TRIGGER = /(?:^|[\s([])@([a-z0-9._-]{0,32})$/i;

/** Where a caret sits on screen. */
export type CaretBox = { left: number; top: number; height: number };
/** What's typed after a trigger character (`@`, `/`), and where the trigger is. */
export type Typed = { start: number; query: string };
/** The keys editors look at (React's and the DOM's keyboard events both fit). */
export type Key = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "preventDefault" | "stopPropagation">;

// What the mirror copies so its text wraps exactly like the textarea's.
const MIRRORED = [
  "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
  "borderBottomWidth", "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
  "textTransform", "wordSpacing", "textIndent", "tabSize", "direction", "textAlign",
] as const;

/** Where character `index` of a textarea sits on screen: a hidden copy of the text up to it, measured. */
function caretBox(el: HTMLTextAreaElement, index: number): CaretBox {
  const style = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const p of MIRRORED) mirror.style[p] = style[p];
  Object.assign(mirror.style, { position: "fixed", top: "0", left: "0", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word" });
  mirror.textContent = el.value.slice(0, index);
  // The rest of the word goes in the mark, so it wraps to the next line when the word does.
  const mark = mirror.appendChild(document.createElement("span"));
  mark.textContent = /^\S*/.exec(el.value.slice(index))![0] || "​";
  document.body.append(mirror);
  const box = el.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || mark.offsetHeight;
  const at = { left: box.left + mark.offsetLeft - el.scrollLeft, top: box.top + mark.offsetTop - el.scrollTop, height: lineHeight };
  mirror.remove();
  return at;
}

/** Who `@query` offers: the workspace's active members (people, then agents; not you) whose username or name starts with it. */
export function useMentionable(query: string | undefined): UserRef[] {
  const { members } = useApp();
  if (query === undefined) return [];
  return members
    .filter((m) => !m.suspendedAt && !isMe(m.user))
    .map((m) => m.user)
    .filter((u) => u.username.startsWith(query) || u.name.toLowerCase().startsWith(query))
    .sort((a, b) => Number(a.kind === "agent") - Number(b.kind === "agent"))
    .slice(0, 8);
}

export const MentionOption = ({ user }: { user: UserRef }) => (
  <>
    <span className="pop-icon">
      <Avatar user={user} />
    </span>
    <span className="mention-name" dir="auto">
      {user.name}
    </span>
    <span className="mention-username">@{user.username}</span>
    {user.kind === "agent" && <span className="mention-tag">Agent</span>}
  </>
);

/**
 * A popover list at the caret, for what's being typed after a trigger (@mentions, the / menu). ↑/↓ (Ctrl-N/P) move,
 * Enter or Tab picks, Esc closes it for that trigger, a click works. It sits under the trigger (above it when there's
 * no room below), inside the viewport. Let `onKeyDown` see keys first: it returns true when it used one.
 */
export function useCaretMenu<T>({
  typed,
  items,
  caret,
  pick,
  option,
  label,
  className,
}: {
  typed: Typed | null;
  items: T[];
  caret: (index: number) => CaretBox | null;
  pick: (item: T) => void;
  option: (item: T) => ReactNode;
  label: string;
  className: string;
}) {
  const [dismissed, setDismissed] = useState<number | null>(null); // Esc on this trigger: stay closed while it's typed
  const [active, setActive] = useState(0);
  const [shown, setShown] = useState<string | null>(null);
  const pop = useRef<HTMLDivElement>(null);
  const key = typed && `${typed.start}:${typed.query}`;
  if (key !== shown) {
    setShown(key); // something else is typed: back to the first option
    setActive(0);
  }
  const open = !!typed && typed.start !== dismissed && items.length > 0;
  const current = Math.min(active, items.length - 1);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const c = typed && caret(typed.start);
      const menu = pop.current;
      if (!c || !menu) return;
      const m = 8;
      const { offsetWidth: w, offsetHeight: h } = menu;
      let top = c.top + c.height + 4;
      if (top + h > innerHeight - m && c.top - 4 - h > m) top = c.top - 4 - h;
      menu.style.left = `${Math.max(m, Math.min(c.left, innerWidth - w - m))}px`;
      menu.style.top = `${top}px`;
    };
    place();
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => {
      removeEventListener("resize", place);
      removeEventListener("scroll", place, true);
    };
  }, [open, key, items.length]);

  const onKeyDown = (e: Key): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setActive(Math.min(current + 1, items.length - 1));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setActive(Math.max(current - 1, 0));
    else if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) pick(items[current]!);
    else if (e.key === "Escape") setDismissed(typed!.start);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  const menu =
    open &&
    createPortal(
      <div ref={pop} className={cls("pop", className)} role="listbox" aria-label={label}>
        <div className="pop-list">
          {items.map((item, i) => (
            <div
              key={i}
              role="option"
              aria-selected={i === current}
              className={cls("pop-item", i === current && "active")}
              onPointerMove={() => i !== current && setActive(i)}
              onMouseDown={(e) => e.preventDefault()} // keep the editor focused
              onClick={() => pick(item)}
            >
              {option(item)}
            </div>
          ))}
        </div>
      </div>,
      document.body,
    );

  return { menu, onKeyDown };
}

/**
 * @mention autocomplete for a markdown textarea. Spread `props` on the textarea, render `menu`, and let `onKeyDown`
 * see keys first: it returns true when it used one.
 */
export function useMentionMenu(ref: RefObject<HTMLTextAreaElement | null>, value: string, setValue: (value: string) => void) {
  const [typed, setTyped] = useState<Typed | null>(null);
  const caret = useRef<number | null>(null); // where to put the caret after an insert
  const users = useMentionable(typed?.query);

  /** Reads the @ before the caret (on every selection change, typing included). */
  const sync = () => {
    const el = ref.current;
    const end = el?.selectionStart ?? 0;
    const m = el && document.activeElement === el && end === el.selectionEnd ? MENTION_TRIGGER.exec(el.value.slice(0, end)) : null;
    setTyped(m ? { start: end - m[1]!.length - 1, query: m[1]!.toLowerCase() } : null);
  };

  const { menu, onKeyDown } = useCaretMenu({
    typed,
    items: users,
    caret: (index) => ref.current && caretBox(ref.current, index),
    pick: (user) => {
      const el = ref.current;
      if (!el || !typed) return;
      const text = `@${user.username} `;
      caret.current = typed.start + text.length;
      setValue(value.slice(0, typed.start) + text + value.slice(el.selectionStart));
      setTyped(null);
    },
    option: (user) => <MentionOption user={user} />,
    label: "Mention someone",
    className: "mention-menu",
  });

  // After an insert, the caret goes right after it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && caret.current !== null) {
      el.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [value]);

  return { menu, onKeyDown, props: { onSelect: sync, onBlur: () => setTyped(null) } };
}

export interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  /** On the editing area, rich or source. */
  className?: string;
  /** Focus it once it's up: true at the end, a number that far through (0 to 1) without scrolling. */
  autoFocus?: boolean | number;
  /** It's up (and focused, with autoFocus). */
  onReady?: () => void;
  onSubmit?: () => void; // ⌘↵
  onSave?: () => void; // ⌘S
  onCancel?: () => void; // Esc
}

/** ⌘↵, ⌘S and Esc, the same in both modes: true when one was used. */
export function editorKey(e: Key, { onSubmit, onSave, onCancel }: EditorProps): boolean {
  const mod = e.metaKey || e.ctrlKey;
  const action = e.key === "Enter" && mod ? onSubmit : e.key === "s" && mod ? onSave : e.key === "Escape" ? onCancel : undefined;
  if (!action) return false;
  e.preventDefault();
  action();
  return true;
}

type Tiptap = typeof import("./tiptap");
let tiptap: Tiptap | null = null;
let loading: Promise<Tiptap> | null = null;
const loadTiptap = () => (loading ??= import("./tiptap").then((m) => (tiptap = m)));

/**
 * A markdown editor: rich text (WYSIWYG) by default, or the markdown source (the Markdown toggle, or when the rich
 * editor can't hold the text exactly: see tiptapKit's fidelity guard). It hands `onChange` markdown only when the
 * person edits, so opening and closing it never rewrites anything. `children` go between it and its foot, which
 * holds the toggle, then `foot`.
 */
export function RichEditor({
  foot,
  footClass = "rich-foot",
  children,
  ...props
}: EditorProps & { foot?: ReactNode; footClass?: string; children?: ReactNode }) {
  const [kit, setKit] = useState(tiptap);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<"rich" | "source" | "kept">("rich"); // kept: the guard sent it to the source
  const [focus, setFocus] = useState(props.autoFocus); // after a toggle, the new mode takes focus

  useEffect(() => {
    if (!kit) loadTiptap().then(setKit, () => setFailed(true)); // offline, say: the source still works
  }, []);

  const source = mode !== "rich" || failed;
  const toggle = () => {
    setFocus(true);
    setMode(source ? "rich" : "source");
  };
  return (
    <>
      {source ? (
        <SourceEditor {...props} autoFocus={focus} />
      ) : kit ? (
        <kit.Rich {...props} autoFocus={focus} onReject={() => setMode("kept")} />
      ) : (
        <div className={cls("rich-loading", props.className)} aria-busy="true">
          {props.value.trim() ? <Markdown text={props.value} /> : <p className="rich-placeholder">{props.placeholder}</p>}
        </div>
      )}
      {children}
      <div className={footClass}>
        <button
          type="button"
          className={cls("btn btn-ghost btn-sm md-toggle", source && "on")}
          aria-pressed={source}
          disabled={!kit}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggle}
          title={source ? "Edit as rich text" : "Edit the markdown source"}
        >
          Markdown
        </button>
        {mode === "kept" && <span className="hint">Opened as markdown to keep its formatting exact.</span>}
        <span className="grow" />
        {foot}
      </div>
    </>
  );
}

/** The markdown source: a textarea that grows with its text (keeping the page where it was). */
function SourceEditor(props: EditorProps) {
  const { value, onChange, label, placeholder, className, autoFocus, onReady } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionMenu(ref, value, onChange);

  useLayoutEffect(() => {
    const el = ref.current!;
    let scroller = el.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const top = scroller?.scrollTop ?? 0;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
    if (scroller) scroller.scrollTop = top;
  }, [value]);

  useLayoutEffect(() => {
    const el = ref.current!;
    if (autoFocus !== undefined && autoFocus !== false) {
      const at =
        autoFocus === true ? el.value.length : autoFocus > 0.02 ? el.value.lastIndexOf("\n", Math.floor(autoFocus * el.value.length)) + 1 : 0;
      el.setSelectionRange(at, at);
      el.focus({ preventScroll: autoFocus !== true });
    }
    onReady?.();
  }, []);

  return (
    <>
      <textarea
        ref={ref}
        className={cls("md-source", className)}
        dir="auto"
        spellCheck
        aria-label={`${label} (Markdown)`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...mention.props}
        onKeyDown={(e) => mention.onKeyDown(e) || editorKey(e, props)}
      />
      {mention.menu}
    </>
  );
}

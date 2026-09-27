// Markdown textarea helpers. @mention autocomplete: a small popover at the caret that inserts `@username `.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { UserRef } from "../shared/types";
import { Avatar, isMe } from "./components";
import { useApp } from "./context";
import { cls } from "./util";

// An @ at the start, after a space or an opening bracket, then what's typed of a username, up to the caret.
const TRIGGER = /(?:^|[\s([])@([a-z0-9._-]{0,32})$/i;

// What the mirror copies so its text wraps exactly like the textarea's.
const MIRRORED = [
  "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
  "borderBottomWidth", "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
  "textTransform", "wordSpacing", "textIndent", "tabSize", "direction", "textAlign",
] as const;

/** Where character `index` of a textarea sits on screen: a hidden copy of the text up to it, measured. */
function caretBox(el: HTMLTextAreaElement, index: number) {
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

/**
 * @mention autocomplete for a markdown textarea. Typing `@` offers the workspace's active members (people, then
 * agents; not you) whose username or name starts with what follows; ↑/↓ move, Enter or Tab inserts `@username `,
 * Esc closes it, a click works too. Spread `props` on the textarea, render `menu`, and let `onKeyDown` see keys
 * first: it returns true when it used one.
 */
export function useMentionMenu(ref: RefObject<HTMLTextAreaElement | null>, value: string, setValue: (value: string) => void) {
  const { members } = useApp();
  const [at, setAt] = useState<{ start: number; query: string } | null>(null); // the @ being typed, and what follows it
  const [dismissed, setDismissed] = useState<number | null>(null); // Esc on this @: stay closed while it's typed
  const [active, setActive] = useState(0);
  const pop = useRef<HTMLDivElement>(null);
  const caret = useRef<number | null>(null); // where to put the caret after an insert

  const users: UserRef[] = at
    ? members
        .filter((m) => !m.suspendedAt && !isMe(m.user))
        .map((m) => m.user)
        .filter((u) => u.username.startsWith(at.query) || u.name.toLowerCase().startsWith(at.query))
        .sort((a, b) => Number(a.kind === "agent") - Number(b.kind === "agent"))
        .slice(0, 8)
    : [];
  const open = !!at && at.start !== dismissed && users.length > 0;
  const current = Math.min(active, users.length - 1);

  /** Reads the @ before the caret (on every selection change, typing included). */
  const sync = () => {
    const el = ref.current;
    const end = el?.selectionStart ?? 0;
    const m = el && document.activeElement === el && end === el.selectionEnd ? TRIGGER.exec(el.value.slice(0, end)) : null;
    const next = m ? { start: end - m[1]!.length - 1, query: m[1]!.toLowerCase() } : null;
    if (next?.start !== at?.start || next?.query !== at?.query) setActive(0);
    setAt(next);
  };

  const pick = (user: UserRef) => {
    const el = ref.current;
    if (!el || !at) return;
    const text = `@${user.username} `;
    caret.current = at.start + text.length;
    setValue(value.slice(0, at.start) + text + value.slice(el.selectionStart));
    setAt(null);
  };

  // After an insert, the caret goes right after it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && caret.current !== null) {
      el.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [value]);

  // Just under the @ (above it when there's no room below), inside the viewport; full width on phones (CSS).
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = ref.current;
      const menu = pop.current;
      if (!el || !menu || !at) return;
      const c = caretBox(el, at.start);
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
  }, [open, at?.start, at?.query, users.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setActive(Math.min(current + 1, users.length - 1));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setActive(Math.max(current - 1, 0));
    else if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) pick(users[current]!);
    else if (e.key === "Escape") setDismissed(at.start);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  const menu =
    open &&
    createPortal(
      <div ref={pop} className="pop mention-menu" role="listbox" aria-label="Mention someone">
        <div className="pop-list">
          {users.map((u, i) => (
            <div
              key={u.username}
              role="option"
              aria-selected={i === current}
              className={cls("pop-item", i === current && "active")}
              onPointerMove={() => i !== current && setActive(i)}
              onMouseDown={(e) => e.preventDefault()} // keep the textarea focused
              onClick={() => pick(u)}
            >
              <span className="pop-icon">
                <Avatar user={u} />
              </span>
              <span className="mention-name" dir="auto">
                {u.name}
              </span>
              <span className="mention-username">@{u.username}</span>
              {u.kind === "agent" && <span className="mention-tag">Agent</span>}
            </div>
          ))}
        </div>
      </div>,
      document.body,
    );

  return { menu, onKeyDown, props: { onSelect: sync, onBlur: () => setAt(null) } };
}

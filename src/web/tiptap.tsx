// The rich text editor, in its own chunk: RichEditor (editor.tsx) fetches it on first edit, so reading never loads it.
// The document model and markdown round-trip are in tiptapKit.ts; this is the view: chips, menus and the toolbar.
import { Editor, Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type DecorationAttrs } from "@tiptap/pm/view";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MENTION_PATTERN, mentionOf, type IssueSummary, type UserRef } from "../shared/types";
import { useApp } from "./context";
import {
  MENTION_TRIGGER,
  MentionOption,
  editorKey,
  upload,
  useCaretMenu,
  useDropHighlight,
  useMentionable,
  type EditorProps,
  type Typed,
} from "./editor";
import { useIssueIndex } from "./issueIndex";
import { wsPath } from "./routing";
import { admits, allowedHref, extensions, toMarkdown } from "./tiptapKit";
import { cls } from "./util";

// ---------- Chips: issue identifiers and @mentions, as the read view shows them. Decorations, never stored. ----------

type ChipSource = { issue: (id: string) => IssueSummary | undefined; member: (username: string) => UserRef | undefined };
const chipsKey = new PluginKey<DecorationSet>("chips");
const IDENT = /\b[A-Z]{2,5}-\d+\b/g;
const MENTIONS = new RegExp(MENTION_PATTERN, "giu");

function chips(doc: PMNode, source: ChipSource): DecorationSet {
  const found: Decoration[] = [];
  const { code, link } = doc.type.schema.marks;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    const text = node.textBetween(0, node.content.size, undefined, "￼"); // one character per position
    const chip = (index: number, length: number, attrs: DecorationAttrs) => {
      const from = pos + 1 + index;
      const to = from + length;
      if (!doc.rangeHasMark(from, to, code!) && !doc.rangeHasMark(from, to, link!)) found.push(Decoration.inline(from, to, attrs));
    };
    for (const m of text.matchAll(IDENT)) {
      const issue = source.issue(m[0]);
      if (issue) chip(m.index, m[0].length, { nodeName: "a", class: "issue-ref", href: wsPath(`/issue/${issue.id}`), title: issue.title });
    }
    for (const m of text.matchAll(MENTIONS)) {
      const username = mentionOf(m[1]!, (u) => !!source.member(u));
      const user = username && source.member(username);
      if (user) chip(m.index, username.length + 1, { class: cls("mention", user.kind === "agent" && "mention-agent"), title: user.name });
    }
    return false;
  });
  return DecorationSet.create(doc, found);
}

/** Recomputed on every change, and when the app's issues or members change (a `chipsKey` meta). */
const Chips = Extension.create<{ source: RefObject<ChipSource> }>({
  name: "chips",
  addProseMirrorPlugins() {
    const { source } = this.options;
    return [
      new Plugin({
        key: chipsKey,
        state: {
          init: (_, state) => chips(state.doc, source.current),
          apply: (tr, set) => (tr.docChanged || tr.getMeta(chipsKey) ? chips(tr.doc, source.current) : set),
        },
        props: { decorations: (state) => chipsKey.getState(state) },
      }),
    ];
  },
});

function useChipSource(): RefObject<ChipSource> {
  const { teams, members } = useApp();
  const index = useIssueIndex();
  const source = useRef<ChipSource>(null!);
  source.current = useMemo(() => {
    const keys = new Set(teams?.map((t) => t.key));
    const active = new Map(members.filter((m) => !m.suspendedAt).map((m) => [m.user.username, m.user]));
    return { issue: (id) => (keys.has(id.slice(0, id.indexOf("-"))) ? index?.get(id) : undefined), member: (u) => active.get(u) };
  }, [teams, index, members]);
  return source;
}

// ---------- The / menu ----------

type Block = { label: string; hint: string; run: (e: Editor) => unknown };
const BLOCKS: Block[] = [
  { label: "Heading 1", hint: "#", run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { label: "Heading 2", hint: "##", run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { label: "Heading 3", hint: "###", run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { label: "Bulleted list", hint: "-", run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: "Numbered list", hint: "1.", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { label: "Checklist", hint: "[]", run: (e) => e.chain().focus().toggleTaskList().run() },
  { label: "Code block", hint: "```", run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { label: "Table", hint: "|", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { label: "Quote", hint: ">", run: (e) => e.chain().focus().toggleBlockquote().run() },
  { label: "Divider", hint: "---", run: (e) => e.chain().focus().setHorizontalRule().run() },
];
const SLASH_TRIGGER = /(?:^|\s)\/([a-z0-9]{0,12})$/i;

/** What's typed after `trigger` up to the caret, in plain text (not code). */
function typedAt(state: EditorState, trigger: RegExp): (Typed & { end: number }) | null {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.spec.code || $from.marks().some((m) => m.type.spec.code)) return null;
  const m = trigger.exec($from.parent.textBetween(0, $from.parentOffset, undefined, "￼"));
  return m ? { start: $from.pos - m[1]!.length - 1, query: m[1]!.toLowerCase(), end: $from.pos } : null;
}

// ---------- Uploads: a placeholder where each file goes (a decoration, never stored) until it's linked there ----------

type Pending = { add?: { id: object; pos: number; name: string }; done?: object };
const uploadsKey = new PluginKey<DecorationSet>("uploads");

const Uploads = Extension.create({
  name: "uploads",
  addProseMirrorPlugins: () => [
    new Plugin({
      key: uploadsKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, set) => {
          set = set.map(tr.mapping, tr.doc);
          const { add, done } = (tr.getMeta(uploadsKey) ?? {}) as Pending;
          if (add) {
            const el = document.createElement("span");
            el.className = "upload-pending";
            el.textContent = `Uploading ${add.name}…`;
            set = set.add(tr.doc, [Decoration.widget(add.pos, el, { id: add.id })]);
          }
          return done ? set.remove(set.find(undefined, undefined, (spec) => spec.id === done)) : set;
        },
      },
      props: { decorations: (state) => uploadsKey.getState(state) },
    }),
  ],
});

/** Uploads files, each shown as a placeholder at `at` (else the caret), then linked where the placeholder is. */
function insertFiles(editor: Editor, files: File[], at: number | null, team: string | null | undefined) {
  for (const file of files) {
    const id = {};
    editor.view.dispatch(editor.state.tr.setMeta(uploadsKey, { add: { id, pos: at ?? editor.state.selection.from, name: file.name } }));
    upload(file, team).then((markdown) => {
      if (editor.isDestroyed) return;
      const pos = uploadsKey.getState(editor.state)!.find(undefined, undefined, (spec) => spec.id === id)[0]?.from;
      editor.view.dispatch(editor.state.tr.setMeta(uploadsKey, { done: id }));
      if (pos === undefined || !markdown) return;
      if (editor.state.doc.resolve(pos).parent.type.spec.code) return editor.view.dispatch(editor.state.tr.insertText(markdown, pos));
      editor.commands.insertContentAt(pos, editor.markdown!.parse(markdown).content?.[0]?.content ?? []);
    });
  }
}

// ---------- The editor ----------

/** `is-empty` on the editor while it holds nothing, so CSS shows its data-placeholder. */
const Placeholder = Extension.create({
  name: "placeholder",
  addProseMirrorPlugins: () => [
    new Plugin({
      props: {
        attributes: ({ doc }): Record<string, string> =>
          doc.childCount === 1 && doc.firstChild!.type.name === "paragraph" && !doc.firstChild!.content.size ? { class: "is-empty" } : {},
      },
    }),
  ],
});

/**
 * Rich text over markdown. It loads `value` only if the fidelity guard admits it (else `onReject`), and calls
 * `onChange` only for a real edit: an edit that's undone hands back `value` exactly as it came.
 */
export function Rich(props: EditorProps & { onReject: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [linking, setLinking] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const held = useRef(props.value); // the value the editor holds: what it was given, or last handed out
  const given = useRef({ value: props.value, markdown: "" }); // the last value given, and how the editor writes it
  const source = useChipSource();
  const keys = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const drop = useDropHighlight();

  useLayoutEffect(() => {
    if (!admits(props.value)) return props.onReject();
    const editor = new Editor({
      element: host.current,
      extensions: extensions([Chips.configure({ source }), Placeholder, Uploads], (files, at) => insertFiles(editor, files, at, latest.current.team)),
      content: props.value,
      contentType: "markdown",
      injectCSS: false, // styles.css has them (the CSP allows no inline styles)
      textDirection: "auto", // dir="auto" on every block, so Arabic lines read right to left
      editorProps: {
        attributes: {
          class: cls("rich md", props.className),
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": props.label,
          "data-placeholder": props.placeholder ?? "",
          spellcheck: "true",
        },
        handleKeyDown: (_view, event) => keys.current(event),
        handleClick: (_view, _pos, event) => {
          // ⌘/Ctrl-click follows a link or chip, in a new tab (a click just places the caret).
          const href = (event.target as Element).closest("a[href]")?.getAttribute("href");
          if (!href || !(event.metaKey || event.ctrlKey) || !allowedHref(href)) return false;
          window.open(wsPath(href), "_blank", "noopener,noreferrer");
          return true;
        },
      },
      onUpdate: ({ editor }) => {
        const markdown = toMarkdown(editor);
        const value = markdown === given.current.markdown ? given.current.value : markdown;
        if (value === held.current) return;
        held.current = value;
        latest.current.onChange(value);
      },
      onTransaction: redraw,
      onFocus: redraw,
      onBlur: redraw,
    });
    given.current.markdown = toMarkdown(editor);
    setEditor(editor);
    const { autoFocus } = latest.current;
    if (autoFocus === true) editor.commands.focus("end");
    else if (typeof autoFocus === "number") {
      const at = TextSelection.near(editor.state.doc.resolve(Math.round(autoFocus * editor.state.doc.content.size)));
      editor.view.dispatch(editor.state.tr.setSelection(at));
      editor.view.focus();
    }
    latest.current.onReady?.();
    return () => editor.destroy();
  }, []);

  // A value from outside (a reload, "Use theirs", a sent comment clearing the composer) replaces the content.
  useEffect(() => {
    if (!editor || props.value === held.current) return;
    if (!admits(props.value)) return props.onReject();
    editor.commands.setContent(props.value, { contentType: "markdown", emitUpdate: false });
    held.current = props.value;
    given.current = { value: props.value, markdown: toMarkdown(editor) };
  }, [editor, props.value]);

  // New issues or members: recompute the chips.
  useEffect(() => {
    editor?.view.dispatch(editor.state.tr.setMeta(chipsKey, true));
  }, [editor, source.current]);

  const focused = !!editor?.isFocused;
  const mentionTyped = editor && focused ? typedAt(editor.state, MENTION_TRIGGER) : null;
  const slashTyped = editor && focused ? typedAt(editor.state, SLASH_TRIGGER) : null;
  const caret = (index: number) => {
    const c = editor!.view.coordsAtPos(index);
    return { left: c.left, top: c.top, height: c.bottom - c.top };
  };
  const replaceTyped = (typed: { start: number; end: number }, text: string) =>
    editor!.view.dispatch(editor!.state.tr.insertText(text, typed.start, typed.end));

  const mention = useCaretMenu({
    typed: mentionTyped,
    items: useMentionable(mentionTyped?.query),
    caret,
    pick: (user) => replaceTyped(mentionTyped!, `@${user.username} `),
    option: (user) => <MentionOption user={user} />,
    label: "Mention someone",
    className: "mention-menu",
  });
  const slash = useCaretMenu({
    typed: slashTyped,
    items: slashTyped ? BLOCKS.filter((b) => b.label.toLowerCase().split(" ").some((w) => w.startsWith(slashTyped.query))) : [],
    caret,
    pick: (block) => {
      replaceTyped(slashTyped!, "");
      block.run(editor!);
    },
    option: (block) => (
      <>
        <span className="pop-label">{block.label}</span>
        <span className="pop-prefix">{block.hint}</span>
      </>
    ),
    label: "Insert a block",
    className: "slash-menu",
  });

  keys.current = (event) => {
    if (mention.onKeyDown(event) || slash.onKeyDown(event)) return true;
    if (editor && event.key === "k" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
      if (editor.state.selection.empty && !editor.isActive("link")) return false;
      editor.chain().extendMarkRange("link").run();
      setLinking(true);
      return true;
    }
    return editorKey(event, latest.current);
  };

  if (props.attach) props.attach.current = (files) => editor && insertFiles(editor, files, null, props.team);

  return (
    <>
      <div ref={host} className={cls("rich-host", drop.over && "dropping")} {...drop.props} />
      {editor && (focused || linking) && <Toolbar editor={editor} linking={linking} setLinking={setLinking} />}
      {mention.menu}
      {slash.menu}
    </>
  );
}

// ---------- The toolbar on a selection ----------

const MARKS = [
  { mark: "bold", label: "Bold", keys: "⌘B", text: <b>B</b>, run: (e: Editor) => e.chain().focus().toggleBold().run() },
  { mark: "italic", label: "Italic", keys: "⌘I", text: <i>I</i>, run: (e: Editor) => e.chain().focus().toggleItalic().run() },
  { mark: "strike", label: "Strikethrough", keys: "⌘⇧S", text: <s>S</s>, run: (e: Editor) => e.chain().focus().toggleStrike().run() },
  { mark: "code", label: "Code", keys: "⌘E", text: <code>{"<>"}</code>, run: (e: Editor) => e.chain().focus().toggleCode().run() },
];

/** Bold, italic, strikethrough, code and link for the selected text; the link button (or ⌘K) edits its address. */
function Toolbar({ editor, linking, setLinking }: { editor: Editor; linking: boolean; setLinking: (on: boolean) => void }) {
  const pop = useRef<HTMLDivElement>(null);
  const { selection } = editor.state;
  const [href, setHref] = useState("");
  const shown = linking || (!selection.empty && selection instanceof TextSelection && !selection.$from.parent.type.spec.code);

  useEffect(() => {
    if (linking) setHref(editor.getAttributes("link").href ?? "");
  }, [linking]);

  // Above the selection (below when there's no room), inside the viewport.
  useLayoutEffect(() => {
    const el = pop.current;
    if (!shown || !el) return;
    const place = () => {
      const start = editor.view.coordsAtPos(editor.state.selection.from);
      const m = 8;
      let top = start.top - el.offsetHeight - 6;
      if (top < m) top = editor.view.coordsAtPos(editor.state.selection.to).bottom + 6;
      el.style.left = `${Math.max(m, Math.min(start.left, innerWidth - el.offsetWidth - m))}px`;
      el.style.top = `${top}px`;
    };
    place();
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => {
      removeEventListener("resize", place);
      removeEventListener("scroll", place, true);
    };
  });

  if (!shown) return null;
  const close = () => {
    setLinking(false);
    editor.commands.focus();
  };
  const apply = () => {
    const url = href.trim();
    const full = !url || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url) ? url : `https://${url}`;
    if (!full) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else if (allowedHref(full)) editor.chain().focus().extendMarkRange("link").setLink({ href: full }).run();
    setLinking(false);
  };

  return createPortal(
    <div ref={pop} className="pop rich-toolbar" role="toolbar" aria-label="Format">
      {linking ? (
        <input
          className="rich-link-input"
          autoFocus
          dir="ltr"
          placeholder="Paste or type a link…"
          aria-label="Link address"
          value={href}
          onChange={(e) => setHref(e.target.value)}
          onBlur={() => setLinking(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        />
      ) : (
        <>
          {MARKS.map((m) => (
            <button
              key={m.mark}
              type="button"
              className={cls("rich-tool", editor.isActive(m.mark) && "on")}
              aria-label={m.label}
              aria-pressed={editor.isActive(m.mark)}
              title={`${m.label} ${m.keys}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => m.run(editor)}
            >
              {m.text}
            </button>
          ))}
          <button
            type="button"
            className={cls("rich-tool", editor.isActive("link") && "on")}
            aria-label="Link"
            title="Link ⌘K"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setLinking(true)}
          >
            Link
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

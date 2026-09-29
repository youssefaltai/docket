// The rich editor's document model: Tiptap extensions, markdown in and out, safe paste, and the fidelity guard.
// Headless (no React), so tests run it as is; the editor UI around it is tiptap.tsx. Markdown stays the stored format.
import { Editor, Extension, flattenExtensions, Node as TiptapNode, type AnyExtension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { BulletList, getListMarker, ListItem, OrderedList, TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Node as PMNode, Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { Marked } from "marked";
import { ATTACHMENT_URL } from "../shared/types";
import { pastedFiles } from "./util";

/**
 * @tiptap/extension-table's renderTableToMarkdown, ported line for line with one change: `|` in a cell's text is
 * escaped to `\|`. Upstream writes it bare, so the next load splits the row and drops a cell.
 */
const PipeSafeTable = Table.extend({
  renderMarkdown: (node: any, h: any) => {
    const cellSep = "\x1f"; // upstream's separator for a cell's hard line breaks, turned into <br>
    if (!node?.content?.length) return "";
    const rows: { text: string; isHeader: boolean; align: string | null }[][] = [];
    node.content.forEach((rowNode: any) => {
      const cells: (typeof rows)[number] = [];
      rowNode.content?.forEach((cellNode: any) => {
        const raw =
          Array.isArray(cellNode.content) && cellNode.content.length > 1
            ? cellNode.content.map((child: any) => h.renderChildren(child)).join(cellSep)
            : cellNode.content
              ? h.renderChildren(cellNode.content)
              : "";
        const text = (raw.split(cellSep).join("\n").replace(/[ \t]*\r?\n[ \t]*/g, "<br>") || "").replace(/\s+/g, " ").trim();
        cells.push({ text: text.replace(/\|/g, "\\|"), isHeader: cellNode.type === "tableHeader", align: cellNode.attrs?.align || null });
      });
      rows.push(cells);
    });
    const columns = rows.reduce((max, r) => Math.max(max, r.length), 0);
    if (columns === 0) return "";
    const widths = Array.from({ length: columns }, (_, i) => Math.max(3, ...rows.map((r) => r[i]?.text.length ?? 0)));
    const aligns = Array.from({ length: columns }, (_, i) => rows.map((r) => r[i]?.align).find(Boolean) ?? null);
    const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - s.length));
    const line = (texts: string[]) => `| ${texts.map((t, i) => pad(t, widths[i]!)).join(" | ")} |\n`;
    const hasHeader = rows[0]!.some((c) => c.isHeader);
    let out = "\n" + line(widths.map((_, i) => (hasHeader ? rows[0]![i]?.text || "" : "")));
    out += `| ${widths
      .map((w, i) => {
        const dashes = "-".repeat(Math.max(3, w));
        return { left: `:${dashes}`, right: `${dashes}:`, center: `:${dashes}:` }[aligns[i] as string] ?? dashes;
      })
      .join(" | ")} |\n`;
    for (const r of hasHeader ? rows.slice(1) : rows) out += line(widths.map((_, i) => r[i]?.text || ""));
    return out;
  },
});

// Lists, patched where @tiptap/extension-list's markdown doesn't round-trip (DKT-37):
// - An item's soft line breaks stay "\n" in its text, as in a paragraph (the read view shows them as line breaks),
//   and the lines after the first are indented under the item, not joined or left to lazy continuation.
// - A tight item's text after a block (a code block, a sublist) is a paragraph, not raw text whose markdown gets
//   escaped (its backticks compounded on every save).
// - Lists remember whether they're loose (blank lines between items: the read view spaces them as paragraphs).

type Json = { type?: string; text?: string; attrs?: Record<string, any>; content?: Json[] };
const LISTS = ["bulletList", "orderedList", "taskList"];
const loose = { loose: { default: false, rendered: false } };

/**
 * An item as markdown: its marker, its first paragraph (every line after the first indented like the item's other
 * content), then its other blocks. In a tight list they follow on the next line, unless a paragraph follows a
 * paragraph or a list, which takes a blank line; in a loose one, blocks are separated by blank lines.
 */
function renderItem(node: Json, h: any, marker: string, pad: string, isLoose: boolean): string {
  const [first, ...rest] = node.content ?? [];
  let out = marker + h.renderChildren([first]).replace(/\n/g, `\n${pad}`);
  let prev = first!;
  rest.forEach((child, i) => {
    const blank = isLoose || (child.type === "paragraph" && (prev.type === "paragraph" || LISTS.includes(prev.type!)));
    const text = h.renderChild?.(child, i + 1) ?? h.renderChildren([child]);
    out += (blank ? "\n\n" : "\n") + text.split("\n").map((line: string) => pad + line).join("\n");
    prev = child;
  });
  return out;
}

const LooseBulletList = BulletList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...loose };
  },
  parseMarkdown: (token, h) => {
    const list = BulletList.config.parseMarkdown!(token, h) as Json;
    return Array.isArray(list) ? list : { ...list, attrs: { loose: !!token.loose } };
  },
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? [], node.attrs?.loose ? "\n\n" : "\n"),
});

const LooseOrderedList = OrderedList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...loose };
  },
  // Read by marked, as the read view reads them: Tiptap's own tokenizer leaves a space on every line under an item,
  // so its blocks shift on each save, and doesn't say if a list is loose.
  markdownTokenizer: null as never,
  parseMarkdown: (token, h) =>
    token.type === "list" && token.ordered
      ? { type: "orderedList", attrs: { start: token.start ?? 1, loose: !!token.loose }, content: h.parseChildren(token.items ?? []) }
      : [],
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? [], node.attrs?.loose ? "\n\n" : "\n"),
});

const FaithfulListItem = ListItem.extend({
  // marked leaves a tight item's text as `text` tokens: read each as a paragraph (upstream reads only the first).
  parseMarkdown: (token, h) => {
    const tokens = token.tokens?.map((t) => (t.type === "text" ? { ...t, type: "paragraph", tokens: t.tokens ?? h.tokenizeInline?.(t.text ?? "") } : t));
    return ListItem.config.parseMarkdown!({ ...token, tokens }, h);
  },
  renderMarkdown: (node, h, ctx) => {
    const attrs = ctx.meta?.parentAttrs ?? {};
    if (ctx.parentType !== "orderedList") return renderItem(node, h, "- ", h.indent(""), !!attrs.loose);
    const marker = getListMarker(attrs.type, (attrs.start ?? 1) - 1 + (ctx.index ?? 0));
    return renderItem(node, h, marker, " ".repeat(marker.length), !!attrs.loose);
  },
});

const FaithfulTaskItem = TaskItem.extend({
  // Tiptap's task list tokenizer reads a task's first line as its text and the lines under it as nested blocks:
  // lines that directly follow it (a paragraph, or an indented code block when they're indented 4 or more) are
  // more of its paragraph.
  parseMarkdown: (token, h) => {
    const [next, ...rest] = token.nestedTokens ?? [];
    if (next && h.tokenizeInline && (next.type === "paragraph" || (next.type === "code" && next.codeBlockStyle === "indented"))) {
      const text = `${token.text}\n${next.text}`.replace(/\n[ \t]+/g, "\n");
      token = { ...token, text, tokens: h.tokenizeInline(text), nestedTokens: rest };
    }
    return TaskItem.config.parseMarkdown!(token, h);
  },
  renderMarkdown: (node, h) => renderItem(node, h, `- [${node.attrs?.checked ? "x" : " "}] `, h.indent(""), false),
});

/**
 * Inline code holding backticks is written the CommonMark way: fenced with one more backtick than its longest run
 * inside, and padded with a space if it starts or ends with one. Tiptap always writes a single backtick and sees only
 * a placeholder when it renders a mark, so the extra fence goes into the text itself (code text isn't escaped).
 */
function fenceCode(node: Json & { marks?: { type: string }[] }) {
  node.content?.forEach(fenceCode);
  const text = node.text;
  if (!text?.includes("`") || !node.marks?.some((m) => m.type === "code")) return;
  const fence = "`".repeat(Math.max(...text.match(/`+/g)!.map((run) => run.length)));
  const pad = /^`|`$/.test(text) ? " " : "";
  node.text = fence + pad + text + pad + fence;
}

/** Only web and mail links, or paths in the app. Anything else (javascript:, data:) is refused. */
export const allowedHref = (href: string) => {
  const url = href.replace(/[\u0000- ]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
  return !scheme || /^(https?|mailto)$/i.test(scheme);
};

/**
 * Images, but only attachments: same-origin `/api/attachments/<id>/<name>`, private to the workspace. Any other image
 * markdown reads as a link to it (the guard sends such text to the source, see plainText), so the editor never loads a
 * remote image. `alt` is kept as markdown source, so it saves back as written.
 */
const AttachmentImage = TiptapNode.create({
  name: "image",
  inline: true,
  group: "inline",
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: { default: "" }, alt: { default: "" }, title: { default: null } }),
  parseHTML: () => [
    {
      tag: "img[src]",
      getAttrs: (el) => (ATTACHMENT_URL.test(el.getAttribute("src") ?? "") ? { src: el.getAttribute("src"), alt: el.getAttribute("alt") ?? "" } : false),
    },
  ],
  renderHTML: ({ node }) => ["img", { src: ATTACHMENT_URL.test(node.attrs.src) ? node.attrs.src : "", alt: node.attrs.alt, title: node.attrs.title }],
  markdownTokenName: "image",
  parseMarkdown: (token, h) => {
    const { href = "", title = null, text = "" } = token as { href?: string; title?: string | null; text?: string };
    if (ATTACHMENT_URL.test(href)) return { type: "image", attrs: { src: href, alt: text, title } };
    return h.applyMark("link", [{ type: "text", text: text || href }], { href, title });
  },
  renderMarkdown: (node) => {
    const title = node.attrs?.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : "";
    return `![${node.attrs?.alt ?? ""}](${node.attrs?.src}${title})`;
  },
});

// StarterKit's paragraph, except that a paragraph of just an image stays a paragraph: Tiptap unwraps it, for block
// images, and ours are inline.
const Paragraph = flattenExtensions([StarterKit]).find((e) => e.name === "paragraph") as TiptapNode;
const ImageParagraph = Paragraph.extend({
  parseMarkdown: (token, h) =>
    token.tokens?.length === 1 && token.tokens[0]!.type === "image"
      ? h.createNode("paragraph", undefined, h.parseInline(token.tokens))
      : Paragraph.config.parseMarkdown!(token, h),
});

/** Files to upload, and where they go: a drop's position, or null for the selection (a paste). */
type OnFiles = (files: File[], at: number | null) => void;

/**
 * Nothing pasted or dropped loads anything remote: HTML loses its images and media before it's parsed (the image node
 * takes only attachments), and files go to `onFiles` (uploaded, then linked) or nowhere. Plain text is read as
 * markdown, except in code.
 */
const SafePaste = Extension.create<{ onFiles?: OnFiles }>({
  name: "safePaste",
  addProseMirrorPlugins() {
    const editor = this.editor;
    const { onFiles } = this.options;
    return [
      new Plugin({
        props: {
          transformPastedHTML: (html) => html.replace(/<\/?(img|picture|source|video|audio|iframe|object|embed|svg|image)\b[^>]*>/gi, ""),
          handlePaste: (_view, event) => {
            const files = pastedFiles(event.clipboardData);
            if (files.length) onFiles?.(files, null);
            return files.length > 0;
          },
          handleDrop: (view, event) => {
            const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
            if (files.length) onFiles?.(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null);
            return files.length > 0;
          },
          clipboardTextParser: (text, $context, plain) => {
            if (plain || $context.parent.type.spec.code) return null as unknown as Slice; // ProseMirror's own
            const doc = PMNode.fromJSON(editor.schema, editor.markdown!.parse(text));
            return Slice.maxOpen(doc.content);
          },
        },
      }),
    ];
  },
});

/** Everything the editor edits, and how it reads and writes markdown. `extra` adds UI-only behaviour; `onFiles` takes pasted and dropped files. */
export function extensions(extra: AnyExtension[] = [], onFiles?: OnFiles): AnyExtension[] {
  return [
    StarterKit.configure({
      underline: false, // no markdown for it
      paragraph: false, // ImageParagraph
      bulletList: false, // the patched lists below
      orderedList: false,
      listItem: false,
      link: {
        openOnClick: false,
        autolink: true,
        shouldAutoLink: (url) => /^(https?:\/\/|www\.)/i.test(url), // not every "file.ts"
        isAllowedUri: (url) => allowedHref(url),
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
      },
    }),
    Markdown.configure({ markedOptions: { gfm: true } }),
    PipeSafeTable.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    LooseBulletList,
    LooseOrderedList,
    FaithfulListItem,
    TaskList,
    FaithfulTaskItem.configure({ nested: true }),
    AttachmentImage,
    ImageParagraph,
    SafePaste.configure({ onFiles }),
    ...extra,
  ];
}

/** The editor's content as markdown, without the empty paragraphs it keeps at the end to type into. */
export function toMarkdown(editor: Editor): string {
  const json = editor.getJSON();
  const blocks = json.content ?? [];
  while (blocks.length > 1 && blocks.at(-1)!.type === "paragraph" && !blocks.at(-1)!.content?.length) blocks.pop();
  fenceCode(json);
  return editor.markdown!.serialize(json);
}

let headless: Editor | null = null;
/** Loads markdown and saves it back, as the editor would. */
export function roundtrip(markdown: string): string {
  headless ??= new Editor({ extensions: extensions(), content: { type: "doc", content: [{ type: "paragraph" }] }, injectCSS: false });
  headless.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
  return toMarkdown(headless);
}

// What a reader sees, rendered as the read view renders it: text, link targets, images (never the same as a link to
// them: a remote image reads as a link in the editor, so it stays in the source), checkboxes, line breaks and
// paragraphs (so a tight list can't turn loose).
const reader = new Marked({ gfm: true, breaks: true, renderer: { html: ({ text }) => text.replace(/</g, "&lt;") } });
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
export function plainText(markdown: string): string {
  return (reader.parse(markdown) as string)
    .replace(/<a [^>]*href="([^"]*)"[^>]*>/g, " $1 ")
    .replace(/<img [^>]*>/g, (tag) => ` 🖼${/src="([^"]*)"/.exec(tag)?.[1]} ${/alt="([^"]*)"/.exec(tag)?.[1]} ${/title="([^"]*)"/.exec(tag)?.[1] ?? ""} `)
    .replace(/<input [^>]*>/g, (tag) => (/ checked/.test(tag) ? "[x]" : "[ ]"))
    .replace(/<br>/g, "⏎")
    .replace(/<p>/g, "¶")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ENTITIES[e]!)
    .replace(/\s+/g, "");
}

/**
 * The fidelity guard: whether markdown can be edited as rich text without changing it beyond formatting.
 * Loading and saving must reach a fixed point in one step, and keep what a reader sees.
 */
export function admits(markdown: string): boolean {
  try {
    const once = roundtrip(markdown);
    return roundtrip(once) === once && plainText(once) === plainText(markdown);
  } catch {
    return false;
  }
}

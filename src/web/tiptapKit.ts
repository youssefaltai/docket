// The rich editor's document model: Tiptap extensions, markdown in and out, safe paste, and the fidelity guard.
// Headless (no React), so tests run it as is; the editor UI around it is tiptap.tsx. Markdown stays the stored format.
import { Editor, Extension, type AnyExtension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Node as PMNode, Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { Marked } from "marked";

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

/** Only web and mail links, or paths in the app. Anything else (javascript:, data:) is refused. */
export const allowedHref = (href: string) => {
  const url = href.replace(/[\u0000- ]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
  return !scheme || /^(https?|mailto)$/i.test(scheme);
};

/**
 * Nothing pasted or dropped loads anything: HTML loses its images and media before it's parsed (the schema has no
 * image node either), and files are ignored. Plain text is read as markdown, except in code.
 */
const SafePaste = Extension.create({
  name: "safePaste",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          transformPastedHTML: (html) => html.replace(/<\/?(img|picture|source|video|audio|iframe|object|embed|svg|image)\b[^>]*>/gi, ""),
          handlePaste: (_view, event) => {
            const data = event.clipboardData;
            return !!data?.files.length && !data.getData("text/plain") && !data.getData("text/html");
          },
          handleDrop: (_view, event) => !!(event as DragEvent).dataTransfer?.files.length,
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

/** Everything the editor edits, and how it reads and writes markdown. `extra` adds UI-only behaviour. */
export function extensions(extra: AnyExtension[] = []): AnyExtension[] {
  return [
    StarterKit.configure({
      underline: false, // no markdown for it
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
    TaskList,
    TaskItem.configure({ nested: true }),
    SafePaste,
    ...extra,
  ];
}

/** The editor's content as markdown, without the empty paragraphs it keeps at the end to type into. */
export function toMarkdown(editor: Editor): string {
  const json = editor.getJSON();
  const blocks = json.content ?? [];
  while (blocks.length > 1 && blocks.at(-1)!.type === "paragraph" && !blocks.at(-1)!.content?.length) blocks.pop();
  return editor.markdown!.serialize(json);
}

let headless: Editor | null = null;
/** Loads markdown and saves it back, as the editor would. */
export function roundtrip(markdown: string): string {
  headless ??= new Editor({ extensions: extensions(), content: { type: "doc", content: [{ type: "paragraph" }] }, injectCSS: false });
  headless.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
  return toMarkdown(headless);
}

// What a reader sees, rendered as the read view renders it: text, link targets, checkboxes and line breaks.
const reader = new Marked({ gfm: true, breaks: true, renderer: { html: ({ text }) => text.replace(/</g, "&lt;") } });
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
export function plainText(markdown: string): string {
  return (reader.parse(markdown) as string)
    .replace(/<a [^>]*href="([^"]*)"[^>]*>/g, " $1 ")
    .replace(/<img [^>]*>/g, (tag) => ` ${/src="([^"]*)"/.exec(tag)?.[1]} ${/alt="([^"]*)"/.exec(tag)?.[1]} `)
    .replace(/<input [^>]*>/g, (tag) => (/ checked/.test(tag) ? "[x]" : "[ ]"))
    .replace(/<br>/g, "⏎")
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

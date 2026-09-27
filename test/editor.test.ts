// The rich editor's markdown round-trip (src/web/tiptapKit.ts). Unlike the other tests it imports src/: it checks how
// a library reads and writes markdown, on a real corpus (fixtures/editor: DKT issue descriptions, the workspace
// isolation design doc, a GFM sampler). It runs on happy-dom, whose globals exist only while this file runs.
import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const dom = new Window();
const added = Object.getOwnPropertyNames(dom).filter((key) => !(key in globalThis));
for (const key of added) (globalThis as any)[key] = (dom as any)[key];
(globalThis as any).window = dom;
added.push("window");
afterAll(async () => {
  for (const key of added) delete (globalThis as any)[key];
  await dom.happyDOM.close();
});

const { Editor } = await import("@tiptap/core");
const { admits, extensions, plainText, roundtrip, toMarkdown } = await import("../src/web/tiptapKit.ts");

const dir = join(import.meta.dir, "fixtures", "editor");
const corpus = readdirSync(dir).map((name) => ({ name, markdown: readFileSync(join(dir, name), "utf8") }));

/** An editor on the page, as the app mounts it. */
const mount = (markdown: string) =>
  new Editor({ element: document.createElement("div"), extensions: extensions(), content: markdown, contentType: "markdown", textDirection: "auto" });

// What the guard sends to markdown source mode, and why: soft line breaks in task and ordered list items that
// Tiptap joins or re-indents (19, 20, 22, 31–33); inline code after a code block in a list item, whose backticks
// get escaped and compound on every save (21, 23, 4, the design doc); ``double backtick`` code (4).
const REJECTED = ["DKT-19.md", "DKT-20.md", "DKT-21.md", "DKT-22.md", "DKT-23.md", "DKT-31.md", "DKT-32.md", "DKT-33.md", "DKT-4.md", "design-doc.md"];

test("the guard admits the corpus except the known lossy cases", () => {
  expect(corpus.length).toBe(37);
  expect(corpus.filter((f) => !admits(f.markdown)).map((f) => f.name).sort()).toEqual(REJECTED.sort());
});

test("what the guard admits survives a one-character edit: nothing lost, and stable on the next load", () => {
  for (const { name, markdown } of corpus.filter((f) => admits(f.markdown))) {
    const editor = mount(markdown);
    let at = 0;
    editor.state.doc.descendants((node, pos) => {
      if (!at && node.isTextblock) at = pos + 1;
      return !at;
    });
    editor.view.dispatch(editor.state.tr.insertText("✱", at));
    const saved = toMarkdown(editor);
    editor.destroy();
    expect([name, saved.split("✱").length]).toEqual([name, 2]);
    expect([name, plainText(saved.replace("✱", ""))]).toEqual([name, plainText(markdown)]);
    expect([name, roundtrip(saved)]).toEqual([name, saved]);
  }
});

test("opening without an edit changes nothing the editor would save", () => {
  for (const { markdown } of corpus.filter((f) => admits(f.markdown))) {
    const editor = mount(markdown);
    const before = toMarkdown(editor);
    editor.view.dispatch(editor.state.tr.setMeta("noop", true)); // e.g. adds the trailing paragraph after a table
    expect(toMarkdown(editor)).toBe(before);
    editor.destroy();
  }
});

test("pipes in table cells stay escaped, so no cell is lost", () => {
  const table = [
    "| Route | Change | Step |",
    "|---|---|---|",
    "| `GET /api/locate` | new: `?issue` \\| `?doc` \\| `?team` → `{ workspace }` | DKT-6 |",
    "| a \\| b | c | d |",
  ].join("\n");
  const once = roundtrip(table);
  expect(once).toContain("`?issue` \\| `?doc` \\| `?team`");
  expect(once).toContain("a \\| b");
  expect(roundtrip(once)).toBe(once);
  expect(plainText(once)).toBe(plainText(table));
  expect(admits(table)).toBe(true);
});

test("the guard rejects what the editor would change: compounding backticks, images", () => {
  const backticks = "- item:\n  ```sql\n  SELECT 1;\n  ```\n  Note `docket-ask` here.\n";
  expect(roundtrip(backticks)).toContain("\\`docket-ask\\`"); // the bug the guard contains
  expect(admits(backticks)).toBe(false);
  expect(admits("![chart](https://example.com/chart.png)")).toBe(false); // no image node: it would become its alt text
  expect(admits("")).toBe(true);
  expect(admits("Plain, **bold** and `code`. هذا نص عربي")).toBe(true);
});

/** Pastes as a browser does (ProseMirror's own pasteText pastes as if with ⇧⌘V). */
function paste(editor: InstanceType<typeof Editor>, data: Record<string, string>) {
  const clipboardData = new DataTransfer();
  for (const [type, value] of Object.entries(data)) clipboardData.setData(type, value);
  editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
}

test("paste: markdown text becomes rich text; HTML images and remote media are dropped", () => {
  const editor = mount("");
  const markdown = "## Plan\n\n**bold** and [a link](https://example.com)\n\n- [ ] task";
  paste(editor, { "text/plain": markdown });
  expect(toMarkdown(editor)).toBe(markdown);

  editor.commands.setContent("");
  paste(editor, { "text/html": '<p>before<img src="https://evil.example/x.png?leak=1">after</p><video src="https://evil.example/v.mp4"></video>' });
  expect(toMarkdown(editor)).toBe("beforeafter");
  expect(editor.view.dom.querySelector("img[src], video, iframe")).toBeNull();
  expect(JSON.stringify(editor.getJSON())).not.toContain("evil.example");
  editor.destroy();
});

test("links keep to safe schemes and open with noopener", () => {
  const editor = mount("[ok](https://example.com) [bad](javascript:alert(1))");
  const links = [...editor.view.dom.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.getAttribute("rel")]);
  expect(links).toEqual([
    ["https://example.com", "noopener noreferrer"],
    ["", "noopener noreferrer"], // shown without its address; the markdown keeps it and the read view drops it
  ]);
  editor.destroy();
});

test("every block reads its own direction (Arabic lines right to left)", () => {
  const editor = mount("English line\n\nسطر عربي\n\n- عنصر");
  const blocks = [...editor.view.dom.querySelectorAll("p, li")].map((el) => el.getAttribute("dir"));
  expect(blocks).toEqual(["auto", "auto", "auto", "auto"]);
  editor.destroy();
});

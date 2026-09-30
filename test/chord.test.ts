// The G-chord (src/web/hooks.ts, useGoChord): the key after G is consumed whether or not it is bound, so a stray
// "G P" doesn't also open the priority picker. Imports src/ on happy-dom, like editor.test.ts.
import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/acme" });
const added = Object.getOwnPropertyNames(dom).filter((key) => !(key in globalThis));
for (const key of added) (globalThis as any)[key] = (dom as any)[key];
(globalThis as any).window = dom;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
added.push("window", "IS_REACT_ACT_ENVIRONMENT");
// Bun has its own global addEventListener; the hooks' bare calls must reach the page's window.
const { addEventListener, removeEventListener } = globalThis;
globalThis.addEventListener = dom.addEventListener.bind(dom) as typeof addEventListener;
globalThis.removeEventListener = dom.removeEventListener.bind(dom) as typeof removeEventListener;
afterAll(async () => {
  globalThis.addEventListener = addEventListener;
  globalThis.removeEventListener = removeEventListener;
  for (const key of added) delete (globalThis as any)[key];
  await dom.happyDOM.close();
});

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useGoChord, useIssueShortcuts } = await import("../src/web/hooks.ts");

const went: string[] = [];
let picked = 0;

// An issue page's shape: the global chord (as main.tsx mounts it) above a page with its own shortcuts and a trigger.
function Page() {
  useGoChord((path) => went.push(path));
  return h(Child);
}
function Child() {
  useIssueShortcuts(() => ({ root: document.body, id: "DKT-1" }));
  return h("button", { "data-cmd": "priority", onClick: () => picked++ });
}
const root = createRoot(document.body.appendChild(document.createElement("div")));
await act(async () => root.render(h(Page)));

/** Presses a key on the page; whether a handler called preventDefault on it. */
const press = (key: string) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e.defaultPrevented;
};

test("G then a bound key navigates", () => {
  press("g");
  expect(press("i")).toBe(true);
  expect(went).toEqual(["/inbox"]);
});

test("G then a key a page binds does nothing", () => {
  press("g");
  expect(press("p")).toBe(true);
  expect(picked).toBe(0);
  expect(went).toEqual(["/inbox"]);
});

test("the chord is spent after its second key, and P alone still works", () => {
  press("g");
  press("x");
  press("p");
  expect(picked).toBe(1);
});

test("Escape cancels the chord without being consumed", () => {
  press("g");
  expect(press("Escape")).toBe(false);
  press("p");
  expect(picked).toBe(2);
});

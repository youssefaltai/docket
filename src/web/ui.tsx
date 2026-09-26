// Shared primitives: routing, app context, hooks, toasts, icons, markdown, modal, comments.
//
// The implementations live in focused modules (routing, context, hooks, icons, modal, toast,
// issueIndex, markdown, components, comments); this file re-exports them as one surface, since
// most pages only need a handful of primitives and importing from "./ui" is the established idiom.
export * from "./util";
export * from "./routing";
export * from "./context";
export * from "./icons";
export * from "./modal";
export * from "./toast";
export * from "./hooks";
export * from "./issueIndex";
export * from "./markdown";
export * from "./components";
export * from "./comments";

// Keys typed into an IME composition (Japanese or Chinese input, say) belong to the IME: Enter there
// confirms the text. Stop them before any app handler can submit, save or move focus.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.isComposing || e.keyCode === 229) e.stopImmediatePropagation();
  },
  true,
);

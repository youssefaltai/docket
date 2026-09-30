// The `?` help overlay: a static reference. `SHORTCUT_GROUPS` is the one place the shortcut list is written; SPEC.md's
// Keyboard section points here and keeps only the prose this list lacks.
import { Kbd, MOD, Modal } from "./ui";

export const SHORTCUT_GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Global",
    rows: [
      [`${MOD}K`, "Open the command menu, even while typing in a field"],
      ["C", "New issue"],
      ["/", "Focus search"],
      ["J / K / ↓ / ↑", "Move focus between rows or cards"],
      ["U / Alt-U", "Inbox: toggle the focused row read or unread / mark all read"],
      ["Backspace / Shift-Backspace", "Inbox: delete the focused row / delete all read"],
      ["Shift-S", "Issue or doc page: subscribe or unsubscribe"],
      ["?", "Show this help"],
      ["G then I", "Go to Inbox"],
      ["G then M", "Go to My Issues"],
      ["G then D", "Go to All docs"],
      ["G then V", "Go to Views"],
      ["G then S", "Go to Settings"],
      ["Esc", "Clear the selection, else close the mobile nav, else leave the page, else blur"],
    ],
  },
  {
    title: "Focused row or issue page",
    rows: [
      ["S", "Set status"],
      ["P", "Set priority"],
      ["A", "Set assignee"],
      ["D", "Set delegate"],
      ["L", "Set labels"],
      ["I", "Claim (assign to me)"],
      [`${MOD}⇧.`, "Issue page: copy its git branch name"],
      [`${MOD}⌫`, "Delete to trash"],
    ],
  },
  {
    title: "Selecting issues (lists and boards)",
    rows: [
      ["X", "Select or deselect the focused row"],
      ["Shift-J / Shift-K / Shift-↓ / Shift-↑", "Extend the selection down or up"],
      ["Shift-click", "Select every row from the last one picked"],
      ["S / P / A / D / L", "With a selection: set it on every selected issue"],
      [`${MOD}⌫`, "With a selection: move them all to trash (asks first)"],
      ["Esc", "Clear the selection"],
    ],
  },
  {
    title: "In a popover picker",
    rows: [
      ["↓ / Ctrl-N", "Next option"],
      ["↑ / Ctrl-P", "Previous option"],
      ["Enter", "Pick"],
      ["Esc", "Close and refocus the trigger"],
      ["Tab", "Close without refocusing"],
    ],
  },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal label="Keyboard shortcuts" className="modal-sm shortcuts" onClose={onClose}>
      <div className="modal-head">
        <span className="modal-title">Keyboard shortcuts</span>
      </div>
      <div className="modal-body shortcuts-body">
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g.title} className="shortcuts-group">
            <h3>{g.title}</h3>
            <table>
              <tbody>
                {g.rows.map(([keys, action]) => (
                  <tr key={keys}>
                    <td>
                      {keys.split(" ").map((part, i) => (part === "/" || part === "then" ? ` ${part} ` : <Kbd key={i}>{part}</Kbd>))}
                    </td>
                    <td>{action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Modal>
  );
}

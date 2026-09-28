// Multi-select on issue lists and boards (DKT-17): a checkbox per row or card, X / Shift-J/K / Shift-click /
// Esc, and a bottom bar that sets status, priority, assignee, delegate or labels on every selected issue, or
// moves them all to the trash, through POST /api/issues/bulk.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { BulkIssuePatch, BulkIssueResult, IssueSummary, Priority, UserRef } from "../shared/types";
import { api } from "./api";
import { PRIORITY_OPTIONS, Picker, statusOptions, useMembers, userOption } from "./pickers";
import {
  Avatar,
  CheckIcon,
  CloseIcon,
  LabelDot,
  labelColor,
  labelGroupOf,
  PriorityIcon,
  StatusIcon,
  TagIcon,
  TrashIcon,
  ask,
  cls,
  errorToast,
  isEditable,
  moveFocus,
  statusGroups,
  toast,
  useApp,
  useKeydown,
} from "./ui";

export interface Selection {
  has: (id: string) => boolean;
  any: boolean;
  /** A checkbox click toggles `id`; with `range` (Shift) it selects everything from the last one touched to it. */
  pick: (id: string, range: boolean) => void;
}

type SetIssues = (fn: (list: IssueSummary[] | null) => IssueSummary[] | null) => void;

// With a selection, these open the bar's picker instead of the focused row's (Linear's behaviour).
const BAR_CMD: Record<string, string> = { s: "status", p: "priority", a: "assignee", d: "delegate", l: "labels" };

const plural = (ids: string[]) => (ids.length === 1 ? ids[0]! : `${ids.length} issues`);
const focusedId = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-issue-id]")?.dataset.issueId;
/** Issue ids in the order they're shown (list groups top to bottom, board columns left to right). */
const shownOrder = () => [...new Set([...document.querySelectorAll<HTMLElement>("[data-issue-id]")].map((el) => el.dataset.issueId!))];

function failed(results: BulkIssueResult[]) {
  const bad = results.filter((r) => r.error);
  if (bad.length === 1) toast(`${bad[0]!.id}: ${bad[0]!.error}`);
  else if (bad.length) toast(`${bad.length} issues weren't changed. ${bad[0]!.id}: ${bad[0]!.error}`);
  return bad;
}

/**
 * The selection for one issues view, and its action bar (`bar`, null when nothing is selected). It lives above
 * the list and board, so it survives switching between them; it clears when `reset` changes (a new team,
 * search or filter). Ids no longer shown (deleted elsewhere, say) drop out of it.
 */
export function useBulk(
  issues: IssueSummary[] | null,
  { setIssues, invalidate, reload }: { setIssues: SetIssues; invalidate: () => number; reload: () => void },
  reset: unknown[],
) {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const clear = (keep: string[] = []) => {
    setIds(new Set(keep));
    anchor.current = null;
  };
  useEffect(() => clear(), reset);
  const selected = issues?.filter((i) => ids.has(i.id)) ?? [];

  const add = (more: (string | undefined)[]) => setIds((cur) => new Set([...cur, ...more.filter((x): x is string => !!x)]));
  const pick = (id: string, range: boolean) => {
    const order = shownOrder();
    const [from, to] = [anchor.current ? order.indexOf(anchor.current) : -1, order.indexOf(id)];
    anchor.current = id;
    if (range && from >= 0 && to >= 0) return add(order.slice(Math.min(from, to), Math.max(from, to) + 1));
    setIds((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  /** Applies `patch` to every selected issue: `local` shows it at once, and any failure reloads the truth. */
  const apply = (patch: BulkIssuePatch, local: (i: IssueSummary) => IssueSummary) => {
    const targets = new Set(selected.map((i) => i.id));
    invalidate();
    const now = new Date().toISOString();
    setIssues((list) => list?.map((i) => (targets.has(i.id) ? { ...local(i), updatedAt: now } : i)) ?? null);
    api.bulkIssues([...targets], patch).then(
      (results) => failed(results).length && reload(),
      (e) => {
        errorToast(e);
        reload();
      },
    );
  };

  // Linear's delete asks nothing (it's undoable); a batch asks once, since it's a bigger blast radius.
  const remove = async () => {
    const targets = selected.map((i) => i.id);
    if (!targets.length || !(await ask(`Move ${plural(targets)} to trash?`, "Delete"))) return;
    invalidate();
    let results: BulkIssueResult[];
    try {
      results = await api.bulkIssues(targets, { delete: true });
    } catch (e) {
      return errorToast(e);
    }
    const bad = failed(results);
    const done = results.filter((r) => r.issue).map((r) => r.id);
    setIssues((list) => list?.filter((i) => !done.includes(i.id)) ?? null);
    clear(bad.map((r) => r.id));
    if (!done.length) return;
    toast(`Moved ${plural(done)} to trash`, undefined, async () => {
      const restored = await Promise.allSettled(done.map((id) => api.restoreIssue(id)));
      const missed = restored.filter((r) => r.status === "rejected").length;
      toast(missed ? `Restored ${done.length - missed} of ${done.length}` : `Restored ${plural(done)}`);
      reload();
    });
  };

  // Capture phase, so these win over the app's own Escape (leave/blur), J/K and the row's S/P/A/D/L/⌘⌫.
  useKeydown((e) => {
    if (e.defaultPrevented || e.altKey || isEditable(e.target) || document.querySelector(".pop, .backdrop")) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    if (!mod && !e.shiftKey && key.toLowerCase() === "x") {
      const id = focusedId();
      if (!id) return;
      e.preventDefault();
      pick(id, false);
    } else if (!mod && e.shiftKey && ["j", "k", "arrowdown", "arrowup"].includes(key.toLowerCase())) {
      e.preventDefault();
      const from = focusedId();
      moveFocus(["j", "arrowdown"].includes(key.toLowerCase()) ? 1 : -1);
      const to = focusedId();
      add([from, to]);
      anchor.current = to ?? null;
    } else if (!selected.length || e.shiftKey) {
      return;
    } else if (key === "Escape" && !mod) {
      e.preventDefault();
      clear();
    } else if (key === "Backspace" && mod) {
      e.preventDefault();
      void remove();
    } else if (!mod && BAR_CMD[key.toLowerCase()]) {
      e.preventDefault();
      document.querySelector<HTMLButtonElement>(`.bulkbar [data-cmd="${BAR_CMD[key.toLowerCase()]}"]`)?.click();
    }
  }, true);

  const selection: Selection = { has: (id) => ids.has(id), any: selected.length > 0, pick };
  const bar = selected.length ? <BulkBar issues={selected} apply={apply} remove={remove} clear={() => clear()} /> : null;
  return { selection, bar };
}

/** A row's or card's checkbox (hover, focus or an active selection show it; always on touch). */
export function SelectBox({ id, selection }: { id: string; selection: Selection }) {
  const on = selection.has(id);
  return (
    <button
      type="button"
      className={cls("select-box", on && "on")}
      role="checkbox"
      aria-checked={on}
      aria-label={`Select ${id}`}
      title="Select (X)"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        selection.pick(id, e.shiftKey);
      }}
    >
      <span className={cls("checkbox", on && "on")}>{on && <CheckIcon />}</span>
    </button>
  );
}

/** Shift-click anywhere on a row or card selects the range to it, instead of opening or editing it. */
export const shiftClick = (id: string, selection: Selection) => (e: MouseEvent) => {
  if (!e.shiftKey) return;
  e.preventDefault();
  e.stopPropagation();
  selection.pick(id, true);
};

/** The values every selected issue shares, so a picker checks one only when it's true of all of them. */
function shared<T>(issues: IssueSummary[], of: (i: IssueSummary) => T): string[] {
  const first = of(issues[0]!);
  return issues.every((i) => of(i) === first) ? [String(first ?? "")] : [];
}

function BulkBar({
  issues,
  apply,
  remove,
  clear,
}: {
  issues: IssueSummary[];
  apply: (patch: BulkIssuePatch, local: (i: IssueSummary) => IssueSummary) => void;
  remove: () => void;
  clear: () => void;
}) {
  const { labels, loadDirectory, teams } = useApp();
  // The statuses of the selected issues' teams; one a team lacks fails for its issues (400) and the rest still apply.
  const statuses = statusGroups((teams ?? []).filter((t) => issues.some((i) => i.team === t.key)));
  const people = useMembers("person");
  const agents = useMembers("agent");
  // Labels usable on every selected issue: the workspace's, and a team's own when they're all that team's.
  const selectedTeams = new Set(issues.map((i) => i.team));
  const usable = labels.filter((l) => !l.isGroup && (l.team === null || (selectedTeams.size === 1 && selectedTeams.has(l.team))));
  const allLabels = [...new Set([...usable.map((l) => l.path), ...issues.flatMap((i) => i.labels)])];
  const common = allLabels.filter((l) => issues.every((i) => i.labels.includes(l)));
  // Adding a label of a group swaps out the group's other label on each issue, as the server does.
  const add = (i: IssueSummary, l: string) => {
    const group = labelGroupOf(labels, l);
    return [...i.labels.filter((x) => group === null || labelGroupOf(labels, x) !== group), l];
  };
  const userPicker = (field: "assignee" | "delegate", label: string, none: string, users: UserRef[], text: string) => (
    <Picker
      label={label}
      cmd={field}
      className="bulkbar-btn"
      options={[{ value: "", label: none, icon: <Avatar user={null} /> }, ...users.map(userOption)]}
      selected={shared(issues, (i) => i[field]?.username)}
      onOpen={loadDirectory}
      onPick={(v) => {
        const user = users.find((u) => u.username === v) ?? null;
        apply({ [field]: user?.username ?? null }, (i) => ({ ...i, [field]: user }));
      }}
    >
      <Avatar user={null} />
      <span className="bulkbar-text">{text}</span>
    </Picker>
  );
  return (
    <div className="bulkbar" role="toolbar" aria-label="Bulk actions">
      <button type="button" className="bulkbar-count" onClick={clear} title="Clear selection (Esc)" aria-label={`${issues.length} selected; clear selection`}>
        {issues.length}
        <span className="bulkbar-text"> selected</span>
        <CloseIcon />
      </button>
      <Picker
        label="Set status"
        cmd="status"
        className="bulkbar-btn"
        options={statusOptions(statuses)}
        selected={shared(issues, (i) => i.status)}
        onPick={(v) => apply({ status: v }, (i) => ({ ...i, status: v }))}
      >
        <StatusIcon status={{ category: "unstarted", color: "#8f8f8f" }} />
        <span className="bulkbar-text">Status</span>
      </Picker>
      <Picker
        label="Set priority"
        cmd="priority"
        className="bulkbar-btn"
        options={PRIORITY_OPTIONS}
        selected={shared(issues, (i) => i.priority)}
        onPick={(v) => apply({ priority: Number(v) as Priority }, (i) => ({ ...i, priority: Number(v) as Priority }))}
      >
        <PriorityIcon priority={3} />
        <span className="bulkbar-text">Priority</span>
      </Picker>
      {userPicker("assignee", "Assign to", "No assignee", people, "Assignee")}
      {userPicker("delegate", "Delegate to", "No delegate", agents, "Delegate")}
      <Picker
        label="Labels"
        cmd="labels"
        className="bulkbar-btn"
        multi
        create="Create label"
        options={allLabels.map((l) => ({ value: l, label: l, icon: <LabelDot color={labelColor(labels, l)} /> }))}
        selected={common}
        onOpen={loadDirectory}
        // Toggles one label on all of them: removes it if every one has it, else adds it where it's missing.
        onPick={(l) =>
          common.includes(l)
            ? apply({ removeLabels: [l] }, (i) => ({ ...i, labels: i.labels.filter((x) => x !== l) }))
            : apply({ addLabels: [l] }, (i) => ({ ...i, labels: i.labels.includes(l) ? i.labels : add(i, l) }))
        }
      >
        <TagIcon />
        <span className="bulkbar-text">Labels</span>
      </Picker>
      <button type="button" className="bulkbar-btn bulkbar-danger" data-cmd="delete" onClick={remove} title="Delete" aria-label="Delete selected issues">
        <TrashIcon />
        <span className="bulkbar-text">Delete</span>
      </button>
    </div>
  );
}

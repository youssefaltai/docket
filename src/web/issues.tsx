// Issues view: header with search + filters, and the list / board layouts.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { STATUS_CATEGORIES, type DueFilter, type IssueSummary } from "../shared/types";
import { api, store } from "./api";
import { getYou } from "./auth";
import { SelectBox, shiftClick, useBulk, type Selection } from "./bulk";
import { AssigneePicker, Picker, PriorityPicker, StatusPicker, useMembers, userOption } from "./pickers";
import {
  Avatar,
  BlockedIcon,
  BoardIcon,
  CalendarIcon,
  ChevronDownIcon,
  DueChip,
  EmptyState,
  IssuesIcon,
  Kbd,
  LabelChip,
  LabelDot,
  Link,
  LoadFailed,
  ListHeader,
  ListIcon,
  PlusIcon,
  TeamNotFound,
  SearchIcon,
  StatusIcon,
  isClosedCategory,
  statusGroups,
  type StatusLook,
  TagIcon,
  cls,
  errorToast,
  fullDate,
  nav,
  toPatch,
  trashToast,
  type IssueChange,
  sortIssues,
  timeAgo,
  useApp,
  useDebounced,
  useFetch,
  useIssueShortcuts,
  useResolved,
} from "./ui";

type View = "list" | "board";
type Patch = (id: string, change: IssueChange) => void;

/** What lists and boards show: every category but triage (its issues wait on the Triage tab). */
export const LISTED = STATUS_CATEGORIES.filter((c) => c !== "triage");

/**
 * `I` (claim) and `⌘⌫`/`Ctrl⌫` (delete to trash) on a focused row/card: the same API calls the issue page's
 * own buttons make, applied to this list's state like any other row edit (see `useIssueShortcuts` for
 * `S`/`P`/`A`, which click the row's own picker triggers instead). Shared by `IssuesView` and `MyIssuesView`.
 */
export function useListShortcuts(
  setIssues: (fn: (list: IssueSummary[] | null) => IssueSummary[] | null) => void,
  invalidate: () => number,
  reload: () => void,
) {
  const claim = (id: string) => {
    invalidate();
    api.claimIssue(id).then((fresh) => setIssues((list) => list?.map((i) => (i.id === id ? fresh : i)) ?? null), errorToast);
  };
  const del = (id: string) => {
    const at = [...document.querySelectorAll<HTMLElement>("[data-nav]")].findIndex((el) => el.closest<HTMLElement>("[data-issue-id]")?.dataset.issueId === id);
    invalidate();
    api.deleteIssue(id).then(() => {
      setIssues((list) => list?.filter((i) => i.id !== id) ?? null);
      trashToast(id, () => api.restoreIssue(id).then(reload, errorToast), `/issue/${id}`);
      requestAnimationFrame(() => {
        const items = document.querySelectorAll<HTMLElement>("[data-nav]");
        items[Math.min(at, items.length - 1)]?.focus();
      });
    }, errorToast);
  };
  useIssueShortcuts(() => {
    // data-issue-id is on the row/card itself, so this still resolves once a trigger inside it (a sibling of
    // the title link) has focus — e.g. right after S/P/A closes and refocuses its own button.
    const root = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-issue-id]");
    const id = root?.dataset.issueId;
    return root && id ? { root, id } : null;
  }, { claim, delete: del });
}

export function IssuesView({ teamKey }: { teamKey: string | null }) {
  const app = useApp();
  const team = teamKey ? app.teams?.find((t) => t.key === teamKey) : undefined;
  const [view, setView] = useState<View>(() => (store.get("view") === "board" ? "board" : "list"));
  const [search, setSearch] = useState("");
  const [label, setLabel] = useState("");
  const [assignee, setAssignee] = useState("");
  const [delegate, setDelegate] = useState("");
  const [due, setDue] = useState<DueFilter | "">("");
  const q = useDebounced(search.trim(), 150);
  const filtered = !!(q || label || assignee || delegate || due);

  useEffect(() => {
    nav.lastList = location.pathname;
    document.title = `${team?.name ?? (teamKey || "All issues")} · Docket`;
  }, [teamKey, team?.name]);

  const {
    data: issues,
    setData: setIssues,
    failed,
    reload,
    invalidate,
  } = useFetch(
    () => api.issues({ team: teamKey ?? undefined, category: LISTED, q, label, assignee, delegate, due: due || undefined }),
    [teamKey, q, label, assignee, delegate, due],
  );

  useListShortcuts(setIssues, invalidate, reload);
  const { selection, bar } = useBulk(issues, { setIssues, invalidate, reload }, [teamKey, q, label, assignee, delegate, due]);

  const patch: Patch = (id, p) => {
    invalidate(); // drop any in-flight fetch that predates this change
    const now = new Date().toISOString();
    setIssues((list) => list?.map((i) => (i.id === id ? { ...i, ...p, updatedAt: now } : i)) ?? null);
    api.updateIssue(id, toPatch(p)).catch((e) => {
      errorToast(e);
      reload();
    });
  };

  const changeView = (v: View) => {
    setView(v);
    store.set("view", v);
  };
  const clearFilters = () => {
    setSearch("");
    setLabel("");
    setAssignee("");
    setDelegate("");
    setDue("");
  };

  let body;
  if (!teamKey && app.teams?.length === 0) {
    body = (
      <EmptyState
        icon={<IssuesIcon />}
        title="Welcome to Docket"
        action={
          <button className="btn btn-primary" onClick={app.newTeam}>
            Create team
          </button>
        }
      >
        Teams group issues under a short key, like DOC-12. Create one to get started.
      </EmptyState>
    );
  } else if (teamKey && app.teams && !team) {
    body = <TeamNotFound teamKey={teamKey} back="/" backLabel="All issues" />;
  } else if (!issues) {
    body = failed ? <LoadFailed message={failed} retry={reload} /> : null;
  } else if (issues.length === 0) {
    body = filtered ? (
      <EmptyState
        icon={<SearchIcon />}
        title="No matching issues"
        action={
          <button className="btn" onClick={clearFilters}>
            Clear filters
          </button>
        }
      >
        Try a different search or filter.
      </EmptyState>
    ) : (
      <EmptyState
        icon={<IssuesIcon />}
        title="No issues yet"
        action={
          <button className="btn btn-primary" onClick={() => app.newIssue()}>
            New issue <Kbd>C</Kbd>
          </button>
        }
      >
        Issues you create{team ? ` in ${team.name}` : ""} will show up here.
      </EmptyState>
    );
  } else if (view === "board") {
    body = <Board issues={issues} team={teamKey} onPatch={patch} selection={selection} />;
  } else {
    body = <IssueList issues={issues} team={teamKey} onPatch={patch} selection={selection} />;
  }

  return (
    <>
      <ListHeader
        team={team}
        title={teamKey ?? "All issues"}
        count={issues?.length ?? 0}
        view="issues"
        onNew={() => app.newIssue()}
        search={search}
        onSearch={setSearch}
      >
        <Filters
          label={label}
          setLabel={setLabel}
          assignee={assignee}
          setAssignee={setAssignee}
          delegate={delegate}
          setDelegate={setDelegate}
          due={due}
          setDue={setDue}
        />
        {filtered && (
          <button className="btn btn-ghost btn-sm" onClick={clearFilters}>
            Clear
          </button>
        )}
        <div className="segmented" role="group" aria-label="Layout">
          <button className={cls(view === "list" && "on")} onClick={() => changeView("list")} aria-pressed={view === "list"} title="List">
            <ListIcon />
          </button>
          <button className={cls(view === "board" && "on")} onClick={() => changeView("board")} aria-pressed={view === "board"} title="Board">
            <BoardIcon />
          </button>
        </div>
      </ListHeader>
      <div className={cls("content", view === "board" && !!issues?.length && "content-board")}>{body}</div>
      {bar}
    </>
  );
}

/** `assignee` and `delegate` are usernames. */
function Filters(props: {
  label: string;
  setLabel: (v: string) => void;
  assignee: string;
  setAssignee: (v: string) => void;
  delegate: string;
  setDelegate: (v: string) => void;
  due: DueFilter | "";
  setDue: (v: DueFilter | "") => void;
}) {
  const { labels, loadDirectory } = useApp();
  const people = useMembers("person");
  const agents = useMembers("agent");
  const me = getYou();
  const any = (label: string, icon: ReactNode) => ({ value: "", label, icon });
  const mine = props.assignee === me.username;
  const selected = people.find((u) => u.username === props.assignee) ?? null;
  const selectedDelegate = agents.find((u) => u.username === props.delegate) ?? null;
  return (
    <>
      <button className={cls("chip", mine && "chip-on")} aria-pressed={mine} onClick={() => props.setAssignee(mine ? "" : me.username)}>
        <Avatar user={me} />
        <span className="chip-text">Mine</span>
      </button>
      <Picker
        label="Filter by label"
        options={[any("Any label", <TagIcon />), ...labels.map((l) => ({ value: l, label: l, icon: <LabelDot name={l} /> }))]}
        selected={[props.label]}
        onPick={props.setLabel}
        onOpen={loadDirectory}
        className={cls("chip", props.label && "chip-on")}
      >
        {props.label ? <LabelDot name={props.label} /> : <TagIcon />}
        <span className="chip-text" dir="auto">
          {props.label || "Label"}
        </span>
        <ChevronDownIcon className="chip-caret" />
      </Picker>
      <Picker
        label="Filter by assignee"
        options={[any("Anyone", <Avatar user={null} />), ...people.map(userOption)]}
        selected={[props.assignee]}
        onPick={props.setAssignee}
        onOpen={loadDirectory}
        className={cls("chip", props.assignee && "chip-on")}
      >
        <Avatar user={selected} />
        <span className="chip-text" dir="auto">
          {selected?.name ?? (props.assignee || "Assignee")}
        </span>
        <ChevronDownIcon className="chip-caret" />
      </Picker>
      <Picker
        label="Filter by delegate"
        options={[any("Anyone", <Avatar user={null} />), ...agents.map(userOption)]}
        selected={[props.delegate]}
        onPick={props.setDelegate}
        onOpen={loadDirectory}
        className={cls("chip", props.delegate && "chip-on")}
      >
        <Avatar user={selectedDelegate} />
        <span className="chip-text" dir="auto">
          {selectedDelegate?.name ?? (props.delegate || "Delegate")}
        </span>
        <ChevronDownIcon className="chip-caret" />
      </Picker>
      <Picker
        label="Filter by due date"
        options={DUE_OPTIONS.map(([value, label]) => ({ value, label, icon: <CalendarIcon /> }))}
        selected={[props.due]}
        onPick={(v) => props.setDue(v as DueFilter | "")}
        className={cls("chip", props.due && "chip-on")}
      >
        <CalendarIcon />
        <span className="chip-text">{props.due ? DUE_OPTIONS.find(([v]) => v === props.due)![1] : "Due date"}</span>
        <ChevronDownIcon className="chip-caret" />
      </Picker>
    </>
  );
}

// Linear's due-date filters; the server applies them by its own date (UTC).
const DUE_OPTIONS: [DueFilter | "", string][] = [
  ["", "Any due date"],
  ["overdue", "Overdue"],
  ["soon", "Due soon"],
  ["today", "Due today"],
  ["any", "Has due date"],
  ["none", "No due date"],
];

// ---------- List ----------

/**
 * The status groups of a list or board: the team's statuses, or every team's in the workspace (a key names its first
 * team's status), triage left out; the board leaves out canceled ones too.
 */
function useGroups(team: string | null | undefined, issues: IssueSummary[], board = false) {
  const { teams } = useApp();
  const scope = (teams ?? []).filter((t) => !team || t.key === team);
  const groups = statusGroups(scope, issues).filter((s) => s.category !== "triage" && !(board && s.category === "canceled"));
  return { groups, sorted: useMemo(() => sortIssues(issues, teams), [issues, teams]) };
}

export function IssueList({ issues, team, onPatch, selection }: { issues: IssueSummary[]; team?: string | null; onPatch: Patch; selection: Selection }) {
  // Completed and canceled groups start collapsed; `toggled` holds the groups flipped from that.
  const [toggled, setToggled] = useState(() => new Set<string>());
  const { groups, sorted } = useGroups(team, issues);
  const toggle = (key: string) =>
    setToggled((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className={cls("list", selection.any && "selecting")}>
      {groups.map((status) => {
        const items = sorted.filter((i) => i.status === status.key);
        if (!items.length) return null;
        const open = isClosedCategory(status.category) === toggled.has(status.key);
        return (
          <section key={status.key}>
            <div className="group">
              <button className="group-toggle" onClick={() => toggle(status.key)} aria-expanded={open}>
                <ChevronDownIcon className={cls("caret", !open && "caret-closed")} />
                <StatusIconLabel status={status} />
                <span className="count">{items.length}</span>
              </button>
              <NewInStatus status={status} />
            </div>
            {open && items.map((i) => <IssueRow key={i.id} issue={i} onPatch={onPatch} selection={selection} />)}
          </section>
        );
      })}
    </div>
  );
}

function NewInStatus({ status }: { status: StatusLook }) {
  const { newIssue } = useApp();
  return (
    <button
      className="icon-btn sm"
      onClick={() => newIssue({ status: status.key })}
      aria-label={`New ${status.name} issue`}
      title="New issue"
    >
      <PlusIcon />
    </button>
  );
}

/** Shown while any blocker is still open. */
function Blocked({ by }: { by: string[] }) {
  const resolved = useResolved();
  const open = by.filter((id) => !resolved(id));
  if (!open.length) return null;
  return (
    <span className="blocked" title={`Blocked by ${open.join(", ")}`}>
      <BlockedIcon />
    </span>
  );
}

function StatusIconLabel({ status }: { status: StatusLook }) {
  return (
    <>
      <StatusIcon status={status} />
      <span className="group-label" dir="auto">
        {status.name}
      </span>
    </>
  );
}

function IssueRow({ issue, onPatch, selection }: { issue: IssueSummary; onPatch: Patch; selection: Selection }) {
  const set = (p: IssueChange) => onPatch(issue.id, p);
  return (
    // data-issue-id on the row itself (not just the title link) so it still resolves once a picker's trigger
    // (a sibling) has focus, e.g. right after S/P/A closes and refocuses its own button.
    <div className={cls("row", selection.has(issue.id) && "selected")} data-issue-id={issue.id} onClickCapture={shiftClick(issue.id, selection)}>
      <SelectBox id={issue.id} selection={selection} />
      <PriorityPicker value={issue.priority} onChange={(priority) => set({ priority })} className="row-btn" cmd="priority" />
      <span className="row-id">{issue.id}</span>
      <StatusPicker team={issue.team} value={issue.status} onChange={(status) => set({ status })} className="row-btn" cmd="status" />
      <Link to={`/issue/${issue.id}`} className="row-title" data-nav dir="auto">
        {issue.title}
      </Link>
      <Blocked by={issue.blockedBy} />
      <span className="grow" />
      <DueChip issue={issue} />
      <Labels labels={issue.labels} max={3} />
      <AssigneePicker value={issue.assignee} onChange={(assignee) => set({ assignee })} className="row-btn" align="end" cmd="assignee" />
      <time className="row-time" dateTime={issue.updatedAt} title={`Updated ${fullDate(issue.updatedAt)}`}>
        {timeAgo(issue.updatedAt)}
      </time>
    </div>
  );
}

function Labels({ labels, max }: { labels: string[]; max: number }) {
  if (!labels.length) return null;
  const extra = labels.length - max;
  return (
    <span className="labels">
      {labels.slice(0, max).map((l) => (
        <LabelChip key={l} name={l} />
      ))}
      {extra > 0 && (
        <span className="label" title={labels.slice(max).join(", ")}>
          +{extra}
        </span>
      )}
    </span>
  );
}

// ---------- Board ----------

/** Columns by status, canceled ones left out. Dropping on a column the issue's team lacks answers 400: it toasts and reloads. */
export function Board({ issues, team, onPatch, selection }: { issues: IssueSummary[]; team?: string | null; onPatch: Patch; selection: Selection }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const { groups, sorted } = useGroups(team, issues, true);

  const drop = (status: string) => {
    const issue = issues.find((i) => i.id === dragging);
    if (issue && issue.status !== status) onPatch(issue.id, { status });
    setDragging(null);
    setOver(null);
  };

  return (
    <div className={cls("board", selection.any && "selecting")}>
      {groups.map((status) => {
        const items = sorted.filter((i) => i.status === status.key);
        return (
          <section
            key={status.key}
            className={cls("column", over === status.key && "column-over")}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOver(status.key);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(status.key);
            }}
          >
            <div className="column-head">
              <StatusIconLabel status={status} />
              <span className="count">{items.length}</span>
              <span className="grow" />
              <NewInStatus status={status} />
            </div>
            <div className="column-body">
              {items.map((i) => (
                <Card
                  key={i.id}
                  issue={i}
                  onPatch={onPatch}
                  selection={selection}
                  dragging={dragging === i.id}
                  onDragStart={() => setDragging(i.id)}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Card({
  issue,
  onPatch,
  selection,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  issue: IssueSummary;
  onPatch: Patch;
  selection: Selection;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const set = (p: IssueChange) => onPatch(issue.id, p);
  return (
    <div
      className={cls("card", dragging && "card-dragging", selection.has(issue.id) && "selected")}
      data-issue-id={issue.id}
      onClickCapture={shiftClick(issue.id, selection)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", issue.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <div className="card-head">
        <StatusPicker team={issue.team} value={issue.status} onChange={(status) => set({ status })} className="row-btn" cmd="status" />
        <span className="row-id">{issue.id}</span>
        <span className="grow" />
        <SelectBox id={issue.id} selection={selection} />
        <AssigneePicker value={issue.assignee} onChange={(assignee) => set({ assignee })} className="row-btn" align="end" cmd="assignee" />
      </div>
      <Link to={`/issue/${issue.id}`} className="card-title" data-nav dir="auto" draggable={false}>
        {issue.title}
      </Link>
      <div className="card-meta">
        <PriorityPicker value={issue.priority} onChange={(priority) => set({ priority })} className="row-btn chip-icon" cmd="priority" />
        <Blocked by={issue.blockedBy} />
        <DueChip issue={issue} />
        <Labels labels={issue.labels} max={2} />
      </div>
    </div>
  );
}

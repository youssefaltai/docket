// Issues view: header with search + filters, and the list / board layouts.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  cycleLastDay,
  PRIORITY_LABELS,
  STATUS_CATEGORIES,
  type Cycle,
  type DueFilter,
  type GroupBy,
  type IssueInput,
  type IssueSummary,
  type Layout,
  type OrderBy,
  type Priority,
  type ProjectSummary,
} from "../shared/types";
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
  CycleIcon,
  DueChip,
  EmptyState,
  EstimateChip,
  GroupCount,
  IssuesIcon,
  Kbd,
  LabelChip,
  LabelDot,
  labelColor,
  Link,
  LoadFailed,
  ListHeader,
  ListIcon,
  PlusIcon,
  PriorityIcon,
  Progress,
  ProjectIcon,
  Section,
  TeamMark,
  TeamNotFound,
  SearchIcon,
  StatusIcon,
  isClosedCategory,
  statusGroups,
  TagIcon,
  ViewsIcon,
  cls,
  dayLabel,
  errorToast,
  estimateOf,
  fullDate,
  nav,
  toPatch,
  trashToast,
  type IssueChange,
  orderIssues,
  timeAgo,
  useApp,
  useDebounced,
  useFetch,
  useIssueShortcuts,
  useResolved,
} from "./ui";

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

/** A team's issues, or all of them; with `cycle`, one of the team's cycles (its page, /t/:key/cycles/:n). */
export function IssuesView({ teamKey, cycle }: { teamKey: string | null; cycle?: number }) {
  const app = useApp();
  const team = teamKey ? app.teams?.find((t) => t.key === teamKey) : undefined;
  const [view, setView] = useState<Layout>(() => (store.get("view") === "board" ? "board" : "list"));
  const [search, setSearch] = useState("");
  const [label, setLabel] = useState("");
  const [assignee, setAssignee] = useState("");
  const [delegate, setDelegate] = useState("");
  const [due, setDue] = useState<DueFilter | "">("");
  const q = useDebounced(search.trim(), 150);
  const filtered = !!(q || label || assignee || delegate || due);

  useEffect(() => {
    nav.lastList = location.pathname;
    document.title = `${cycle ? `Cycle ${cycle} · ` : ""}${team?.name ?? (teamKey || "All issues")} · Docket`;
  }, [teamKey, team?.name, cycle]);

  const {
    data: issues,
    setData: setIssues,
    failed,
    reload,
    invalidate,
  } = useFetch(
    () => api.issues({ team: teamKey ?? undefined, cycle: cycle?.toString(), category: LISTED, q, label, assignee, delegate, due: due || undefined }),
    [teamKey, cycle, q, label, assignee, delegate, due],
  );
  const cycles = useFetch(cycle && teamKey ? () => api.cycles(teamKey) : null, [teamKey, cycle]).data;
  const shown = cycles?.find((c) => c.number === cycle);

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

  const changeView = (v: Layout) => {
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
  } else if (cycles && !shown) {
    body = (
      <EmptyState title="Cycle not found" action={<Link className="btn" to={`/t/${teamKey}/cycles`}>All cycles</Link>}>
        There’s no cycle {cycle} in {teamKey}.
      </EmptyState>
    );
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
        Issues you create{cycle ? ` in Cycle ${cycle}` : team ? ` in ${team.name}` : ""} will show up here.
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
        view={cycle ? "cycles" : "issues"}
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
        <LayoutToggle layout={view} onChange={changeView} />
        {app.workspace?.role !== "guest" && (
          <button
            className="icon-btn"
            onClick={() =>
              app.newView({ filter: { team: teamKey ?? undefined, cycle: cycle?.toString(), q, label, assignee, delegate, due: due || undefined }, display: { layout: view } })
            }
            aria-label="Save as view"
            title="Save as view"
          >
            <ViewsIcon />
          </button>
        )}
      </ListHeader>
      {shown && <CycleCard cycle={shown} className="cycle-bar" />}
      <div className={cls("content", view === "board" && !!issues?.length && "content-board")}>{body}</div>
      {bar}
    </>
  );
}

const cycleDates = (c: Cycle) => `${dayLabel(c.startsAt.slice(0, 10))} – ${dayLabel(cycleLastDay(c.endsAt))}`;
const done = (c: Cycle) => `${c.completedCount} of ${c.issueCount} done`;

/** A cycle at a glance: "Cycle 12 · Mar 3 – Mar 17 · 5 days left", its progress and "5 of 12 done". */
function CycleCard({ cycle: c, link, className }: { cycle: Cycle; link?: boolean; className?: string }) {
  const days = Math.max(0, Math.ceil((Date.parse(c.endsAt) - Date.now()) / 86_400_000));
  const title = `Cycle ${c.number}`;
  return (
    <div className={cls("cycle-card", className)}>
      <CycleIcon />
      {link ? (
        <Link to={`/t/${c.team}/cycles/${c.number}`} className="cycle-title" data-nav>
          {title}
        </Link>
      ) : (
        <span className="cycle-title">{title}</span>
      )}
      <span className="muted">
        {cycleDates(c)}
        {c.state === "current" && ` · ${days === 1 ? "1 day" : `${days} days`} left`}
        {c.state === "completed" && " · completed"}
      </span>
      <span className="grow" />
      <Progress value={c.progress} />
      <span className="muted cycle-done">{done(c)}</span>
    </div>
  );
}

/** A team's cycles: the current one as a card, then upcoming ones, then completed ones (newest first), each opening its page. */
export function CyclesView({ teamKey }: { teamKey: string }) {
  const app = useApp();
  const team = app.teams?.find((t) => t.key === teamKey);
  useEffect(() => {
    nav.lastList = location.pathname;
    document.title = `${team?.name ?? teamKey} cycles · Docket`;
  }, [teamKey, team?.name]);
  const { data: cycles, failed, reload } = useFetch(() => api.cycles(teamKey), [teamKey]);
  const current = cycles?.find((c) => c.state === "current");
  const upcoming = cycles?.filter((c) => c.state === "upcoming") ?? [];
  const completed = cycles?.filter((c) => c.state === "completed").reverse() ?? [];
  const rows = (list: Cycle[]) => (
    <div className="subs">
      {list.map((c) => (
        <div className="row sub cycle-row" key={c.number}>
          <CycleIcon />
          <Link to={`/t/${teamKey}/cycles/${c.number}`} className="row-title" data-nav>
            Cycle {c.number}
          </Link>
          <span className="row-meta cycle-dates">{cycleDates(c)}</span>
          <span className="grow" />
          <span className="count" title={done(c)}>
            {c.completedCount}/{c.issueCount}
          </span>
          <Progress value={c.progress} />
        </div>
      ))}
    </div>
  );

  let body;
  if (app.teams && !team) body = <TeamNotFound teamKey={teamKey} back="/" backLabel="All issues" />;
  else if (!cycles) body = failed ? <LoadFailed message={failed} retry={reload} /> : null;
  else if (!team?.cycleWeeks && !cycles.length) {
    body = (
      <EmptyState icon={<CycleIcon />} title="Cycles are off" action={<Link className="btn" to={`/t/${teamKey}/settings`}>Team settings</Link>}>
        Turn them on in team settings to plan work in repeating periods.
      </EmptyState>
    );
  } else {
    body = (
      <div className="cycles">
        {current ? (
          <CycleCard cycle={current} link />
        ) : (
          upcoming[0] && <p className="section-empty">Cycle {upcoming[0].number} starts {dayLabel(upcoming[0].startsAt.slice(0, 10))}.</p>
        )}
        {upcoming.length > 0 && <Section title="Upcoming">{rows(upcoming)}</Section>}
        {completed.length > 0 && <Section title="Completed">{rows(completed)}</Section>}
      </div>
    );
  }
  return (
    <>
      <ListHeader team={team} title={teamKey} count={0} view="cycles" />
      <div className="content">{body}</div>
    </>
  );
}

/** List or Board. */
export function LayoutToggle({ layout, onChange, disabled }: { layout: Layout; onChange: (layout: Layout) => void; disabled?: boolean }) {
  return (
    <div className="segmented" role="group" aria-label="Layout">
      {(["list", "board"] as const).map((l) => (
        <button key={l} className={cls(layout === l && "on")} onClick={() => onChange(l)} aria-pressed={layout === l} disabled={disabled} title={l === "list" ? "List" : "Board"}>
          {l === "list" ? <ListIcon /> : <BoardIcon />}
        </button>
      ))}
    </div>
  );
}

/**
 * `assignee` and `delegate` are usernames, or "me": the viewer, what the Mine chip sets, so a saved view means whoever
 * opens it. With `setTeam`, a team filter too (a view's). `disabled`: shown, not changeable.
 */
export function Filters(props: {
  team?: string;
  setTeam?: (v: string) => void;
  project?: string;
  setProject?: (v: string) => void;
  disabled?: boolean;
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
  const { teams } = useApp();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const loadProjects = () => void api.projects().then(setProjects, errorToast);
  useEffect(() => void (props.project && loadProjects()), []); // to name the one chosen
  const any = (label: string, icon: ReactNode) => ({ value: "", label, icon });
  const assignee = props.assignee === "me" ? me.username : props.assignee;
  const delegate = props.delegate === "me" ? me.username : props.delegate;
  const mine = assignee === me.username;
  const selected = people.find((u) => u.username === assignee) ?? null;
  const selectedDelegate = agents.find((u) => u.username === delegate) ?? null;
  const disabled = props.disabled;
  return (
    <>
      <button className={cls("chip", mine && "chip-on")} aria-pressed={mine} disabled={disabled} onClick={() => props.setAssignee(mine ? "" : "me")}>
        <Avatar user={me} />
        <span className="chip-text">Mine</span>
      </button>
      {props.setTeam && (
        <Picker
          label="Filter by team"
          options={[any("Any team", <IssuesIcon />), ...(teams ?? []).map((t) => ({ value: t.key, label: t.name, icon: <TeamMark id={t.key} /> }))]}
          selected={[props.team ?? ""]}
          onPick={props.setTeam}
          disabled={disabled}
          className={cls("chip", props.team && "chip-on")}
        >
          {props.team ? <TeamMark id={props.team} /> : <IssuesIcon />}
          <span className="chip-text" dir="auto">
            {teams?.find((t) => t.key === props.team)?.name ?? (props.team || "Team")}
          </span>
          <ChevronDownIcon className="chip-caret" />
        </Picker>
      )}
      {props.setProject && (
        <Picker
          label="Filter by project"
          options={[any("Any project", <ProjectIcon />), ...projects.map((p) => ({ value: p.slug, label: p.name, icon: <ProjectIcon /> }))]}
          selected={[props.project ?? ""]}
          onPick={props.setProject}
          onOpen={loadProjects}
          disabled={disabled}
          className={cls("chip", props.project && "chip-on")}
        >
          <ProjectIcon />
          <span className="chip-text" dir="auto">
            {projects.find((p) => p.slug === props.project)?.name ?? (props.project || "Project")}
          </span>
          <ChevronDownIcon className="chip-caret" />
        </Picker>
      )}
      <Picker
        label="Filter by label"
        disabled={disabled}
        // Groups too: a group matches any of its labels.
        options={[any("Any label", <TagIcon />), ...labels.map((l) => ({ value: l.path, label: l.path, icon: <LabelDot color={l.color} /> }))]}
        selected={[props.label]}
        onPick={props.setLabel}
        onOpen={loadDirectory}
        className={cls("chip", props.label && "chip-on")}
      >
        {props.label ? <LabelDot color={labelColor(labels, props.label)} /> : <TagIcon />}
        <span className="chip-text" dir="auto">
          {props.label || "Label"}
        </span>
        <ChevronDownIcon className="chip-caret" />
      </Picker>
      <Picker
        label="Filter by assignee"
        disabled={disabled}
        options={[any("Anyone", <Avatar user={null} />), ...people.map(userOption)]}
        selected={[assignee]}
        onPick={props.setAssignee}
        onOpen={loadDirectory}
        className={cls("chip", props.assignee && "chip-on")}
      >
        <Avatar user={selected} />
        <span className="chip-text" dir="auto">
          {selected?.name ?? (assignee || "Assignee")}
        </span>
        <ChevronDownIcon className="chip-caret" />
      </Picker>
      <Picker
        label="Filter by delegate"
        disabled={disabled}
        options={[any("Anyone", <Avatar user={null} />), ...agents.map(userOption)]}
        selected={[delegate]}
        onPick={props.setDelegate}
        onOpen={loadDirectory}
        className={cls("chip", props.delegate && "chip-on")}
      >
        <Avatar user={selectedDelegate} />
        <span className="chip-text" dir="auto">
          {selectedDelegate?.name ?? (delegate || "Delegate")}
        </span>
        <ChevronDownIcon className="chip-caret" />
      </Picker>
      <Picker
        label="Filter by due date"
        disabled={disabled}
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

/** How a list or board is grouped and ordered: by status and priority unless a saved view says otherwise. */
export type Display = { groupBy?: GroupBy; orderBy?: OrderBy };

/** One group of a list or board: its issues in order, its head, and what a new issue or a dropped card gets there. */
interface Group {
  key: string;
  name: string;
  icon: ReactNode;
  items: IssueSummary[];
  collapsed: boolean; // starts collapsed in a list: completed and canceled statuses
  defaults: Partial<IssueInput>; // a new issue from the group's +
  drop?: IssueChange; // a card dropped in the column; none for labels (an issue can carry several)
}

const PRIORITY_GROUPS: Priority[] = [1, 2, 3, 4, 0];
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/**
 * The groups of a list or board. By status: the team's statuses, or every team's in the workspace (a key names its first
 * team's status), triage left out, and on a board canceled ones too. By priority: Urgent to Low, then none. By assignee
 * or label: those the issues have, then "No assignee" / "No labels" if any lack one; an issue with two labels is in both.
 */
function useGroups(team: string | null | undefined, issues: IssueSummary[], { groupBy = "status", orderBy = "priority" }: Display, board = false) {
  const { teams, labels } = useApp();
  const sorted = useMemo(() => orderIssues(issues, orderBy), [issues, orderBy]);
  const sum = issues.some((i) => estimateOf(teams, i)); // counts show estimate totals once anything in view has one
  const group = (g: Omit<Group, "items" | "collapsed">, has: (i: IssueSummary) => boolean, collapsed = false): Group => ({
    ...g,
    collapsed,
    items: sorted.filter(has),
  });
  let groups: Group[];
  if (groupBy === "status") {
    const scope = (teams ?? []).filter((t) => !team || t.key === team);
    groups = statusGroups(scope, issues)
      .filter((s) => s.category !== "triage" && !(board && s.category === "canceled"))
      .map((s) =>
        group({ key: s.key, name: s.name, icon: <StatusIcon status={s} />, defaults: { status: s.key }, drop: { status: s.key } }, (i) => i.status === s.key, isClosedCategory(s.category)),
      );
  } else if (groupBy === "priority") {
    groups = PRIORITY_GROUPS.map((p) =>
      group({ key: String(p), name: PRIORITY_LABELS[p], icon: <PriorityIcon priority={p} />, defaults: { priority: p }, drop: { priority: p } }, (i) => i.priority === p),
    );
  } else if (groupBy === "assignee") {
    const people = [...new Map(issues.flatMap((i) => (i.assignee ? [[i.assignee.username, i.assignee] as const] : []))).values()].sort((a, b) => byName(a.name, b.name));
    groups = [
      ...people.map((u) =>
        group({ key: u.username, name: u.name, icon: <Avatar user={u} />, defaults: { assignee: u.username }, drop: { assignee: u } }, (i) => i.assignee?.username === u.username),
      ),
      group({ key: "", name: "No assignee", icon: <Avatar user={null} />, defaults: {}, drop: { assignee: null } }, (i) => !i.assignee),
    ];
  } else {
    const paths = [...new Set(issues.flatMap((i) => i.labels))].sort(byName);
    groups = [
      ...paths.map((path) => group({ key: path, name: path, icon: <LabelDot color={labelColor(labels, path)} />, defaults: { labels: [path] } }, (i) => i.labels.includes(path))),
      group({ key: "", name: "No labels", icon: <TagIcon />, defaults: {} }, (i) => !i.labels.length),
    ];
  }
  // Every status and priority column stays on a board; the rest show only where issues are.
  if (!board || groupBy === "assignee" || groupBy === "label") groups = groups.filter((g) => g.items.length);
  return { groups, sum };
}

export function IssueList({
  issues,
  team,
  display = {},
  onPatch,
  selection,
}: {
  issues: IssueSummary[];
  team?: string | null;
  display?: Display;
  onPatch: Patch;
  selection: Selection;
}) {
  // Completed and canceled groups start collapsed; `toggled` holds the groups flipped from that.
  const [toggled, setToggled] = useState(() => new Set<string>());
  const { groups, sum } = useGroups(team, issues, display);
  const toggle = (key: string) =>
    setToggled((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className={cls("list", selection.any && "selecting")}>
      {groups.map((g) => {
        const open = g.collapsed === toggled.has(g.key);
        return (
          <section key={g.key}>
            <div className="group">
              <button className="group-toggle" onClick={() => toggle(g.key)} aria-expanded={open}>
                <ChevronDownIcon className={cls("caret", !open && "caret-closed")} />
                <GroupLabel group={g} />
                <GroupCount items={g.items} sum={sum} />
              </button>
              <NewInGroup group={g} />
            </div>
            {open && g.items.map((i) => <IssueRow key={i.id} issue={i} onPatch={onPatch} selection={selection} />)}
          </section>
        );
      })}
    </div>
  );
}

function NewInGroup({ group }: { group: Group }) {
  const { newIssue } = useApp();
  return (
    <button className="icon-btn sm" onClick={() => newIssue(group.defaults)} aria-label={`New ${group.name} issue`} title="New issue">
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

function GroupLabel({ group }: { group: Group }) {
  return (
    <>
      {group.icon}
      <span className="group-label" dir="auto">
        {group.name}
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
      <EstimateChip issue={issue} />
      <DueChip issue={issue} />
      <Labels labels={issue.labels} max={3} />
      <AssigneePicker team={issue.team} value={issue.assignee} onChange={(assignee) => set({ assignee })} className="row-btn" align="end" cmd="assignee" />
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
        <LabelChip key={l} path={l} />
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

/**
 * Columns by group (status by default, canceled ones left out). Dropping a card sets the column's status, priority or
 * assignee (label columns take no drops); a status its team lacks answers 400: it toasts and reloads.
 */
export function Board({
  issues,
  team,
  display = {},
  onPatch,
  selection,
}: {
  issues: IssueSummary[];
  team?: string | null;
  display?: Display;
  onPatch: Patch;
  selection: Selection;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const { groups, sum } = useGroups(team, issues, display, true);

  const drop = (group: Group) => {
    const issue = issues.find((i) => i.id === dragging);
    if (issue && group.drop && !group.items.includes(issue)) onPatch(issue.id, group.drop);
    setDragging(null);
    setOver(null);
  };

  return (
    <div className={cls("board", selection.any && "selecting")}>
      {groups.map((g) => {
        const items = g.items;
        return (
          <section
            key={g.key}
            className={cls("column", over === g.key && "column-over")}
            onDragOver={(e) => {
              if (!dragging || !g.drop) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOver(g.key);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(g);
            }}
          >
            <div className="column-head">
              <GroupLabel group={g} />
              <GroupCount items={items} sum={sum} />
              <span className="grow" />
              <NewInGroup group={g} />
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
        <AssigneePicker team={issue.team} value={issue.assignee} onChange={(assignee) => set({ assignee })} className="row-btn" align="end" cmd="assignee" />
      </div>
      <Link to={`/issue/${issue.id}`} className="card-title" data-nav dir="auto" draggable={false}>
        {issue.title}
      </Link>
      <div className="card-meta">
        <PriorityPicker value={issue.priority} onChange={(priority) => set({ priority })} className="row-btn chip-icon" cmd="priority" />
        <Blocked by={issue.blockedBy} />
        <EstimateChip issue={issue} />
        <DueChip issue={issue} />
        <Labels labels={issue.labels} max={2} />
      </div>
    </div>
  );
}

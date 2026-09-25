// Issues view: header with search + filters, and the list / board layouts.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CLOSED_STATUSES, STATUSES, STATUS_LABELS, type IssuePatch, type IssueSummary, type Status } from "../shared/types";
import { api, store } from "./api";
import { AssigneePicker, Picker, PriorityPicker, StatusPicker, personOption } from "./pickers";
import {
  Avatar,
  BlockedIcon,
  BoardIcon,
  ChevronDownIcon,
  EmptyState,
  IssuesIcon,
  Kbd,
  LabelChip,
  LabelDot,
  Link,
  ListHeader,
  ListIcon,
  PlusIcon,
  ProjectNotFound,
  SearchIcon,
  StatusIcon,
  TagIcon,
  cls,
  errorToast,
  fullDate,
  nav,
  sortIssues,
  timeAgo,
  useApp,
  useDebounced,
  useFetch,
} from "./ui";

type View = "list" | "board";
type Patch = (id: string, patch: IssuePatch) => void;

export function IssuesView({ projectKey }: { projectKey: string | null }) {
  const app = useApp();
  const project = projectKey ? app.projects?.find((p) => p.key === projectKey) : undefined;
  const [view, setView] = useState<View>(() => (store.get("view") === "board" ? "board" : "list"));
  const [search, setSearch] = useState("");
  const [label, setLabel] = useState("");
  const [assignee, setAssignee] = useState("");
  const q = useDebounced(search.trim(), 150);
  const filtered = !!(q || label || assignee);

  useEffect(() => {
    nav.lastList = location.pathname;
    document.title = `${project?.name ?? (projectKey || "All issues")} · Docket`;
  }, [projectKey, project?.name]);

  // "All issues" is the current workspace's; wait until it's known.
  const workspace = projectKey ? undefined : app.workspace?.key;
  const {
    data: issues,
    setData: setIssues,
    reload,
    invalidate,
  } = useFetch(
    projectKey || workspace ? () => api.issues({ project: projectKey ?? undefined, workspace, q, label, assignee }) : null,
    [projectKey, workspace, q, label, assignee],
  );

  const patch: Patch = (id, p) => {
    invalidate(); // drop any in-flight fetch that predates this change
    const now = new Date().toISOString();
    setIssues((list) => list?.map((i) => (i.id === id ? { ...i, ...p, updatedAt: now } : i)) ?? null);
    api.updateIssue(id, p).catch((e) => {
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
  };

  let body;
  if (!projectKey && app.workspaceProjects?.length === 0) {
    body = (
      <EmptyState
        icon={<IssuesIcon />}
        title="Welcome to Docket"
        action={
          <button className="btn btn-primary" onClick={app.newProject}>
            Create project
          </button>
        }
      >
        Projects group issues under a short key, like DOC-12. Create one to get started.
      </EmptyState>
    );
  } else if (projectKey && app.projects && !project) {
    body = <ProjectNotFound projectKey={projectKey} back="/" backLabel="All issues" />;
  } else if (!issues) {
    body = null;
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
        Issues you create{project ? ` in ${project.name}` : ""} will show up here.
      </EmptyState>
    );
  } else if (view === "board") {
    body = <Board issues={issues} onPatch={patch} />;
  } else {
    body = <IssueList issues={issues} onPatch={patch} />;
  }

  return (
    <>
      <ListHeader
        project={project}
        title={projectKey ?? "All issues"}
        count={issues?.length ?? 0}
        view="issues"
        onNew={() => app.newIssue()}
        search={search}
        onSearch={setSearch}
      >
        <Filters label={label} setLabel={setLabel} assignee={assignee} setAssignee={setAssignee} />
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
    </>
  );
}

function Filters(props: { label: string; setLabel: (v: string) => void; assignee: string; setAssignee: (v: string) => void }) {
  const { labels, people, name, loadDirectory } = useApp();
  const any = (label: string, icon: ReactNode) => ({ value: "", label, icon });
  const mine = props.assignee === name;
  return (
    <>
      <button className={cls("chip", mine && "chip-on")} aria-pressed={mine} onClick={() => props.setAssignee(mine ? "" : name)}>
        <Avatar name={name} />
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
        options={[any("Anyone", <Avatar name={null} />), ...people.map((p) => personOption(p, name))]}
        selected={[props.assignee]}
        onPick={props.setAssignee}
        onOpen={loadDirectory}
        className={cls("chip", props.assignee && "chip-on")}
      >
        <Avatar name={props.assignee || null} />
        <span className="chip-text" dir="auto">
          {props.assignee || "Assignee"}
        </span>
        <ChevronDownIcon className="chip-caret" />
      </Picker>
    </>
  );
}

// ---------- List ----------

function IssueList({ issues, onPatch }: { issues: IssueSummary[]; onPatch: Patch }) {
  const [collapsed, setCollapsed] = useState(() => new Set(CLOSED_STATUSES));
  const sorted = useMemo(() => sortIssues(issues), [issues]);
  const toggle = (s: Status) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (!next.delete(s)) next.add(s);
      return next;
    });

  return (
    <div className="list">
      {STATUSES.map((status) => {
        const items = sorted.filter((i) => i.status === status);
        if (!items.length) return null;
        const open = !collapsed.has(status);
        return (
          <section key={status}>
            <div className="group">
              <button className="group-toggle" onClick={() => toggle(status)} aria-expanded={open}>
                <ChevronDownIcon className={cls("caret", !open && "caret-closed")} />
                <StatusIconLabel status={status} />
                <span className="count">{items.length}</span>
              </button>
              <NewInStatus status={status} />
            </div>
            {open && items.map((i) => <IssueRow key={i.id} issue={i} onPatch={onPatch} />)}
          </section>
        );
      })}
    </div>
  );
}

function NewInStatus({ status }: { status: Status }) {
  const { newIssue } = useApp();
  return (
    <button
      className="icon-btn sm"
      onClick={() => newIssue({ status })}
      aria-label={`New ${STATUS_LABELS[status]} issue`}
      title="New issue"
    >
      <PlusIcon />
    </button>
  );
}

function Blocked({ by }: { by: string[] }) {
  if (!by.length) return null;
  return (
    <span className="blocked" title={`Blocked by ${by.join(", ")}`}>
      <BlockedIcon />
    </span>
  );
}

function StatusIconLabel({ status }: { status: Status }) {
  return (
    <>
      <StatusIcon status={status} />
      <span className="group-label">{STATUS_LABELS[status]}</span>
    </>
  );
}

function IssueRow({ issue, onPatch }: { issue: IssueSummary; onPatch: Patch }) {
  const set = (p: IssuePatch) => onPatch(issue.id, p);
  return (
    <div className="row">
      <PriorityPicker value={issue.priority} onChange={(priority) => set({ priority })} className="row-btn" />
      <span className="row-id">{issue.id}</span>
      <StatusPicker value={issue.status} onChange={(status) => set({ status })} className="row-btn" />
      <Link to={`/issue/${issue.id}`} className="row-title" data-nav dir="auto">
        {issue.title}
      </Link>
      <Blocked by={issue.blockedBy} />
      <span className="grow" />
      <Labels labels={issue.labels} max={3} />
      <AssigneePicker value={issue.assignee} onChange={(assignee) => set({ assignee })} className="row-btn" align="end" />
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

const BOARD_STATUSES = STATUSES.filter((s) => s !== "canceled");

function Board({ issues, onPatch }: { issues: IssueSummary[]; onPatch: Patch }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  const sorted = useMemo(() => sortIssues(issues), [issues]);

  const drop = (status: Status) => {
    const issue = issues.find((i) => i.id === dragging);
    if (issue && issue.status !== status) onPatch(issue.id, { status });
    setDragging(null);
    setOver(null);
  };

  return (
    <div className="board">
      {BOARD_STATUSES.map((status) => {
        const items = sorted.filter((i) => i.status === status);
        return (
          <section
            key={status}
            className={cls("column", over === status && "column-over")}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOver(status);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(status);
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
  dragging,
  onDragStart,
  onDragEnd,
}: {
  issue: IssueSummary;
  onPatch: Patch;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const set = (p: IssuePatch) => onPatch(issue.id, p);
  return (
    <div
      className={cls("card", dragging && "card-dragging")}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", issue.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <div className="card-head">
        <StatusPicker value={issue.status} onChange={(status) => set({ status })} className="row-btn" />
        <span className="row-id">{issue.id}</span>
        <span className="grow" />
        <AssigneePicker value={issue.assignee} onChange={(assignee) => set({ assignee })} className="row-btn" align="end" />
      </div>
      <Link to={`/issue/${issue.id}`} className="card-title" data-nav dir="auto" draggable={false}>
        {issue.title}
      </Link>
      <div className="card-meta">
        <PriorityPicker value={issue.priority} onChange={(priority) => set({ priority })} className="row-btn chip-icon" />
        <Blocked by={issue.blockedBy} />
        <Labels labels={issue.labels} max={2} />
      </div>
    </div>
  );
}

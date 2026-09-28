// Saved views (Linear's custom views): the workspace's list of them, and one view's issues, filtered, grouped, ordered
// and laid out as saved. Its creator or an admin changes it right here; everyone else uses it as it is.
import { useEffect, useState } from "react";
import { GROUP_BYS, ORDER_BYS, type CustomView, type CustomViewPatch, type GroupBy, type OrderBy, type ViewDisplay, type ViewFilter } from "../shared/types";
import { api } from "./api";
import { getYou } from "./auth";
import { useBulk } from "./bulk";
import { Board, Filters, IssueList, LayoutToggle, LISTED, useListShortcuts } from "./issues";
import { Picker } from "./pickers";
import {
  Avatar,
  ChevronDownIcon,
  EmptyState,
  GroupIcon,
  InlineInput,
  Link,
  ListHeader,
  LoadFailed,
  MenuButton,
  MoreIcon,
  PlusIcon,
  SearchIcon,
  SortIcon,
  StarIcon,
  TrashIcon,
  ViewsIcon,
  ask,
  cls,
  errorToast,
  fullDate,
  nav,
  navigate,
  timeAgo,
  toPatch,
  type IssueChange,
  useApp,
  useDebounced,
  useFetch,
} from "./ui";

const GROUP_LABELS: Record<GroupBy, string> = { status: "Status", assignee: "Assignee", priority: "Priority", label: "Label" };
const ORDER_LABELS: Record<OrderBy, string> = { priority: "Priority", updated: "Last updated", created: "Last created" };

/** Stars a view into your sidebar, or unstars it: yours alone. */
function Star({ view, onChange }: { view: CustomView; onChange?: (view: CustomView) => void }) {
  const { reloadViews } = useApp();
  const toggle = () =>
    api.favoriteView(view.id, !view.favorite).then((fresh) => {
      onChange?.(fresh);
      reloadViews();
    }, errorToast);
  return (
    <button
      className={cls("icon-btn sm row-action", view.favorite && "starred")}
      onClick={toggle}
      aria-pressed={view.favorite}
      aria-label="Favorite"
      title={view.favorite ? "Remove from favorites" : "Add to favorites"}
    >
      <StarIcon />
    </button>
  );
}

export function ViewsPage() {
  const app = useApp();
  const views = app.views;
  useEffect(() => void (document.title = "Views · Docket"), []);

  let body;
  if (!views) body = null;
  else if (!views.length)
    body = (
      <EmptyState
        icon={<ViewsIcon />}
        title="No views yet"
        action={
          <button className="btn btn-primary" onClick={() => app.newView()}>
            New view
          </button>
        }
      >
        Save a list’s filters as a view to come back to them, and share them with everyone here. Star one to keep it in the sidebar.
      </EmptyState>
    );
  else
    body = (
      <div className="list">
        {views.map((v) => (
          <div className="row" key={v.id}>
            <Star view={v} />
            <Link to={`/view/${v.id}`} className="row-title" data-nav dir="auto">
              {v.name}
            </Link>
            <span className="grow" />
            <span className="row-meta view-by" title={`By ${v.creator.name}`}>
              <Avatar user={v.creator} />
              <span className="row-by" dir="auto">
                {v.creator.name}
              </span>
            </span>
            <time className="row-time" dateTime={v.updatedAt} title={`Updated ${fullDate(v.updatedAt)}`}>
              {timeAgo(v.updatedAt)}
            </time>
          </div>
        ))}
      </div>
    );

  return (
    <>
      <header className="header">
        <MenuButton />
        <div className="header-title">
          <span>Views</span>
          {!!views?.length && <span className="header-count">{views.length}</span>}
        </div>
        <button className="btn btn-sm view-new" onClick={() => app.newView()}>
          <PlusIcon /> New view
        </button>
      </header>
      <div className="content">{body}</div>
    </>
  );
}

function DisplayControls({ display, onChange, disabled }: { display: ViewDisplay; onChange: (d: Partial<ViewDisplay>) => void; disabled: boolean }) {
  return (
    <>
      <Picker
        label="Group by"
        options={GROUP_BYS.map((g) => ({ value: g, label: GROUP_LABELS[g] }))}
        selected={[display.groupBy]}
        onPick={(g) => onChange({ groupBy: g as GroupBy })}
        disabled={disabled}
        className="chip"
      >
        <GroupIcon />
        <span className="chip-text">Group: {GROUP_LABELS[display.groupBy]}</span>
        <ChevronDownIcon className="chip-caret" />
      </Picker>
      <Picker
        label="Order by"
        options={ORDER_BYS.map((o) => ({ value: o, label: ORDER_LABELS[o] }))}
        selected={[display.orderBy]}
        onPick={(o) => onChange({ orderBy: o as OrderBy })}
        disabled={disabled}
        className="chip"
      >
        <SortIcon />
        <span className="chip-text">Order: {ORDER_LABELS[display.orderBy]}</span>
        <ChevronDownIcon className="chip-caret" />
      </Picker>
      <LayoutToggle layout={display.layout} onChange={(layout) => onChange({ layout })} disabled={disabled} />
    </>
  );
}

export function CustomViewPage({ id }: { id: number }) {
  const app = useApp();
  const { data: view, setData: setView, missing, failed, reload } = useFetch(() => api.view(id), [id]);
  const canEdit = !!view && (view.creator.username === getYou().username || app.workspace?.role === "admin");
  // The search box starts as the view's search; for its editors, what's typed is saved once it settles.
  const [search, setSearch] = useState<string | null>(null);
  useEffect(() => void (view && search === null && setSearch(view.filter.q ?? "")), [view]);
  const q = useDebounced((search ?? "").trim(), 300);

  useEffect(() => void (nav.lastList = location.pathname), []);
  useEffect(() => void (document.title = `${view?.name ?? "View"} · Docket`), [view?.name]);

  // Shown at once, saved in order; a refused change toasts and reloads the view.
  const change = (patch: CustomViewPatch) => {
    if (!view) return;
    setView({ ...view, name: patch.name ?? view.name, filter: patch.filter ?? view.filter, display: { ...view.display, ...patch.display } });
    api.updateView(id, patch).catch((e) => {
      errorToast(e);
      reload();
    });
  };
  const setFilter = (field: keyof ViewFilter) => (value: string) => view && change({ filter: { ...view.filter, [field]: value || undefined } });
  useEffect(() => {
    if (view && canEdit && search !== null && q !== (view.filter.q ?? "")) change({ filter: { ...view.filter, q: q || undefined } });
  }, [q]);

  const filter = view && { category: LISTED, ...view.filter, q };
  const key = JSON.stringify(filter);
  const {
    data: issues,
    setData: setIssues,
    failed: issuesFailed,
    reload: reloadIssues,
    invalidate,
  } = useFetch(filter && (() => api.issues(filter)), [key]);
  useListShortcuts(setIssues, invalidate, reloadIssues);
  const { selection, bar } = useBulk(issues, { setIssues, invalidate, reload: reloadIssues }, [key]);

  const patch = (issueId: string, p: IssueChange) => {
    invalidate();
    const now = new Date().toISOString();
    setIssues((list) => list?.map((i) => (i.id === issueId ? { ...i, ...p, updatedAt: now } : i)) ?? null);
    api.updateIssue(issueId, toPatch(p)).catch((e) => {
      errorToast(e);
      reloadIssues();
    });
  };

  const remove = async () => {
    if (!view || !(await ask(`Delete “${view.name}”? It’s gone for everyone in the workspace.`, "Delete"))) return;
    api.deleteView(id).then(() => {
      app.reloadViews();
      navigate("/views");
    }, errorToast);
  };

  let body;
  if (missing)
    body = (
      <EmptyState icon={<ViewsIcon />} title="View not found" action={<Link className="btn" to="/views">All views</Link>}>
        It was deleted, or it’s in another workspace.
      </EmptyState>
    );
  else if (!view) body = failed ? <LoadFailed message={failed} retry={reload} /> : null;
  else if (!issues) body = issuesFailed ? <LoadFailed message={issuesFailed} retry={reloadIssues} /> : null;
  else if (!issues.length)
    body = (
      <EmptyState icon={<SearchIcon />} title="No matching issues">
        Nothing matches this view right now.
      </EmptyState>
    );
  else if (view.display.layout === "board")
    body = <Board key={view.display.groupBy} issues={issues} team={view.filter.team} display={view.display} onPatch={patch} selection={selection} />;
  else body = <IssueList key={view.display.groupBy} issues={issues} team={view.filter.team} display={view.display} onPatch={patch} selection={selection} />;

  const title = view && (
    <span className="view-title">
      <Star view={view} onChange={setView} />
      {canEdit ? <InlineInput label="View name" value={view.name} onSave={(name) => change({ name })} /> : <span dir="auto">{view.name}</span>}
      {canEdit && (
        <Picker label="View actions" options={[{ value: "delete", label: "Delete view", icon: <TrashIcon /> }]} selected={[]} onPick={remove} className="icon-btn sm">
          <MoreIcon />
        </Picker>
      )}
    </span>
  );
  const f = view?.filter ?? {};
  return (
    <>
      <ListHeader
        team={undefined}
        title={title ?? "View"}
        count={issues?.length ?? 0}
        view="issues"
        onNew={view ? () => app.newIssue({ team: view.filter.team }) : undefined}
        search={search ?? ""}
        onSearch={view ? setSearch : undefined}
      >
        {view && (
          <>
            <Filters
              team={f.team ?? ""}
              setTeam={setFilter("team")}
              project={f.project ?? ""}
              setProject={setFilter("project")}
              label={f.label ?? ""}
              setLabel={setFilter("label")}
              assignee={f.assignee ?? ""}
              setAssignee={setFilter("assignee")}
              delegate={f.delegate ?? ""}
              setDelegate={setFilter("delegate")}
              due={f.due ?? ""}
              setDue={setFilter("due")}
              disabled={!canEdit}
            />
            <DisplayControls display={view.display} onChange={(display) => change({ display })} disabled={!canEdit} />
          </>
        )}
      </ListHeader>
      <div className={cls("content", view?.display.layout === "board" && !!issues?.length && "content-board")}>{body}</div>
      {bar}
    </>
  );
}

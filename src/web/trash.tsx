// A team's trash: deleted issues and docs, restorable for 30 days (see SPEC.md, Trash).
import { useEffect, type ReactNode } from "react";
import type { DocumentSummary, IssueSummary } from "../shared/types";
import { api } from "./api";
import {
  DocIcon,
  EmptyState,
  Link,
  ListHeader,
  LoadFailed,
  StatusIcon,
  TeamNotFound,
  TrashIcon,
  ago,
  errorToast,
  fullDate,
  toast,
  useApp,
  useFetch,
} from "./ui";

export function TrashView({ teamKey }: { teamKey: string }) {
  const app = useApp();
  const team = app.teams?.find((t) => t.key === teamKey);
  const { data: trash, failed, reload } = useFetch(() => api.trash(teamKey), [teamKey]);

  useEffect(() => {
    document.title = `Trash · ${team?.name ?? teamKey} · Docket`;
  }, [team?.name, teamKey]);

  const restore = (label: string, call: () => Promise<unknown>, href: string) =>
    call().then(() => {
      toast(`Restored ${label}`, href);
      reload();
    }, errorToast);

  let body;
  if (app.teams && !team) body = <TeamNotFound teamKey={teamKey} back="/" backLabel="All issues" />;
  else if (!trash) body = failed ? <LoadFailed message={failed} retry={reload} /> : null;
  else if (!trash.issues.length && !trash.documents.length)
    body = (
      <EmptyState icon={<TrashIcon />} title="Trash is empty">
        Deleted issues and docs stay here for 30 days, then they’re gone for good.
      </EmptyState>
    );
  else
    body = (
      <div className="list">
        <Group title="Issues" items={trash.issues}>
          {(i: IssueSummary) => (
            <TrashRow
              key={i.id}
              icon={<StatusIcon status={i.status} />}
              id={i.id}
              title={i.title}
              href={`/issue/${i.id}`}
              deletedAt={i.deletedAt!}
              onRestore={() => restore(i.id, () => api.restoreIssue(i.id), `/issue/${i.id}`)}
            />
          )}
        </Group>
        <Group title="Docs" items={trash.documents}>
          {(d: DocumentSummary) => (
            <TrashRow
              key={d.slug}
              icon={<DocIcon className="doc-icon" />}
              title={d.title}
              href={`/doc/${d.slug}`}
              deletedAt={d.deletedAt!}
              onRestore={() => restore(`“${d.title}”`, () => api.restoreDocument(d.slug), `/doc/${d.slug}`)}
            />
          )}
        </Group>
      </div>
    );

  return (
    <>
      <ListHeader team={team} title={teamKey} count={trash ? trash.issues.length + trash.documents.length : 0} view="trash" />
      <div className="content">{body}</div>
    </>
  );
}

function Group<T>({ title, items, children }: { title: string; items: T[]; children: (item: T) => ReactNode }) {
  if (!items.length) return null;
  return (
    <section>
      <div className="group">
        <span className="group-toggle">
          <span className="group-label">{title}</span>
          <span className="count">{items.length}</span>
        </span>
      </div>
      {items.map(children)}
    </section>
  );
}

function TrashRow(props: { icon: ReactNode; id?: string; title: string; href: string; deletedAt: string; onRestore: () => void }) {
  return (
    <div className="row">
      {props.icon}
      {props.id && <span className="row-id">{props.id}</span>}
      <Link to={props.href} className="row-title" data-nav dir="auto">
        {props.title}
      </Link>
      <span className="grow" />
      <time className="row-meta" dateTime={props.deletedAt} title={fullDate(props.deletedAt)}>
        Deleted {ago(props.deletedAt)}
      </time>
      <button className="btn btn-sm row-action" onClick={props.onRestore}>
        Restore
      </button>
    </div>
  );
}

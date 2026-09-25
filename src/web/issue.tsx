// Issue page: title, description, sub-issues, comments and the properties panel.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CLOSED_STATUSES, PRIORITY_LABELS, STATUS_LABELS, type Issue, type IssuePatch } from "../shared/types";
import { HttpError, api, getMe } from "./api";
import { AssigneePicker, BlockedByPicker, LabelsPicker, ParentPicker, PriorityPicker, StatusPicker } from "./pickers";
import {
  Avatar,
  ago,
  ChevronRightIcon,
  Comments,
  CopyIcon,
  DocIcon,
  EmptyState,
  Kbd,
  LabelChip,
  Link,
  MOD,
  Markdown,
  MenuButton,
  ParentIcon,
  PencilIcon,
  PlusIcon,
  PriorityIcon,
  ProjectMark,
  Section,
  StatusIcon,
  TitleEditor,
  TrashIcon,
  errorToast,
  fullDate,
  nav,
  navigate,
  sortIssues,
  toast,
  useApp,
  useAutosize,
  useFetch,
  type CommentActions,
} from "./ui";

export function IssuePage({ id }: { id: string }) {
  const app = useApp();
  const { data: issue, setData: setIssue, missing, reload, invalidate, isLatest } = useFetch(() => api.issue(id), [id]);

  useEffect(() => {
    document.title = `${issue ? `${issue.id} ${issue.title}` : id} · Docket`;
  }, [id, issue?.title]);

  const projectKey = issue?.project ?? id.replace(/-\d+$/, "");
  const project = app.projects?.find((p) => p.key === projectKey);

  const header = (actions?: ReactNode) => (
    <header className="header">
      <MenuButton />
      <nav className="crumbs">
        <Link to={`/p/${projectKey}`} dir="auto">
          {project?.name ?? projectKey}
        </Link>
        <ChevronRightIcon />
        <span className="crumb-id">{issue?.id ?? id}</span>
      </nav>
      <span className="grow" />
      {actions}
    </header>
  );

  if (missing)
    return (
      <>
        {header()}
        <div className="content">
          <EmptyState title="Issue not found" action={<Link className="btn" to={nav.lastList}>Back to issues</Link>}>
            {id} doesn’t exist, or it was deleted.
          </EmptyState>
        </div>
      </>
    );
  if (!issue) return header();

  // Functional updaters so a patch always applies on top of the latest state, not a
  // stale closure. Each response merges only its own slice (top-level fields for `patch`,
  // just the one child for `patchChild`) so a patch and a patchChild racing each other
  // can't clobber one another's optimistic update; the seq guard only drops a response
  // that's been superseded by another call of the *same* kind.
  const patch = (p: IssuePatch) => {
    const n = invalidate();
    const now = new Date().toISOString();
    setIssue((cur) => (cur ? { ...cur, ...p, updatedAt: now } : cur));
    api
      .updateIssue(issue.id, p)
      .then((fresh) => {
        if (!isLatest(n)) return;
        setIssue((cur) => (cur ? { ...fresh, children: cur.children } : cur));
      })
      .catch((e) => {
        errorToast(e);
        reload();
      });
  };

  const patchChild = (childId: string, p: IssuePatch) => {
    const n = invalidate();
    setIssue((cur) =>
      cur ? { ...cur, children: cur.children.map((c) => (c.id === childId ? { ...c, ...p } : c)) } : cur,
    );
    api
      .updateIssue(childId, p)
      .then((fresh) => {
        if (!isLatest(n)) return;
        setIssue((cur) =>
          cur
            ? {
                ...cur,
                children: cur.children.map((c) =>
                  c.id === childId ? { ...c, ...p, updatedAt: fresh.updatedAt, completedAt: fresh.completedAt } : c,
                ),
              }
            : cur,
        );
      })
      .catch((e) => {
        errorToast(e);
        reload();
      });
  };

  // Each comment call answers with the whole issue; apply it unless something newer landed.
  const withFresh = async (call: () => Promise<Issue>) => {
    const n = invalidate();
    const fresh = await call();
    if (isLatest(n)) setIssue(fresh);
  };
  const comments: CommentActions = {
    add: (body) => withFresh(() => api.comment(issue.id, body)),
    edit: (cid, body) => withFresh(() => api.editComment(issue.id, cid, body)),
    remove: (cid) => withFresh(() => api.deleteComment(issue.id, cid)),
  };

  // Members can claim an open issue nobody holds; the server refuses (naming the holder) if someone got there first.
  const claimable = !!getMe().member && !issue.assignee && !CLOSED_STATUSES.includes(issue.status);
  const claim = () => withFresh(() => api.claimIssue(issue.id)).catch(errorToast);

  // The description is the one field sent with baseUpdatedAt, since a stale save would overwrite someone's
  // text. Comments bump updatedAt too, so on a 409 it only counts as a conflict if the description itself
  // changed; otherwise it saves again on top of the fresh version.
  const saveDescription = async (description: string, start: Edit) => {
    const n = invalidate();
    const save = (base: string) => api.updateIssue(issue.id, { description, baseUpdatedAt: base });
    try {
      const fresh = await save(start.base);
      if (isLatest(n)) setIssue(fresh);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409)) throw e;
      const latest = await api.issue(issue.id);
      if (latest.description !== start.value) {
        setIssue(latest);
        throw e;
      }
      const fresh = await save(latest.updatedAt);
      if (isLatest(n)) setIssue(fresh);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete ${issue.id}? This can’t be undone.`)) return;
    try {
      await api.deleteIssue(issue.id);
      toast(`Deleted ${issue.id}`);
      navigate(nav.lastList);
    } catch (e) {
      errorToast(e);
    }
  };

  const copyId = () =>
    navigator.clipboard.writeText(issue.id).then(
      () => toast(`Copied ${issue.id}`),
      () => toast("Couldn’t copy to clipboard"),
    );

  return (
    <>
      {header(
        <>
          {claimable && (
            <button className="btn btn-sm" onClick={claim} title="Assign it to you and set it in progress">
              Claim
            </button>
          )}
          <button className="icon-btn" onClick={copyId} aria-label="Copy ID" title="Copy ID">
            <CopyIcon />
          </button>
          <button className="icon-btn" onClick={remove} aria-label="Delete issue" title="Delete issue">
            <TrashIcon />
          </button>
        </>,
      )}
      <div className="issue">
        <div className="issue-main">
          <div className="issue-inner">
            {issue.parent && (
              <Link className="issue-parent" to={`/issue/${issue.parent}`}>
                <ParentIcon /> Sub-issue of <span className="mono">{issue.parent}</span>
              </Link>
            )}
            <TitleEditor key={issue.id} value={issue.title} onSave={(title) => patch({ title })} />
            {/* Narrow screens show the properties under the title instead of in the side panel. */}
            <div className="issue-props-inline">
              <Properties issue={issue} patch={patch} />
            </div>
            <Description key={`d-${issue.id}`} value={issue.description} updatedAt={issue.updatedAt} onSave={saveDescription} />
            <SubIssues issue={issue} onPatch={patchChild} />
            <Docs issue={issue} />
            <Activity issue={issue} actions={comments} />
          </div>
        </div>
        <aside className="issue-props">
          <Properties issue={issue} patch={patch} />
        </aside>
      </div>
    </>
  );
}

/** What an edit started from: the description, and the issue's updatedAt to send as baseUpdatedAt. */
type Edit = { value: string; base: string };

function Description({
  value,
  updatedAt,
  onSave,
}: {
  value: string;
  updatedAt: string;
  onSave: (v: string, start: Edit) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const started = useRef<Edit>({ value, base: updatedAt });
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutosize(ref, editing ? draft : "");

  useEffect(() => {
    const el = ref.current;
    if (editing && el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  const start = () => {
    started.current = { value, base: updatedAt };
    setDraft(value);
    setConflict(false);
    setEditing(true);
  };
  const close = () => {
    setConflict(false);
    setEditing(false);
  };
  const save = () => {
    if (saving) return;
    if (draft.trim() === started.current.value.trim()) return close();
    setSaving(true);
    onSave(draft.trim(), started.current).then(close, (e) => {
      if (e instanceof HttpError && e.status === 409) setConflict(true);
      else errorToast(e);
    }).finally(() => setSaving(false));
  };
  // After a conflict, the props hold their version: keep editing on top of it, or take it.
  const rebase = () => {
    started.current = { value, base: updatedAt };
    setConflict(false);
  };
  const takeTheirs = () => {
    rebase();
    setDraft(value);
  };

  if (editing)
    return (
      <div className="editor">
        <textarea
          ref={ref}
          className="editor-input"
          dir="auto"
          value={draft}
          placeholder="Add a description…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        />
        {conflict && (
          <div className="editor-conflict" role="alert">
            <span>Someone changed this description while you were editing.</span>
            <span className="grow" />
            <button className="btn btn-sm" onClick={takeTheirs}>
              Use theirs
            </button>
            <button className="btn btn-sm" onClick={rebase}>
              Keep mine
            </button>
          </div>
        )}
        <div className="editor-foot">
          <span className="hint">Markdown supported</span>
          <span className="grow" />
          <button className="btn btn-ghost btn-sm" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || conflict}>
            {saving ? "Saving…" : "Save"} <Kbd>{MOD}↵</Kbd>
          </button>
        </div>
      </div>
    );

  if (!value.trim())
    return (
      <button className="desc-empty" onClick={start}>
        Add a description…
      </button>
    );

  return (
    <div className="desc">
      <Markdown text={value} />
      <button className="icon-btn sm desc-edit" onClick={start} aria-label="Edit description" title="Edit description">
        <PencilIcon />
      </button>
    </div>
  );
}

function SubIssues({ issue, onPatch }: { issue: Issue; onPatch: (id: string, p: IssuePatch) => void }) {
  const app = useApp();
  const children = sortIssues(issue.children);
  const done = children.filter((c) => c.status === "done").length;
  return (
    <Section
      title="Sub-issues"
      count={children.length > 0 ? `${done}/${children.length}` : undefined}
      action={
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => app.newIssue({ project: issue.project, parent: issue.id, status: "todo" })}
        >
          <PlusIcon /> Add
        </button>
      }
    >
      {children.length > 0 && (
        <div className="subs">
          {children.map((c) => (
            <div className="row sub" key={c.id}>
              <StatusPicker value={c.status} onChange={(status) => onPatch(c.id, { status })} className="row-btn" />
              <span className="row-id">{c.id}</span>
              <Link to={`/issue/${c.id}`} className="row-title" dir="auto">
                {c.title}
              </Link>
              <span className="grow" />
              <PriorityPicker value={c.priority} onChange={(priority) => onPatch(c.id, { priority })} className="row-btn" />
              <AssigneePicker value={c.assignee} onChange={(assignee) => onPatch(c.id, { assignee })} className="row-btn" align="end" />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function Docs({ issue }: { issue: Issue }) {
  if (!issue.docs.length) return null;
  return (
    <Section title="Docs" count={issue.docs.length}>
      <div className="subs">
        {issue.docs.map((d) => (
          <div className="row sub" key={d.slug}>
            <DocIcon className="doc-icon" />
            <Link to={`/doc/${d.slug}`} className="row-title" dir="auto">
              {d.title}
            </Link>
            <span className="grow" />
            <time className="row-time" dateTime={d.updatedAt} title={`Updated ${fullDate(d.updatedAt)} by ${d.updatedBy}`}>
              {ago(d.updatedAt)}
            </time>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Activity({ issue, actions }: { issue: Issue; actions: CommentActions }) {
  return (
    <Comments title="Activity" comments={issue.comments} actions={actions}>
      <li className="event">
        <span className="event-dot" />
        Created <time title={fullDate(issue.createdAt)}>{ago(issue.createdAt)}</time>
      </li>
      {issue.completedAt && (
        <li className="event">
          <StatusIcon status={issue.status} size={12} />
          Marked {STATUS_LABELS[issue.status].toLowerCase()}{" "}
          <time title={fullDate(issue.completedAt)}>{ago(issue.completedAt)}</time>
        </li>
      )}
    </Comments>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prop">
      <div className="prop-label">{label}</div>
      <div className="prop-value">{children}</div>
    </div>
  );
}

function Relations({ ids, children }: { ids: string[]; children?: ReactNode }) {
  return (
    <div className="rels">
      {ids.map((id) => (
        <Link key={id} to={`/issue/${id}`} className="rel">
          {id}
        </Link>
      ))}
      {children}
    </div>
  );
}

function Properties({ issue, patch }: { issue: Issue; patch: (p: IssuePatch) => void }) {
  const app = useApp();
  const project = app.projects?.find((p) => p.key === issue.project);
  const none = <span className="muted">None</span>;
  return (
    <>
      <Prop label="Status">
        <StatusPicker value={issue.status} onChange={(status) => patch({ status })} className="prop-btn">
          <StatusIcon status={issue.status} />
          {STATUS_LABELS[issue.status]}
        </StatusPicker>
      </Prop>
      <Prop label="Priority">
        <PriorityPicker value={issue.priority} onChange={(priority) => patch({ priority })} className="prop-btn">
          <PriorityIcon priority={issue.priority} />
          {PRIORITY_LABELS[issue.priority]}
        </PriorityPicker>
      </Prop>
      <Prop label="Assignee">
        <AssigneePicker value={issue.assignee} onChange={(assignee) => patch({ assignee })} className="prop-btn">
          <Avatar name={issue.assignee} />
          {issue.assignee ? <span dir="auto">{issue.assignee}</span> : <span className="muted">Unassigned</span>}
        </AssigneePicker>
      </Prop>
      <Prop label="Labels">
        <LabelsPicker value={issue.labels} onChange={(labels) => patch({ labels })} className="prop-btn prop-wrap">
          {issue.labels.length ? issue.labels.map((l) => <LabelChip key={l} name={l} />) : <span className="muted">Add labels</span>}
        </LabelsPicker>
      </Prop>
      <Prop label="Project">
        <Link to={`/p/${issue.project}`} className="prop-btn">
          <ProjectMark id={issue.project} />
          <span dir="auto">{project?.name ?? issue.project}</span>
        </Link>
      </Prop>
      <Prop label="Parent">
        <Relations ids={issue.parent ? [issue.parent] : []}>
          <ParentPicker
            value={issue.parent}
            onChange={(parent) => patch({ parent })}
            project={issue.project}
            exclude={[issue.id, ...issue.children.map((c) => c.id)]}
            className={issue.parent ? "icon-btn xs" : "prop-btn"}
          >
            {issue.parent ? <PencilIcon /> : none}
          </ParentPicker>
        </Relations>
      </Prop>
      <Prop label="Blocked by">
        <Relations ids={issue.blockedBy}>
          <BlockedByPicker
            value={issue.blockedBy}
            onChange={(blockedBy) => patch({ blockedBy })}
            exclude={[issue.id]}
            className={issue.blockedBy.length ? "icon-btn xs" : "prop-btn"}
          >
            {issue.blockedBy.length ? <PencilIcon /> : none}
          </BlockedByPicker>
        </Relations>
      </Prop>
      {issue.blocks.length > 0 && (
        <Prop label="Blocks">
          <Relations ids={issue.blocks} />
        </Prop>
      )}
      <div className="props-meta">
        <span title={fullDate(issue.createdAt)}>Created {ago(issue.createdAt)}</span>
        <span title={fullDate(issue.updatedAt)}>Updated {ago(issue.updatedAt)}</span>
      </div>
    </>
  );
}

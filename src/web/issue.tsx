// Issue page: title, description, sub-issues, comments and the properties panel.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PRIORITY_LABELS, STATUS_LABELS, type Comment, type Issue, type IssuePatch } from "../shared/types";
import { HttpError, api } from "./api";
import { AssigneePicker, BlockedByPicker, LabelsPicker, ParentPicker, PriorityPicker, StatusPicker } from "./pickers";
import {
  Avatar,
  ago,
  ChevronRightIcon,
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
  StatusIcon,
  TrashIcon,
  errorToast,
  fullDate,
  nav,
  navigate,
  sortIssues,
  toast,
  useApp,
  useAutosize,
  useLive,
} from "./ui";

export function IssuePage({ id }: { id: string }) {
  const app = useApp();
  const live = useLive();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [missing, setMissing] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    const n = ++seq.current;
    api
      .issue(id)
      .then((i) => {
        if (n !== seq.current) return;
        setIssue(i);
        setMissing(false);
      })
      .catch((e) => {
        if (n !== seq.current) return;
        if (e instanceof HttpError && e.status === 404) setMissing(true);
        else errorToast(e);
      });
  }, [id, live, tick]);

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
    const n = ++seq.current;
    const now = new Date().toISOString();
    setIssue((cur) => (cur ? { ...cur, ...p, updatedAt: now } : cur));
    api
      .updateIssue(issue.id, p)
      .then((fresh) => {
        if (n !== seq.current) return;
        setIssue((cur) => (cur ? { ...fresh, children: cur.children } : cur));
      })
      .catch((e) => {
        errorToast(e);
        reload();
      });
  };

  const patchChild = (childId: string, p: IssuePatch) => {
    const n = ++seq.current;
    setIssue((cur) =>
      cur ? { ...cur, children: cur.children.map((c) => (c.id === childId ? { ...c, ...p } : c)) } : cur,
    );
    api
      .updateIssue(childId, p)
      .then((fresh) => {
        if (n !== seq.current) return;
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

  const comment = async (body: string) => {
    const n = ++seq.current;
    const fresh = await api.comment(issue.id, body);
    if (n === seq.current) setIssue(fresh);
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
            <Description key={`d-${issue.id}`} value={issue.description} onSave={(description) => patch({ description })} />
            <SubIssues issue={issue} onPatch={patchChild} />
            <Docs issue={issue} />
            <Activity issue={issue} onComment={comment} />
          </div>
        </div>
        <aside className="issue-props">
          <Properties issue={issue} patch={patch} />
        </aside>
      </div>
    </>
  );
}

export function TitleEditor({
  value,
  onSave,
  className = "issue-title",
  placeholder = "Issue title",
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const skip = useRef(false);
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(value);
  }, [value]);
  useAutosize(ref, draft);
  return (
    <textarea
      ref={ref}
      className={className}
      rows={1}
      dir="auto"
      aria-label="Title"
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          skip.current = true;
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        const v = draft.trim();
        if (!skip.current && v && v !== value) onSave(v);
        else setDraft(value);
        skip.current = false;
      }}
    />
  );
}

function Description({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
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
    setDraft(value);
    setEditing(true);
  };
  const save = () => {
    if (draft.trim() !== value.trim()) onSave(draft.trim());
    setEditing(false);
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
              setEditing(false);
            }
          }}
        />
        <div className="editor-foot">
          <span className="hint">Markdown supported</span>
          <span className="grow" />
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" onClick={save}>
            Save <Kbd>{MOD}↵</Kbd>
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
    <section className="section">
      <div className="section-head">
        <h3>Sub-issues</h3>
        {children.length > 0 && (
          <span className="count">
            {done}/{children.length}
          </span>
        )}
        <span className="grow" />
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => app.newIssue({ project: issue.project, parent: issue.id, status: "todo" })}
        >
          <PlusIcon /> Add
        </button>
      </div>
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
    </section>
  );
}

function Docs({ issue }: { issue: Issue }) {
  if (!issue.docs?.length) return null;
  return (
    <section className="section">
      <div className="section-head">
        <h3>Docs</h3>
        <span className="count">{issue.docs.length}</span>
      </div>
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
    </section>
  );
}

function Activity({ issue, onComment }: { issue: Issue; onComment: (body: string) => Promise<void> }) {
  return (
    <Comments title="Activity" comments={issue.comments} onComment={onComment}>
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

/** A comment thread with composer, shared by issues and docs. `children` are extra timeline events. */
export function Comments({
  title = "Comments",
  comments,
  onComment,
  children,
}: {
  title?: string;
  comments: Comment[];
  onComment: (body: string) => Promise<void>;
  children?: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h3>{title}</h3>
      </div>
      <ol className="timeline">
        {children}
        {comments.map((c) => (
          <li className="comment" key={c.id}>
            <div className="comment-head">
              <Avatar name={c.author} />
              <span className="comment-author" dir="auto">
                {c.author}
              </span>
              <time title={fullDate(c.createdAt)}>{ago(c.createdAt)}</time>
            </div>
            <Markdown text={c.body} />
          </li>
        ))}
      </ol>
      <Composer onSubmit={onComment} />
    </section>
  );
}

function Composer({ onSubmit }: { onSubmit: (body: string) => Promise<void> }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutosize(ref, body);
  const send = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onSubmit(text);
      setBody("");
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={2}
        dir="auto"
        placeholder="Leave a comment…"
        aria-label="Comment"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      <div className="composer-foot">
        <button className="btn btn-primary btn-sm" disabled={!body.trim() || busy} onClick={send}>
          Comment <Kbd>{MOD}↵</Kbd>
        </button>
      </div>
    </div>
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

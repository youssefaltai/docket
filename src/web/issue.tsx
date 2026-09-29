// Issue page: title, description, sub-issues, comments and the properties panel.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ESTIMATE_VALUES, PRIORITY_LABELS, type Issue, type IssueLink } from "../shared/types";
import { HttpError, api } from "./api";
import { RichEditor } from "./editor";
import { SubscribeButton } from "./inbox";
import {
  AssigneePicker,
  BlockedByPicker,
  CyclePicker,
  DelegatePicker,
  DuplicatePicker,
  EstimatePicker,
  LabelsPicker,
  MilestonePicker,
  ParentPicker,
  ProjectPicker,
  PriorityPicker,
  RelatedPicker,
  StatusPicker,
  TeamPicker,
  useProjects,
} from "./pickers";
import {
  ArchivedBanner,
  ArchiveIcon,
  EditorTeam,
  Avatar,
  ago,
  BranchIcon,
  CommitIcon,
  PullRequestIcon,
  CalendarIcon,
  EstimateIcon,
  ChevronRightIcon,
  CloseIcon,
  Comments,
  CycleIcon,
  CopyIcon,
  DocIcon,
  EmptyState,
  Kbd,
  LabelChip,
  Link,
  LoadFailed,
  MOD,
  Markdown,
  MenuButton,
  navigate,
  ParentIcon,
  PencilIcon,
  PlusIcon,
  PriorityIcon,
  ProjectIcon,
  ProjectStatusIcon,
  Reactions,
  TeamMark,
  Section,
  StatusIcon,
  TitleEditor,
  TrashIcon,
  copyText,
  cls,
  dayLabel,
  dueInfo,
  isClosedCategory,
  issueStatus,
  errorToast,
  fullDate,
  isMe,
  toPatch,
  type IssueChange,
  nav,
  sortIssues,
  useApp,
  useFetch,
  type CommentActions,
  useIssueShortcuts,
  useResolved,
  useKeydown,
  TrashBanner,
} from "./ui";
import { deleteToTrash } from "./trashActions";

export function IssuePage({ id }: { id: string }) {
  const app = useApp();
  const { data: issue, setData: setIssue, missing, failed, reload, invalidate, isLatest } = useFetch(() => api.issue(id), [id]);

  useEffect(() => {
    document.title = `${issue ? `${issue.id} ${issue.title}` : id} · Docket`;
  }, [id, issue?.title]);

  // Opened by an identifier it had before it moved team, or just moved: show its current one in the address bar.
  useEffect(() => {
    if (issue && issue.id !== id) navigate(`/issue/${issue.id}${location.search}${location.hash}`, true);
  }, [id, issue?.id]);

  // S/P/A/D/L, I and ⌘⌫ click the matching data-cmd trigger anywhere on the page (the Properties panel's
  // pickers, and the header's Claim/trash buttons below) — see useIssueShortcuts.
  useIssueShortcuts(() => (issue ? { root: document.body, id: issue.id } : null));

  const teamKey = issue?.team ?? id.replace(/-\d+$/, "");
  const team = app.teams?.find((t) => t.key === teamKey);

  const header = (actions?: ReactNode) => (
    <header className="header">
      <MenuButton />
      <nav className="crumbs">
        <Link to={`/t/${teamKey}`} dir="auto">
          {team?.name ?? teamKey}
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
  if (!issue)
    return failed ? (
      <>
        {header()}
        <div className="content">
          <LoadFailed message={failed} retry={reload} />
        </div>
      </>
    ) : (
      header()
    );

  // Functional updaters so a patch always applies on top of the latest state, not a
  // stale closure. Each response merges only its own slice (top-level fields for `patch`,
  // just the one child for `patchChild`) so a patch and a patchChild racing each other
  // can't clobber one another's optimistic update; the seq guard only drops a response
  // that's been superseded by another call of the *same* kind.
  const patch = (p: IssueChange) => {
    const n = invalidate();
    const now = new Date().toISOString();
    setIssue((cur) => (cur ? { ...cur, ...p, updatedAt: now } : cur));
    api
      .updateIssue(issue.id, toPatch(p))
      .then((fresh) => {
        if (!isLatest(n)) return;
        setIssue((cur) => (cur ? { ...fresh, children: cur.children } : cur));
      })
      .catch((e) => {
        errorToast(e);
        reload();
      });
  };

  const patchChild = (childId: string, p: IssueChange) => {
    const n = invalidate();
    setIssue((cur) =>
      cur ? { ...cur, children: cur.children.map((c) => (c.id === childId ? { ...c, ...p } : c)) } : cur,
    );
    api
      .updateIssue(childId, toPatch(p))
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
    reply: (parent, body) => withFresh(() => api.comment(issue.id, body, parent)),
    resolve: (cid, resolved) => withFresh(() => api.resolveThread(issue.id, cid, resolved)),
    react: (cid, emoji, on) => withFresh(() => api.reactToComment(issue.id, cid, emoji, on)),
  };

  // You can claim an open issue no other active member holds (a suspended member doesn't hold one),
  // including your own not yet in progress: the server's rule, which has the last word.
  const { assignee } = issue;
  const heldByOther =
    !!assignee && !isMe(assignee) && app.members.some((m) => m.user.username === assignee.username && !m.suspendedAt);
  const { category } = issueStatus(app.teams, issue);
  const alreadyMine = isMe(assignee) && category === "started";
  const claimable = !issue.deletedAt && !issue.archivedAt && !isClosedCategory(category) && !heldByOther && !alreadyMine;
  const claim = () => withFresh(() => api.claimIssue(issue.id)).catch(errorToast);
  // Manual archive: only a live, unarchived issue that's done or canceled (the server allows any live issue, but
  // that's what archiving is for; auto-archive only ever reaches these too).
  const archivable = !issue.deletedAt && !issue.archivedAt && isClosedCategory(category);
  const archive = () => withFresh(() => api.archiveIssue(issue.id)).catch(errorToast);

  // The description is the one field sent with baseUpdatedAt, since a stale save would overwrite someone's
  // text. Comments bump updatedAt too, so on a 409 it only counts as a conflict if the description itself
  // changed; otherwise it saves again on top of the fresh version.
  const saveDescription = async (description: string, start: Edit) => {
    const n = invalidate();
    const conflict = (e: unknown) => e instanceof HttpError && e.status === 409;
    // Saves on `base`; true if it landed, false on a 409.
    const save = async (base: string) => {
      try {
        const fresh = await api.updateIssue(issue.id, { description, baseUpdatedAt: base });
        if (isLatest(n)) setIssue(fresh);
        return true;
      } catch (e) {
        if (!conflict(e)) throw e;
        return false;
      }
    };
    if (await save(start.base)) return;
    let latest = await api.issue(issue.id);
    if (latest.description === start.value) {
      if (await save(latest.updatedAt)) return;
      latest = await api.issue(issue.id);
    }
    // A real conflict: show the latest version, so the banner and its choices work from what's there now.
    setIssue(latest);
    throw new HttpError("Issue changed since you read it", 409);
  };

  const remove = () => deleteToTrash(() => api.deleteIssue(issue.id), issue.id, () => api.restoreIssue(issue.id), `/issue/${issue.id}`, nav.lastList);

  return (
    <>
      {header(
        <>
          {claimable && (
            <button className="btn btn-sm" data-cmd="claim" onClick={claim} title="Assign it to you and set it in progress">
              Claim
            </button>
          )}
          {!issue.deletedAt && !issue.archivedAt && <SubscribeButton subscribed={issue.subscribed} onToggle={() => withFresh(() => api.subscribeIssue(issue.id, !issue.subscribed)).catch(errorToast)} />}
          <button className="icon-btn" onClick={() => copyText(issue.id, `Copied ${issue.id}`)} aria-label="Copy ID" title="Copy ID">
            <CopyIcon />
          </button>
          <CopyBranchButton branch={issue.branchName} />
          {archivable && (
            <button className="icon-btn" data-cmd="archive" onClick={archive} aria-label="Archive issue" title="Archive issue">
              <ArchiveIcon />
            </button>
          )}
          {!issue.deletedAt && (
            <button className="icon-btn" data-cmd="delete" onClick={remove} aria-label="Delete issue" title="Delete issue">
              <TrashIcon />
            </button>
          )}
        </>,
      )}
      <EditorTeam.Provider value={issue.team}>
      <div className="issue">
        <div className="issue-main">
          <div className="issue-inner">
            {issue.deletedAt ? (
              <TrashBanner deletedAt={issue.deletedAt} onRestore={() => withFresh(() => api.restoreIssue(issue.id))} />
            ) : (
              issue.archivedAt && (
                <ArchivedBanner archivedAt={issue.archivedAt} onUnarchive={() => withFresh(() => api.unarchiveIssue(issue.id))} />
              )
            )}
            {/* A trashed or archived issue is read-only until restored/unarchived: the fieldset disables every control in it. */}
            <fieldset className="plain" disabled={!!issue.deletedAt || !!issue.archivedAt}>
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
              <Description
                key={`d-${issue.id}`}
                value={issue.description}
                updatedAt={issue.updatedAt}
                onSave={saveDescription}
                reactions={issue.reactions}
                onReact={(emoji, on) => withFresh(() => api.reactToIssue(issue.id, emoji, on)).catch(errorToast)}
              />
              <SubIssues issue={issue} onPatch={patchChild} />
              <Docs issue={issue} />
              <Links issue={issue} />
              {!issue.deletedAt && <Comments title="Activity" comments={issue.comments} activity={issue.activity} team={issue.team} actions={comments} />}
            </fieldset>
          </div>
        </div>
        <aside className="issue-props">
          <fieldset className="plain" disabled={!!issue.deletedAt || !!issue.archivedAt}>
            <Properties issue={issue} patch={patch} />
          </fieldset>
        </aside>
      </div>
      </EditorTeam.Provider>
    </>
  );
}

/** Copies the issue's git branch name for you: "ana/dkt-12-fix-login" (also ⌘/Ctrl+Shift+. on the issue page). */
function CopyBranchButton({ branch }: { branch: string }) {
  const copy = () => copyText(branch, `Copied ${branch}`);
  useKeydown((e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.code !== "Period") return;
    e.preventDefault();
    copy();
  });
  return (
    <button className="icon-btn" onClick={copy} aria-label="Copy git branch name" title={`Copy git branch name (${MOD}⇧.)`}>
      <BranchIcon />
    </button>
  );
}

/** What an edit started from: the description, and the issue's (or project's) updatedAt to send as baseUpdatedAt. */
export type Edit = { value: string; base: string };

/** A markdown description edited in place and saved with baseUpdatedAt: an issue's, or a project's (no reactions). */
export function Description({
  value,
  updatedAt,
  onSave,
  reactions,
  onReact,
}: {
  value: string;
  updatedAt: string;
  onSave: (v: string, start: Edit) => Promise<void>;
  reactions?: Issue["reactions"];
  onReact?: (emoji: string, on: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false); // guards double ⌘↵ presses before `saving` re-renders
  const started = useRef<Edit>({ value, base: updatedAt });

  const start = () => {
    started.current = { value, base: updatedAt };
    setDraft(value);
    setConflict(false);
    setEditing(true);
  };
  const close = () => setEditing(false);
  const save = () => {
    if (conflict || inFlight.current) return;
    if (draft.trim() === started.current.value.trim()) return close();
    inFlight.current = true;
    setSaving(true);
    onSave(draft.trim(), started.current)
      .then(close, (e) => {
        if (e instanceof HttpError && e.status === 409) setConflict(true);
        else errorToast(e);
      })
      .finally(() => {
        inFlight.current = false;
        setSaving(false);
      });
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
        <RichEditor
          className="editor-input"
          label="Description"
          placeholder="Add a description…"
          value={draft}
          onChange={setDraft}
          autoFocus
          onSubmit={save}
          onCancel={close}
          footClass="editor-foot"
          foot={
            <>
              <button className="btn btn-ghost btn-sm" onClick={close}>
                Cancel
              </button>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || conflict}>
                {saving ? "Saving…" : "Save"} <Kbd>{MOD}↵</Kbd>
              </button>
            </>
          }
        >
          {conflict && (
            <div className="editor-conflict" role="alert">
              <div className="editor-conflict-head">
                <span>Someone changed this description while you were editing. Theirs:</span>
                <span className="grow" />
                <button className="btn btn-sm" onClick={takeTheirs}>
                  Use theirs
                </button>
                <button className="btn btn-sm" onClick={rebase}>
                  Keep mine
                </button>
              </div>
              <pre className="editor-theirs" dir="auto">
                {value || "(empty)"}
              </pre>
            </div>
          )}
        </RichEditor>
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
      {reactions && onReact && <Reactions reactions={reactions} onToggle={onReact} />}
    </div>
  );
}

function SubIssues({ issue, onPatch }: { issue: Issue; onPatch: (id: string, p: IssueChange) => void }) {
  const app = useApp();
  const children = sortIssues(issue.children, app.teams);
  const done = children.filter((c) => issueStatus(app.teams, c).category === "completed").length;
  return (
    <Section
      title="Sub-issues"
      count={children.length > 0 ? `${done}/${children.length}` : undefined}
      action={
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => app.newIssue({ team: issue.team, parent: issue.id })}
        >
          <PlusIcon /> Add
        </button>
      }
    >
      {children.length > 0 && (
        <div className="subs">
          {children.map((c) => (
            <div className="row sub" key={c.id}>
              <StatusPicker team={c.team} value={c.status} onChange={(status) => onPatch(c.id, { status })} className="row-btn" />
              <span className="row-id">{c.id}</span>
              <Link to={`/issue/${c.id}`} className="row-title" dir="auto">
                {c.title}
              </Link>
              <span className="grow" />
              <PriorityPicker value={c.priority} onChange={(priority) => onPatch(c.id, { priority })} className="row-btn" />
              <AssigneePicker team={c.team} value={c.assignee} onChange={(assignee) => onPatch(c.id, { assignee })} className="row-btn" align="end" />
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
            <time className="row-time" dateTime={d.updatedAt} title={`Updated ${fullDate(d.updatedAt)} by ${d.updatedBy.name}`}>
              {ago(d.updatedAt)}
            </time>
          </div>
        ))}
      </div>
    </Section>
  );
}

const PR_STATES = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" };

/** A link's URL if it's http(s): titles and URLs come from GitHub payloads, so nothing else becomes an href. */
function webUrl(url: string): string | undefined {
  try {
    const { protocol, href } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? href : undefined;
  } catch {
    return undefined;
  }
}

/** Opens GitHub in a new tab; the title is plain text. */
const LinkTitle = ({ link }: { link: IssueLink }) => (
  <a className="row-title" href={webUrl(link.url)} target="_blank" rel="noopener noreferrer" dir="auto">
    {link.title || link.url}
  </a>
);

/** Pull requests (and, below them, commits) that GitHub linked to this issue. */
function Links({ issue }: { issue: Issue }) {
  if (!issue.links.length) return null;
  const prs = issue.links.filter((l) => l.kind === "pull_request");
  return (
    <Section title="Pull requests" count={prs.length || undefined}>
      <div className="subs">
        {issue.links.map((l) =>
          l.kind === "pull_request" ? (
            <div className="row sub" key={l.url}>
              <PullRequestIcon className={cls("link-icon", l.state && `pr-${l.state}`)} />
              <LinkTitle link={l} />
              {l.number !== null && <span className="mono muted">#{l.number}</span>}
              <span className="grow" />
              {l.state && <span className={cls("pr-state", `pr-${l.state}`)}>{PR_STATES[l.state]}</span>}
            </div>
          ) : (
            <div className="row sub link-commit" key={l.url}>
              <CommitIcon className="link-icon" />
              <LinkTitle link={l} />
            </div>
          ),
        )}
      </div>
    </Section>
  );
}

/**
 * A plain date input under the property button: clicking opens the browser's own picker. It saves on blur, so typing
 * a date digit by digit saves once, not at every intermediate valid date.
 */
function DueDate({ issue, patch }: { issue: Issue; patch: (p: IssueChange) => void }) {
  const [draft, setDraft] = useState<string | null>(null); // while editing
  const value = draft ?? issue.dueOn ?? "";
  const { teams } = useApp();
  const due = dueInfo({ dueOn: value || null }, isClosedCategory(issueStatus(teams, issue).category));
  const save = () => {
    // A year typed past 4 digits (12026) is a valid date to the browser but not a due date: keep the saved one.
    if (draft !== null && /^(\d{4}-\d{2}-\d{2})?$/.test(draft) && (draft || null) !== issue.dueOn) patch({ dueOn: draft || null });
    setDraft(null);
  };
  return (
    <>
      <label className={cls("prop-btn due-prop", due?.tone)} title={due?.title}>
        <CalendarIcon />
        {value ? dayLabel(value) : <span className="muted">No due date</span>}
        <input
          type="date"
          aria-label="Due date"
          value={value}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onClick={(e) => {
            try {
              e.currentTarget.showPicker();
            } catch {}
          }}
        />
      </label>
      {value && (
        <button className="icon-btn xs" onClick={() => patch({ dueOn: null })} aria-label="Remove due date" title="Remove due date">
          <CloseIcon />
        </button>
      )}
    </>
  );
}

function Prop({ label, cmd, children }: { label: string; cmd?: string; children: ReactNode }) {
  return (
    <div className="prop" data-cmd={cmd}>
      <div className="prop-label">{label}</div>
      <div className="prop-value">{children}</div>
    </div>
  );
}

/** Identifier chips; a relation whose blocker is resolved is struck through, since it no longer blocks. */
function Relations({ ids, resolved, children }: { ids: string[]; resolved?: (id: string) => boolean; children?: ReactNode }) {
  return (
    <div className="rels">
      {ids.map((id) => (
        <Link
          key={id}
          to={`/issue/${id}`}
          className={cls("rel", resolved?.(id) && "rel-resolved")}
          title={resolved?.(id) ? "Resolved: no longer blocking" : undefined}
        >
          {id}
        </Link>
      ))}
      {children}
    </div>
  );
}

function Properties({ issue, patch }: { issue: Issue; patch: (p: IssueChange) => void }) {
  const app = useApp();
  const team = app.teams?.find((t) => t.key === issue.team);
  const none = <span className="muted">None</span>;
  const resolved = useResolved();
  const projects = useProjects();
  const project = projects.find((p) => p.slug === issue.project);
  return (
    <>
      <Prop label="Status" cmd="status">
        <StatusPicker team={issue.team} value={issue.status} onChange={(status) => patch({ status })} className="prop-btn">
          <StatusIcon status={issueStatus(app.teams, issue)} />
          {issueStatus(app.teams, issue).name}
        </StatusPicker>
      </Prop>
      <Prop label="Priority" cmd="priority">
        <PriorityPicker value={issue.priority} onChange={(priority) => patch({ priority })} className="prop-btn">
          <PriorityIcon priority={issue.priority} />
          {PRIORITY_LABELS[issue.priority]}
        </PriorityPicker>
      </Prop>
      {team?.estimateScale && (
        <Prop label="Estimate" cmd="estimate">
          <EstimatePicker scale={team.estimateScale} value={issue.estimate} onChange={(estimate) => patch({ estimate })} className="prop-btn">
            <EstimateIcon />
            {issue.estimate ? ESTIMATE_VALUES[team.estimateScale][issue.estimate - 1] : <span className="muted">No estimate</span>}
          </EstimatePicker>
        </Prop>
      )}
      <Prop label="Assignee" cmd="assignee">
        <AssigneePicker team={issue.team} value={issue.assignee} onChange={(assignee) => patch({ assignee })} className="prop-btn">
          <Avatar user={issue.assignee} />
          {issue.assignee ? <span dir="auto">{issue.assignee.name}</span> : <span className="muted">Unassigned</span>}
        </AssigneePicker>
      </Prop>
      <Prop label="Delegate" cmd="delegate">
        <DelegatePicker team={issue.team} value={issue.delegate} onChange={(delegate) => patch({ delegate })} className="prop-btn">
          <Avatar user={issue.delegate} />
          {issue.delegate ? <span dir="auto">{issue.delegate.name}</span> : none}
        </DelegatePicker>
      </Prop>
      <Prop label="Labels" cmd="labels">
        <LabelsPicker team={issue.team} value={issue.labels} onChange={(labels) => patch({ labels })} className="prop-btn prop-wrap">
          {issue.labels.length ? issue.labels.map((l) => <LabelChip key={l} path={l} />) : <span className="muted">Add labels</span>}
        </LabelsPicker>
      </Prop>
      <Prop label="Due date">
        <DueDate issue={issue} patch={patch} />
      </Prop>
      <Prop label="Project" cmd="project">
        <ProjectPicker projects={projects} value={issue.project} onChange={(project) => patch({ project, milestone: null })} className="prop-btn">
          {project ? <ProjectStatusIcon status={project.status} /> : <ProjectIcon />}
          {issue.project ? <span dir="auto">{project?.name ?? issue.project}</span> : <span className="muted">No project</span>}
        </ProjectPicker>
      </Prop>
      {issue.project && (
        <Prop label="Milestone" cmd="milestone">
          <MilestonePicker project={issue.project} value={issue.milestone} onChange={(milestone) => patch({ milestone })} className="prop-btn">
            {issue.milestone ? <span dir="auto">{issue.milestone}</span> : <span className="muted">No milestone</span>}
          </MilestonePicker>
        </Prop>
      )}
      {team?.cycleWeeks && (
        <Prop label="Cycle" cmd="cycle">
          <CyclePicker team={issue.team} value={issue.cycle} onChange={(cycle) => patch({ cycle })} className="prop-btn">
            <CycleIcon />
            {issue.cycle ? `Cycle ${issue.cycle}${issue.cycle === team.currentCycle ? " (current)" : ""}` : <span className="muted">No cycle</span>}
          </CyclePicker>
        </Prop>
      )}
      <Prop label="Team" cmd="team">
        <TeamPicker value={issue.team} onChange={(key) => key !== issue.team && patch({ team: key })} className="prop-btn">
          <TeamMark id={issue.team} />
          <span dir="auto">{team?.name ?? issue.team}</span>
        </TeamPicker>
      </Prop>
      <Prop label="Parent">
        <Relations ids={issue.parent ? [issue.parent] : []}>
          <ParentPicker
            value={issue.parent}
            onChange={(parent) => patch({ parent })}
            team={issue.team}
            exclude={[issue.id, ...issue.children.map((c) => c.id)]}
            className={issue.parent ? "icon-btn xs" : "prop-btn"}
          >
            {issue.parent ? <PencilIcon /> : none}
          </ParentPicker>
        </Relations>
      </Prop>
      <Prop label="Blocked by">
        <Relations ids={issue.blockedBy} resolved={resolved}>
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
          <Relations ids={issue.blocks} resolved={() => isClosedCategory(issueStatus(app.teams, issue).category)} />
        </Prop>
      )}
      <Prop label="Related">
        <Relations ids={issue.relatedTo}>
          <RelatedPicker
            value={issue.relatedTo}
            onChange={(relatedTo) => patch({ relatedTo })}
            exclude={[issue.id]}
            className={issue.relatedTo.length ? "icon-btn xs" : "prop-btn"}
          >
            {issue.relatedTo.length ? <PencilIcon /> : none}
          </RelatedPicker>
        </Relations>
      </Prop>
      <Prop label="Duplicate of">
        <Relations ids={issue.duplicateOf ? [issue.duplicateOf] : []}>
          <DuplicatePicker
            value={issue.duplicateOf}
            onChange={(duplicateOf) => patch({ duplicateOf })}
            exclude={[issue.id, ...issue.duplicates]}
            className={issue.duplicateOf ? "icon-btn xs" : "prop-btn"}
          >
            {issue.duplicateOf ? <PencilIcon /> : none}
          </DuplicatePicker>
        </Relations>
      </Prop>
      {issue.duplicates.length > 0 && (
        <Prop label="Duplicates">
          <Relations ids={issue.duplicates} />
        </Prop>
      )}
      <div className="props-meta">
        <span title={fullDate(issue.createdAt)}>Created {ago(issue.createdAt)}</span>
        <span title={fullDate(issue.updatedAt)}>Updated {ago(issue.updatedAt)}</span>
      </div>
    </>
  );
}

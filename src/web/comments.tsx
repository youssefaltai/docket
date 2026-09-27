// A comment thread with composer, shared by issues and docs; an issue's history interleaves with it.
import { Fragment, useState, type ReactNode } from "react";
import { PRIORITY_LABELS, STATUS_LABELS, type Activity, type Comment, type Priority, type Status, type UserRef } from "../shared/types";
import { Avatar, isMe, Kbd, Section } from "./components";
import { RichEditor } from "./editor";
import { PencilIcon, StatusIcon, TrashIcon } from "./icons";
import { Link } from "./routing";
import { useRun } from "./hooks";
import { Markdown } from "./markdown";
import { ask, errorToast } from "./toast";
import { ago, dayLabel, fullDate, MOD } from "./util";

export interface CommentActions {
  add: (body: string) => Promise<void>;
  edit: (id: number, body: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

/** A comment thread with composer, shared by issues and docs; `activity` (an issue's history) interleaves by time. */
export function Comments({
  title = "Comments",
  comments,
  activity = [],
  actions,
}: {
  title?: string;
  comments: Comment[];
  activity?: Activity[];
  actions: CommentActions;
}) {
  return (
    <Section title={title}>
      <ol className="timeline">
        {timeline(comments, activity).map((item) =>
          "body" in item ? <CommentItem key={`c${item.id}`} comment={item} actions={actions} /> : <Run key={item[0]!.rows[0]!.id} lines={item} />,
        )}
      </ol>
      <Composer onSubmit={actions.add} />
    </Section>
  );
}

/** One mutation: consecutive rows with one actor and time, never repeating a kind (that's the next mutation). */
type Line = { actor: UserRef; createdAt: string; rows: Activity[] };

/** Comments, and the runs of history lines between them, by time (history first on ties). */
function timeline(comments: Comment[], activity: Activity[]): (Comment | Line[])[] {
  const lines: Line[] = [];
  for (const row of activity) {
    const last = lines.at(-1);
    const same = last && last.createdAt === row.createdAt && last.actor.username === row.actor.username;
    if (same && !last.rows.some((r) => r.kind === row.kind)) last.rows.push(row);
    else lines.push({ actor: row.actor, createdAt: row.createdAt, rows: [row] });
  }
  const items: (Comment | Line[])[] = [];
  let next = 0;
  for (const c of [...comments, null]) {
    const run: Line[] = [];
    while (next < lines.length && (!c || lines[next]!.createdAt <= c.createdAt)) run.push(lines[next++]!);
    if (run.length) items.push(run);
    if (c) items.push(c);
  }
  return items;
}

/** History between two comments: a long run shows its last 2 lines until expanded (Linear's collapse). Creation always shows. */
function Run({ lines }: { lines: Line[] }) {
  const [open, setOpen] = useState(false);
  const pinned = lines[0]!.rows[0]!.kind === "created" ? lines.slice(0, 1) : [];
  const rest = lines.slice(pinned.length);
  const hidden = open || rest.length <= 3 ? 0 : rest.length - 2;
  return (
    <>
      {pinned.map((line) => (
        <HistoryLine key={line.rows[0]!.id} line={line} />
      ))}
      {hidden > 0 && (
        <li className="event">
          <button className="event-more" onClick={() => setOpen(true)}>
            Show {hidden} earlier changes
          </button>
        </li>
      )}
      {rest.slice(hidden).map((line) => (
        <HistoryLine key={line.rows[0]!.id} line={line} />
      ))}
    </>
  );
}

function HistoryLine({ line }: { line: Line }) {
  const moved = line.rows.find((r) => r.kind === "status" || r.kind === "claimed");
  return (
    <li className="event">
      <span className="event-icon">{moved ? <StatusIcon status={moved.to as Status} size={12} /> : <span className="event-dot" />}</span>
      <span>
        <b className="event-name" dir="auto">
          {line.actor.name}
        </b>{" "}
        {line.rows.map((r, i) => (
          <Fragment key={r.id}>
            {i > 0 && ", "}
            {describe(r, line.actor)}
          </Fragment>
        ))}
        {" · "}
        <time title={fullDate(line.createdAt)}>{ago(line.createdAt)}</time>
      </span>
    </li>
  );
}

/** One change in words: "moved from Todo to In Progress", "assigned to Ana", "added label bug". */
function describe({ kind, from, to }: Activity, actor: UserRef): ReactNode {
  const name = (text: string) => (
    <b className="event-name" dir="auto">
      {text}
    </b>
  );
  const who = (u: UserRef | null) => (u?.username === actor.username ? "themselves" : name(u?.name ?? "someone"));
  const issue = (id: string) => (
    <Link className="mono" to={`/issue/${id}`}>
      {id}
    </Link>
  );
  const joined = (items: string[], show: (item: string) => ReactNode) =>
    items.map((item, i) => (
      <Fragment key={item}>
        {i > 0 && ", "}
        {show(item)}
      </Fragment>
    ));
  // Labels, blockers and related issues: what was added, then what was removed.
  const diff = (show: (item: string) => ReactNode, add: string, remove: string) => {
    const [was, now] = [(from ?? []) as string[], (to ?? []) as string[]];
    const added = now.filter((v) => !was.includes(v));
    const removed = was.filter((v) => !now.includes(v));
    return (
      <>
        {added.length > 0 && (
          <>
            {add} {joined(added, show)}
          </>
        )}
        {added.length > 0 && removed.length > 0 && ", "}
        {removed.length > 0 && (
          <>
            {remove} {joined(removed, show)}
          </>
        )}
      </>
    );
  };
  switch (kind) {
    case "created":
      return "created the issue";
    case "title":
      return <>changed the title to “{name(to as string)}”</>;
    case "description":
      return "updated the description";
    case "status":
      return `moved from ${STATUS_LABELS[from as Status]} to ${STATUS_LABELS[to as Status]}`;
    case "priority":
      return to ? `set priority to ${PRIORITY_LABELS[to as Priority]}` : "removed priority";
    case "assignee":
      return to ? <>assigned to {who(to as UserRef)}</> : <>unassigned {who(from as UserRef)}</>;
    case "delegate":
      return to ? <>delegated to {who(to as UserRef)}</> : <>removed delegate {who(from as UserRef)}</>;
    case "labels":
      return diff(name, "added label", "removed label");
    case "parent":
      return to ? <>set parent to {issue(to as string)}</> : "removed parent";
    case "blockedBy":
      return diff(issue, "marked as blocked by", "removed blocker");
    case "relatedTo":
      return diff(issue, "marked as related to", "removed related");
    case "duplicateOf":
      return to ? <>marked as a duplicate of {issue(to as string)}</> : "unmarked as a duplicate";
    case "dueOn":
      return to ? `set the due date to ${dayLabel(to as string)}` : "removed the due date";
    case "claimed":
      return "claimed the issue";
    case "trashed":
      return "moved to trash";
    case "restored":
      return "restored";
  }
}

function CommentItem({ comment: c, actions }: { comment: Comment; actions: CommentActions }) {
  const [editing, setEditing] = useState(false);
  const save = async (body: string) => {
    if (body !== c.body.trim()) await actions.edit(c.id, body);
    setEditing(false);
  };
  const remove = async () => {
    if (await ask("Delete this comment? This can’t be undone.", "Delete")) actions.remove(c.id).catch(errorToast);
  };
  return (
    <li className="comment">
      <div className="comment-head">
        <Avatar user={c.author} />
        <span className="comment-author" dir="auto" title={`@${c.author.username}`}>
          {c.author.name}
        </span>
        <time title={fullDate(c.createdAt)}>{ago(c.createdAt)}</time>
        {c.editedAt && (
          <span className="comment-edited" title={`Edited ${fullDate(c.editedAt)}`}>
            edited
          </span>
        )}
        {isMe(c.author) && !editing && (
          <span className="comment-actions">
            <button className="icon-btn xs" onClick={() => setEditing(true)} aria-label="Edit comment" title="Edit">
              <PencilIcon />
            </button>
            <button className="icon-btn xs" onClick={remove} aria-label="Delete comment" title="Delete">
              <TrashIcon />
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <Composer initial={c.body} action="Save" onSubmit={save} onCancel={() => setEditing(false)} />
      ) : (
        <Markdown text={c.body} />
      )}
    </li>
  );
}

/** Writes a new comment, or edits one when given `initial` and `onCancel`. */
function Composer({
  onSubmit,
  initial = "",
  action = "Comment",
  onCancel,
}: {
  onSubmit: (body: string) => Promise<void>;
  initial?: string;
  action?: string;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [open, setOpen] = useState(!!onCancel); // the editor loads on first use
  const { busy, run } = useRun();
  const send = () => {
    const text = body.trim();
    if (text)
      run(async () => {
        await onSubmit(text);
        setBody("");
      });
  };
  if (!open)
    return (
      <button className="composer composer-idle" onClick={() => setOpen(true)} onFocus={() => setOpen(true)}>
        Leave a comment…
      </button>
    );
  return (
    <div className="composer">
      <RichEditor
        className="composer-input"
        label="Comment"
        placeholder="Leave a comment…"
        value={body}
        onChange={setBody}
        autoFocus
        onSubmit={send}
        onCancel={onCancel ?? (() => (document.activeElement as HTMLElement | null)?.blur())}
        footClass="composer-foot"
        foot={
          <>
            {onCancel && (
              <button className="btn btn-ghost btn-sm" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button className="btn btn-primary btn-sm" disabled={!body.trim() || busy} onClick={send}>
              {action} <Kbd>{MOD}↵</Kbd>
            </button>
          </>
        }
      />
    </div>
  );
}

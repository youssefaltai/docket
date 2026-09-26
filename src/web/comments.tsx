// A comment thread with composer, shared by issues and docs.
import { useRef, useState, type ReactNode } from "react";
import type { Comment } from "../shared/types";
import { Avatar, isMe, Kbd, Section } from "./components";
import { PencilIcon, TrashIcon } from "./icons";
import { useAutosize, useRun } from "./hooks";
import { Markdown } from "./markdown";
import { ask, errorToast } from "./toast";
import { ago, fullDate, MOD } from "./util";

export interface CommentActions {
  add: (body: string) => Promise<void>;
  edit: (id: number, body: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

/** A comment thread with composer, shared by issues and docs. `children` are extra timeline events. */
export function Comments({
  title = "Comments",
  comments,
  actions,
  children,
}: {
  title?: string;
  comments: Comment[];
  actions: CommentActions;
  children?: ReactNode;
}) {
  return (
    <Section title={title}>
      <ol className="timeline">
        {children}
        {comments.map((c) => (
          <CommentItem key={c.id} comment={c} actions={actions} />
        ))}
      </ol>
      <Composer onSubmit={actions.add} />
    </Section>
  );
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
  const { busy, run } = useRun();
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutosize(ref, body);
  const send = () => {
    const text = body.trim();
    if (text)
      run(async () => {
        await onSubmit(text);
        setBody("");
      });
  };
  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={2}
        dir="auto"
        placeholder="Leave a comment…"
        aria-label="Comment"
        autoFocus={!!onCancel}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (onCancel) onCancel();
            else e.currentTarget.blur();
          }
        }}
      />
      <div className="composer-foot">
        {onCancel && (
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn-primary btn-sm" disabled={!body.trim() || busy} onClick={send}>
          {action} <Kbd>{MOD}↵</Kbd>
        </button>
      </div>
    </div>
  );
}

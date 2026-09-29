// The inbox (Linear's): what needs you in this workspace, one row per issue or doc; and the bell that follows one.
import { useEffect } from "react";
import type { Inbox, Notification } from "../shared/types";
import { api } from "./api";
import {
  Avatar,
  BellIcon,
  DocIcon,
  EmptyState,
  InboxIcon,
  Link,
  MenuButton,
  StatusIcon,
  TrashIcon,
  cls,
  errorToast,
  fullDate,
  isEditable,
  timeAgo,
  useApp,
  useKeydown,
  useLive,
  useTitle,
  useStatusOf,
} from "./ui";

/** A row: an issue's or doc's notifications, newest first. */
interface Group {
  key: string;
  latest: Notification;
  ids: number[];
  unread: boolean;
}

function groups(list: Notification[]): Group[] {
  const byTarget = new Map<string, Group>();
  for (const n of list) {
    const key = n.issue ? `issue:${n.issue.id}` : n.document ? `doc:${n.document.slug}` : `n:${n.id}`;
    const g = byTarget.get(key);
    if (g) {
      g.ids.push(n.id);
      g.unread ||= !n.readAt;
    } else byTarget.set(key, { key, latest: n, ids: [n.id], unread: !n.readAt });
  }
  return [...byTarget.values()];
}

/** Keys: J/K or arrows move (the app's), Enter opens, U toggles read, Alt+U all read, Backspace deletes, Shift+Backspace deletes all read. */
export function InboxView() {
  const { inbox, setInbox, reloadInbox } = useApp();
  const live = useLive();
  useEffect(reloadInbox, [live, reloadInbox]); // titles and statuses stay current
  useTitle("Inbox");

  const rows = inbox ? groups(inbox.notifications) : [];
  const apply = (call: Promise<Inbox>, then?: () => void) =>
    call.then((fresh) => {
      setInbox(fresh);
      then?.();
    }, errorToast);
  const open = (g: Group) => g.unread && apply(api.markRead(true, g.ids));
  const toggle = (g: Group) => apply(api.markRead(g.unread, g.ids));
  const markAll = () => apply(api.markRead(true));
  const deleteRead = () => apply(api.deleteNotifications());
  // Deleting a row keeps focus where it was, on the next one.
  const remove = (g: Group) => {
    const at = rows.indexOf(g);
    apply(api.deleteNotifications(g.ids), () =>
      requestAnimationFrame(() => {
        const items = document.querySelectorAll<HTMLElement>("[data-nav]");
        items[Math.min(at, items.length - 1)]?.focus();
      }),
    );
  };

  useKeydown((e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || isEditable(e.target) || document.querySelector(".pop, .backdrop")) return;
    const focused = rows.find((g) => g.key === (document.activeElement as HTMLElement | null)?.dataset.key);
    const u = e.code === "KeyU" || e.key.toLowerCase() === "u"; // Option+U types "¨" on a Mac: go by the key
    if (u && e.altKey) markAll();
    else if (u && !e.shiftKey && focused) toggle(focused);
    else if (e.key === "Backspace" && e.shiftKey) deleteRead();
    else if (e.key === "Backspace" && !e.altKey && focused) remove(focused);
    else return;
    e.preventDefault();
  });

  const unread = inbox?.unread ?? 0;
  return (
    <>
      <header className="header">
        <MenuButton />
        <div className="header-title">
          <span>Inbox</span>
          {unread > 0 && <span className="header-count">{unread}</span>}
        </div>
        <span className="grow" />
        {rows.length > 0 && (
          <>
            <button className="btn btn-sm" onClick={markAll} disabled={!unread} title="Mark all read (Alt+U)">
              Mark all read
            </button>
            <button className="icon-btn" onClick={deleteRead} aria-label="Delete read" title="Delete read (Shift+Backspace)">
              <TrashIcon />
            </button>
          </>
        )}
      </header>
      <div className="content">
        {inbox && !rows.length ? (
          <EmptyState icon={<InboxIcon />} title="You’re all caught up">
            Mentions, assignments and updates on what you follow show up here.
          </EmptyState>
        ) : (
          <div className="list">
            {rows.map((g) => (
              <Row key={g.key} group={g} onOpen={() => open(g)} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Row({ group, onOpen }: { group: Group; onOpen: () => void }) {
  const n = group.latest;
  const [href, title] = n.issue ? [`/issue/${n.issue.id}`, n.issue.title] : [`/doc/${n.document?.slug}`, n.document?.title];
  return (
    <div className={cls("row inbox-row", group.unread && "unread")}>
      <span className="inbox-dot" title={group.unread ? "Unread" : undefined} />
      <Avatar user={n.actor} />
      <div className="inbox-main">
        <div className="inbox-target">
          {n.issue ? <span className="row-id">{n.issue.id}</span> : <DocIcon className="doc-icon" />}
          <Link to={href} className="row-title" data-nav data-key={group.key} dir="auto" onClick={onOpen}>
            {title}
          </Link>
        </div>
        <div className="inbox-event">
          <Event n={n} />
          {group.ids.length > 1 && <span className="inbox-more">+{group.ids.length - 1}</span>}
        </div>
      </div>
      <time className="row-time" dateTime={n.createdAt} title={fullDate(n.createdAt)}>
        {timeAgo(n.createdAt)}
      </time>
    </div>
  );
}

/** "Ana mentioned you", "Claude moved to In Review", "Ana commented: …". */
function Event({ n }: { n: Notification }) {
  const statusOf = useStatusOf();
  const who = <span dir="auto">{n.actor.name}</span>;
  // A status key of the issue's team (its identifier's prefix).
  const moved = n.status ? statusOf(n.issue?.id.replace(/-\d+$/, "") ?? "", n.status) : null;
  const excerpt = n.comment && (
    <>
      : <span dir="auto">{n.comment.excerpt}</span>
    </>
  );
  switch (n.kind) {
    case "assigned":
      return <span className="inbox-text">{who} assigned you</span>;
    case "delegated":
      return <span className="inbox-text">{who} delegated to you</span>;
    case "mentioned":
      return <span className="inbox-text">{who} mentioned you{excerpt}</span>;
    case "commented":
      return <span className="inbox-text">{who} commented{excerpt}</span>;
    case "status":
      return (
        <span className="inbox-text">
          {who} moved to <StatusIcon status={moved!} /> {moved!.name}
        </span>
      );
  }
}

/** Follow or unfollow an issue or doc (Shift+S on its page): subscribers get its comments and status changes. */
export function SubscribeButton({ subscribed, onToggle }: { subscribed: boolean; onToggle: () => void }) {
  useKeydown((e) => {
    if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isEditable(e.target)) return;
    if ((e.code !== "KeyS" && e.key !== "S") || document.querySelector(".pop, .backdrop")) return;
    e.preventDefault();
    onToggle();
  });
  return (
    <button
      className={cls("icon-btn", subscribed && "subscribed")}
      onClick={onToggle}
      aria-label="Subscribe"
      aria-pressed={subscribed}
      title={subscribed ? "Unsubscribe (Shift+S)" : "Subscribe (Shift+S)"}
    >
      <BellIcon />
    </button>
  );
}

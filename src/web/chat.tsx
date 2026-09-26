// The assistant panel: ⌘J or the sidebar opens it. Replies stream from docket-chat through /api/chat (see
// its CHAT_API.md). A change the assistant proposes shows as a card with every real argument; nothing
// changes until the person confirms it.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { store } from "./api";
import { chatApi, type ChatAction, type ChatConversation, type ChatEvent, type ChatMessage, type ChatTool } from "./chatApi";
import { CloseIcon, ComposeIcon, HistoryIcon, Kbd, Link, MOD, Markdown, PencilIcon, TrashIcon, ask, cls, errorToast, fullDate, timeAgo, useAutosize, useKeydown } from "./ui";

// ---------- Open or closed ----------

let open = false;
const openListeners = new Set<() => void>();

export function toggleChat(next = !open) {
  open = next;
  openListeners.forEach((l) => l());
}

const useOpen = () =>
  useSyncExternalStore(
    (cb) => {
      openListeners.add(cb);
      return () => void openListeners.delete(cb);
    },
    () => open,
  );

export const ChatIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z" />
  </svg>
);

/** ⌘J anywhere toggles the panel. Mounted once it's first opened, then kept (hidden) so a reply keeps streaming. */
export function ChatDock() {
  const isOpen = useOpen();
  const [mounted, setMounted] = useState(isOpen);
  useKeydown((e) => {
    if (document.querySelector(".pop, .backdrop")) return; // like the app's other shortcuts: not over a menu or dialog
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
      e.preventDefault();
      toggleChat();
    }
  });
  if (isOpen && !mounted) setMounted(true);
  return mounted ? <ChatPanel open={isOpen} /> : null;
}

// ---------- The panel ----------

type Live = ChatMessage & { error?: string };

const SUGGESTIONS = ["What's in progress right now?", "What's assigned to me?", "Summarize the most recent docs"];

function ChatPanel({ open }: { open: boolean }) {
  const [view, setView] = useState<"thread" | "list">("thread");
  const [conversation, setConversation] = useState<string | null>(() => store.get("chat.conversation") || null);
  const [title, setTitle] = useState("");
  const [messages, setMessages] = useState<Live[]>([]);
  const [pending, setPending] = useState<ChatAction | null>(null);
  const [streaming, setStreaming] = useState<AbortController | null>(null);
  const [draft, setDraft] = useState("");
  const streamingRef = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow the reply while the reader is at the bottom
  useAutosize(input, draft);

  // Focus moves in when the panel opens, and back to what opened it when it closes, unless something
  // else has taken it (as the app's modals do).
  const opener = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open) {
      opener.current = document.activeElement as HTMLElement | null;
      input.current?.focus();
    } else
      setTimeout(() => {
        const at = document.activeElement;
        if (!at || at === document.body || panel.current?.contains(at)) opener.current?.focus?.({ preventScroll: true });
      });
  }, [open]);

  /** Opens a conversation (null: a new one). `stay` keeps the list open, e.g. after deleting the current one. */
  const select = (id: string | null, stay = false) => {
    store.set("chat.conversation", id ?? "");
    setConversation(id);
    if (!id) {
      setTitle("");
      setMessages([]);
      setPending(null);
    }
    if (stay) return;
    setView("thread");
    setTimeout(() => input.current?.focus());
  };

  const load = (id: string) =>
    chatApi.get(id).then(
      (c) => {
        setTitle(c.title);
        setMessages(c.messages);
        setPending(c.pendingAction);
      },
      (e) => (e?.status === 404 ? select(null) : errorToast(e)),
    );

  useEffect(() => {
    // A conversation that just started streaming is already on screen.
    if (conversation && !streamingRef.current) load(conversation);
  }, [conversation]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  /** Streams one reply into a new assistant message (after `question`, if there is one). */
  async function run(start: (signal: AbortSignal, on: (e: ChatEvent) => void) => Promise<void>, question?: string) {
    const ctrl = new AbortController();
    streamingRef.current = ctrl;
    setStreaming(ctrl);
    stick.current = true;
    const liveId = `live-${Date.now()}`;
    const at = new Date().toISOString();
    setMessages((ms) => [
      ...ms,
      ...(question ? [{ id: `${liveId}-q`, role: "user" as const, content: question, createdAt: at }] : []),
      { id: liveId, role: "assistant", content: "", tools: [], status: "streaming", createdAt: at },
    ]);
    const patch = (fn: (m: Live) => Live) => setMessages((ms) => ms.map((m) => (m.id === liveId ? fn(m) : m)));
    let started = false;
    try {
      await start(ctrl.signal, (e) => {
        started = true;
        if (e.event === "conversation") {
          setTitle(e.data.title);
          if (e.data.created) {
            store.set("chat.conversation", e.data.id);
            setConversation(e.data.id);
          }
        } else if (e.event === "delta") patch((m) => ({ ...m, content: m.content + e.data.text }));
        else if (e.event === "tool") patch((m) => ({ ...m, tools: upsert(m.tools ?? [], e.data) }));
        else if (e.event === "confirm") setPending(e.data);
        else if (e.event === "title") setTitle(e.data.title);
        else if (e.event === "done") patch((m) => ({ ...m, status: "complete" }));
        else if (e.event === "error") patch((m) => ({ ...m, status: "error", error: e.data.message }));
      });
    } catch (err) {
      if (ctrl.signal.aborted) patch((m) => ({ ...m, status: "stopped" }));
      else if (!started) {
        // Refused before anything streamed (busy, rate limited, no model…): nothing was kept.
        setMessages((ms) => ms.filter((m) => m.id !== liveId && m.id !== `${liveId}-q`));
        if (question) setDraft((d) => d || question);
        errorToast(err);
      } else patch((m) => ({ ...m, status: "error", error: "The connection dropped. Try again." }));
    } finally {
      streamingRef.current = null;
      setStreaming(null);
      input.current?.focus();
    }
  }

  const send = (text: string) => {
    const question = text.trim();
    if (!question || streamingRef.current) return;
    setDraft("");
    setPending(null); // a change still waiting is dropped when the conversation moves on
    void run((signal, on) => chatApi.send({ ...(conversation ? { conversationId: conversation } : {}), message: question }, signal, on), question);
  };

  const confirm = (a: ChatAction) => {
    setPending(null);
    void run((signal, on) => chatApi.confirm(a.actionId, signal, on)).then(() => {
      if (conversation) load(conversation); // the stored reply: the proposal and its follow-up as one message
    });
  };

  const cancel = (a: ChatAction) => {
    setPending(null);
    chatApi
      .cancel(a.actionId)
      .catch(errorToast)
      .finally(() => {
        if (conversation) load(conversation);
        input.current?.focus();
      });
  };

  const lastQuestion = [...messages].reverse().find((m) => m.role === "user")?.content;
  const last = messages.at(-1);

  return (
    <aside
      ref={panel}
      className="chat-panel"
      hidden={!open}
      aria-label="Ask Docket"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          toggleChat(false);
        }
      }}
    >
      <header className="chat-head">
        <button
          className="icon-btn sm"
          aria-label="Conversations"
          aria-pressed={view === "list"}
          title="Conversations"
          onClick={() => setView((v) => (v === "list" ? "thread" : "list"))}
        >
          <HistoryIcon />
        </button>
        <h2 className="chat-title" dir="auto">
          {view === "list" ? "Conversations" : title || "Ask Docket"}
        </h2>
        <button className="icon-btn sm" aria-label="New conversation" title="New conversation" onClick={() => select(null)}>
          <ComposeIcon />
        </button>
        <button className="icon-btn sm" aria-label="Close" title={`Close (${MOD}J)`} onClick={() => toggleChat(false)}>
          <CloseIcon />
        </button>
      </header>

      {view === "list" ? (
        <ConversationList
          current={conversation}
          onPick={select}
          onDeleted={(id) => id === conversation && select(null, true)}
          onRenamed={(id, t) => id === conversation && setTitle(t)}
        />
      ) : (
        <>
          <div
            className="chat-thread"
            ref={scroller}
            role="log"
            aria-live="polite"
            aria-label="Conversation"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            }}
          >
            {messages.length === 0 && (
              <div className="chat-welcome">
                <ChatIcon />
                <h3>Ask about your work</h3>
                <p>Answers come from the issues, docs and teams you can see in Docket.</p>
                {SUGGESTIONS.map((q) => (
                  <button key={q} className="chat-suggestion" onClick={() => send(q)}>
                    {q}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="chat-msg chat-user" dir="auto">
                  {m.content}
                </div>
              ) : (
                <Reply key={m.id} message={m} onRetry={m === last && lastQuestion && !streaming ? () => send(lastQuestion) : undefined} />
              ),
            )}
            {pending && <ConfirmCard action={pending} busy={!!streaming} onConfirm={() => confirm(pending)} onCancel={() => cancel(pending)} />}
          </div>

          <form
            className="chat-compose"
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
          >
            <textarea
              ref={input}
              className="input"
              rows={1}
              value={draft}
              placeholder="Ask about your issues and docs"
              aria-label="Message"
              maxLength={4000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(draft);
                }
              }}
            />
            {streaming ? (
              <button type="button" className="btn" onClick={() => streaming.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={!draft.trim()} title={`Send (${MOD}↵)`}>
                Send
              </button>
            )}
          </form>
        </>
      )}
    </aside>
  );
}

const upsert = (tools: ChatTool[], t: ChatTool) => (tools.some((x) => x.callId === t.callId) ? tools.map((x) => (x.callId === t.callId ? t : x)) : [...tools, t]);

function Reply({ message: m, onRetry }: { message: Live; onRetry?: () => void }) {
  const streaming = m.status === "streaming";
  return (
    <article className="chat-msg chat-reply" aria-busy={streaming}>
      {!!m.tools?.length && (
        <div className="chat-tools">
          {m.tools.map((t, i) => (
            <span key={t.callId ?? i} className={cls("chat-tool", t.status)} title={`${t.summary} (${t.status})`}>
              {t.summary || t.name}
            </span>
          ))}
        </div>
      )}
      {/* No images: a reply's image URL could carry what the model read to someone else's server on render. */}
      {m.content ? <Markdown text={m.content} images={false} /> : streaming && <span className="chat-thinking">Thinking…</span>}
      {m.status === "stopped" && <p className="chat-note">Stopped.</p>}
      {m.status === "error" && <p className="chat-note chat-error">{m.error ?? "This reply didn't finish."}</p>}
      {onRetry && (m.status === "stopped" || m.status === "error") && (
        <button className="btn btn-sm chat-retry" onClick={onRetry}>
          Retry
        </button>
      )}
    </article>
  );
}

// ---------- A proposed change ----------

/** update_issue → "Update issue" */
const actionName = (tool: string) => tool.charAt(0).toUpperCase() + tool.slice(1).replace(/_/g, " ");

/**
 * Every argument that will run, as key: value, from the stored change itself. The summary is secondary:
 * argument text comes from the model (and whatever it read), so the card shows exactly what runs.
 */
function ConfirmCard({ action, busy, onConfirm, onCancel }: { action: ChatAction; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const name = actionName(action.tool);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" }); // newer browsers return a promise: not a cleanup
  }, []);
  return (
    <section ref={ref} className="chat-confirm" aria-labelledby="chat-confirm-title">
      <h3 id="chat-confirm-title">{name}?</h3>
      <dl className="chat-args">
        {Object.entries(action.args).map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>
              {k === "baseUpdatedAt" && typeof v === "string" ? `only if unchanged since ${fullDate(v)}` : <Value value={v} />}
            </dd>
          </Fragment>
        ))}
      </dl>
      <p className="chat-summary" title={action.summary}>
        {action.summary}
      </p>
      <p className="chat-note">Nothing changes until you confirm. Expires in {until(action.expiresAt)}.</p>
      <div className="chat-confirm-actions">
        <button className="btn btn-primary" disabled={busy} onClick={onConfirm}>
          {name}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

const until = (iso: string) => `${Math.max(1, Math.round((Date.parse(iso) - Date.now()) / 60_000))} min`;

function Value({ value }: { value: unknown }): ReactNode {
  if (value === null) return <em>none (clears it)</em>;
  if (Array.isArray(value))
    return value.length ? (
      value.map((v, i) => (
        <Fragment key={i}>
          {i > 0 && ", "}
          <Value value={v} />
        </Fragment>
      ))
    ) : (
      <em>none</em>
    );
  if (typeof value === "string") {
    if (/^[A-Z]{2,5}-\d+$/.test(value)) return <Link to={`/issue/${value}`}>{value}</Link>;
    if (!value) return <em>empty</em>;
    if (value.length > 160 || value.includes("\n"))
      return (
        <details>
          <summary dir="auto">
            <span className="chat-preview">{value.slice(0, 100).trim()}… </span>
            <span className="chat-note">({value.length} characters)</span>
          </summary>
          <pre dir="auto">{value}</pre>
        </details>
      );
    return <span dir="auto">{value}</span>;
  }
  if (typeof value === "object") return <pre>{JSON.stringify(value, null, 2)}</pre>;
  return <span>{String(value)}</span>;
}

// ---------- Conversations ----------

function ConversationList({
  current,
  onPick,
  onDeleted,
  onRenamed,
}: {
  current: string | null;
  onPick: (id: string) => void;
  onDeleted: (id: string) => void;
  onRenamed: (id: string, title: string) => void;
}) {
  const [list, setList] = useState<ChatConversation[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const more = (after?: string) =>
    chatApi.list(after).then((r) => {
      setList((l) => [...(after ? (l ?? []) : []), ...r.conversations]);
      setNext(r.nextCursor);
    }, errorToast);
  useEffect(() => void more(), []);

  const rename = (c: ChatConversation, title: string) => {
    setEditing(null);
    const t = title.trim();
    if (!t || t === c.title) return;
    chatApi.rename(c.id, t).then((r) => {
      setList((l) => l?.map((x) => (x.id === c.id ? r : x)) ?? null);
      onRenamed(c.id, r.title);
    }, errorToast);
  };
  const remove = (c: ChatConversation) => {
    void ask(`Delete “${c.title}”? This can't be undone.`, "Delete").then(async (yes) => {
      if (!yes) return;
      await chatApi.remove(c.id).then(() => {
        setList((l) => l?.filter((x) => x.id !== c.id) ?? null);
        onDeleted(c.id);
      }, errorToast);
    });
  };

  if (!list) return <div className="chat-list" />;
  return (
    <div className="chat-list">
      {list.length === 0 && <p className="chat-note chat-empty">No conversations yet.</p>}
      {list.map((c) =>
        editing === c.id ? (
          <input
            key={c.id}
            className="input chat-rename"
            defaultValue={c.title}
            aria-label="Conversation title"
            maxLength={100}
            autoFocus
            onBlur={(e) => rename(c, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") rename(c, e.currentTarget.value);
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setEditing(null);
              }
            }}
          />
        ) : (
          <div key={c.id} className={cls("chat-row", c.id === current && "active")}>
            <button className="chat-row-open" onClick={() => onPick(c.id)} aria-current={c.id === current || undefined}>
              <span className="chat-row-title" dir="auto">
                {c.title}
              </span>
              <span className="chat-row-time">{timeAgo(c.updatedAt)}</span>
            </button>
            <button className="icon-btn xs" aria-label={`Rename “${c.title}”`} title="Rename" onClick={() => setEditing(c.id)}>
              <PencilIcon />
            </button>
            <button className="icon-btn xs" aria-label={`Delete “${c.title}”`} title="Delete" onClick={() => remove(c)}>
              <TrashIcon />
            </button>
          </div>
        ),
      )}
      {next && (
        <button className="btn btn-sm chat-more" onClick={() => more(next)}>
          Show more
        </button>
      )}
    </div>
  );
}

/** The sidebar's entry. */
export function ChatNavItem() {
  return (
    <button className="nav-item" onClick={() => toggleChat()}>
      <ChatIcon />
      <span className="nav-label">Ask Docket</span>
      <Kbd>{MOD}J</Kbd>
    </button>
  );
}

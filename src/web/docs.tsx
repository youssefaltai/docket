// Documents: the docs list, the doc page (reading, editing, outline, history) and its editor.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Document, DocumentSummary, DocumentVersion, DocumentVersionSummary } from "../shared/types";
import { HttpError, api } from "./api";
import { Comments, TitleEditor } from "./issue";
import { ProjectPicker } from "./pickers";
import {
  Avatar,
  ChevronRightIcon,
  CloseIcon,
  DocIcon,
  EmptyState,
  HistoryIcon,
  Kbd,
  Link,
  Markdown,
  MenuButton,
  PlusIcon,
  ProjectMark,
  ProjectTabs,
  ProjectTitle,
  SearchIcon,
  StatusIcon,
  TrashIcon,
  ago,
  cls,
  errorToast,
  fullDate,
  isEditable,
  nav,
  navigate,
  toast,
  useApp,
  useDebounced,
  useLive,
} from "./ui";

// ---------- Docs list ----------

export function DocsView({ projectKey }: { projectKey: string | null }) {
  const app = useApp();
  const live = useLive();
  const project = projectKey ? app.projects?.find((p) => p.key === projectKey) : undefined;
  const [search, setSearch] = useState("");
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const q = useDebounced(search.trim(), 150);
  const seq = useRef(0);

  useEffect(() => {
    nav.lastDocs = location.pathname;
    document.title = `${project ? `${project.name} docs` : projectKey || "All docs"} · Docket`;
  }, [projectKey, project?.name]);

  // "All docs" is the current workspace's; wait until it's known.
  const workspace = projectKey ? undefined : app.workspace?.key;
  useEffect(() => {
    if (!projectKey && !workspace) return;
    const n = ++seq.current;
    api
      .documents({ project: projectKey ?? undefined, workspace, q: q || undefined })
      .then((list) => n === seq.current && setDocs(list))
      .catch((e) => {
        if (n !== seq.current) return;
        errorToast(e);
        setDocs((cur) => cur ?? []);
      });
  }, [projectKey, workspace, q, live]);

  // Server order is project key, then position; keep it while grouping.
  const groups = new Map<string, DocumentSummary[]>();
  for (const d of docs ?? []) groups.set(d.project, [...(groups.get(d.project) ?? []), d]);

  let body;
  if (projectKey && app.projects && !project) {
    body = (
      <EmptyState title="Project not found" action={<Link className="btn" to="/docs">All docs</Link>}>
        There’s no project with the key {projectKey}.
      </EmptyState>
    );
  } else if (!docs) {
    body = null;
  } else if (docs.length === 0) {
    body = q ? (
      <EmptyState
        icon={<SearchIcon />}
        title="No matching docs"
        action={
          <button className="btn" onClick={() => setSearch("")}>
            Clear search
          </button>
        }
      >
        Try a different search.
      </EmptyState>
    ) : (
      <EmptyState
        icon={<DocIcon />}
        title="No docs yet"
        action={
          <button className="btn btn-primary" onClick={() => app.newDoc(projectKey ?? undefined)}>
            New doc
          </button>
        }
      >
        Specs, plans and notes{project ? ` for ${project.name}` : ""}, written in Markdown by you or your agents.
      </EmptyState>
    );
  } else if (projectKey) {
    body = <div className="list">{docs.map((d) => <DocRow key={d.slug} doc={d} />)}</div>;
  } else {
    body = (
      <div className="list">
        {[...groups].map(([key, list]) => (
          <section key={key}>
            <div className="group">
              <Link to={`/p/${key}/docs`} className="group-toggle">
                <ProjectMark id={key} />
                <span className="group-label" dir="auto">
                  {app.projects?.find((p) => p.key === key)?.name ?? key}
                </span>
                <span className="count">{list.length}</span>
              </Link>
              <button className="icon-btn sm" onClick={() => app.newDoc(key)} aria-label="New doc" title="New doc">
                <PlusIcon />
              </button>
            </div>
            {list.map((d) => (
              <DocRow key={d.slug} doc={d} />
            ))}
          </section>
        ))}
      </div>
    );
  }

  return (
    <>
      <header className="header">
        <MenuButton />
        <div className="header-title">
          {project ? <ProjectTitle project={project} /> : <span>{projectKey ?? "All docs"}</span>}
          {docs && docs.length > 0 && <span className="header-count">{docs.length}</span>}
        </div>
        {project && <ProjectTabs project={project.key} view="docs" />}
        <button className="icon-btn mobile-only" onClick={() => app.newDoc(projectKey ?? undefined)} aria-label="New doc">
          <PlusIcon />
        </button>
        <div className="controls">
          <label className="search">
            <SearchIcon />
            <input
              id="search"
              type="search"
              placeholder="Search docs"
              value={search}
              autoComplete="off"
              dir="auto"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  if (search) setSearch("");
                  else e.currentTarget.blur();
                } else if (e.key === "ArrowDown" || e.key === "Enter") {
                  e.preventDefault();
                  document.querySelector<HTMLElement>("[data-nav]")?.focus();
                }
              }}
            />
            {!search && <Kbd>/</Kbd>}
          </label>
          <button className="btn btn-sm desktop-only" onClick={() => app.newDoc(projectKey ?? undefined)}>
            <PlusIcon /> New doc
          </button>
        </div>
      </header>
      <div className="content">{body}</div>
    </>
  );
}

function DocRow({ doc }: { doc: DocumentSummary }) {
  return (
    <div className="row">
      <DocIcon className="doc-icon" />
      <Link to={`/doc/${doc.slug}`} className="row-title" data-nav dir="auto">
        {doc.title}
      </Link>
      <span className="grow" />
      <span className="row-meta" title={`Updated ${fullDate(doc.updatedAt)} by ${doc.updatedBy}`}>
        Updated {ago(doc.updatedAt)}
        <span className="row-by">
          {" by "}
          <span dir="auto">{doc.updatedBy}</span>
        </span>
      </span>
    </div>
  );
}

// ---------- Doc page ----------

type SaveState = "idle" | "saving" | "saved" | "error";
const SAVE_LABELS: Record<SaveState, string> = { idle: "", saving: "Saving…", saved: "Saved", error: "Not saved" };

export function DocPage({ slug }: { slug: string }) {
  const app = useApp();
  const live = useLive();
  const [doc, setDoc] = useState<Document | null>(null);
  const [missing, setMissing] = useState(false);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState(() => nav.editDoc === slug);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [history, setHistory] = useState(false);
  const [preview, setPreview] = useState<DocumentVersion | null>(null);
  const seq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const startAt = useRef(0); // scroll ratio to open the editor at
  const unsaved = useRef(false); // editor holds changes it can't save (remote conflict)
  const { setDocProject } = app;

  useEffect(() => {
    if (nav.editDoc === slug) nav.editDoc = "";
  }, [slug]);

  useEffect(() => {
    const n = ++seq.current;
    api
      .document(slug)
      .then((d) => {
        if (n !== seq.current) return;
        setDoc(d);
        setMissing(false);
      })
      .catch((e) => {
        if (n !== seq.current) return;
        if (e instanceof HttpError && e.status === 404) setMissing(true);
        else errorToast(e);
      });
  }, [slug, live, tick]);

  useEffect(() => {
    document.title = `${doc?.title || "Doc"} · Docket`;
  }, [doc?.title]);

  useEffect(() => setDocProject(doc?.project ?? null), [doc?.project, setDocProject]);
  useEffect(() => () => setDocProject(null), [setDocProject]);

  // Honor #section links once the content is there.
  const loaded = !!doc;
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (loaded && id) body.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView();
  }, [loaded]);

  const startEdit = () => {
    const sc = scroller.current;
    startAt.current = sc ? sc.scrollTop / Math.max(1, sc.scrollHeight - sc.clientHeight) : 0;
    setPreview(null);
    setHistory(false);
    setEditing(true);
  };
  const stopEdit = () => {
    if (unsaved.current && !confirm("Discard your unsaved changes?")) return false;
    setEditing(false);
    setSaveState("idle");
    return true;
  };

  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
    if (document.querySelector(".pop, .backdrop")) return;
    if ((e.key === "e" || e.key === "E") && doc && !editing) {
      e.preventDefault();
      startEdit();
    } else if (e.key === "Escape" && (editing || preview || history)) {
      e.preventDefault();
      if (editing) stopEdit();
      else if (preview) setPreview(null);
      else setHistory(false);
    }
  };
  useEffect(() => {
    // Capture phase: runs before the app's global Escape (which leaves the page).
    const handler = (e: KeyboardEvent) => keys.current(e);
    addEventListener("keydown", handler, true);
    return () => removeEventListener("keydown", handler, true);
  }, []);

  const outline = useOutline(body, scroller);

  const projectKey = doc?.project;
  const project = app.projects?.find((p) => p.key === projectKey);
  const header = (
    <header className="header">
      <MenuButton />
      <nav className="crumbs">
        {projectKey ? (
          <Link to={`/p/${projectKey}/docs`} dir="auto">
            {project?.name ?? projectKey}
          </Link>
        ) : (
          <Link to={nav.lastDocs}>Docs</Link>
        )}
        <ChevronRightIcon />
        <span className="crumb-doc" dir="auto">
          {doc?.title}
        </span>
      </nav>
      <span className="grow" />
      {doc && (
        <>
          {editing && <span className={cls("save-state", saveState === "error" && "save-error")}>{SAVE_LABELS[saveState]}</span>}
          {editing ? (
            <button className="btn btn-sm" onClick={stopEdit}>
              Done
            </button>
          ) : (
            <button className="btn btn-sm" onClick={startEdit}>
              Edit <Kbd>E</Kbd>
            </button>
          )}
          <button
            className="icon-btn"
            onClick={() => (history ? (setHistory(false), setPreview(null)) : stopEdit() && setHistory(true))}
            aria-label="Version history"
            aria-expanded={history}
            title="Version history"
          >
            <HistoryIcon />
          </button>
          <button className="icon-btn" onClick={() => remove(doc)} aria-label="Delete doc" title="Delete doc">
            <TrashIcon />
          </button>
        </>
      )}
    </header>
  );

  if (missing)
    return (
      <>
        {header}
        <div className="content">
          <EmptyState title="Doc not found" action={<Link className="btn" to={nav.lastDocs}>Back to docs</Link>}>
            There’s no doc at /doc/{slug}. It may have been deleted.
          </EmptyState>
        </div>
      </>
    );
  if (!doc) return header;

  const apply = (fresh: Document) => {
    ++seq.current; // drop any in-flight fetch that predates this change
    setDoc(fresh);
  };
  const patch = (p: Parameters<typeof api.updateDocument>[1]) =>
    api.updateDocument(doc.slug, p).then(apply, (e) => {
      errorToast(e);
      setTick((t) => t + 1);
    });

  const restore = async (v: DocumentVersion) => {
    try {
      apply(await api.updateDocument(doc.slug, { content: v.content, checkpoint: true }));
      setPreview(null);
      toast(`Restored the version from ${fullDate(v.createdAt)}`);
    } catch (e) {
      errorToast(e);
    }
  };

  const shown = preview ? preview.content : doc.content;

  return (
    <>
      {header}
      <div className="doc">
        <div className="doc-scroll" ref={scroller}>
          <div className="doc-grid">
            <article className="doc-col">
              <TitleEditor
                key={doc.slug}
                className="doc-title"
                placeholder="Untitled"
                value={doc.title}
                onSave={(title) => patch({ title })}
              />
              <div className="doc-meta">
                <ProjectPicker value={doc.project} onChange={(p) => p !== doc.project && patch({ project: p })} className="doc-meta-btn">
                  <ProjectMark id={doc.project} />
                  <span dir="auto">{project?.name ?? doc.project}</span>
                </ProjectPicker>
                <span aria-hidden="true">·</span>
                <span title={fullDate(doc.updatedAt)}>
                  Updated {ago(doc.updatedAt)} by <span dir="auto">{doc.updatedBy}</span>
                </span>
                {doc.versionCount > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <button className="doc-meta-btn" onClick={() => stopEdit() && setHistory(true)}>
                      {doc.versionCount} {doc.versionCount === 1 ? "version" : "versions"}
                    </button>
                  </>
                )}
              </div>

              {preview && (
                <div className="doc-banner">
                  <HistoryIcon />
                  <span className="doc-banner-text">
                    Version from <time>{fullDate(preview.createdAt)}</time> by <span dir="auto">{preview.author}</span>
                  </span>
                  <span className="grow" />
                  <button className="btn btn-ghost btn-sm" onClick={() => setPreview(null)}>
                    Cancel
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={() => restore(preview)}>
                    Restore
                  </button>
                </div>
              )}

              {editing ? (
                <DocEditor
                  doc={doc}
                  scroller={scroller}
                  startAt={startAt.current}
                  unsaved={unsaved}
                  onSaved={apply}
                  onLocal={(content) => setDoc((d) => d && { ...d, content })}
                  onStatus={setSaveState}
                  onConflict={() => setTick((t) => t + 1)}
                  onExit={stopEdit}
                />
              ) : shown.trim() ? (
                <div ref={body}>
                  <Markdown className="doc-md" text={shown} />
                </div>
              ) : (
                <button className="desc-empty" onClick={startEdit}>
                  This doc is empty. Press <Kbd>E</Kbd> to start writing.
                </button>
              )}

              {!editing && !preview && (
                <>
                  {doc.issues.length > 0 && (
                    <section className="section">
                      <div className="section-head">
                        <h3>Issues in this doc</h3>
                        <span className="count">{doc.issues.length}</span>
                      </div>
                      <div className="subs">
                        {doc.issues.map((i) => (
                          <div className="row sub" key={i.id}>
                            <StatusIcon status={i.status} />
                            <span className="row-id">{i.id}</span>
                            <Link to={`/issue/${i.id}`} className="row-title" dir="auto">
                              {i.title}
                            </Link>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                  <Comments
                    comments={doc.comments}
                    onComment={async (text) => {
                      const n = ++seq.current;
                      const fresh = await api.commentDocument(doc.slug, text);
                      if (n === seq.current) setDoc(fresh);
                    }}
                  />
                </>
              )}
            </article>
            {!editing && outline.heads.length > 1 && (
              <nav className="doc-outline" aria-label="Outline">
                <div className="doc-outline-title">On this page</div>
                {outline.heads.map((h) => (
                  <a
                    key={h.id}
                    href={`#${h.id}`}
                    className={cls("doc-outline-item", h.level === 3 && "sub", outline.active === h.id && "on")}
                    dir="auto"
                    onClick={(e) => {
                      e.preventDefault();
                      outline.go(h.id);
                    }}
                  >
                    {h.text}
                  </a>
                ))}
              </nav>
            )}
          </div>
        </div>
        {history && (
          <History
            doc={doc}
            selected={preview?.id ?? null}
            onSelect={(v, current) => {
              if (current) return setPreview(null);
              api.version(doc.slug, v.id).then(setPreview, errorToast);
            }}
            onClose={() => {
              setHistory(false);
              setPreview(null);
            }}
          />
        )}
      </div>
    </>
  );
}

async function remove(doc: Document) {
  if (!confirm(`Delete “${doc.title}”? Its history and comments go with it.`)) return;
  try {
    await api.deleteDocument(doc.slug);
    toast(`Deleted “${doc.title}”`);
    navigate(`/p/${doc.project}/docs`);
  } catch (e) {
    errorToast(e);
  }
}

// ---------- Outline ----------

interface Head {
  id: string;
  text: string;
  level: number;
}

/** h2/h3 of the rendered doc, and the one currently at the top of the scroll area. */
function useOutline(body: RefObject<HTMLElement | null>, scroller: RefObject<HTMLElement | null>) {
  const [heads, setHeads] = useState<Head[]>([]);
  const [active, setActive] = useState("");
  const els = useRef<HTMLElement[]>([]);

  // Cheap enough to re-read after every render; only a real change sets state.
  useLayoutEffect(() => {
    els.current = [...(body.current?.querySelectorAll<HTMLElement>("h2[id], h3[id]") ?? [])];
    const next = els.current.map((h) => ({ id: h.id, text: h.textContent ?? "", level: h.tagName === "H2" ? 2 : 3 }));
    setHeads((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
  });

  useEffect(() => {
    const sc = scroller.current;
    if (!sc || !heads.length) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const line = sc.getBoundingClientRect().top + 96;
      const atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
      let id = els.current[0]?.id ?? "";
      for (const el of els.current) if (atEnd || el.getBoundingClientRect().top <= line) id = el.id;
      setActive(id);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [heads, scroller]);

  const go = (id: string) => els.current.find((el) => el.id === id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return { heads, active, go };
}

// ---------- History ----------

function History({
  doc,
  selected,
  onSelect,
  onClose,
}: {
  doc: Document;
  selected: number | null;
  onSelect: (v: DocumentVersionSummary, current: boolean) => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<DocumentVersionSummary[] | null>(null);
  useEffect(() => {
    api.versions(doc.slug).then(setVersions, errorToast);
  }, [doc.slug, doc.updatedAt, doc.versionCount]);

  return (
    <aside className="doc-history" aria-label="Version history">
      <div className="doc-history-head">
        <h3>History</h3>
        {versions && <span className="count">{versions.length}</span>}
        <span className="grow" />
        <button className="icon-btn sm" onClick={onClose} aria-label="Close history" title="Close">
          <CloseIcon />
        </button>
      </div>
      <ol className="doc-history-list">
        {versions?.map((v, i) => {
          const on = selected === v.id || (selected === null && i === 0);
          return (
            <li key={v.id}>
              <button className={cls("version", on && "on")} onClick={() => onSelect(v, i === 0)} aria-pressed={on}>
                <Avatar name={v.author} />
                <span className="version-text">
                  <span className="version-author" dir="auto">
                    {v.author}
                  </span>
                  <time title={fullDate(v.createdAt)}>{ago(v.createdAt)}</time>
                </span>
                {i === 0 && <span className="version-tag">Current</span>}
              </button>
            </li>
          );
        })}
      </ol>
      {versions?.length === 0 && <p className="doc-history-empty">No versions yet.</p>}
    </aside>
  );
}

// ---------- Editor ----------

/**
 * Full-height markdown editor with autosave. It never overwrites the draft with a remote
 * change: that shows a banner instead, and saving pauses until the user picks a side.
 */
function DocEditor({
  doc,
  scroller,
  startAt,
  unsaved,
  onSaved,
  onLocal,
  onStatus,
  onConflict,
  onExit,
}: {
  doc: Document;
  scroller: RefObject<HTMLDivElement | null>;
  startAt: number;
  unsaved: RefObject<boolean>;
  onSaved: (fresh: Document) => void;
  onLocal: (content: string) => void;
  onStatus: (s: SaveState) => void;
  /** The server rejected a save because the doc changed since (409); go refetch it. */
  onConflict: () => void;
  onExit: () => void;
}) {
  const [draft, setDraft] = useState(doc.content);
  const [conflict, setConflict] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  // base: what the server has from us; echo: how it came back; inflight: being saved now.
  const s = useRef({
    draft: doc.content,
    base: doc.content,
    baseUpdatedAt: doc.updatedAt,
    echo: doc.content,
    inflight: null as string | null,
    blocked: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }).current;
  unsaved.current = !!conflict && draft !== s.base;

  const save = async () => {
    clearTimeout(s.timer);
    if (s.blocked || s.inflight !== null || s.draft === s.base) return;
    const text = s.draft;
    s.inflight = text;
    onStatus("saving");
    try {
      const fresh = await api.updateDocument(doc.slug, { content: text, baseUpdatedAt: s.baseUpdatedAt });
      s.base = text;
      s.baseUpdatedAt = fresh.updatedAt;
      s.echo = fresh.content;
      s.inflight = null;
      onSaved(fresh);
    } catch (e) {
      s.inflight = null;
      if (e instanceof HttpError && e.status === 409) {
        // Someone else changed the doc first: stop retrying and let the conflict
        // banner (below, via the refetched `doc` prop) offer Reload / Keep mine.
        s.blocked = true;
        onStatus("idle");
        onConflict();
        return;
      }
      errorToast(e);
      return onStatus("error");
    }
    if (s.draft !== s.base) save();
    else if (!s.blocked) onStatus("saved");
  };

  // A change that isn't ours arrived while editing.
  useEffect(() => {
    if ([s.base, s.echo, s.inflight, s.draft].includes(doc.content)) {
      // Content still matches what we know: a benign external bump (e.g. the title
      // changed elsewhere). Adopt its updatedAt so the next save isn't rejected as a
      // false conflict.
      s.baseUpdatedAt = doc.updatedAt;
      return;
    }
    s.blocked = true;
    clearTimeout(s.timer);
    onStatus("idle");
    setConflict(doc.updatedBy);
  }, [doc.content, doc.updatedAt]);

  const change = (text: string) => {
    s.draft = text;
    setDraft(text);
    clearTimeout(s.timer);
    if (s.blocked) return;
    onStatus("saving");
    s.timer = setTimeout(save, 1000);
  };

  const reload = () => {
    s.draft = s.base = s.echo = doc.content;
    s.baseUpdatedAt = doc.updatedAt;
    s.blocked = false;
    setDraft(doc.content);
    setConflict(null);
  };
  const keepMine = () => {
    s.base = doc.content;
    s.baseUpdatedAt = doc.updatedAt;
    s.blocked = false;
    setConflict(null);
    save();
  };

  // Leaving edit mode (or the page) saves whatever is pending; the reading view shows it right away.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (s.draft !== s.base) e.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => {
      removeEventListener("beforeunload", warn);
      if (!s.blocked && s.draft !== s.base) {
        onLocal(s.draft);
        save();
      }
    };
  }, []);

  // Grow with the content; the page scrolls, not the textarea. Keep the scroll position steady.
  useLayoutEffect(() => {
    const el = ref.current;
    const sc = scroller.current;
    if (!el) return;
    const top = sc?.scrollTop ?? 0;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (sc) sc.scrollTop = top;
  }, [draft, scroller]);

  // Open at roughly the spot that was being read.
  useLayoutEffect(() => {
    const el = ref.current;
    const sc = scroller.current;
    if (!el) return;
    const at = startAt > 0.02 ? el.value.lastIndexOf("\n", Math.floor(startAt * el.value.length)) + 1 : 0;
    el.setSelectionRange(at, at);
    el.focus({ preventScroll: true });
    if (sc) sc.scrollTop = startAt * (sc.scrollHeight - sc.clientHeight);
  }, []);

  return (
    <>
      {conflict && (
        <div className="doc-banner doc-banner-warn" role="status">
          <span className="doc-banner-text">
            Updated by <b dir="auto">{conflict}</b> while you were editing
          </span>
          <span className="grow" />
          {draft !== s.base && (
            <button className="btn btn-ghost btn-sm" onClick={keepMine}>
              Keep mine
            </button>
          )}
          <button className="btn btn-sm" onClick={reload}>
            Reload
          </button>
        </div>
      )}
      <textarea
        ref={ref}
        className="doc-editor"
        dir="auto"
        spellCheck
        aria-label="Content (Markdown)"
        placeholder="Write in Markdown… Mention issues like BRD-2, link docs with [Title](/doc/slug)."
        value={draft}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onExit();
          }
        }}
      />
    </>
  );
}

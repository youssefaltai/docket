// Small shared UI pieces built on the primitives above: identity, chips, form fields, list headers.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { api } from "./api";
import { getYou } from "./auth";
import type { Team, UserRef } from "../shared/types";
import { useApp } from "./context";
import { PlusIcon, SearchIcon, SettingsIcon, MenuIcon, TrashIcon } from "./icons";
import { Link } from "./routing";
import { useAutosize, useRun } from "./hooks";
import { errorToast } from "./toast";
import { ago, cls, fullDate, hueStyle } from "./util";

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;

/** Whether the signed-in user is `user` in the current workspace, e.g. a comment's author (the server checks too). */
export const isMe = (user: UserRef | null) => user?.username === getYou().username;

export function Avatar({ user }: { user: UserRef | null }) {
  if (!user)
    return (
      <span className="avatar avatar-none" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18">
          <circle cx="9" cy="9" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
        </svg>
      </span>
    );
  return (
    <span className={cls("avatar", user.kind === "agent" && "avatar-agent")} style={hueStyle(user.username)} aria-hidden="true">
      {[...user.name.trim()][0]?.toUpperCase()}
    </span>
  );
}

export const LabelDot = ({ name }: { name: string }) => <i className="label-dot" style={hueStyle(name)} />;

export function LabelChip({ name }: { name: string }) {
  return (
    <span className="label" dir="auto">
      <LabelDot name={name} />
      {name}
    </span>
  );
}

export function TeamMark({ id }: { id: string }) {
  return (
    <span className="team-mark" style={hueStyle(id)} aria-hidden="true">
      {id[0]}
    </span>
  );
}

/** Team header: mark, inline-editable name and a settings button. */
function TeamTitle({ team }: { team: Team }) {
  const { reloadTeams, teamSettings } = useApp();
  return (
    <>
      <TeamMark id={team.key} />
      <InlineInput
        label="Team name"
        value={team.name}
        onSave={(name) => api.updateTeam(team.key, { name }).then(reloadTeams, errorToast)}
      />
      <button
        className="icon-btn sm"
        onClick={() => teamSettings(team.key)}
        aria-label="Team settings"
        title="Team settings"
      >
        <SettingsIcon />
      </button>
    </>
  );
}

/** Links as tabs: [to, label, whether it's the current one]. */
export function Tabs({ label, tabs }: { label: string; tabs: [to: string, label: string, on: boolean][] }) {
  return (
    <nav className="tabs" aria-label={label}>
      {tabs.map(([to, text, on]) => (
        <Link key={to} to={to} className={cls("tab", on && "on")} aria-current={on ? "page" : undefined}>
          {text}
        </Link>
      ))}
    </nav>
  );
}

export function MenuButton() {
  const { openNav } = useApp();
  return (
    <button className="icon-btn menu-btn" onClick={openNav} aria-label="Open menu">
      <MenuIcon />
    </button>
  );
}

/** In place of a page whose first load failed: says why, with a retry. */
export function LoadFailed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <EmptyState title="Couldn’t load this" action={<button className="btn" onClick={retry}>Try again</button>}>
      {message}
    </EmptyState>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** A labeled form field, with an optional hint below. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/**
 * A field that looks like text until focused: Enter (or leaving it) saves, Esc reverts.
 * A remote change to `value` never replaces what's being typed.
 */
function useInlineEdit<E extends HTMLInputElement | HTMLTextAreaElement>(value: string, onSave: (v: string) => void) {
  const ref = useRef<E>(null);
  const [draft, setDraft] = useState(value);
  const skip = useRef(false);
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(value);
  }, [value]);
  const props = {
    ref,
    value: draft,
    dir: "auto",
    onKeyDown: (e: ReactKeyboardEvent<E>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.currentTarget.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        skip.current = true;
        setDraft(value);
        e.currentTarget.blur();
      }
    },
    onBlur: () => {
      const v = draft.trim();
      if (!skip.current && v && v !== value) onSave(v);
      else setDraft(value);
      skip.current = false;
    },
  };
  return { draft, setDraft, props };
}

function InlineInput({ value, onSave, label }: { value: string; onSave: (v: string) => void; label: string }) {
  const { draft, setDraft, props } = useInlineEdit<HTMLInputElement>(value, onSave);
  return (
    <input
      {...props}
      className="inline-input"
      aria-label={label}
      size={Math.max(4, [...draft].length)}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

/** A large title that wraps: an issue's or a doc's. */
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
  const { draft, setDraft, props } = useInlineEdit<HTMLTextAreaElement>(value, onSave);
  useAutosize(props.ref, draft);
  return (
    <textarea
      {...props}
      className={className}
      rows={1}
      aria-label="Title"
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
    />
  );
}

/** Header of the issues and docs lists: title, team tabs, search, then `children` (filters, buttons). */
export function ListHeader({
  team,
  title,
  count,
  view,
  onNew,
  search,
  onSearch,
  placeholder = "Search",
  children,
}: {
  team: Team | undefined;
  title: string;
  count: number;
  view: "issues" | "docs" | "trash";
  /** New item, search and controls: lists have them, the trash doesn't. */
  onNew?: () => void;
  search?: string;
  onSearch?: (q: string) => void;
  placeholder?: string;
  children?: ReactNode;
}) {
  return (
    <header className="header">
      <MenuButton />
      <div className="header-title">
        {team ? <TeamTitle team={team} /> : <span>{title}</span>}
        {count > 0 && <span className="header-count">{count}</span>}
      </div>
      {team && (
        <Tabs
          label="Team views"
          tabs={[
            [`/t/${team.key}`, "Issues", view === "issues"],
            [`/t/${team.key}/docs`, "Docs", view === "docs"],
            [`/t/${team.key}/trash`, "Trash", view === "trash"],
          ]}
        />
      )}
      {onNew && (
        <button className="icon-btn mobile-only" onClick={onNew} aria-label={view === "docs" ? "New doc" : "New issue"}>
          <PlusIcon />
        </button>
      )}
      {onSearch && (
      <div className="controls">
        <label className="search">
          <SearchIcon />
          <input
            id="search"
            type="search"
            placeholder={placeholder}
            value={search}
            autoComplete="off"
            dir="auto"
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (search) onSearch("");
                else e.currentTarget.blur();
              } else if (e.key === "ArrowDown" || e.key === "Enter") {
                e.preventDefault();
                document.querySelector<HTMLElement>("[data-nav]")?.focus();
              }
            }}
          />
          {!search && <Kbd>/</Kbd>}
        </label>
        {children}
      </div>
      )}
    </header>
  );
}

/** Atop a trashed issue or doc opened by URL: it can be read and restored, nothing else. */
export function TrashBanner({ deletedAt, onRestore }: { deletedAt: string; onRestore: () => Promise<unknown> }) {
  const { busy, run } = useRun();
  return (
    <div className="doc-banner doc-banner-warn" role="status">
      <TrashIcon />
      <span className="doc-banner-text">
        In the trash since <time title={fullDate(deletedAt)}>{ago(deletedAt)}</time>. Restore it to make changes.
      </span>
      <span className="grow" />
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(onRestore)}>
        Restore
      </button>
    </div>
  );
}

export function TeamNotFound({ teamKey, back, backLabel }: { teamKey: string; back: string; backLabel: string }) {
  return (
    <EmptyState title="Team not found" action={<Link className="btn" to={back}>{backLabel}</Link>}>
      There’s no team with the key {teamKey}.
    </EmptyState>
  );
}

/** A titled block: sub-issues, comments, a settings section… */
export function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h3>{title}</h3>
        {count !== undefined && <span className="count">{count}</span>}
        {action && (
          <>
            <span className="grow" />
            {action}
          </>
        )}
      </div>
      {children}
    </section>
  );
}

// Popover pickers for issue properties. All share one keyboard-friendly <Picker>.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  PRIORITIES,
  PRIORITY_LABELS,
  STATUSES,
  STATUS_LABELS,
  type IssueSummary,
  type Priority,
  type Status,
  type UserKind,
  type UserRef,
} from "../shared/types";
import { api } from "./api";
import {
  Avatar,
  CheckIcon,
  CloseIcon,
  LabelDot,
  PlusIcon,
  PriorityIcon,
  TeamMark,
  StatusIcon,
  cls,
  errorToast,
  isMe,
  useApp,
} from "./ui";

interface Option {
  value: string;
  label: string;
  icon?: ReactNode;
  prefix?: string; // shown in mono before the label, e.g. an identifier
}

interface PickerProps {
  label: string;
  options: Option[];
  selected: string[];
  onPick: (value: string) => void;
  multi?: boolean;
  /** Offer "<create> “query”" when the query matches nothing exactly. */
  create?: string;
  onOpen?: () => void;
  className?: string;
  align?: "start" | "end";
  children: ReactNode;
}

const coarse = matchMedia("(pointer: coarse)");

export function Picker({ label, options, selected, onPick, multi, create, onOpen, className, align, children }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;

  const q = query.trim();
  const lq = q.toLowerCase();
  const items: (Option & { create?: true })[] = options
    .filter((o) => !lq || o.label.toLowerCase().includes(lq) || o.value.toLowerCase().includes(lq))
    .slice(0, 100);
  if (create && q && !options.some((o) => o.value.toLowerCase() === lq))
    items.push({ value: q, label: `${create} “${q}”`, icon: <PlusIcon />, create: true });
  const current = Math.min(active, items.length - 1);

  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };
  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => selected.includes(o.value))));
    setOpen(true);
    onOpen?.();
  };
  const pick = (o: Option) => {
    onPick(o.value);
    if (multi) setQuery("");
    else close();
  };

  // Anchor to the trigger, flip above when there's no room below.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = trigger.current?.getBoundingClientRect();
      const el = pop.current;
      if (!t || !el) return;
      const m = 8;
      const { offsetWidth: w, offsetHeight: h } = el;
      const left = Math.max(m, Math.min(align === "end" ? t.right - w : t.left, innerWidth - w - m));
      let top = t.bottom + 4;
      if (top + h > innerHeight - m && t.top - 4 - h > m) top = t.top - 4 - h;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };
    place();
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => {
      removeEventListener("resize", place);
      removeEventListener("scroll", place, true);
    };
  }, [open, items.length, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  useEffect(() => {
    if (open) pop.current?.querySelector(`[data-i="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, current]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) close();
          else show();
        }}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <div ref={pop} className="pop" role="dialog" aria-label={label} onClick={(e) => e.stopPropagation()}>
            <input
              className="pop-search"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={items[current] ? optionId(current) : undefined}
              autoFocus={!coarse.matches}
              value={query}
              placeholder={`${label}…`}
              dir="auto"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
                  e.preventDefault();
                  setActive(Math.min(current + 1, items.length - 1));
                } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
                  e.preventDefault();
                  setActive(Math.max(current - 1, 0));
                } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  const o = items[current];
                  if (o) pick(o);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  close();
                } else if (e.key === "Tab") close(false);
              }}
            />
            <div className="pop-list" id={listId} role="listbox" aria-multiselectable={multi}>
              {items.map((o, i) => {
                const on = !o.create && selected.includes(o.value);
                return (
                  <div
                    key={o.create ? "\0create" : o.value}
                    id={optionId(i)}
                    data-i={i}
                    role="option"
                    aria-selected={on}
                    className={cls("pop-item", i === current && "active")}
                    onPointerMove={() => i !== current && setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(o)}
                  >
                    {multi && !o.create && <span className={cls("checkbox", on && "on")}>{on && <CheckIcon />}</span>}
                    {o.icon && <span className="pop-icon">{o.icon}</span>}
                    {o.prefix && <span className="pop-prefix">{o.prefix}</span>}
                    <span className="pop-label" dir="auto">
                      {o.label}
                    </span>
                    {!multi && on && <CheckIcon className="pop-check" />}
                  </div>
                );
              })}
              {items.length === 0 && <div className="pop-empty">No results</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

type Trigger = { className?: string; children?: ReactNode; align?: "start" | "end" };
const uniq = (xs: string[]) => [...new Set(xs)];

/** A user as a picker option (value: username), marking the viewer. */
export const userOption = (user: UserRef): Option => ({
  value: user.username,
  label: isMe(user) ? `${user.name} (you)` : user.name,
  icon: <Avatar user={user} />,
});

/** Active members of the current workspace of one kind (people assign, agents are delegates), you first. */
export function useMembers(kind: UserKind): UserRef[] {
  const users = useApp()
    .members.filter((m) => !m.suspendedAt && m.user.kind === kind)
    .map((m) => m.user);
  return [...users.filter(isMe), ...users.filter((u) => !isMe(u))];
}
const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

const STATUS_OPTIONS: Option[] = STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s], icon: <StatusIcon status={s} /> }));
const PRIORITY_OPTIONS: Option[] = PRIORITIES.map((p) => ({
  value: String(p),
  label: PRIORITY_LABELS[p],
  icon: <PriorityIcon priority={p} />,
}));

export function StatusPicker({ value, onChange, children, ...rest }: Trigger & { value: Status; onChange: (s: Status) => void }) {
  return (
    <Picker
      label="Change status"
      options={STATUS_OPTIONS}
      selected={[value]}
      onPick={(v) => v !== value && onChange(v as Status)}
      {...rest}
    >
      {children ?? <StatusIcon status={value} />}
    </Picker>
  );
}

export function PriorityPicker({
  value,
  onChange,
  children,
  ...rest
}: Trigger & { value: Priority; onChange: (p: Priority) => void }) {
  return (
    <Picker
      label="Set priority"
      options={PRIORITY_OPTIONS}
      selected={[String(value)]}
      onPick={(v) => Number(v) !== value && onChange(Number(v) as Priority)}
      {...rest}
    >
      {children ?? <PriorityIcon priority={value} />}
    </Picker>
  );
}

type UserPickerProps = Trigger & { value: UserRef | null; onChange: (user: UserRef | null) => void };

function UserPicker({ kind, label, none, value, onChange, children, ...rest }: UserPickerProps & { kind: UserKind; label: string; none: string }) {
  const { loadDirectory } = useApp();
  const members = useMembers(kind);
  // Keep the current holder listed even if they left the workspace.
  const users = value && !members.some((u) => u.username === value.username) ? [...members, value] : members;
  return (
    <Picker
      label={label}
      options={[{ value: "", label: none, icon: <Avatar user={null} /> }, ...users.map(userOption)]}
      selected={[value?.username ?? ""]}
      onPick={(v) => v !== (value?.username ?? "") && onChange(users.find((u) => u.username === v) ?? null)}
      onOpen={loadDirectory}
      {...rest}
    >
      {children ?? <Avatar user={value} />}
    </Picker>
  );
}

export const AssigneePicker = (props: UserPickerProps) => (
  <UserPicker kind="person" label="Assign to" none="No assignee" {...props} />
);

export const DelegatePicker = (props: UserPickerProps) => (
  <UserPicker kind="agent" label="Delegate to" none="No delegate" {...props} />
);

export function LabelsPicker({
  value,
  onChange,
  children,
  ...rest
}: Trigger & { value: string[]; onChange: (labels: string[]) => void; children: ReactNode }) {
  const { labels, loadDirectory } = useApp();
  const options = uniq([...labels, ...value])
    .sort((a, b) => a.localeCompare(b))
    .map((l) => ({ value: l, label: l, icon: <LabelDot name={l} /> }));
  return (
    <Picker
      label="Labels"
      create="Create label"
      multi
      options={options}
      selected={value}
      onPick={(v) => onChange(toggle(value, v))}
      onOpen={loadDirectory}
      {...rest}
    >
      {children}
    </Picker>
  );
}

export function TeamPicker({ value, onChange, children, ...rest }: Trigger & { value: string; onChange: (key: string) => void }) {
  const { workspaceTeams } = useApp();
  const options = (workspaceTeams ?? []).map((p) => ({ value: p.key, label: p.name, icon: <TeamMark id={p.key} /> }));
  return (
    <Picker label="Team" options={options} selected={[value]} onPick={onChange} {...rest}>
      {children}
    </Picker>
  );
}

function useIssueOptions(team: string | undefined, exclude: string[]) {
  const { workspace } = useApp();
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  // A team already scopes tightly enough; otherwise (Blocked by, any team) stay
  // within the current workspace instead of leaking every workspace's issues.
  const load = () =>
    void api
      .issues(team ? { team } : workspace ? { workspace: workspace.key } : {})
      .then(setIssues)
      .catch(errorToast);
  const options: Option[] = issues
    .filter((i) => !exclude.includes(i.id))
    .map((i) => ({ value: i.id, label: i.title, prefix: i.id, icon: <StatusIcon status={i.status} /> }));
  return { options, load };
}

export function ParentPicker({
  value,
  onChange,
  team,
  exclude = [],
  children,
  ...rest
}: Trigger & { value: string | null; onChange: (id: string | null) => void; team: string; exclude?: string[]; children: ReactNode }) {
  const { options, load } = useIssueOptions(team, exclude);
  return (
    <Picker
      label="Set parent"
      options={[{ value: "", label: "No parent", icon: <CloseIcon className="muted" /> }, ...options]}
      selected={[value ?? ""]}
      onPick={(v) => (v || null) !== value && onChange(v || null)}
      onOpen={load}
      {...rest}
    >
      {children}
    </Picker>
  );
}

export function BlockedByPicker({
  value,
  onChange,
  exclude = [],
  children,
  ...rest
}: Trigger & { value: string[]; onChange: (ids: string[]) => void; exclude?: string[]; children: ReactNode }) {
  const { options, load } = useIssueOptions(undefined, exclude);
  return (
    <Picker
      label="Blocked by"
      multi
      options={options}
      selected={value}
      onPick={(v) => onChange(toggle(value, v))}
      onOpen={load}
      {...rest}
    >
      {children}
    </Picker>
  );
}

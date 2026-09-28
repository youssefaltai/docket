// Popover pickers for issue properties. All share one keyboard-friendly <Picker>.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ESTIMATE_VALUES,
  PRIORITIES,
  PRIORITY_LABELS,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  type Cycle,
  type EstimateScale,
  type IssueSummary,
  type IssueTemplate,
  type Milestone,
  type Priority,
  type ProjectStatus,
  type ProjectSummary,
  type UserKind,
  type UserRef,
} from "../shared/types";
import { api } from "./api";
import {
  Avatar,
  CheckIcon,
  CloseIcon,
  CycleIcon,
  EstimateIcon,
  LabelDot,
  MoreIcon,
  PlusIcon,
  PriorityIcon,
  ProjectStatusIcon,
  TeamMark,
  useFetch,
  IssueStatusIcon,
  StatusIcon,
  cls,
  statusOf,
  teamStatuses,
  type StatusLook,
  errorToast,
  findLabel,
  isMe,
  labelColor,
  labelGroupOf,
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
  /** The current value in words, for screen readers: the trigger often shows only an icon. */
  valueText?: string;
  className?: string;
  align?: "start" | "end";
  /** `data-cmd` on the trigger button: the command menu and single-key shortcuts click it to open this picker. */
  cmd?: string;
  disabled?: boolean;
  children: ReactNode;
}

const coarse = matchMedia("(pointer: coarse)");

export function Picker({ label, options, selected, onPick, multi, create, onOpen, valueText, className, align, cmd, disabled, children }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;

  const q = query.trim();
  const lq = q.toLowerCase();
  // An exact match comes first, so "ENG-1" + Enter picks ENG-1, not ENG-10.
  const exact = (o: Option) => o.value.toLowerCase() === lq || o.label.toLowerCase() === lq;
  const items: (Option & { create?: true })[] = options
    .filter((o) => !lq || o.label.toLowerCase().includes(lq) || o.value.toLowerCase().includes(lq))
    .sort((a, b) => (lq ? Number(exact(b)) - Number(exact(a)) : 0))
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
        data-cmd={cmd}
        disabled={disabled}
        aria-label={valueText ? `${label}: ${valueText}` : label}
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

type Trigger = { className?: string; children?: ReactNode; align?: "start" | "end"; cmd?: string };
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
    .members.filter((m) => !m.suspendedAt && !m.integration && m.user.kind === kind)
    .map((m) => m.user);
  return [...users.filter(isMe), ...users.filter((u) => !isMe(u))];
}
const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

export const statusOptions = (statuses: StatusLook[]): Option[] =>
  statuses.map((s) => ({ value: s.key, label: s.name, icon: <StatusIcon status={s} /> }));
export const PRIORITY_OPTIONS: Option[] = PRIORITIES.map((p) => ({
  value: String(p),
  label: PRIORITY_LABELS[p],
  icon: <PriorityIcon priority={p} />,
}));

/** A status of `team`'s workflow (each issue's own team: sub-issues can be in others). */
export function StatusPicker({ team, value, onChange, children, ...rest }: Trigger & { team: string; value: string; onChange: (s: string) => void }) {
  const { teams } = useApp();
  const current = statusOf(teams, team, value);
  return (
    <Picker
      label="Change status"
      valueText={current.name}
      options={statusOptions(teamStatuses(teams, team))}
      selected={[value]}
      onPick={(v) => v !== value && onChange(v)}
      {...rest}
    >
      {children ?? <StatusIcon status={current} />}
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
      valueText={PRIORITY_LABELS[value]}
      options={PRIORITY_OPTIONS}
      selected={[String(value)]}
      onPick={(v) => Number(v) !== value && onChange(Number(v) as Priority)}
      {...rest}
    >
      {children ?? <PriorityIcon priority={value} />}
    </Picker>
  );
}

/** A position (1–5) in the team's estimate scale, shown as the scale's values, or none. */
export function EstimatePicker({
  scale,
  value,
  onChange,
  children,
  ...rest
}: Trigger & { scale: EstimateScale; value: number | null; onChange: (estimate: number | null) => void }) {
  const options = [{ value: "", label: "No estimate" }, ...ESTIMATE_VALUES[scale].map((v, i) => ({ value: String(i + 1), label: v, icon: <EstimateIcon /> }))];
  return (
    <Picker
      label="Set estimate"
      valueText={value ? ESTIMATE_VALUES[scale][value - 1] : "No estimate"}
      options={options}
      selected={[String(value ?? "")]}
      onPick={(v) => (Number(v) || null) !== value && onChange(Number(v) || null)}
      {...rest}
    >
      {children}
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
      valueText={value?.name ?? none}
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

/**
 * Labels usable on `team`'s issues (the workspace's and its own; groups aren't applied), by path. Picking one of a
 * group the issue already has swaps it, as in Linear. "Create label" takes a name, or Group/Label (made when saved).
 */
export function LabelsPicker({
  team,
  value,
  onChange,
  children,
  ...rest
}: Trigger & { team: string; value: string[]; onChange: (labels: string[]) => void; children: ReactNode }) {
  const { labels, loadDirectory } = useApp();
  const usable = labels.filter((l) => !l.isGroup && (l.team === null || l.team === team)).map((l) => l.path);
  const options = uniq([...usable, ...value.filter((p) => !findLabel(labels, p))]).map((p) => ({ value: p, label: p, icon: <LabelDot color={labelColor(labels, p)} /> }));
  const pick = (v: string) => {
    if (value.includes(v)) return onChange(value.filter((p) => p !== v));
    const group = labelGroupOf(labels, v);
    onChange([...value.filter((p) => group === null || labelGroupOf(labels, p) !== group), v]);
  };
  return (
    <Picker label="Labels" create="Create label" multi options={options} selected={value} onPick={pick} onOpen={loadDirectory} {...rest}>
      {children}
    </Picker>
  );
}

export function TeamPicker({ value, onChange, children, ...rest }: Trigger & { value: string; onChange: (key: string) => void }) {
  const { teams } = useApp();
  const options = (teams ?? []).map((t) => ({ value: t.key, label: t.name, icon: <TeamMark id={t.key} /> }));
  return (
    <Picker label="Team" options={options} selected={[value]} onPick={onChange} {...rest}>
      {children}
    </Picker>
  );
}

/** Several teams of the workspace: a project's (at least one stays). */
export function TeamsPicker({ value, onChange, children, ...rest }: Trigger & { value: string[]; onChange: (keys: string[]) => void }) {
  const { teams } = useApp();
  const options = (teams ?? []).map((t) => ({ value: t.key, label: t.name, icon: <TeamMark id={t.key} /> }));
  const pick = (key: string) => {
    const next = toggle(value, key);
    if (next.length) onChange(next);
  };
  return (
    <Picker label="Teams" multi options={options} selected={value} onPick={pick} {...rest}>
      {children}
    </Picker>
  );
}

/** A row's "…" menu. */
export function RowMenu({ label, actions }: { label: string; actions: [label: string, run: () => void][] }) {
  return (
    <Picker
      label={label}
      options={actions.map(([label]) => ({ value: label, label }))}
      selected={[]}
      onPick={(picked) => actions.find(([label]) => label === picked)?.[1]()}
      className="icon-btn sm"
      align="end"
    >
      <MoreIcon />
    </Picker>
  );
}

export const LeadPicker = (props: UserPickerProps) => <UserPicker kind="person" label="Set lead" none="No lead" {...props} />;

export function ProjectStatusPicker({ value, onChange, children, ...rest }: Trigger & { value: ProjectStatus; onChange: (s: ProjectStatus) => void }) {
  return (
    <Picker
      label="Project status"
      valueText={PROJECT_STATUS_LABELS[value]}
      options={PROJECT_STATUSES.map((s) => ({ value: s, label: PROJECT_STATUS_LABELS[s], icon: <ProjectStatusIcon status={s} /> }))}
      selected={[value]}
      onPick={(v) => v !== value && onChange(v as ProjectStatus)}
      {...rest}
    >
      {children ?? <ProjectStatusIcon status={value} />}
    </Picker>
  );
}

/** The current workspace's projects (reloaded on live updates), for pickers that show a project by name. */
export const useProjects = () => useFetch(() => api.projects(), []).data ?? [];

/** One project of the workspace, or none (by slug). */
export function ProjectPicker({
  projects,
  value,
  onChange,
  children,
  ...rest
}: Trigger & { projects: ProjectSummary[]; value: string | null; onChange: (slug: string | null) => void }) {
  return (
    <Picker
      label="Set project"
      options={[
        { value: "", label: "No project", icon: <CloseIcon className="muted" /> },
        ...projects.map((p) => ({ value: p.slug, label: p.name, icon: <ProjectStatusIcon status={p.status} /> })),
      ]}
      selected={[value ?? ""]}
      onPick={(v) => (v || null) !== value && onChange(v || null)}
      {...rest}
    >
      {children}
    </Picker>
  );
}

/** A team's issue templates, reloaded whenever `team` changes (the New issue modal's Template control). */
export function useTemplates(team: string): IssueTemplate[] {
  const [templates, setTemplates] = useState<IssueTemplate[]>([]);
  useEffect(() => {
    if (!team) return setTemplates([]);
    let live = true;
    api.templates(team).then((t) => live && setTemplates(t), errorToast);
    return () => void (live = false);
  }, [team]);
  return templates;
}

/** One of the team's templates, by name; picking one hands it to `onPick` to merge into the draft. */
export function TemplatePicker({
  templates,
  onPick,
  children,
  ...rest
}: Trigger & { templates: IssueTemplate[]; onPick: (t: IssueTemplate) => void }) {
  return (
    <Picker
      label="Template"
      options={templates.map((t) => ({ value: String(t.id), label: t.name }))}
      selected={[]}
      onPick={(v) => {
        const t = templates.find((x) => x.id === Number(v));
        if (t) onPick(t);
      }}
      {...rest}
    >
      {children}
    </Picker>
  );
}

/** One milestone of `project`, or none (by name); its milestones load when it opens. */
export function MilestonePicker({
  project,
  value,
  onChange,
  children,
  ...rest
}: Trigger & { project: string; value: string | null; onChange: (name: string | null) => void }) {
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const load = () => void api.project(project).then((p) => setMilestones(p.milestones), errorToast);
  return (
    <Picker
      label="Set milestone"
      options={[{ value: "", label: "No milestone", icon: <CloseIcon className="muted" /> }, ...milestones.map((m) => ({ value: m.name, label: m.name }))]}
      selected={[value ?? ""]}
      onPick={(v) => (v || null) !== value && onChange(v || null)}
      onOpen={load}
      {...rest}
    >
      {children}
    </Picker>
  );
}

/** A cycle of the team: none, the current one or an upcoming one; a completed one is listed only while it's the value. */
export function CyclePicker({
  team,
  value,
  onChange,
  children,
  ...rest
}: Trigger & { team: string; value: number | null; onChange: (cycle: number | null) => void }) {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const load = () => void api.cycles(team).then(setCycles, errorToast);
  const options = cycles
    .filter((c) => c.state !== "completed" || c.number === value)
    .map((c) => ({ value: String(c.number), label: `Cycle ${c.number}${c.state === "current" ? " (current)" : ""}`, icon: <CycleIcon /> }));
  return (
    <Picker
      label="Set cycle"
      options={[{ value: "", label: "No cycle", icon: <CloseIcon className="muted" /> }, ...options]}
      selected={[String(value ?? "")]}
      onPick={(v) => (Number(v) || null) !== value && onChange(Number(v) || null)}
      onOpen={load}
      {...rest}
    >
      {children}
    </Picker>
  );
}

function useIssueOptions(team: string | undefined, exclude: string[]) {
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  // A team's issues, or (blocked by, related, duplicate of: any team) the current workspace's.
  const load = () =>
    void api
      .issues(team ? { team } : {})
      .then(setIssues)
      .catch(errorToast);
  const options: Option[] = issues
    .filter((i) => !exclude.includes(i.id))
    .map((i) => ({ value: i.id, label: i.title, prefix: i.id, icon: <IssueStatusIcon issue={i} /> }));
  return { options, load };
}

/** One issue or none: a parent, or the issue a duplicate points to. `team`: only that team's issues. */
function IssuePicker({
  value,
  onChange,
  label,
  none,
  team,
  exclude = [],
  children,
  ...rest
}: Trigger & { value: string | null; onChange: (id: string | null) => void; label: string; none: string; team?: string; exclude?: string[]; children: ReactNode }) {
  const { options, load } = useIssueOptions(team, exclude);
  return (
    <Picker
      label={label}
      options={[{ value: "", label: none, icon: <CloseIcon className="muted" /> }, ...options]}
      selected={[value ?? ""]}
      onPick={(v) => (v || null) !== value && onChange(v || null)}
      onOpen={load}
      {...rest}
    >
      {children}
    </Picker>
  );
}

type IssuePickerProps = Omit<Parameters<typeof IssuePicker>[0], "label" | "none">;

export const ParentPicker = (props: IssuePickerProps & { team: string }) => <IssuePicker label="Set parent" none="No parent" {...props} />;

export const DuplicatePicker = (props: IssuePickerProps) => <IssuePicker label="Duplicate of" none="Not a duplicate" {...props} />;

/** Several issues of the workspace, any team: blockers or related issues. */
function IssuesPicker({
  value,
  onChange,
  label,
  exclude = [],
  children,
  ...rest
}: Trigger & { value: string[]; onChange: (ids: string[]) => void; label: string; exclude?: string[]; children: ReactNode }) {
  const { options, load } = useIssueOptions(undefined, exclude);
  return (
    <Picker label={label} multi options={options} selected={value} onPick={(v) => onChange(toggle(value, v))} onOpen={load} {...rest}>
      {children}
    </Picker>
  );
}

type IssuesPickerProps = Omit<Parameters<typeof IssuesPicker>[0], "label">;

export const BlockedByPicker = (props: IssuesPickerProps) => <IssuesPicker label="Blocked by" {...props} />;

export const RelatedPicker = (props: IssuesPickerProps) => <IssuesPicker label="Related" {...props} />;

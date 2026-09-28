// New issue, doc, team and workspace dialogs.
import { useState, type ReactNode } from "react";
import { PRIORITY_LABELS, PROJECT_STATUS_LABELS, type CustomViewInput, type IssueInput, type ProjectStatus, type UserRef, type Workspace } from "../shared/types";
import { api } from "./api";
import { RichEditor } from "./editor";
import {
  AssigneePicker,
  LabelsPicker,
  LeadPicker,
  ParentPicker,
  PriorityPicker,
  ProjectPicker,
  ProjectStatusPicker,
  TeamPicker,
  TeamsPicker,
  StatusPicker,
  useProjects,
} from "./pickers";
import {
  Avatar,
  ChevronRightIcon,
  CloseIcon,
  DateButton,
  Field,
  Kbd,
  findLabel,
  LabelDot,
  labelColor,
  MOD,
  Modal,
  ParentIcon,
  PriorityIcon,
  ProjectIcon,
  ProjectStatusIcon,
  TeamMark,
  StatusIcon,
  statusOf,
  TagIcon,
  nav,
  navigate,
  toast,
  useApp,
  useRun,
} from "./ui";

function ModalHead({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-head">
      {children}
      <span className="grow" />
      <button className="icon-btn" onClick={onClose} aria-label="Close">
        <CloseIcon />
      </button>
    </div>
  );
}

/** "Team ›" in front of a new issue or doc's title. */
function TeamCrumb({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const { teams } = useApp();
  const team = teams?.find((t) => t.key === value);
  return (
    <>
      <TeamPicker value={value} onChange={onChange} className="chip">
        {team && <TeamMark id={team.key} />}
        <span dir="auto">{team?.name ?? "Team"}</span>
      </TeamPicker>
      <ChevronRightIcon className="muted" />
    </>
  );
}

type Draft = Required<Omit<IssueInput, "blockedBy" | "relatedTo" | "duplicateOf" | "dueOn" | "estimate" | "assignee" | "delegate" | "milestone">> & {
  assignee: UserRef | null;
};

export function NewIssueModal({ defaults, onClose }: { defaults: Partial<IssueInput>; onClose: () => void }) {
  const { teams, labels: allLabels } = useApp();
  // The team's default status, unless the page asked for another (a list group's +, the Triage tab).
  const startIn = (key: string, status?: string) => {
    const team = teams?.find((t) => t.key === key);
    return status && (!team || team.statuses.some((s) => s.key === status)) ? status : (team?.defaultStatus ?? "backlog");
  };
  const [draft, setDraft] = useState<Draft>(() => ({
    team: defaults.team ?? "",
    title: defaults.title ?? "",
    description: defaults.description ?? "",
    status: startIn(defaults.team ?? "", defaults.status),
    priority: defaults.priority ?? 0,
    labels: defaults.labels ?? [],
    assignee: null,
    parent: defaults.parent ?? null,
    project: defaults.project ?? null,
  }));
  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const { team, title, description, status, priority, labels, assignee, parent, project } = draft;
  const projects = useProjects();
  const inProject = projects.find((p) => p.slug === project);
  // The description's editor loads on first use (focused then), or at once for a given description.
  const [describing, setDescribing] = useState<false | "open" | "focus">(defaults.description ? "open" : false);

  const { busy, run } = useRun();
  const submit = () => {
    if (!title.trim() || !team) return;
    run(async () => {
      const issue = await api.createIssue({
        ...draft,
        project: project ?? undefined, // none named: a sub-issue joins its parent's
        assignee: assignee?.username ?? null,
        title: title.trim(),
        description: description.trim() || undefined,
      });
      toast(`Created ${issue.id}`, `/issue/${issue.id}`);
      onClose();
    });
  };

  return (
    <Modal label="New issue" onClose={onClose} onSubmit={submit}>
      <ModalHead onClose={onClose}>
        {/* A parent and the old team's own labels belong to it, so switching teams drops them; the status stays if the new team has it. */}
        <TeamCrumb
          value={team}
          onChange={(key) => {
            if (key === team) return;
            const usable = (path: string) => (findLabel(allLabels, path)?.team ?? key) === key;
            setDraft((d) => ({ ...d, team: key, parent: null, status: startIn(key, d.status), labels: d.labels.filter(usable) }));
          }}
        />
        <span className="modal-title">New issue</span>
      </ModalHead>
      <div className="modal-body">
        <input
          className="new-title"
          autoFocus
          dir="auto"
          placeholder="Issue title"
          aria-label="Title"
          value={title}
          onChange={(e) => set("title")(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              if (describing) document.querySelector<HTMLElement>(".modal .new-desc")?.focus();
              else setDescribing("focus");
            }
          }}
        />
        {describing ? (
          <RichEditor
            className="new-desc"
            label="Description"
            placeholder="Add description…"
            value={description}
            onChange={set("description")}
            autoFocus={describing === "focus"}
            onSubmit={submit}
            onCancel={onClose}
          />
        ) : (
          <button className="new-desc new-desc-idle" onClick={() => setDescribing("focus")} onFocus={() => setDescribing("focus")}>
            Add description…
          </button>
        )}
      </div>
      <div className="modal-chips">
        <StatusPicker team={team} value={status} onChange={set("status")} className="chip">
          <StatusIcon status={statusOf(teams, team, status)} />
          {statusOf(teams, team, status).name}
        </StatusPicker>
        <PriorityPicker value={priority} onChange={set("priority")} className="chip">
          <PriorityIcon priority={priority} />
          {priority ? PRIORITY_LABELS[priority] : "Priority"}
        </PriorityPicker>
        <AssigneePicker value={assignee} onChange={set("assignee")} className="chip">
          <Avatar user={assignee} />
          <span dir="auto">{assignee?.name ?? "Assignee"}</span>
        </AssigneePicker>
        <LabelsPicker team={team} value={labels} onChange={set("labels")} className="chip">
          {labels.length ? (
            labels.map((l) => (
              <span key={l} className="chip-label" dir="auto">
                <LabelDot color={labelColor(allLabels, l)} />
                {l}
              </span>
            ))
          ) : (
            <>
              <TagIcon />
              Labels
            </>
          )}
        </LabelsPicker>
        {team && (
          <ParentPicker value={parent} onChange={set("parent")} team={team} className="chip">
            <ParentIcon />
            {parent ? <span className="mono">{parent}</span> : "Parent"}
          </ParentPicker>
        )}
        <ProjectPicker projects={projects} value={project} onChange={set("project")} className="chip">
          {inProject ? <ProjectStatusIcon status={inProject.status} /> : <ProjectIcon />}
          <span dir="auto">{project ? (inProject?.name ?? project) : "Project"}</span>
        </ProjectPicker>
      </div>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn btn-primary" disabled={!title.trim() || !team || busy} onClick={submit}>
          Create issue <Kbd>{MOD}↵</Kbd>
        </button>
      </div>
    </Modal>
  );
}

export function NewDocModal({ team: initial, project, onClose }: { team: string; project?: string; onClose: () => void }) {
  const [team, setTeam] = useState(initial);
  const [title, setTitle] = useState("");
  const ready = !!title.trim() && !!team;
  const { busy, run } = useRun();
  const submit = () => {
    if (!ready) return;
    run(async () => {
      const doc = await api.createDocument({ team, title: title.trim(), project });
      nav.editDoc = doc.slug; // open straight into edit mode
      navigate(`/doc/${doc.slug}`);
      onClose();
    });
  };

  return (
    <Modal label="New doc" className="modal-sm" onClose={onClose} onSubmit={submit}>
      <ModalHead onClose={onClose}>
        <TeamCrumb value={team} onChange={setTeam} />
        <span className="modal-title">New doc</span>
      </ModalHead>
      <div className="modal-body modal-body-doc">
        <input
          className="new-title"
          autoFocus
          dir="auto"
          placeholder="Doc title"
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
      <div className="modal-foot">
        <span className="hint">Opens in the editor. Markdown, autosaved.</span>
        <span className="grow" />
        <button className="btn btn-primary" disabled={!ready || busy} onClick={submit}>
          Create doc <Kbd>↵</Kbd>
        </button>
      </div>
    </Modal>
  );
}

export function NewProjectModal({ team, onClose }: { team?: string; onClose: () => void }) {
  const { teams: allTeams } = useApp();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("backlog");
  const [lead, setLead] = useState<UserRef | null>(null);
  const [targetDate, setTargetDate] = useState<string | null>(null);
  const [teams, setTeams] = useState<string[]>(team ? [team] : []);
  const ready = !!name.trim() && teams.length > 0;
  const { busy, run } = useRun();
  const submit = () => {
    if (!ready) return;
    run(async () => {
      const project = await api.createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        status,
        lead: lead?.username ?? null,
        targetDate,
        teams,
      });
      navigate(`/project/${project.slug}`);
      onClose();
    });
  };
  const teamName = (key: string) => allTeams?.find((t) => t.key === key)?.name ?? key;
  return (
    <Modal label="New project" onClose={onClose} onSubmit={submit}>
      <ModalHead onClose={onClose}>
        <span className="modal-title">New project</span>
      </ModalHead>
      <div className="modal-body">
        <input
          className="new-title"
          autoFocus
          dir="auto"
          placeholder="Project name"
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              document.querySelector<HTMLElement>(".modal .new-desc")?.focus();
            }
          }}
        />
        <textarea
          className="new-desc"
          dir="auto"
          placeholder="Add a short summary…"
          aria-label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="modal-chips">
        <ProjectStatusPicker value={status} onChange={setStatus} className="chip">
          <ProjectStatusIcon status={status} />
          {PROJECT_STATUS_LABELS[status]}
        </ProjectStatusPicker>
        <LeadPicker value={lead} onChange={setLead} className="chip">
          <Avatar user={lead} />
          <span dir="auto">{lead?.name ?? "Lead"}</span>
        </LeadPicker>
        <DateButton value={targetDate} onChange={setTargetDate} label="Target date" placeholder="Target date" className="chip" />
        <TeamsPicker value={teams} onChange={setTeams} className="chip">
          {teams.length ? (
            teams.map((key) => (
              <span key={key} className="chip-label" dir="auto">
                <TeamMark id={key} />
                {teamName(key)}
              </span>
            ))
          ) : (
            "Teams"
          )}
        </TeamsPicker>
      </div>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn btn-primary" disabled={!ready || busy} onClick={submit}>
          Create project <Kbd>{MOD}↵</Kbd>
        </button>
      </div>
    </Modal>
  );
}

/** A small dialog with a form of fields, Cancel and a primary button. */
function FormModal({
  title,
  aside,
  action,
  ready,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  aside?: ReactNode;
  action: string;
  ready: boolean;
  onSubmit: () => Promise<void>;
  onClose: () => void;
  children: ReactNode;
}) {
  const { busy, run } = useRun();
  const submit = () => {
    if (ready) run(onSubmit);
  };
  return (
    <Modal label={title} className="modal-sm" onClose={onClose} onSubmit={submit}>
      <ModalHead onClose={onClose}>
        <span className="modal-title">{title}</span>
        {aside}
      </ModalHead>
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {children}
        <button type="submit" hidden />
      </form>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!ready || busy} onClick={submit}>
          {action}
        </button>
      </div>
    </Modal>
  );
}

function deriveKey(name: string): string {
  const words = name.toUpperCase().match(/[A-Z]+/g) ?? [];
  const key = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 3);
  return key.slice(0, 5);
}

export function NewTeamModal({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState("");
  const [customKey, setCustomKey] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const key = customKey ?? deriveKey(name);
  const workspace = app.workspace;

  return (
    <FormModal
      title="New team"
      aside={
        workspace && (
          <span className="muted" dir="auto">
            in {workspace.name}
          </span>
        )
      }
      action="Create team"
      ready={!!name.trim() && /^[A-Z]{2,5}$/.test(key) && !!workspace}
      onSubmit={async () => {
        const team = await api.createTeam({
          key,
          name: name.trim(),
          description: description.trim() || undefined,
        });
        app.reloadTeams();
        navigate(`/t/${team.key}`);
        onClose();
      }}
      onClose={onClose}
    >
      <Field label="Name">
        <input className="input" autoFocus dir="auto" placeholder="Docket" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Key" hint={`2–5 letters. Issues are numbered ${key || "DOC"}-1, ${key || "DOC"}-2, …`}>
        <input
          className="input mono"
          placeholder="DOC"
          value={key}
          onChange={(e) => setCustomKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5))}
        />
      </Field>
      <Field
        label={
          <>
            Description <em>optional</em>
          </>
        }
      >
        <textarea className="input" dir="auto" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </FormModal>
  );
}

export function NewWorkspaceModal({ onCreate, onClose }: { onCreate: (w: Workspace) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  return (
    <FormModal
      title="New workspace"
      action="Create workspace"
      ready={!!name.trim()}
      onSubmit={async () => {
        onCreate(await api.createWorkspace({ name: name.trim() }));
        onClose();
      }}
      onClose={onClose}
    >
      <Field label="Name" hint="A workspace groups related teams, with their issues and docs.">
        <input className="input" autoFocus dir="auto" placeholder="Acme" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
    </FormModal>
  );
}

/** Saves a view in the current workspace, from the filter and layout it was opened with (none: every issue), then opens it. */
export function NewViewModal({ defaults, onClose }: { defaults: Omit<CustomViewInput, "name">; onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState("");
  return (
    <FormModal
      title="New view"
      aside={
        app.workspace && (
          <span className="muted" dir="auto">
            in {app.workspace.name}
          </span>
        )
      }
      action="Create view"
      ready={!!name.trim()}
      onSubmit={async () => {
        const view = await api.createView({ ...defaults, name: name.trim() });
        app.reloadViews();
        navigate(`/view/${view.id}`);
        onClose();
      }}
      onClose={onClose}
    >
      <Field label="Name" hint="Everyone in the workspace can see and use it. Change its filters and display on its page.">
        <input className="input" autoFocus dir="auto" placeholder="Open bugs" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
    </FormModal>
  );
}

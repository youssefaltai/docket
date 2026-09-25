// New issue, doc, team and workspace dialogs.
import { useRef, useState, type ReactNode } from "react";
import { PRIORITY_LABELS, STATUS_LABELS, type IssueInput, type UserRef, type Workspace } from "../shared/types";
import { api } from "./api";
import { AssigneePicker, LabelsPicker, ParentPicker, PriorityPicker, TeamPicker, StatusPicker } from "./pickers";
import {
  Avatar,
  ChevronRightIcon,
  CloseIcon,
  Field,
  Kbd,
  LabelDot,
  MOD,
  Modal,
  ParentIcon,
  PriorityIcon,
  TeamMark,
  StatusIcon,
  TagIcon,
  nav,
  navigate,
  toast,
  useApp,
  useAutosize,
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

type Draft = Required<Omit<IssueInput, "blockedBy" | "assignee" | "delegate">> & { assignee: UserRef | null };

export function NewIssueModal({ defaults, onClose }: { defaults: Partial<IssueInput>; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => ({
    team: defaults.team ?? "",
    title: defaults.title ?? "",
    description: defaults.description ?? "",
    status: defaults.status ?? "todo",
    priority: defaults.priority ?? 0,
    labels: defaults.labels ?? [],
    assignee: null,
    parent: defaults.parent ?? null,
  }));
  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const { team, title, description, status, priority, labels, assignee, parent } = draft;
  const desc = useRef<HTMLTextAreaElement>(null);
  useAutosize(desc, description);

  const { busy, run } = useRun();
  const submit = () => {
    if (!title.trim() || !team) return;
    run(async () => {
      const issue = await api.createIssue({
        ...draft,
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
        {/* A parent belongs to the old team, so switching teams clears it. */}
        <TeamCrumb
          value={team}
          onChange={(key) => key !== team && setDraft((d) => ({ ...d, team: key, parent: null }))}
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
              desc.current?.focus();
            }
          }}
        />
        <textarea
          ref={desc}
          className="new-desc"
          dir="auto"
          rows={3}
          placeholder="Add description… (Markdown)"
          aria-label="Description"
          value={description}
          onChange={(e) => set("description")(e.target.value)}
        />
      </div>
      <div className="modal-chips">
        <StatusPicker value={status} onChange={set("status")} className="chip">
          <StatusIcon status={status} />
          {STATUS_LABELS[status]}
        </StatusPicker>
        <PriorityPicker value={priority} onChange={set("priority")} className="chip">
          <PriorityIcon priority={priority} />
          {priority ? PRIORITY_LABELS[priority] : "Priority"}
        </PriorityPicker>
        <AssigneePicker value={assignee} onChange={set("assignee")} className="chip">
          <Avatar user={assignee} />
          <span dir="auto">{assignee?.name ?? "Assignee"}</span>
        </AssigneePicker>
        <LabelsPicker value={labels} onChange={set("labels")} className="chip">
          {labels.length ? (
            labels.map((l) => (
              <span key={l} className="chip-label" dir="auto">
                <LabelDot name={l} />
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

export function NewDocModal({ team: initial, onClose }: { team: string; onClose: () => void }) {
  const [team, setTeam] = useState(initial);
  const [title, setTitle] = useState("");
  const ready = !!title.trim() && !!team;
  const { busy, run } = useRun();
  const submit = () => {
    if (!ready) return;
    run(async () => {
      const doc = await api.createDocument({ team, title: title.trim() });
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
          workspace: workspace!.key,
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

/** Edits what the header can't inline: the description and, for admins, the workspace's name. */
export function TeamSettingsModal({ teamKey, onClose }: { teamKey: string; onClose: () => void }) {
  const app = useApp();
  const team = app.teams?.find((t) => t.key === teamKey);
  const home = app.workspaces?.find((w) => w.key === team?.workspace);
  const [description, setDescription] = useState(team?.description ?? "");
  const [workspaceName, setWorkspaceName] = useState(home?.name ?? "");
  if (!team || !home) return null;
  const admin = home.role === "admin"; // only admins rename the workspace

  return (
    <FormModal
      title="Team settings"
      aside={
        <span className="muted" dir="auto">
          {team.name}
        </span>
      }
      action="Save"
      ready={!admin || !!workspaceName.trim()}
      onSubmit={async () => {
        if (admin && workspaceName.trim() !== home.name) await api.updateWorkspace(home.key, { name: workspaceName.trim() });
        if (description.trim() !== team.description) await api.updateTeam(team.key, { description: description.trim() });
        app.reloadTeams();
        onClose();
      }}
      onClose={onClose}
    >
      <Field
        label={
          <>
            Description <em>optional</em>
          </>
        }
      >
        <textarea
          className="input"
          autoFocus
          dir="auto"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      {admin && (
        <Field label="Workspace name" hint={`Renames ${home.name} for all its teams.`}>
          <input className="input" dir="auto" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
        </Field>
      )}
    </FormModal>
  );
}

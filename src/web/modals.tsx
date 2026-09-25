// New issue, doc, project and workspace dialogs.
import { useRef, useState, type ReactNode } from "react";
import { PRIORITY_LABELS, STATUS_LABELS, type IssueInput, type ProjectPatch, type Workspace } from "../shared/types";
import { api } from "./api";
import { AssigneePicker, LabelsPicker, ParentPicker, PriorityPicker, ProjectPicker, StatusPicker } from "./pickers";
import {
  Avatar,
  ChevronRightIcon,
  CloseIcon,
  Kbd,
  LabelDot,
  MOD,
  Modal,
  ParentIcon,
  PriorityIcon,
  ProjectMark,
  StatusIcon,
  TagIcon,
  errorToast,
  nav,
  navigate,
  toast,
  useApp,
  useAutosize,
} from "./ui";

/** Submits once at a time; a failure is shown and the form stays open to retry. */
function useSubmit(ready: boolean, action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await action();
    } catch (e) {
      errorToast(e);
      setBusy(false);
    }
  };
  return { busy, submit };
}

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

/** "Project ›" in front of a new issue or doc's title. */
function ProjectCrumb({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const { projects } = useApp();
  const project = projects?.find((p) => p.key === value);
  return (
    <>
      <ProjectPicker value={value} onChange={onChange} className="chip">
        {project && <ProjectMark id={project.key} />}
        <span dir="auto">{project?.name ?? "Project"}</span>
      </ProjectPicker>
      <ChevronRightIcon className="muted" />
    </>
  );
}

type Draft = Required<Omit<IssueInput, "blockedBy">>;

export function NewIssueModal({ defaults, onClose }: { defaults: Partial<IssueInput>; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => ({
    project: defaults.project ?? "",
    title: defaults.title ?? "",
    description: defaults.description ?? "",
    status: defaults.status ?? "todo",
    priority: defaults.priority ?? 0,
    labels: defaults.labels ?? [],
    assignee: defaults.assignee ?? null,
    parent: defaults.parent ?? null,
  }));
  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const { project, title, description, status, priority, labels, assignee, parent } = draft;
  const desc = useRef<HTMLTextAreaElement>(null);
  useAutosize(desc, description);

  const { busy, submit } = useSubmit(!!title.trim() && !!project, async () => {
    const issue = await api.createIssue({
      ...draft,
      title: title.trim(),
      description: description.trim() || undefined,
    });
    toast(`Created ${issue.id}`, `/issue/${issue.id}`);
    onClose();
  });

  return (
    <Modal label="New issue" onClose={onClose} onSubmit={submit}>
      <ModalHead onClose={onClose}>
        {/* A parent belongs to the old project, so switching projects clears it. */}
        <ProjectCrumb
          value={project}
          onChange={(key) => key !== project && setDraft((d) => ({ ...d, project: key, parent: null }))}
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
          <Avatar name={assignee} />
          <span dir="auto">{assignee ?? "Assignee"}</span>
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
        {project && (
          <ParentPicker value={parent} onChange={set("parent")} project={project} className="chip">
            <ParentIcon />
            {parent ? <span className="mono">{parent}</span> : "Parent"}
          </ParentPicker>
        )}
      </div>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn btn-primary" disabled={!title.trim() || !project || busy} onClick={submit}>
          Create issue <Kbd>{MOD}↵</Kbd>
        </button>
      </div>
    </Modal>
  );
}

export function NewDocModal({ project: initial, onClose }: { project: string; onClose: () => void }) {
  const [project, setProject] = useState(initial);
  const [title, setTitle] = useState("");
  const ready = !!title.trim() && !!project;
  const { busy, submit } = useSubmit(ready, async () => {
    const doc = await api.createDocument({ project, title: title.trim() });
    nav.editDoc = doc.slug; // open straight into edit mode
    navigate(`/doc/${doc.slug}`);
    onClose();
  });

  return (
    <Modal label="New doc" className="modal-sm" onClose={onClose} onSubmit={submit}>
      <ModalHead onClose={onClose}>
        <ProjectCrumb value={project} onChange={setProject} />
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
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
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
  const { busy, submit } = useSubmit(ready, onSubmit);
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

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState("");
  const [customKey, setCustomKey] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const key = customKey ?? deriveKey(name);
  const workspace = app.workspace;

  return (
    <FormModal
      title="New project"
      aside={
        workspace && (
          <span className="muted" dir="auto">
            in {workspace.name}
          </span>
        )
      }
      action="Create project"
      ready={!!name.trim() && /^[A-Z]{2,5}$/.test(key) && !!workspace}
      onSubmit={async () => {
        const project = await api.createProject({
          key,
          workspace: workspace!.key,
          name: name.trim(),
          description: description.trim() || undefined,
        });
        app.reloadProjects();
        navigate(`/p/${project.key}`);
        onClose();
      }}
      onClose={onClose}
    >
      <label className="field">
        <span>Name</span>
        <input className="input" autoFocus dir="auto" placeholder="Docket" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Key</span>
        <input
          className="input mono"
          placeholder="DOC"
          value={key}
          onChange={(e) => setCustomKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5))}
        />
        <small>2–5 letters. Issues are numbered {key || "DOC"}-1, {key || "DOC"}-2, …</small>
      </label>
      <label className="field">
        <span>
          Description <em>optional</em>
        </span>
        <textarea className="input" dir="auto" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
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
      <label className="field">
        <span>Name</span>
        <input className="input" autoFocus dir="auto" placeholder="Acme" value={name} onChange={(e) => setName(e.target.value)} />
        <small>A workspace groups related projects, with their issues and docs.</small>
      </label>
    </FormModal>
  );
}

/** Edits what the header can't inline: the description, the workspace it's in, and that workspace's name. */
export function ProjectSettingsModal({ projectKey, onClose }: { projectKey: string; onClose: () => void }) {
  const app = useApp();
  const project = app.projects?.find((p) => p.key === projectKey);
  const home = app.workspaces?.find((w) => w.key === project?.workspace);
  const [description, setDescription] = useState(project?.description ?? "");
  const [workspace, setWorkspace] = useState(project?.workspace ?? "");
  const [workspaceName, setWorkspaceName] = useState(home?.name ?? "");
  if (!project || !home) return null;

  return (
    <FormModal
      title="Project settings"
      aside={
        <span className="muted" dir="auto">
          {project.name}
        </span>
      }
      action="Save"
      ready={!!workspaceName.trim()}
      onSubmit={async () => {
        if (workspaceName.trim() !== home.name) await api.updateWorkspace(home.key, { name: workspaceName.trim() });
        const patch: ProjectPatch = {};
        if (description.trim() !== project.description) patch.description = description.trim();
        if (workspace !== project.workspace) patch.workspace = workspace;
        if (Object.keys(patch).length) await api.updateProject(project.key, patch);
        app.reloadProjects();
        onClose();
      }}
      onClose={onClose}
    >
      <label className="field">
        <span>
          Description <em>optional</em>
        </span>
        <textarea
          className="input"
          autoFocus
          dir="auto"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Workspace</span>
        <select className="input" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
          {app.workspaces?.map((w) => (
            <option key={w.key} value={w.key}>
              {w.name}
            </option>
          ))}
        </select>
        <small>Moving keeps its key, issues and docs.</small>
      </label>
      <label className="field">
        <span>Workspace name</span>
        <input className="input" dir="auto" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
        <small>Renames {home.name} for all its projects.</small>
      </label>
    </FormModal>
  );
}

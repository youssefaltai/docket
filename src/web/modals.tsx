// New issue, doc, project and workspace dialogs.
import { useRef, useState } from "react";
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  type IssueInput,
  type Priority,
  type Status,
  type Workspace,
} from "../shared/types";
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

export function NewIssueModal({ defaults, onClose }: { defaults: Partial<IssueInput>; onClose: () => void }) {
  const app = useApp();
  const [project, setProject] = useState(defaults.project ?? "");
  const [title, setTitle] = useState(defaults.title ?? "");
  const [description, setDescription] = useState(defaults.description ?? "");
  const [status, setStatus] = useState<Status>(defaults.status ?? "todo");
  const [priority, setPriority] = useState<Priority>(defaults.priority ?? 0);
  const [labels, setLabels] = useState<string[]>(defaults.labels ?? []);
  const [assignee, setAssignee] = useState<string | null>(defaults.assignee ?? null);
  const [parent, setParent] = useState<string | null>(defaults.parent ?? null);
  const [busy, setBusy] = useState(false);
  const desc = useRef<HTMLTextAreaElement>(null);
  useAutosize(desc, description);

  const proj = app.projects?.find((p) => p.key === project);
  const ready = !!title.trim() && !!project && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const issue = await api.createIssue({
        project,
        title: title.trim(),
        description: description.trim() || undefined,
        status,
        priority,
        labels,
        assignee,
        parent,
      });
      toast(`Created ${issue.id}`, `/issue/${issue.id}`);
      onClose();
    } catch (e) {
      errorToast(e);
      setBusy(false);
    }
  };

  return (
    <Modal label="New issue" onClose={onClose} onSubmit={submit}>
      <div className="modal-head">
        <ProjectPicker
          value={project}
          onChange={(key) => {
            if (key !== project) setParent(null);
            setProject(key);
          }}
          className="chip"
        >
          {proj && <ProjectMark id={proj.key} />}
          <span dir="auto">{proj?.name ?? "Project"}</span>
        </ProjectPicker>
        <ChevronRightIcon className="muted" />
        <span className="modal-title">New issue</span>
        <span className="grow" />
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>
      <div className="modal-body">
        <input
          className="new-title"
          autoFocus
          dir="auto"
          placeholder="Issue title"
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
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
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="modal-chips">
        <StatusPicker value={status} onChange={setStatus} className="chip">
          <StatusIcon status={status} />
          {STATUS_LABELS[status]}
        </StatusPicker>
        <PriorityPicker value={priority} onChange={setPriority} className="chip">
          <PriorityIcon priority={priority} />
          {priority ? PRIORITY_LABELS[priority] : "Priority"}
        </PriorityPicker>
        <AssigneePicker value={assignee} onChange={setAssignee} className="chip">
          <Avatar name={assignee} />
          <span dir="auto">{assignee ?? "Assignee"}</span>
        </AssigneePicker>
        <LabelsPicker value={labels} onChange={setLabels} className="chip">
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
          <ParentPicker value={parent} onChange={setParent} project={project} className="chip">
            <ParentIcon />
            {parent ? <span className="mono">{parent}</span> : "Parent"}
          </ParentPicker>
        )}
      </div>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn btn-primary" disabled={!ready} onClick={submit}>
          Create issue <Kbd>{MOD}↵</Kbd>
        </button>
      </div>
    </Modal>
  );
}

export function NewDocModal({ project: initial, onClose }: { project: string; onClose: () => void }) {
  const app = useApp();
  const [project, setProject] = useState(initial);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const proj = app.projects?.find((p) => p.key === project);
  const ready = !!title.trim() && !!project && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const doc = await api.createDocument({ project, title: title.trim() });
      nav.editDoc = doc.slug; // open straight into edit mode
      navigate(`/doc/${doc.slug}`);
      onClose();
    } catch (e) {
      errorToast(e);
      setBusy(false);
    }
  };

  return (
    <Modal label="New doc" className="modal-sm" onClose={onClose} onSubmit={submit}>
      <div className="modal-head">
        <ProjectPicker value={project} onChange={setProject} className="chip">
          {proj && <ProjectMark id={proj.key} />}
          <span dir="auto">{proj?.name ?? "Project"}</span>
        </ProjectPicker>
        <ChevronRightIcon className="muted" />
        <span className="modal-title">New doc</span>
        <span className="grow" />
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>
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
        <button className="btn btn-primary" disabled={!ready} onClick={submit}>
          Create doc <Kbd>↵</Kbd>
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
  const [busy, setBusy] = useState(false);
  const key = customKey ?? deriveKey(name);
  const workspace = app.workspace;
  const ready = !!name.trim() && /^[A-Z]{2,5}$/.test(key) && !!workspace && !busy;

  const submit = async () => {
    if (!ready || !workspace) return;
    setBusy(true);
    try {
      const project = await api.createProject({
        key,
        workspace: workspace.key,
        name: name.trim(),
        description: description.trim() || undefined,
      });
      app.reloadProjects();
      navigate(`/p/${project.key}`);
      onClose();
    } catch (e) {
      errorToast(e);
      setBusy(false);
    }
  };

  return (
    <Modal label="New project" className="modal-sm" onClose={onClose} onSubmit={submit}>
      <div className="modal-head">
        <span className="modal-title">New project</span>
        {workspace && (
          <span className="muted" dir="auto">
            in {workspace.name}
          </span>
        )}
        <span className="grow" />
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
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
          <textarea
            className="input"
            dir="auto"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <button type="submit" hidden />
      </form>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!ready} onClick={submit}>
          Create project
        </button>
      </div>
    </Modal>
  );
}

export function NewWorkspaceModal({ onCreate, onClose }: { onCreate: (w: Workspace) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !!name.trim() && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      onCreate(await api.createWorkspace({ name: name.trim() }));
      onClose();
    } catch (e) {
      errorToast(e);
      setBusy(false);
    }
  };

  return (
    <Modal label="New workspace" className="modal-sm" onClose={onClose} onSubmit={submit}>
      <div className="modal-head">
        <span className="modal-title">New workspace</span>
        <span className="grow" />
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="field">
          <span>Name</span>
          <input className="input" autoFocus dir="auto" placeholder="Default" value={name} onChange={(e) => setName(e.target.value)} />
          <small>A workspace groups related projects, with their issues and docs.</small>
        </label>
        <button type="submit" hidden />
      </form>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!ready} onClick={submit}>
          Create workspace
        </button>
      </div>
    </Modal>
  );
}

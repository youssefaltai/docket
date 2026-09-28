// Projects: the list (the workspace's, or those a team takes part in) and a project's page: its description,
// milestones, attached docs and issues.
import { useEffect, useState } from "react";
import { PROJECT_STATUS_LABELS, type Milestone, type Project, type ProjectPatch, type ProjectSummary } from "../shared/types";
import { HttpError, api } from "./api";
import { useBulk } from "./bulk";
import { Description, type Edit } from "./issue";
import { IssueList, LISTED, useListShortcuts } from "./issues";
import { LeadPicker, ProjectStatusPicker, RowMenu, TeamsPicker } from "./pickers";
import {
  Avatar,
  ChevronRightIcon,
  CloseIcon,
  DateButton,
  DocIcon,
  EmptyState,
  InlineInput,
  Link,
  LoadFailed,
  ListHeader,
  MenuButton,
  PlusIcon,
  ProjectIcon,
  ProjectStatusIcon,
  SearchIcon,
  Section,
  TeamMark,
  TeamNotFound,
  TitleEditor,
  ago,
  ask,
  cls,
  dayLabel,
  errorToast,
  fullDate,
  nav,
  percent,
  Progress,
  toPatch,
  type IssueChange,
  useApp,
  useFetch,
} from "./ui";

const issues = (n: number) => `${n} ${n === 1 ? "issue" : "issues"}`;

// ---------- Projects list ----------

export function ProjectsView({ teamKey }: { teamKey: string | null }) {
  const app = useApp();
  const team = teamKey ? app.teams?.find((t) => t.key === teamKey) : undefined;
  const [search, setSearch] = useState("");

  useEffect(() => {
    nav.lastProjects = location.pathname;
    document.title = `${team ? `${team.name} projects` : teamKey || "Projects"} · Docket`;
  }, [teamKey, team?.name]);

  const { data: projects, failed, reload } = useFetch(() => api.projects({ team: teamKey ?? undefined }), [teamKey]);
  const q = search.trim().toLowerCase();
  const shown = projects?.filter((p) => p.name.toLowerCase().includes(q));
  const newProject = () => app.newProject(teamKey ?? undefined);

  let body;
  if (teamKey && app.teams && !team) {
    body = <TeamNotFound teamKey={teamKey} back="/projects" backLabel="All projects" />;
  } else if (!projects || !shown) {
    body = failed ? <LoadFailed message={failed} retry={reload} /> : null;
  } else if (projects.length === 0) {
    body = (
      <EmptyState
        icon={<ProjectIcon />}
        title="No projects yet"
        action={
          <button className="btn btn-primary" onClick={newProject}>
            New project
          </button>
        }
      >
        Projects group issues from any team toward one goal, with milestones and a target date.
      </EmptyState>
    );
  } else if (shown.length === 0) {
    body = (
      <EmptyState
        icon={<SearchIcon />}
        title="No matching projects"
        action={
          <button className="btn" onClick={() => setSearch("")}>
            Clear search
          </button>
        }
      >
        Try a different search.
      </EmptyState>
    );
  } else {
    body = (
      <div className="list">
        {shown.map((p) => (
          <ProjectRow key={p.slug} project={p} onChange={reload} />
        ))}
      </div>
    );
  }

  return (
    <>
      <ListHeader
        team={team}
        title="Projects"
        count={shown?.length ?? 0}
        view="projects"
        onNew={newProject}
        search={search}
        onSearch={setSearch}
        placeholder="Search projects"
      >
        <button className="btn btn-sm desktop-only" onClick={newProject}>
          <PlusIcon /> New project
        </button>
      </ListHeader>
      <div className="content">{body}</div>
    </>
  );
}

function ProjectRow({ project: p, onChange }: { project: ProjectSummary; onChange: () => void }) {
  const setLead = (lead: string | null) => api.updateProject(p.slug, { lead }).then(onChange, errorToast);
  return (
    <div className="row project-row">
      <ProjectStatusIcon status={p.status} />
      <Link to={`/project/${p.slug}`} className="row-title" data-nav dir="auto">
        {p.name}
      </Link>
      <span className="grow" />
      <Progress value={p.progress} title={`${percent(p.progress)} of ${issues(p.issueCount)}`} />
      <span className="row-meta project-date" title={p.targetDate ? `Target date ${dayLabel(p.targetDate)}` : undefined}>
        {p.targetDate && dayLabel(p.targetDate)}
      </span>
      <span className="project-teams" title={p.teams.join(", ")}>
        {p.teams.map((key) => (
          <TeamMark key={key} id={key} />
        ))}
      </span>
      <LeadPicker value={p.lead} onChange={(lead) => setLead(lead?.username ?? null)} className="row-btn" align="end" />
    </div>
  );
}

// ---------- Project page ----------

export function ProjectPage({ slug }: { slug: string }) {
  const app = useApp();
  const { data: project, setData: setProject, missing, failed, reload, invalidate, isLatest } = useFetch(() => api.project(slug), [slug]);
  const list = useFetch(() => api.issues({ project: slug, category: LISTED }), [slug]);
  const [milestone, setMilestone] = useState<string | null>(null); // the issue list's filter
  const shown = milestone === null ? list.data : (list.data?.filter((i) => i.milestone === milestone) ?? null);
  useListShortcuts(list.setData, list.invalidate, list.reload);
  const { selection, bar } = useBulk(shown, { setIssues: list.setData, invalidate: list.invalidate, reload: list.reload }, [slug, milestone]);

  useEffect(() => {
    document.title = `${project?.name ?? slug} · Docket`;
  }, [slug, project?.name]);

  const header = (
    <header className="header">
      <MenuButton />
      <nav className="crumbs">
        <Link to={nav.lastProjects}>Projects</Link>
        <ChevronRightIcon />
        <span className="crumb-doc" dir="auto">
          {project?.name}
        </span>
      </nav>
    </header>
  );

  if (missing)
    return (
      <>
        {header}
        <div className="content">
          <EmptyState title="Project not found" action={<Link className="btn" to={nav.lastProjects}>Back to projects</Link>}>
            There’s no project {slug} in this workspace.
          </EmptyState>
        </div>
      </>
    );
  if (!project)
    return (
      <>
        {header}
        {failed && (
          <div className="content">
            <LoadFailed message={failed} retry={reload} />
          </div>
        )}
      </>
    );

  // Every edit answers with the whole project; apply it unless something newer landed.
  const apply = async (call: Promise<Project>) => {
    const n = invalidate();
    try {
      const fresh = await call;
      if (isLatest(n)) setProject(fresh);
    } catch (e) {
      errorToast(e);
      reload();
    }
  };
  const patch = (p: ProjectPatch) => apply(api.updateProject(project.slug, p));

  // As on the issue page: only a change to the description itself is a conflict; anything else saves again on top.
  const saveDescription = async (description: string, start: Edit) => {
    const n = invalidate();
    const save = async (base: string) => {
      try {
        const fresh = await api.updateProject(project.slug, { description, baseUpdatedAt: base });
        if (isLatest(n)) setProject(fresh);
        return true;
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 409)) throw e;
        return false;
      }
    };
    if (await save(start.base)) return;
    let latest = await api.project(project.slug);
    if (latest.description === start.value) {
      if (await save(latest.updatedAt)) return;
      latest = await api.project(project.slug);
    }
    setProject(latest);
    throw new HttpError("Project changed since you read it", 409);
  };

  const patchIssue = (id: string, p: IssueChange) => {
    list.invalidate();
    list.setData((issues) => issues?.map((i) => (i.id === id ? { ...i, ...p, updatedAt: new Date().toISOString() } : i)) ?? null);
    api.updateIssue(id, toPatch(p)).catch((e) => {
      errorToast(e);
      list.reload();
    });
  };

  const teamName = (key: string) => app.teams?.find((t) => t.key === key)?.name ?? key;
  const team = project.teams[0];

  return (
    <>
      {header}
      <div className="content">
        <div className="issue-inner project-inner">
          <TitleEditor key={project.slug} value={project.name} placeholder="Project name" onSave={(name) => patch({ name })} />
          <div className="project-chips">
            <ProjectStatusPicker value={project.status} onChange={(status) => patch({ status })} className="chip">
              <ProjectStatusIcon status={project.status} />
              {PROJECT_STATUS_LABELS[project.status]}
            </ProjectStatusPicker>
            <LeadPicker value={project.lead} onChange={(lead) => patch({ lead: lead?.username ?? null })} className="chip">
              <Avatar user={project.lead} />
              <span dir="auto">{project.lead?.name ?? "No lead"}</span>
            </LeadPicker>
            <span className="chip-group">
              <DateButton
                value={project.targetDate}
                onChange={(targetDate) => patch({ targetDate })}
                label="Target date"
                placeholder="Target date"
                className="chip"
              />
              {project.targetDate && (
                <button className="icon-btn xs" onClick={() => patch({ targetDate: null })} aria-label="Remove target date" title="Remove target date">
                  <CloseIcon />
                </button>
              )}
            </span>
            <TeamsPicker value={project.teams} onChange={(teams) => patch({ teams })} className="chip">
              {project.teams.map((key) => (
                <span key={key} className="chip-label" dir="auto">
                  <TeamMark id={key} />
                  {teamName(key)}
                </span>
              ))}
            </TeamsPicker>
          </div>
          <div className="project-progress">
            <Progress value={project.progress} />
            <span className="muted">· {issues(project.issueCount)}</span>
          </div>
          <Description key={`d-${project.slug}`} value={project.description} updatedAt={project.updatedAt} onSave={saveDescription} />
          <Milestones project={project} apply={apply} filter={milestone} setFilter={setMilestone} />
          <Section
            title="Docs"
            count={project.docs.length || undefined}
            action={
              <button className="btn btn-ghost btn-sm" onClick={() => app.newDoc(team, project.slug)}>
                <PlusIcon /> New doc
              </button>
            }
          >
            {project.docs.length > 0 && (
              <div className="subs">
                {project.docs.map((d) => (
                  <div className="row sub" key={d.slug}>
                    <DocIcon className="doc-icon" />
                    <Link to={`/doc/${d.slug}`} className="row-title" dir="auto">
                      {d.title}
                    </Link>
                    <span className="grow" />
                    <time className="row-time" dateTime={d.updatedAt} title={`Updated ${fullDate(d.updatedAt)} by ${d.updatedBy.name}`}>
                      {ago(d.updatedAt)}
                    </time>
                  </div>
                ))}
              </div>
            )}
          </Section>
          <Section
            title="Issues"
            count={shown ? (milestone === null ? shown.length : `${shown.length} in ${milestone}`) : undefined}
            action={
              <>
                {milestone !== null && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setMilestone(null)}>
                    <CloseIcon /> Show all
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => app.newIssue({ team, project: project.slug })}>
                  <PlusIcon /> New issue
                </button>
              </>
            }
          >
            {shown && shown.length > 0 && (
              <div className="subs project-issues">
                <IssueList issues={shown} onPatch={patchIssue} selection={selection} />
              </div>
            )}
          </Section>
        </div>
      </div>
      {bar}
    </>
  );
}

function Milestones({
  project,
  apply,
  filter,
  setFilter,
}: {
  project: Project;
  apply: (call: Promise<Project>) => Promise<void>;
  filter: string | null;
  setFilter: (name: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const add = () => {
    const n = name.trim();
    if (!n) return setAdding(false);
    setName("");
    apply(api.createMilestone(project.slug, { name: n }));
  };
  const list = project.milestones;
  return (
    <Section
      title="Milestones"
      count={list.length || undefined}
      action={
        <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
          <PlusIcon /> Add milestone
        </button>
      }
    >
      {list.length === 0 && !adding && <p className="section-empty">Break the project into stages, like Alpha and Beta.</p>}
      {(list.length > 0 || adding) && (
        <div className="subs">
          {list.map((m, i) => (
            <MilestoneRow
              key={m.id}
              project={project}
              milestone={m}
              above={list.slice(0, i)}
              below={list.slice(i + 1)}
              apply={apply}
              on={filter === m.name}
              onToggle={() => setFilter(filter === m.name ? null : m.name)}
            />
          ))}
          {adding && (
            <div className="row sub">
              <MilestoneGlyph />
              <input
                className="inline-input milestone-new"
                autoFocus
                dir="auto"
                placeholder="Milestone name, e.g. Beta"
                aria-label="New milestone"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => !name.trim() && setAdding(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setName("");
                    setAdding(false);
                  }
                }}
              />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

/** A milestone's mark: a small diamond. */
const MilestoneGlyph = () => (
  <svg className="milestone-glyph" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M7 2l5 5-5 5-5-5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);

function MilestoneRow({
  project,
  milestone: m,
  above,
  below,
  apply,
  on,
  onToggle,
}: {
  project: Project;
  milestone: Milestone;
  above: Milestone[];
  below: Milestone[];
  apply: (call: Promise<Project>) => Promise<void>;
  on: boolean;
  onToggle: () => void;
}) {
  const update = (patch: Parameters<typeof api.updateMilestone>[2]) => apply(api.updateMilestone(project.slug, m.id, patch));
  // Moving is to the midpoint between the two neighbours on that side, or one past the last (as for workflow statuses).
  const [up1, up2, down1, down2] = [above.at(-1), above.at(-2), below[0], below[1]];
  const actions: [string, () => void][] = [];
  if (up1) actions.push(["Move up", () => update({ position: up2 ? (up1.position + up2.position) / 2 : up1.position - 1 })]);
  if (down1) actions.push(["Move down", () => update({ position: down2 ? (down1.position + down2.position) / 2 : down1.position + 1 })]);
  actions.push([
    "Delete",
    async () => {
      if (await ask(`Delete the milestone ${m.name}? Its issues stay in the project.`, "Delete")) apply(api.deleteMilestone(project.slug, m.id));
    },
  ]);
  return (
    <div
      className={cls("row sub milestone-row", on && "selected")}
      onClick={(e) => !(e.target as HTMLElement).closest("input, button, label") && onToggle()}
    >
      <button className="row-btn" onClick={onToggle} aria-pressed={on} aria-label={`Show only ${m.name}'s issues`} title="Show only its issues">
        <MilestoneGlyph />
      </button>
      <InlineInput label="Milestone name" value={m.name} onSave={(name) => update({ name })} />
      <span className="grow" />
      <DateButton value={m.targetDate} onChange={(targetDate) => update({ targetDate })} label="Target date" placeholder="No date" className="doc-meta-btn" />
      <Progress value={m.progress} title={`${percent(m.progress)} of ${issues(m.issueCount)}`} />
      <span className="count milestone-count">{m.issueCount}</span>
      <RowMenu label={`${m.name} actions`} actions={actions} />
    </div>
  );
}

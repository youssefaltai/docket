// Team membership (Linear's): the Browse teams page (/<ws>/teams), where you join and leave teams, and a team's Members
// and access in its settings. A private team is seen only by its members; admins join one with a warning first.
import { TEAM_PERMISSIONS, type Permission, type Team, type TeamMember, type WorkspaceRole } from "../shared/types";
import { api } from "./api";
import { auth, can, getYou } from "./auth";
import { Picker, RowMenu, userOption } from "./pickers";
import {
  ask,
  Avatar,
  EmptyState,
  errorToast,
  isMe,
  Link,
  LockIcon,
  MenuButton,
  navigate,
  PlusIcon,
  Section,
  TeamMark,
  TeamsIcon,
  useApp,
  useFetch,
  useTitle,
} from "./ui";

/** Every team you see, to join or leave; for admins also the private teams they aren't in, to join (with a warning). */
export function TeamsPage() {
  const { teams, workspace, reloadTeams } = useApp();
  const admin = can("teams.manage_any");
  useTitle("Teams");
  const { data: listing } = useFetch(admin && workspace ? () => api.teamListings(workspace.key) : null, [workspace?.key, admin]);
  const hidden = (listing ?? []).filter((t) => !teams?.some((v) => v.key === t.key));
  const join = async (key: string, name: string, secret: boolean) => {
    if (secret && !(await ask(`Join ${name}? You'll see its issues.`, "Join"))) return;
    api.addTeamMember(key, "me").then(() => {
      reloadTeams();
      if (secret) navigate(`/t/${key}`);
    }, errorToast);
  };
  const leave = (team: Team) => api.removeTeamMember(team.key, getYou().username).then(reloadTeams, errorToast);
  if (!teams) return null;
  return (
    <>
      <header className="header">
        <MenuButton />
        <div className="header-title">
          <span>Teams</span>
          <span className="header-count">{teams.length}</span>
        </div>
      </header>
      <div className="content">
        {teams.length + hidden.length === 0 ? (
          <EmptyState icon={<TeamsIcon />} title="No teams yet">
            {can("teams.create") ? "Create one from the sidebar." : "You'll see the teams you're added to here."}
          </EmptyState>
        ) : (
          <div className="list">
            {teams.map((t) => (
              <div className="row" key={t.key}>
                <TeamMark id={t.key} />
                <Link to={`/t/${t.key}`} className="row-title" data-nav dir="auto">
                  {t.name}
                </Link>
                <span className="row-id mono">{t.key}</span>
                {t.private && <LockIcon className="team-lock" aria-label="Private" />}
                <span className="grow" />
                {t.member ? (
                  <button className="btn btn-sm btn-ghost" onClick={() => leave(t)}>
                    Leave
                  </button>
                ) : (
                  can("teams.join") && (
                    <button className="btn btn-sm" onClick={() => join(t.key, t.name, false)}>
                      Join
                    </button>
                  )
                )}
              </div>
            ))}
            {hidden.map((t) => (
              <div className="row dim" key={t.key}>
                <TeamMark id={t.key} />
                <span className="row-title" dir="auto">
                  {t.name}
                </span>
                <span className="row-id mono">{t.key}</span>
                <LockIcon className="team-lock" aria-label="Private" />
                <span className="grow" />
                <span className="row-meta">{t.memberCount === 1 ? "1 member" : `${t.memberCount} members`}</span>
                <button className="btn btn-sm" onClick={() => join(t.key, t.name, true)}>
                  Join
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const browses = (m: { permissions: Permission[] }) => m.permissions.includes("workspace.browse");

/**
 * A team's members (team settings): who's in it, add someone (its members with team.members, and teams.manage_any), take
 * someone off, join or leave, give someone a role of their own in the team; and whether it's private (team.privacy).
 * Making it private says who loses access.
 */
export function TeamMembers({ team }: { team: Team }) {
  const { members, reloadTeams, loadDirectory } = useApp();
  const anyTeam = can("teams.manage_any");
  const { data: inTeam, reload } = useFetch(() => api.teamMembers(team.key), [team.key]);
  const roles = useFetch(can("team.roles", team.key) || can("members.assign_role") ? auth.roles : null, [team.key]);
  const changed = () => {
    reload();
    reloadTeams();
    loadDirectory();
  };
  const manage = (team.member && can("team.members", team.key)) || anyTeam;
  // Only teams.manage_any adds those who don't browse the workspace (guests): who a guest sees is theirs to decide.
  const addable = members
    .filter((m) => !m.suspendedAt && (anyTeam || browses(m)) && !inTeam?.some((u) => u.username === m.user.username))
    .map((m) => m.user);
  const add = (username: string) => api.addTeamMember(team.key, username).then(changed, errorToast);
  const remove = async (username: string) => {
    if (username === getYou().username && team.private && !(await ask(`Leave ${team.name}? You won't see it anymore.`, "Leave"))) return;
    api.removeTeamMember(team.key, username).then(changed, errorToast);
  };
  const setPrivate = async (on: boolean) => {
    const outside = members.filter((m) => !m.suspendedAt && !m.integration && !m.teams.includes(team.key) && browses(m));
    const names = outside.map((m) => m.user.name).join(", ");
    const note = on
      ? `Only its members will see ${team.name}, its issues and docs.${outside.length ? ` ${names} ${outside.length === 1 ? "loses" : "lose"} access.` : ""}`
      : `Everyone in the workspace but guests will see ${team.name}, its issues and docs.`;
    if (await ask(`Make ${team.name} ${on ? "private" : "public"}? ${note}`, on ? "Make private" : "Make public")) {
      api.updateTeam(team.key, { private: on }).then(changed, errorToast);
    }
  };
  return (
    <Section
      title="Members"
      count={inTeam?.length}
      action={
        manage ? (
          <Picker label="Add member" options={addable.map(userOption)} selected={[]} onPick={add} className="btn btn-sm" align="end">
            <PlusIcon />
            Add member
          </Picker>
        ) : (
          can(team.private ? "teams.manage_any" : "teams.join") && (
            <button className="btn btn-sm" onClick={() => add("me")}>
              Join
            </button>
          )
        )
      }
    >
      <p className="settings-hint">
        {team.private ? "Private: only its members see this team, its issues and docs." : "Public: everyone in the workspace but guests sees this team. Its members have it in their sidebar."}
      </p>
      {can("team.privacy", team.key) && (
        <label className="workflow-switch">
          <input type="checkbox" checked={team.private} onChange={(e) => setPrivate(e.target.checked)} />
          <span>
            <LockIcon className="team-lock" /> <b>Private</b> <span className="muted">Only the team's members see it. Admins too, once they join.</span>
          </span>
        </label>
      )}
      <div className="settings-list">
        {inTeam?.map((u) => (
          <div className="settings-row" key={u.username}>
            <Avatar user={u} />
            <div className="settings-row-main">
              <div className="settings-row-title">
                <span dir="auto">{u.name}</span> <span className="muted">@{u.username}</span>
              </div>
              {!roles.data && u.role && <div className="settings-row-meta">{u.roleName} in this team</div>}
            </div>
            {roles.data && <TeamRole team={team.key} member={u} roles={roles.data} onChange={changed} />}
            {(manage || isMe(u)) && (
              <RowMenu label={`Manage ${u.name}`} actions={[[isMe(u) ? "Leave team" : "Remove from team", () => remove(u.username)]]} />
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

/**
 * A member's role in a team: their workspace role's, or one of their own there for the team's permissions. Only roles
 * whose team permissions you hold in the team can be given, never to yourself.
 */
function TeamRole({ team, member, roles, onChange }: { team: string; member: TeamMember; roles: WorkspaceRole[]; onChange: () => void }) {
  const { members } = useApp();
  const inWorkspace = members.find((m) => m.user.username === member.username);
  const holds = (ps: Permission[]) => ps.every((p) => !TEAM_PERMISSIONS.includes(p) || can(p, team));
  const current = roles.find((r) => r.key === member.role)?.permissions ?? inWorkspace?.permissions ?? [];
  const set = (role: string) => auth.setTeamRole(team, member.username, role || null).then(onChange, errorToast);
  return (
    <select
      className="input settings-select"
      aria-label={`${member.name}'s role in ${team}`}
      value={member.role ?? ""}
      disabled={isMe(member) || !holds(current)}
      onChange={(e) => set(e.target.value)}
    >
      <option value="">{inWorkspace ? `${inWorkspace.roleName} (workspace)` : "Workspace role"}</option>
      {roles.map((r) => (
        <option key={r.key} value={r.key} disabled={!holds(r.permissions)}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

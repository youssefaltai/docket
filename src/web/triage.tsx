// A team's Triage (Linear's): issues waiting to be accepted into the workflow. Shown while the team has a triage status.
import { useEffect } from "react";
import { DUPLICATE_STATUS, type IssueSummary } from "../shared/types";
import { api } from "./api";
import {
  EmptyState,
  InboxIcon,
  IssueStatusIcon,
  Kbd,
  Link,
  ListHeader,
  LoadFailed,
  TeamNotFound,
  errorToast,
  fullDate,
  timeAgo,
  toast,
  useApp,
  useFetch,
} from "./ui";

export function TriageView({ teamKey }: { teamKey: string }) {
  const app = useApp();
  const team = app.teams?.find((t) => t.key === teamKey);
  const triage = team?.statuses.find((s) => s.category === "triage");
  const { data: issues, setData, failed, reload, invalidate } = useFetch(() => api.issues({ team: teamKey, category: ["triage"] }), [teamKey]);

  useEffect(() => {
    document.title = `Triage · ${team?.name ?? teamKey} · Docket`;
  }, [team?.name, teamKey]);

  // Accept: into the team's default status. Decline: its first canceled status that isn't Duplicate.
  const decline = team?.statuses.find((s) => s.category === "canceled" && s.key !== DUPLICATE_STATUS);
  const move = (issue: IssueSummary, status: string, done: string) => {
    invalidate();
    setData((list) => list?.filter((i) => i.id !== issue.id) ?? null);
    api.updateIssue(issue.id, { status }).then(
      () => toast(`${done} ${issue.id}`, `/issue/${issue.id}`),
      (e) => {
        errorToast(e);
        reload();
      },
    );
  };
  const newIssue = () => app.newIssue({ team: teamKey, status: triage?.key });

  let body;
  if (app.teams && !team) body = <TeamNotFound teamKey={teamKey} back="/" backLabel="All issues" />;
  else if (team && !triage)
    body = (
      <EmptyState icon={<InboxIcon />} title="Triage is off" action={<Link className="btn" to={`/t/${teamKey}/settings`}>Team settings</Link>}>
        Turn it on in the team’s workflow settings.
      </EmptyState>
    );
  else if (!issues) body = failed ? <LoadFailed message={failed} retry={reload} /> : null;
  else if (!issues.length)
    body = (
      <EmptyState
        icon={<InboxIcon />}
        title="Nothing to triage"
        action={
          <button className="btn btn-primary" onClick={newIssue}>
            New issue <Kbd>C</Kbd>
          </button>
        }
      >
        New issues from this tab wait here until someone accepts them.
      </EmptyState>
    );
  else
    body = (
      <div className="list">
        {issues.map((i) => (
          <div className="row" key={i.id} data-issue-id={i.id}>
            <IssueStatusIcon issue={i} />
            <span className="row-id">{i.id}</span>
            <Link to={`/issue/${i.id}`} className="row-title" data-nav dir="auto">
              {i.title}
            </Link>
            <span className="grow" />
            <time className="row-time" dateTime={i.createdAt} title={`Created ${fullDate(i.createdAt)}`}>
              {timeAgo(i.createdAt)}
            </time>
            <button className="btn btn-sm row-action" onClick={() => move(i, team!.defaultStatus, "Accepted")}>
              Accept
            </button>
            {decline && (
              <button className="btn btn-sm row-action" onClick={() => move(i, decline.key, "Declined")}>
                Decline
              </button>
            )}
          </div>
        ))}
      </div>
    );

  return (
    <>
      <ListHeader team={team} title={teamKey} count={issues?.length ?? 0} view="triage" onNew={newIssue} />
      <div className="content">{body}</div>
    </>
  );
}

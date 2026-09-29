// A live cache of every issue's id/status/title, kept current by the app shell, so markdown can
// render identifier chips (and check whether the issue they point to is resolved) without a fetch.
import { useMemo, useSyncExternalStore } from "react";
import type { IssueSummary, UserRef } from "../shared/types";
import { useApp } from "./context";
import { isClosedCategory, issueStatus } from "./hooks";
import { createStore } from "./util";

const issueIndex = createStore<Map<string, IssueSummary> | null>(null);

/** Every issue by its identifier, and by any it had before it moved team (so old mentions still chip and link). */
export const setIssueIndex = (list: IssueSummary[]) =>
  issueIndex.set(new Map(list.flatMap((i) => [i.id, ...i.previousIdentifiers].map((id) => [id, i] as const))));

export const useIssueIndex = () => useSyncExternalStore(issueIndex.subscribe, issueIndex.get);

/** What text chips: the issue an identifier names (in a known team) and the active member an @username names. */
export type ChipSource = { issue: (id: string) => IssueSummary | undefined; member: (username: string) => UserRef | undefined };

export function useChipSource(): ChipSource {
  const { teams, members } = useApp();
  const index = useIssueIndex();
  return useMemo(() => {
    const keys = new Set(teams?.map((t) => t.key));
    const active = new Map(members.filter((m) => !m.suspendedAt).map((m) => [m.user.username, m.user]));
    return { issue: (id) => (keys.has(id.slice(0, id.indexOf("-"))) ? index?.get(id) : undefined), member: (u) => active.get(u) };
  }, [teams, index, members]);
}

/** Whether an issue is completed or canceled, as far as the index knows (a resolved blocker no longer blocks). */
export function useResolved() {
  const index = useIssueIndex();
  const { teams } = useApp();
  return (id: string) => {
    const issue = index?.get(id);
    return !!issue && isClosedCategory(issueStatus(teams, issue).category);
  };
}

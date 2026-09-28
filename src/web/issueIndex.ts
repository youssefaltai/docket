// A live cache of every issue's id/status/title, kept current by the app shell, so markdown can
// render identifier chips (and check whether the issue they point to is resolved) without a fetch.
import { useSyncExternalStore } from "react";
import type { IssueSummary } from "../shared/types";
import { useApp } from "./context";
import { isClosedCategory, issueStatus } from "./hooks";

let issueIndex: Map<string, IssueSummary> | null = null;
const indexListeners = new Set<() => void>();

/** Every issue by its identifier, and by any it had before it moved team (so old mentions still chip and link). */
export function setIssueIndex(list: IssueSummary[]) {
  issueIndex = new Map(list.flatMap((i) => [i.id, ...i.previousIdentifiers].map((id) => [id, i] as const)));
  indexListeners.forEach((l) => l());
}

export const useIssueIndex = () =>
  useSyncExternalStore(
    (cb) => {
      indexListeners.add(cb);
      return () => void indexListeners.delete(cb);
    },
    () => issueIndex,
  );

/** Whether an issue is completed or canceled, as far as the index knows (a resolved blocker no longer blocks). */
export function useResolved() {
  const index = useIssueIndex();
  const { teams } = useApp();
  return (id: string) => {
    const issue = index?.get(id);
    return !!issue && isClosedCategory(issueStatus(teams, issue).category);
  };
}

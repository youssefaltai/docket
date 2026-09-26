// A live cache of every issue's id/status/title, kept current by the app shell, so markdown can
// render identifier chips (and check whether the issue they point to is resolved) without a fetch.
import { useSyncExternalStore } from "react";
import { CLOSED_STATUSES, type IssueSummary } from "../shared/types";

let issueIndex: Map<string, IssueSummary> | null = null;
const indexListeners = new Set<() => void>();

export function setIssueIndex(list: IssueSummary[]) {
  issueIndex = new Map(list.map((i) => [i.id, i]));
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

/** Whether an issue is done or canceled, as far as the index knows (a resolved blocker no longer blocks). */
export function useResolved() {
  const index = useIssueIndex();
  return (id: string) => {
    const status = index?.get(id)?.status;
    return !!status && CLOSED_STATUSES.includes(status);
  };
}

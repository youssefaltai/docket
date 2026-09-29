// "My Issues": what's yours across every team in this workspace. Assigned / Created / Delegated / Subscribed.
import { useEffect } from "react";
import type { IssueFilter } from "../shared/types";
import { api } from "./api";
import { useBulk } from "./bulk";
import { Board, IssueList, LISTED, LayoutToggle, listPatch, useLayout, useListShortcuts } from "./issues";
import { MY_TABS, type MyTab } from "./routing";
import {
  EmptyState,
  IssuesIcon,
  LoadFailed,
  MenuButton,
  Tabs,
  cls,
  nav,
  useFetch,
} from "./ui";

const TAB_LABEL: Record<MyTab, string> = {
  assigned: "Assigned",
  created: "Created",
  delegated: "Delegated",
  subscribed: "Subscribed",
};

const EMPTY: Record<MyTab, { title: string; body: string }> = {
  assigned: { title: "Nothing assigned to you", body: "Issues assigned to you across every team will show up here." },
  created: { title: "You haven't created anything", body: "Issues you create will show up here." },
  delegated: { title: "No delegated work", body: "Issues you own that an agent is currently working on will show up here." },
  subscribed: { title: "Not subscribed to anything", body: "Issues you follow will show up here." },
};

function filterFor(tab: MyTab): IssueFilter {
  switch (tab) {
    case "created":
      return { creator: "me" };
    case "subscribed":
      return { subscribed: true };
    default: // assigned, delegated: narrowed client-side to those with a delegate set
      return { assignee: "me" };
  }
}

export function MyIssuesView({ tab }: { tab: MyTab }) {
  const [view, changeView] = useLayout();

  useEffect(() => {
    nav.lastList = location.pathname;
    document.title = "My Issues · Docket";
  }, []);

  const { data: issues, setData: setIssues, failed, reload, invalidate } = useFetch(() => api.issues({ ...filterFor(tab), category: LISTED }), [tab]);
  const shown = tab === "delegated" ? issues?.filter((i) => i.delegate) : issues;

  useListShortcuts(setIssues, invalidate, reload);
  const { selection, bar } = useBulk(shown ?? null, { setIssues, invalidate, reload }, [tab]);

  const patch = listPatch(setIssues, invalidate, reload);

  let body;
  if (!shown) {
    body = failed ? <LoadFailed message={failed} retry={reload} /> : null;
  } else if (shown.length === 0) {
    const empty = EMPTY[tab];
    body = (
      <EmptyState icon={<IssuesIcon />} title={empty.title}>
        {empty.body}
      </EmptyState>
    );
  } else if (view === "board") {
    body = <Board issues={shown} onPatch={patch} selection={selection} />;
  } else {
    body = <IssueList issues={shown} onPatch={patch} selection={selection} />;
  }

  return (
    <>
      <header className="header">
        <MenuButton />
        <div className="header-title">
          <span>My Issues</span>
          {!!shown?.length && <span className="header-count">{shown.length}</span>}
        </div>
        <div className="controls">
          <Tabs label="My issues views" tabs={MY_TABS.map((t): [string, string, boolean] => [`/my/${t}`, TAB_LABEL[t], t === tab])} />
          <LayoutToggle layout={view} onChange={changeView} />
        </div>
      </header>
      <div className={cls("content", view === "board" && !!shown?.length && "content-board")}>{body}</div>
      {bar}
    </>
  );
}

// "My Issues": what's yours across every team in this workspace. Assigned / Created / Delegated / Subscribed.
import { useEffect, useState } from "react";
import type { IssueFilter } from "../shared/types";
import { api, store } from "./api";
import { Board, IssueList, useListShortcuts } from "./issues";
import { MY_TABS, type MyTab } from "./routing";
import {
  BoardIcon,
  EmptyState,
  IssuesIcon,
  ListIcon,
  LoadFailed,
  MenuButton,
  Tabs,
  cls,
  errorToast,
  nav,
  toPatch,
  type IssueChange,
  useFetch,
} from "./ui";

type View = "list" | "board";

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
  const [view, setView] = useState<View>(() => (store.get("view") === "board" ? "board" : "list"));

  useEffect(() => {
    nav.lastList = location.pathname;
    document.title = "My Issues · Docket";
  }, []);

  const { data: issues, setData: setIssues, failed, reload, invalidate } = useFetch(() => api.issues(filterFor(tab)), [tab]);
  const shown = tab === "delegated" ? issues?.filter((i) => i.delegate) : issues;

  useListShortcuts(setIssues, invalidate, reload);

  const patch = (id: string, p: IssueChange) => {
    invalidate();
    const now = new Date().toISOString();
    setIssues((list) => list?.map((i) => (i.id === id ? { ...i, ...p, updatedAt: now } : i)) ?? null);
    api.updateIssue(id, toPatch(p)).catch((e) => {
      errorToast(e);
      reload();
    });
  };

  const changeView = (v: View) => {
    setView(v);
    store.set("view", v);
  };

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
    body = <Board issues={shown} onPatch={patch} />;
  } else {
    body = <IssueList issues={shown} onPatch={patch} />;
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
          <div className="segmented" role="group" aria-label="Layout">
            <button className={cls(view === "list" && "on")} onClick={() => changeView("list")} aria-pressed={view === "list"} title="List">
              <ListIcon />
            </button>
            <button className={cls(view === "board" && "on")} onClick={() => changeView("board")} aria-pressed={view === "board"} title="Board">
              <BoardIcon />
            </button>
          </div>
        </div>
      </header>
      <div className={cls("content", view === "board" && !!shown?.length && "content-board")}>{body}</div>
    </>
  );
}

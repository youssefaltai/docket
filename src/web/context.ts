// The app-wide context: current workspace/teams/labels/members and the actions views trigger on the shell.
import { createContext, useContext } from "react";
import type { Inbox, IssueInput, Label, Team, Workspace, WorkspaceMember } from "../shared/types";

export interface AppState {
  workspaces: Workspace[] | null;
  /** The current workspace: the URL's (/acme/…). */
  workspace: Workspace | null;
  /** The current workspace's teams (sidebar, pickers, chips, new issue/doc defaults). */
  teams: Team[] | null;
  /** The current workspace's labels and groups, by path (pickers, chips, filters, settings). */
  labels: Label[];
  /** The current workspace's members (assignee and delegate pickers). */
  members: WorkspaceMember[];
  /** Your inbox in the current workspace (the sidebar shows its unread count), null until it loads. */
  inbox: Inbox | null;
  /** Shows an inbox a write answered with; `reloadInbox` fetches it again. */
  setInbox: (inbox: Inbox) => void;
  reloadInbox: () => void;
  /** Refresh labels and members (called when a picker opens). */
  loadDirectory: () => void;
  /** Refetch teams and workspaces now, without waiting for the live update. */
  reloadTeams: () => void;
  newIssue: (defaults?: Partial<IssueInput>) => void;
  /** `project`: attach the new doc to it (its slug). */
  newDoc: (team?: string, project?: string) => void;
  /** New project, taking part: `team` (default: the current one). */
  newProject: (team?: string) => void;
  newTeam: () => void;
  newWorkspace: () => void;
  /** Switches to another of your workspaces, keeping the same kind of page (settings, docs, inbox, my issues, or issues). */
  switchWorkspace: (key: string) => void;
  /** The doc page reports its team so the sidebar and "new" defaults follow it. */
  setDocTeam: (key: string | null) => void;
  openNav: () => void;
}

export const AppContext = createContext<AppState>(null!);
export const useApp = () => useContext(AppContext);

/** Bumped (debounced) on every server event; views refetch when it changes. */
export const LiveContext = createContext(0);
export const useLive = () => useContext(LiveContext);

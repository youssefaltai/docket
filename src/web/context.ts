// The app-wide context: current workspace/teams/labels/members and the actions views trigger on the shell.
import { createContext, useContext } from "react";
import type { IssueInput, Team, Workspace, WorkspaceMember } from "../shared/types";

export interface AppState {
  workspaces: Workspace[] | null;
  /** The current workspace: remembered, following deep links, else the first. */
  workspace: Workspace | null;
  /** Every team, in any workspace (identifier chips, issue and doc pages). */
  teams: Team[] | null;
  /** Teams in the current workspace (sidebar, pickers, new issue/doc defaults). */
  workspaceTeams: Team[] | null;
  labels: string[];
  /** The current workspace's members (assignee and delegate pickers). */
  members: WorkspaceMember[];
  /** Refresh labels and members (called when a picker opens). */
  loadDirectory: () => void;
  /** Refetch teams and workspaces now, without waiting for the live update. */
  reloadTeams: () => void;
  newIssue: (defaults?: Partial<IssueInput>) => void;
  newDoc: (team?: string) => void;
  newTeam: () => void;
  newWorkspace: () => void;
  teamSettings: (key: string) => void;
  /** The doc page reports its team so the sidebar and "new" defaults follow it. */
  setDocTeam: (key: string | null) => void;
  openNav: () => void;
}

export const AppContext = createContext<AppState>(null!);
export const useApp = () => useContext(AppContext);

/** Bumped (debounced) on every server event; views refetch when it changes. */
export const LiveContext = createContext(0);
export const useLive = () => useContext(LiveContext);

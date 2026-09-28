// Inline SVG icons, plus the status/priority glyphs shared with rendered markdown (issue-ref chips).
import type { SVGProps } from "react";
import type { IssueSummary, Priority, ProjectStatus, StatusCategory } from "../shared/types";
import { useApp } from "./context";
import { issueStatus, statusOf } from "./hooks";

type IconProps = SVGProps<SVGSVGElement>;
const icon = (d: string) => (props: IconProps) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <path d={d} />
  </svg>
);

export const PlusIcon = icon("M8 3.5v9M3.5 8h9");
export const CloseIcon = icon("M4.5 4.5l7 7M11.5 4.5l-7 7");
export const CheckIcon = icon("M3.5 8.5l3 3 6-7");
export const ChevronRightIcon = icon("M6.5 4l4 4-4 4");
export const ChevronDownIcon = icon("M4 6.5l4 4 4-4");
export const SearchIcon = icon("M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM13.5 13.5l-3-3");
export const MenuIcon = icon("M2.5 4.5h11M2.5 8h11M2.5 11.5h11");
export const ListIcon = icon("M2.5 4h11M2.5 8h11M2.5 12h11");
export const BoardIcon = icon("M3 2.5h2.5v11H3zM6.75 2.5h2.5v7h-2.5zM10.5 2.5H13v9h-2.5z");
export const IssuesIcon = icon("M2.5 6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM4.5 2.75h7");
export const TagIcon = icon("M2.5 3.5a1 1 0 0 1 1-1h4l6 6-5 5-6-6zM5.5 5.5h.01");
export const ParentIcon = icon("M4 2.5v6a2 2 0 0 0 2 2h6.5M10 8l2.5 2.5L10 13");
export const BlockedIcon = icon("M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM3.8 3.8l8.4 8.4");
export const TrashIcon = icon("M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6");
export const ArchiveIcon = icon("M2.5 3.5h11a1 1 0 0 1 1 1v2h-13v-2a1 1 0 0 1 1-1zM3.5 6.5v6a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-6M6.5 9h3");
export const PencilIcon = icon("M10.5 2.5l3 3L6 13H3v-3z");
export const ReplyIcon = icon("M6 3.5L2.5 7 6 10.5M2.5 7h6.5a4 4 0 0 1 4 4v1.5");
export const EstimateIcon = icon("M8 2.5l5.5 10h-11z");
export const CalendarIcon = icon("M3.5 3.5h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM2.5 6.5h11M5.5 2v3M10.5 2v3");
const Dots = icon("M3.5 8h.01M8 8h.01M12.5 8h.01");
export const MoreIcon = (props: IconProps) => <Dots strokeWidth={2.4} {...props} />;
export const CopyIcon = icon("M5.5 5.5h7v7h-7zM10.5 5.5v-2h-7v7h2");
export const BranchIcon = icon("M4.5 2v8.5M4.5 13.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11.5 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11.5 5.5c0 3.5-7 2-7 5");
export const PullRequestIcon = icon(
  "M4.5 5v6M4.5 5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM4.5 14a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11.5 14a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11.5 11V6a2 2 0 0 0-2-2H7.5M9 2.5L7.5 4 9 5.5",
);
export const CommitIcon = icon("M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM2 8h4M10 8h4");
export const ProjectIcon = icon("M8 1.75l5.5 3.1v6.3L8 14.25l-5.5-3.1v-6.3zM2.5 4.85L8 8l5.5-3.15M8 8v6.25");
export const DocIcon =icon("M3.5 2.5a1 1 0 0 1 1-1h4.5l3.5 3.5v8.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1zM9 1.5V5h3.5M6 8.5h4M6 11h2.5");
export const HistoryIcon = icon("M2 8a6 6 0 1 0 6-6 6.5 6.5 0 0 0-4.5 1.8L2 5.3M2 2v3.3h3.3M8 4.7V8l2.7 1.3");
export const SettingsIcon = icon("M2.5 4.5h6M12 4.5h1.5M2.5 11.5h1.5M7.5 11.5h6M10 3v3M6 10v3");
export const InboxIcon = icon("M2.5 9.5l1.6-5.3a1 1 0 0 1 1-.7h5.8a1 1 0 0 1 1 .7l1.6 5.3v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM2.5 9.5h3l1 1.5h3l1-1.5h3");
export const BellIcon = icon("M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1.5H3zM6.5 13.5a1.5 1.5 0 0 0 3 0");
export const InfoIcon = icon("M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 7v3.5M8 5.4h.01");
export const ComposeIcon =icon("M13.5 8.5v4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h4M11.5 2.5l2 2L8 10H6V8z");
export const PaperclipIcon = icon("M13 7.5l-5.2 5.2a3 3 0 0 1-4.3-4.2L9 3a2 2 0 0 1 2.9 2.8L6.6 11a1 1 0 0 1-1.4-1.4L10 4.8");
export const StarIcon = icon("M8 2l1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.4l-3.6 1.9.7-4.1-3-2.9 4.1-.6z");
export const GroupIcon = icon("M2.5 3.5h11M5 6.5h8.5M5 9.5h8.5M2.5 12.5h11");
export const SortIcon = icon("M5 13V3M2.5 5.5L5 3l2.5 2.5M11 3v10M8.5 10.5L11 13l2.5-2.5");
export const CycleIcon = icon("M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v2.6h-2.6M8 5v3l2 1.5");
export const ViewsIcon =icon("M8 2.5l5.5 3L8 8.5l-5.5-3zM2.5 8L8 11l5.5-3M2.5 10.5L8 13.5l5.5-3");
export const SmileIcon = icon("M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM5.75 6.5h.01M10.25 6.5h.01M5.3 9.3a3.2 3.2 0 0 0 5.4 0");
export const LockIcon = icon("M4.5 7.5h7a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zM5.5 7.5v-2a2.5 2.5 0 0 1 5 0v2");
export const TeamsIcon = icon("M6 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM2.5 13a3.5 3.5 0 0 1 7 0M10.5 7a1.75 1.75 0 1 0 0-3.5M11.5 9.6a3 3 0 0 1 2 2.9");
export const TemplateIcon = icon("M3 3.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 6.5h10M5.5 9h5M5.5 11h3");

export function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
      <rect width="16" height="16" rx="4" fill="currentColor" />
      <rect x="4" y="5" width="8" height="1.6" rx=".8" fill="#fff" />
      <rect x="4" y="9.4" width="5" height="1.6" rx=".8" fill="#fff" />
    </svg>
  );
}

/** What a status icon draws: a glyph by category, in the status's color; `fill` is how full a started one's pie is. */
export type StatusGlyph = { category: StatusCategory; color: string; fill?: number };

/** Status icon markup, shared by <StatusIcon> and the issue chips inside rendered markdown. */
export function statusBody({ category, color, fill = 0.5 }: StatusGlyph): string {
  const c = /^#[0-9a-f]{6}$/i.test(color) ? color : "#8f8f8f"; // into markup: only ever a hex color
  const ring = `<circle cx="7" cy="7" r="6" stroke="${c}" stroke-width="1.5" fill="none"/>`;
  const pie = (f: number) =>
    `<circle cx="7" cy="7" r="2" fill="none" stroke="${c}" stroke-width="4" stroke-dasharray="${f * 4 * Math.PI} 100" transform="rotate(-90 7 7)"/>`;
  const disc = (mark: string) =>
    `<circle cx="7" cy="7" r="6.75" fill="${c}"/><path d="${mark}" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  return {
    triage: disc("M4.5 7h5M7.5 5l2 2-2 2"),
    backlog: `<circle cx="7" cy="7" r="6" stroke="${c}" stroke-width="1.5" fill="none" stroke-dasharray="2.1 1.67"/>`,
    unstarted: ring,
    started: ring + pie(fill),
    completed: disc("M4.4 7.2l1.8 1.8 3.5-3.7"),
    canceled: disc("M5 5l4 4M9 5l-4 4"),
  }[category];
}

// Chips in rendered markdown know a status by its key alone: they draw the first team's status with that key
// (the app shell keeps this current), else the default workflow's.
let chipStatuses = new Map<string, StatusGlyph>();
export const setChipStatuses = (statuses: Map<string, StatusGlyph>) => (chipStatuses = statuses);

export const statusSvg = (key: string) =>
  `<svg class="status-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">${statusBody(chipStatuses.get(key) ?? statusOf(null, "", key))}</svg>`;

export function StatusIcon({ status, size = 14 }: { status: StatusGlyph; size?: number }) {
  return (
    <svg
      className="status-icon"
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: statusBody(status) }}
    />
  );
}

/** A project's status as a status glyph: backlog a dashed ring, planned a ring, in progress half a pie, paused an orange ring, then check and x discs. */
const PROJECT_GLYPHS: Record<ProjectStatus, StatusGlyph> = {
  backlog: { category: "backlog", color: "#a3a3a3" },
  planned: { category: "unstarted", color: "#8f8f8f" },
  in_progress: { category: "started", color: "#e8a800", fill: 0.5 },
  paused: { category: "unstarted", color: "#f76b15" }, // --urgent
  completed: { category: "completed", color: "#5e6ad2" },
  canceled: { category: "canceled", color: "#b4b4b4" },
};

export const ProjectStatusIcon = ({ status, size }: { status: ProjectStatus; size?: number }) => <StatusIcon status={PROJECT_GLYPHS[status]} size={size} />;

/** An issue's status icon, from its team's workflow. */
export function IssueStatusIcon({ issue, size }: { issue: Pick<IssueSummary, "team" | "status" | "statusCategory">; size?: number }) {
  return <StatusIcon status={issueStatus(useApp().teams, issue)} size={size} />;
}

export function PriorityIcon({ priority }: { priority: Priority }) {
  if (priority === 1)
    return (
      <svg className="priority-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--urgent)" />
        <rect x="6.25" y="3.5" width="1.5" height="4.5" rx=".75" fill="#fff" />
        <circle cx="7" cy="10.1" r=".9" fill="#fff" />
      </svg>
    );
  if (priority === 0)
    return (
      <svg className="priority-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="var(--faint)">
        <rect x="1.5" y="6.25" width="2.5" height="1.5" rx=".75" />
        <rect x="5.75" y="6.25" width="2.5" height="1.5" rx=".75" />
        <rect x="10" y="6.25" width="2.5" height="1.5" rx=".75" />
      </svg>
    );
  const filled = 5 - priority; // high 3, medium 2, low 1
  return (
    <svg className="priority-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="currentColor">
      {[
        [1.5, 8, 4.5],
        [5.5, 5, 7.5],
        [9.5, 2, 10.5],
      ].map(([x, y, h], i) => (
        <rect key={i} x={x} y={y} width="3" height={h} rx="1" opacity={i < filled ? 1 : 0.25} />
      ))}
    </svg>
  );
}

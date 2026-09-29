// Rendering Markdown (issue descriptions, comments, docs): sanitized, with issue-ref and mention chips and client routing.
import { useMemo } from "react";
import { Marked } from "marked";
import { ATTACHMENT_URL, MENTION_PATTERN, mentionOf } from "../shared/types";
import { useApp } from "./context";
import { statusSvg } from "./icons";
import { isPlainClick, navigate, wsPath } from "./routing";
import { useChipSource, type ChipSource } from "./issueIndex";
import { cls } from "./util";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Browsers strip whitespace/control chars when parsing URLs, so check the cleaned form. */
function safeUrl(href: string): string | null {
  const url = href.replace(/[\u0000- ]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
  return !scheme || /^(https?|mailto)$/i.test(scheme) ? url : null;
}

/** App paths and in-page anchors stay in the tab (and route client-side); everything else opens a new one. */
const isInternal = (url: string) => /^(\/(?!\/)|#)/.test(url);

// Set right before each parse: which identifiers resolve to real issues of known teams (one from before a move links to
// the issue's current one) and which @usernames to active members.
let chips: ChipSource;
const IDENT = /\b[A-Z]{2,5}-\d+\b/g;
const MENTIONS = new RegExp(MENTION_PATTERN, "giu");
const MENTION_AT = new RegExp(MENTION_PATTERN, "iuy");
const known = (username: string) => !!chips.member(username);
/** The member mentioned at the start of `src`, given the text just `before` it (a mention needs a boundary there). */
function mentionAt(before: string, src: string): string | undefined {
  MENTION_AT.lastIndex = before.length;
  const m = MENTION_AT.exec(before + src.slice(0, 34)); // "@", at most 32 characters, and the one after
  return m ? mentionOf(m[1]!, known) : undefined;
}

// Heading ids for the outline and #anchors; deduped per parse.
let headingIds = new Map<string, number>();
function headingId(text: string): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const n = headingIds.get(base) ?? 0;
  headingIds.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  hooks: {
    preprocess(md) {
      headingIds = new Map();
      return md;
    },
  },
  extensions: [
    {
      name: "issueRef",
      level: "inline",
      start(src) {
        for (const m of src.matchAll(IDENT)) if (chips.issue(m[0])) return m.index;
      },
      tokenizer(src) {
        const m = /^[A-Z]{2,5}-\d+\b/.exec(src);
        if (m && !this.lexer.state.inLink && chips.issue(m[0])) return { type: "issueRef", raw: m[0] };
      },
      renderer({ raw }) {
        const issue = chips.issue(raw);
        if (!issue) return raw;
        return `<a class="issue-ref" href="${wsPath(`/issue/${issue.id}`)}" title="${escapeHtml(issue.title)}">${statusSvg(issue.status)}${raw}</a>`;
      },
    },
    {
      // @username of an active member: a plain-text chip (nothing loads). dir="ltr" keeps "@name" whole in Arabic text.
      name: "mention",
      level: "inline",
      start(src) {
        for (const m of src.matchAll(MENTIONS)) if (mentionOf(m[1]!, known)) return m.index;
      },
      tokenizer(src, tokens) {
        const username = this.lexer.state.inLink ? undefined : mentionAt(tokens.at(-1)?.raw.slice(-1) ?? "", src);
        if (username) return { type: "mention", raw: src.slice(0, username.length + 1), username };
      },
      renderer({ username }) {
        const user = chips.member(username)!;
        const kind = user.kind === "agent" ? "mention mention-agent" : "mention";
        return `<span class="${kind}" dir="ltr" title="${escapeHtml(user.name)}">@${username}</span>`;
      },
    },
  ],
  renderer: {
    // Raw HTML is shown as text, never rendered.
    html: ({ text, block }) => (block ? `<p>${escapeHtml(text)}</p>` : escapeHtml(text)),
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${escapeHtml(headingId(text))}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const url = safeUrl(href);
      if (!url) return text;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      const internal = isInternal(url);
      // Attachments are files, not app pages: a new tab (an image) or a download.
      const target = internal && !url.startsWith("/api/") ? "" : ` target="_blank" rel="noopener noreferrer"`;
      // Stored content says [Title](/doc/slug): the doc in the content's workspace, the one shown.
      return `<a href="${escapeHtml(internal ? wsPath(url) : url)}"${t}${target}>${text}</a>`;
    },
    // Only attachments (same origin, private to the workspace) load as images. Any other image is a link: a remote
    // image in text an agent wrote could carry data out, or track readers, on page load, with no click.
    image({ href, title, text }) {
      const url = safeUrl(href);
      if (!url) return escapeHtml(text);
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      if (!ATTACHMENT_URL.test(url)) return `<a href="${escapeHtml(url)}"${t} target="_blank" rel="noopener noreferrer">${escapeHtml(text || url)}</a>`;
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${t} loading="lazy">`;
    },
  },
});

export function Markdown({ text, className }: { text: string; className?: string }) {
  const { workspace } = useApp();
  const chipSource = useChipSource();
  const html = useMemo(() => {
    chips = chipSource;
    return (marked.parse(text) as string).replace(/<(p|h[1-6]|ul|ol|blockquote|table|td|th)(?=[\s>])/g, '<$1 dir="auto"');
  }, [text, chipSource, workspace?.key]);
  return (
    <div
      className={cls("md", className)}
      dir="auto"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        // Links to /doc/…, /issue/… etc. route client-side; attachments (/api/…) open in their new tab.
        const href = (e.target as Element).closest("a")?.getAttribute("href");
        if (!href?.startsWith("/") || href.startsWith("//") || href.startsWith("/api/") || !isPlainClick(e)) return;
        e.preventDefault();
        navigate(href);
      }}
    />
  );
}

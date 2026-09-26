// Rendering Markdown (issue descriptions, comments, docs): sanitized, with issue-ref chips and client routing.
import { useMemo } from "react";
import { Marked } from "marked";
import type { IssueSummary } from "../shared/types";
import { useApp } from "./context";
import { statusSvg } from "./icons";
import { isPlainClick, navigate } from "./routing";
import { useIssueIndex } from "./issueIndex";
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

// Set right before each parse: whether images load (not in the assistant's replies, see Markdown).
let allowImages = true;

// Set right before each parse: which identifiers resolve to real issues of known teams.
let chipKeys = new Set<string>();
let chipIndex: Map<string, IssueSummary> | null = null;
const chipFor = (id: string) => (chipKeys.has(id.slice(0, id.indexOf("-"))) ? chipIndex?.get(id) : undefined);
const IDENT = /\b[A-Z]{2,5}-\d+\b/g;

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
        for (const m of src.matchAll(IDENT)) if (chipFor(m[0])) return m.index;
      },
      tokenizer(src) {
        const m = /^[A-Z]{2,5}-\d+\b/.exec(src);
        if (m && !this.lexer.state.inLink && chipFor(m[0])) return { type: "issueRef", raw: m[0] };
      },
      renderer({ raw }) {
        const issue = chipFor(raw);
        if (!issue) return raw;
        return `<a class="issue-ref" href="/issue/${raw}" title="${escapeHtml(issue.title)}">${statusSvg(issue.status)}${raw}</a>`;
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
      const target = isInternal(url) ? "" : ` target="_blank" rel="noopener noreferrer"`;
      return `<a href="${escapeHtml(url)}"${t}${target}>${text}</a>`;
    },
    image({ href, title, text }) {
      if (!allowImages) return escapeHtml(text);
      const url = safeUrl(href);
      if (!url) return escapeHtml(text);
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${t} loading="lazy">`;
    },
  },
});

/**
 * `images={false}` shows an image's alt text instead of loading it: for text a model wrote, where a
 * prompt injected into what it read could make it write an image URL that carries data out on render.
 */
export function Markdown({ text, className, images = true }: { text: string; className?: string; images?: boolean }) {
  const { teams } = useApp();
  const index = useIssueIndex();
  const html = useMemo(() => {
    chipKeys = new Set(teams?.map((t) => t.key));
    chipIndex = index;
    allowImages = images;
    try {
      return (marked.parse(text) as string).replace(/<(p|h[1-6]|ul|ol|blockquote|table|td|th)(?=[\s>])/g, '<$1 dir="auto"');
    } finally {
      allowImages = true;
    }
  }, [text, teams, index, images]);
  return (
    <div
      className={cls("md", className)}
      dir="auto"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        // Links to /doc/…, /issue/… etc. route client-side.
        const href = (e.target as Element).closest("a")?.getAttribute("href");
        if (!href?.startsWith("/") || href.startsWith("//") || !isPlainClick(e)) return;
        e.preventDefault();
        navigate(href);
      }}
    />
  );
}

// A small Markdown renderer for walkthrough prose. It exists so line
// references (`[phrase](line:40-52)`) and workspace file links render as
// first-class links; BB's Markdown component does not expose link hooks.
import { Fragment, type ReactNode } from "react";
import { experimental_FileLink as FileLink, UrlLink } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";

export interface ProseContext {
  environmentId: string | null;
  /** The code block a `line:` reference points into. */
  codePath: string | null;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/gu;

function lineRange(value: string): { start: number; end: number } | null {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function link(label: ReactNode, href: string, context: ProseContext, key: string): ReactNode {
  const refClass = "cursor-pointer border-b border-dotted border-muted-foreground/70 hover:bg-secondary";
  if (href.startsWith("line:")) {
    const range = lineRange(href.slice(5));
    if (range && context.codePath && context.environmentId) {
      return (
        <FileLink
          key={key}
          target={{ kind: "workspace", environmentId: context.environmentId, path: context.codePath }}
          location={range.start === range.end ? { kind: "line", line: range.start, column: null } : { kind: "range", startLine: range.start, endLine: range.end }}
          className={refClass}
          title={`${context.codePath}, line${range.start === range.end ? ` ${range.start}` : `s ${range.start}–${range.end}`}`}
        >
          {label}
        </FileLink>
      );
    }
    return (
      <span key={key} className="border-b border-dotted border-muted-foreground/50">
        {label}
      </span>
    );
  }
  if (/^https?:\/\//u.test(href)) {
    return (
      <UrlLink key={key} href={href} className="underline underline-offset-2">
        {label}
      </UrlLink>
    );
  }
  const file = /^([^#]+?)(?:#L(\d+)(?:-L?(\d+))?)?$/u.exec(href);
  if (file && context.environmentId && !href.includes("://")) {
    const start = file[2] ? Number(file[2]) : null;
    const end = file[3] ? Number(file[3]) : start;
    return (
      <FileLink
        key={key}
        target={{ kind: "workspace", environmentId: context.environmentId, path: file[1]! }}
        location={start === null ? null : start === end ? { kind: "line", line: start, column: null } : { kind: "range", startLine: start, endLine: end! }}
        className={refClass}
      >
        {label}
      </FileLink>
    );
  }
  return <Fragment key={key}>{label}</Fragment>;
}

function inline(text: string, context: ProseContext, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (match[1]) {
      out.push(
        <code key={key} className="rounded bg-secondary px-1 py-px font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      out.push(
        <strong key={key} className="font-medium">
          {inline(token.slice(2, -2), context, key)}
        </strong>,
      );
    } else if (match[3]) {
      out.push(<em key={key}>{inline(token.slice(1, -1), context, key)}</em>);
    } else if (match[4]) {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(token)!;
      out.push(link(inline(linkMatch[1]!, context, key), linkMatch[2]!, context, key));
    }
    last = start + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Paragraphs, bullet and numbered lists, and inline code, emphasis, and links. */
export function Prose({ text, context, className }: { text: string; context: ProseContext; className?: string }) {
  const blocks = text.trim().split(/\n{2,}/u);
  return (
    <div className={cn("space-y-3 font-serif text-[15px] leading-[1.65]", className)}>
      {blocks.map((block, blockIndex) => {
        const lines = block.split("\n");
        const bullets = lines.every((line) => /^\s*[-*]\s+/u.test(line));
        const numbered = lines.every((line) => /^\s*\d+[.)]\s+/u.test(line));
        if (bullets || numbered) {
          const Tag = numbered ? "ol" : "ul";
          return (
            <Tag key={blockIndex} className={cn("space-y-1 pl-5", numbered ? "list-decimal" : "list-disc")}>
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>{inline(line.replace(/^\s*(?:[-*]|\d+[.)])\s+/u, ""), context, `${blockIndex}-${lineIndex}`)}</li>
              ))}
            </Tag>
          );
        }
        const heading = /^#{1,6}\s+(.*)$/u.exec(block);
        if (heading && lines.length === 1) {
          return (
            <p key={blockIndex} className="font-medium">
              {inline(heading[1]!, context, `${blockIndex}`)}
            </p>
          );
        }
        return <p key={blockIndex}>{inline(lines.join(" "), context, `${blockIndex}`)}</p>;
      })}
    </div>
  );
}

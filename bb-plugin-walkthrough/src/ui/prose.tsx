// A small Markdown renderer for walkthrough prose. It exists so line
// references (`[phrase](line:40-52)`) and workspace file links render as
// first-class links; BB's Markdown component does not expose link hooks.
import { Fragment, memo, type ReactNode } from "react";
import { experimental_FileLink as FileLink, UrlLink } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { fileTarget, type FileContext } from "../files.ts";
import { parseMarkdownBlocks } from "./markdown-blocks.ts";

export interface ProseContext {
  files: FileContext;
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
  const refClass = "wt-ref";
  if (href.startsWith("line:")) {
    const range = lineRange(href.slice(5));
    const target = context.codePath ? fileTarget(context.files, context.codePath) : null;
    if (range && target) {
      return (
        <FileLink
          key={key}
          target={target}
          location={range.start === range.end ? { kind: "line", line: range.start, column: null } : { kind: "range", startLine: range.start, endLine: range.end }}
          className={refClass}
          title={`${context.codePath}, line${range.start === range.end ? ` ${range.start}` : `s ${range.start}–${range.end}`}`}
        >
          {label}
        </FileLink>
      );
    }
    return (
      <span key={key} className="wt-ref">
        {label}
      </span>
    );
  }
  if (/^https?:\/\//u.test(href)) {
    return (
      <UrlLink key={key} href={href} className="wt-link">
        {label}
      </UrlLink>
    );
  }
  const file = /^([^#]+?)(?:#L(\d+)(?:-L?(\d+))?)?$/u.exec(href);
  const target = file && !href.includes("://") ? fileTarget(context.files, file[1]!) : null;
  if (file && target) {
    const start = file[2] ? Number(file[2]) : null;
    const end = file[3] ? Number(file[3]) : start;
    return (
      <FileLink
        key={key}
        target={target}
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
        <code key={key} className="wt-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      out.push(
        <strong key={key}>
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

/** Memoized so a streaming answer re-parses only when its text changes. Paragraphs, headings, bullet and numbered lists, fenced code, and inline code, emphasis, and links. */
function ProseImpl({ text, context, className }: { text: string; context: ProseContext; className?: string }) {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className={cn("wt-prose", className)}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "code":
            return (
              <pre
                key={index}
                className="wt-pre"
              >
                <code>{block.text}</code>
              </pre>
            );
          case "table":
            return (
              <div key={index} className="wt-table-wrap">
                <table className="wt-table">
                  <thead>
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th key={cellIndex} className="wt-th">
                          {inline(cell, context, `${index}-h${cellIndex}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="wt-td">
                            {inline(cell, context, `${index}-${rowIndex}-${cellIndex}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={index} {...(block.ordered ? { start: block.start } : {})} className={block.ordered ? "wt-ol" : "wt-ul"}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{inline(item, context, `${index}-${itemIndex}`)}</li>
                ))}
              </Tag>
            );
          }
          case "heading":
            return (
              <p key={index} className="wt-subhead">
                {inline(block.text, context, `${index}`)}
              </p>
            );
          case "paragraph":
            return <p key={index}>{inline(block.text, context, `${index}`)}</p>;
        }
      })}
    </div>
  );
}

export const Prose = memo(ProseImpl, (a, b) => a.text === b.text && a.className === b.className && a.context.codePath === b.context.codePath && a.context.files === b.context.files);

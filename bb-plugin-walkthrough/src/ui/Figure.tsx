// A figure in the reading page: a numbered code excerpt whose gutter carries
// note markers, with each note hanging in the right margin on wide pages and
// stacked under the code on narrow ones. Rows have a fixed height, so a note's
// offset is arithmetic instead of measurement and nothing reflows after paint.
import { useContext, useEffect, useId, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { defaultExcerptView, excerptCode, NOTE_KIND_LABEL, type ExcerptView } from "../model.ts";
import type { DeliveredCodeBlock as CodeBlock, DeliveredNote as Note, DeliveredWalkthrough as Walkthrough, Location } from "../schemas.ts";
import { ReaderContext } from "./context.ts";
import { savedExcerpt, type Snapshot } from "./fields.ts";
import { Hint } from "./Hint.tsx";
import { useWalkthroughRpc } from "./hooks.ts";
import { useNotify } from "./notices.tsx";
import { LocationLink } from "./parts.tsx";
import { parsePatchRows, rowIndexForLine, type PatchRow } from "./patch-lines.ts";
import { rowEmphasis, type Emphasis } from "./word-diff.ts";

const VIEW_LABEL: Record<ExcerptView, string> = { change: "Diff", after: "After", before: "Before" };
const VIEWS: ExcerptView[] = ["change", "after", "before"];
export const ROW_HEIGHT = 20;
const HEADER_HEIGHT = 32;
const CODE_PAD = 6;
const CLAMP_ROWS = 30;
const MARGIN_NOTE_GAP = 8;
/** Said when a figure has no code to show (a walkthrough saved before excerpts were kept, or code that is gone). */
export const NO_SAVED_COPY = "No saved copy of this code";

/** What a reader flagged: a place in the code and the text it came from. */
export interface FlagTarget {
  /** Null for a selection in prose, which is not anchored to a place in the code. */
  location: Location | null;
  quote: string | null;
}

interface Annotation {
  key: string;
  row: number;
  text: string;
  /** The reader's flag kind ("Note", "Todo"…); null for the agent's own margin notes. */
  label: string | null;
  /** What the marker shows: the agent's notes are numbered, the reader's flags lettered. */
  glyph: string;
  own: boolean;
}

/** The revision a figure was read at, as a short SHA. */
export function shortSha(sha: string | null | undefined): string | null {
  return sha && /^[0-9a-f]{7,64}$/iu.test(sha) ? sha.slice(0, 7) : null;
}

/** A GitHub page for the figure's file at the revision it was read at, for a walkthrough of a GitHub PR. */
export function githubLink(walkthrough: Pick<Walkthrough, "pr">, block: Pick<CodeBlock, "path" | "startLine" | "endLine" | "snapshot">): string | null {
  const url = walkthrough.pr?.url;
  const match = url ? /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/\d+/u.exec(url) : null;
  if (!match) return null;
  const sha = block.snapshot?.headSha;
  if (!sha || !/^[0-9a-f]{7,64}$/iu.test(sha) || block.path.startsWith("/")) return `${url!.replace(/\/+$/u, "")}/files`;
  const encoded = block.path.split("/").map(encodeURIComponent).join("/");
  return `${match[1]}/blob/${sha}/${encoded}#L${block.startLine}-L${block.endLine}`;
}

/** The file lines a selection inside a figure spans, read from the rows' `data-line` attributes. */
export function figureSelection(range: Range): FlagTarget | null {
  const lineOf = (node: Node | null) => {
    const element = node instanceof Element ? node : (node?.parentElement ?? null);
    const row = element?.closest<HTMLElement>("[data-line]");
    return row ? Number(row.dataset.line) : null;
  };
  const figure = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest<HTMLElement>("figure[data-code-path]");
  const first = lineOf(range.startContainer);
  const last = lineOf(range.endContainer);
  const path = figure?.dataset.codePath;
  if (!figure || !path || first === null || last === null) return null;
  const startLine = Math.min(first, last);
  const endLine = Math.max(first, last);
  return { location: { path, startLine, ...(endLine > startLine ? { endLine } : {}) }, quote: range.toString().trim().slice(0, 2000) || null };
}

function useSnapshot(walkthrough: Walkthrough, block: CodeBlock): { data: Snapshot | null; loading: boolean } {
  const rpc = useWalkthroughRpc();
  const saved = useMemo(() => savedExcerpt(block), [block]);
  const [fetched, setFetched] = useState<Snapshot | "missing" | null>(null);
  useEffect(() => {
    if (saved) return;
    let live = true;
    setFetched(null);
    rpc
      .call("excerpt", { walkthroughId: walkthrough.id, path: block.path, startLine: block.startLine, endLine: block.endLine })
      .then(
        (result) => live && setFetched(result.outcome === "available" ? { change: result.change, after: result.after, before: result.before } : "missing"),
        () => live && setFetched("missing"),
      );
    return () => {
      live = false;
    };
  }, [rpc, saved, walkthrough.id, block.path, block.startLine, block.endLine]);
  if (saved) return { data: saved, loading: false };
  return { data: fetched && fetched !== "missing" ? fetched : null, loading: fetched === null };
}

function annotationsFor(block: CodeBlock, notes: Note[], rows: PatchRow[], glyphs: Map<string, string>): Annotation[] {
  const at = (line: number | undefined) => (rows.length === 0 ? 0 : line === undefined ? 0 : rowIndexForLine(rows, line));
  const agent = block.notes
    .map((note, index) => ({ key: `a${index}`, row: at(note.line), text: note.text }))
    .sort((a, b) => a.row - b.row)
    .map((note, index): Annotation => ({ ...note, label: null, glyph: String(index + 1), own: false }));
  const own = notes.map((note): Annotation => ({ key: `n${note.id}`, row: at(note.location?.startLine), text: note.text, label: NOTE_KIND_LABEL[note.kind], glyph: glyphs.get(note.id) ?? "•", own: true }));
  return [...agent, ...own].sort((a, b) => a.row - b.row);
}

/** How tall a margin note is: about 30 characters to a 20px line in the 210px margin, plus its padding. */
function noteHeight(annotation: Annotation): number {
  return Math.ceil((annotation.text.length + (annotation.label?.length ?? 0) + 3) / 30) * 20 + 6;
}

/** Where each margin note starts: level with its row, pushed down past the note above it. */
function marginOffsets(annotations: Annotation[]): number[] {
  let floor = 0;
  return annotations.map((annotation) => {
    const top = Math.max(HEADER_HEIGHT + CODE_PAD + annotation.row * ROW_HEIGHT, floor);
    floor = top + noteHeight(annotation) + MARGIN_NOTE_GAP;
    return top;
  });
}

/** A line of code with the words that changed marked (see word-diff.ts); the text itself is untouched, so selecting and copying it read the same. */
function EmphasizedText({ text, ranges }: { text: string; ranges: Emphasis | undefined }) {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], index) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={index} className="wt-w">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * The hairline from a code row to its margin note. A note level with its row
 * gets a short tick; one pushed down past the note above it gets an elbow that
 * runs from the row to the note, so a displaced note still points at its line.
 * It crosses the 18px gap between the figure and the margin, and is drawn in the
 * note's own box so it lights up with it.
 */
function Leader({ drift, slot }: { drift: number; /** Which of the figure's notes this is; neighbours bend at different x so their leaders read as separate lines, not one bracket. */ slot: number }) {
  const d = Math.max(0, Math.round(drift));
  const elbow = d > 12;
  const height = elbow ? d + 1 : 1;
  const x = 5 + (slot % 3) * 3;
  const path = elbow ? `M0 .5 H${x - 4} Q${x} .5 ${x} 4.5 V${d - 3.5} Q${x} ${d + 0.5} ${x + 4} ${d + 0.5} H18` : "M0 .5 H18";
  return (
    <svg className="wt-leader" width={18} height={height} viewBox={`0 0 18 ${height}`} style={{ top: 10 - (elbow ? d : 0) }} aria-hidden>
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1} />
    </svg>
  );
}

export function Figure({
  walkthrough,
  block,
  notes,
  wide,
  onFlag,
  streaming = false,
}: {
  walkthrough: Walkthrough;
  block: CodeBlock;
  /** Open notes the reader anchored inside this excerpt. */
  notes: Note[];
  wide: boolean;
  onFlag: (target: FlagTarget, anchor: DOMRect) => void;
  /** The figure is still being written; its code comes from the working tree until the part is saved. */
  streaming?: boolean;
}) {
  const { data, loading } = useSnapshot(walkthrough, block);
  const { glyphs } = useContext(ReaderContext);
  const notify = useNotify();
  const isCode = block.view === "code";
  const [chosen, setChosen] = useState<ExcerptView | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  // The line the keyboard is on, as a row index; `c` flags it.
  const [cursor, setCursor] = useState<number | null>(null);
  const figureId = useId();
  const hot = hovered ?? pinned;

  const preferred: ExcerptView = isCode ? "after" : (chosen ?? (data ? defaultExcerptView(data) : "change"));
  const view = data && !data[preferred] ? (VIEWS.find((candidate) => data[candidate]) ?? preferred) : preferred;
  const patch = data ? (isCode ? (data.after ?? data.change) : data[view]) : null;
  const copyView: ExcerptView = isCode ? (data?.after ? "after" : "change") : view;
  const rows = useMemo(() => (patch ? parsePatchRows(patch) : []), [patch]);
  const emphasis = useMemo(() => rowEmphasis(rows), [rows]);
  const annotations = useMemo(() => annotationsFor(block, notes, rows, glyphs), [block, notes, rows, glyphs]);
  const offsets = useMemo(() => marginOffsets(annotations), [annotations]);
  // A note below the clamp stretches it to just past that note; the rest stays folded so flagging never opens the whole figure.
  const lastNoteRow = annotations.reduce((max, annotation) => Math.max(max, annotation.row), -1);
  const clampRows = Math.max(CLAMP_ROWS, lastNoteRow + 2);
  const clamped = rows.length > clampRows && !expanded;
  const markerRows = new Map<number, Annotation[]>();
  annotations.forEach((annotation) => markerRows.set(annotation.row, [...(markerRows.get(annotation.row) ?? []), annotation]));
  // A figure with nothing to show has no rows for notes to point at: they collapse under it instead.
  const empty = !loading && rows.length === 0;
  // The margin hangs outside the figure and may run past its bottom rule: the notes are free to, since the column beside the next paragraph is empty.
  // Only a figure that follows closely is moved down (see .wt-figure[data-hang] in app.css), so notes never collide with the next figure's.
  const last = annotations.at(-1);
  const shownRows = clamped ? clampRows : rows.length;
  const figureHeight = HEADER_HEIGHT + CODE_PAD * 2 + shownRows * ROW_HEIGHT;
  const hang = wide && last && !empty ? Math.max(0, Math.ceil((offsets.at(-1) ?? 0) + noteHeight(last) - figureHeight)) : 0;
  const revision = shortSha(block.snapshot?.headSha) ?? shortSha(block.snapshot?.baseSha);
  const github = githubLink(walkthrough, block);

  const copy = (text: string, done: string) =>
    void navigator.clipboard.writeText(text).then(
      () => notify(done),
      () => notify("Could not copy", "error"),
    );
  const flaggable = rows.map((row, index) => (row.kind !== "gap" && row.newNo !== null ? index : -1)).filter((index) => index >= 0);
  const flagRow = (index: number, element: Element) => {
    const row = rows[index];
    if (!row || row.newNo === null) return;
    onFlag({ location: { path: block.path, startLine: row.newNo }, quote: row.text.trim() || null }, element.getBoundingClientRect());
  };
  const onCodeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.target !== event.currentTarget) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const at = cursor === null ? -1 : flaggable.indexOf(cursor);
      const next = event.key === "ArrowDown" ? Math.min(flaggable.length - 1, at + 1) : Math.max(0, at - 1);
      const row = flaggable[next];
      if (row === undefined) return;
      setCursor(row);
      document.getElementById(`${figureId}-r${row}`)?.scrollIntoView?.({ block: "nearest" });
    } else if ((event.key === "c" || event.key === "Enter") && cursor !== null) {
      event.preventDefault();
      event.stopPropagation();
      const element = document.getElementById(`${figureId}-r${cursor}`);
      if (element) flagRow(cursor, element);
    }
  };
  const cursorLine = cursor === null ? null : (rows[cursor]?.newNo ?? null);

  const note = (annotation: Annotation, drift = -1, slot = 0) => (
    <div
      key={annotation.key}
      className={cn("wt-mn", annotation.own && "wt-mn-own", hot === annotation.key && "wt-hot")}
      onMouseEnter={() => setHovered(annotation.key)}
      onMouseLeave={() => setHovered(null)}
    >
      {drift >= 0 ? <Leader drift={drift} slot={slot} /> : null}
      <span className={cn("wt-m wt-m-inline", annotation.own && "wt-m-own")} aria-hidden>
        {annotation.glyph}
      </span>
      {annotation.label ? <span className="wt-mn-kind">{annotation.label} · </span> : null}
      {annotation.text}
    </div>
  );
  const marginNotes =
    annotations.length === 0 ? null : empty ? (
      <details className="wt-notes-collapsed">
        <summary>{annotations.length === 1 ? "1 note on this code" : `${annotations.length} notes on this code`}</summary>
        <div className="wt-notes-stack">{annotations.map((annotation) => note(annotation))}</div>
      </details>
    ) : wide ? (
      <div className="wt-margin" aria-label="Notes on this code">
        {annotations.map((annotation, index) => (
          <div key={annotation.key} className="wt-margin-slot" style={{ top: offsets[index] }}>
            {note(annotation, (offsets[index] ?? 0) - (HEADER_HEIGHT + CODE_PAD + annotation.row * ROW_HEIGHT), index)}
          </div>
        ))}
      </div>
    ) : (
      <div className="wt-notes-stack" aria-label="Notes on this code">
        {annotations.map((annotation) => note(annotation))}
      </div>
    );

  return (
    <figure data-code-path={block.path} data-code-start={block.startLine} data-code-end={block.endLine} className="wt-figure" data-wide={wide || undefined} data-streaming={streaming || undefined} data-hang={hang > 0 || undefined} style={hang > 0 ? ({ "--wt-hang": `${hang}px` } as CSSProperties) : undefined}>
      <figcaption className="wt-cap">{block.caption}</figcaption>
      <div className="wt-fig">
        <div className="wt-fh">
          <span className="wt-fh-where">
            <LocationLink files={walkthrough} location={{ path: block.path, startLine: block.startLine, endLine: block.endLine }} className="wt-fh-loc" />
            {revision ? (
              <span className="wt-fh-rev" aria-label={`Read at revision ${revision}`}>
                @ {revision}
              </span>
            ) : null}
          </span>
          <span className="wt-sp" />
          {!isCode && !empty ? (
            <div role="group" aria-label="Show the code as" className="wt-seg">
              {VIEWS.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  disabled={!data?.[candidate]}
                  aria-pressed={view === candidate}
                  onClick={() => setChosen(candidate)}
                >
                  {VIEW_LABEL[candidate]}
                </button>
              ))}
            </div>
          ) : null}
          {github ? (
            <UrlLink href={github} className="wt-fh-link">
              Open on GitHub
            </UrlLink>
          ) : null}
          <Hint label="Copy the path">
            <button type="button" className="wt-icon-btn" aria-label="Copy the path" onClick={() => copy(block.path, "Path copied")}>
              <Icon name="Link" className="size-3.5" aria-hidden />
            </button>
          </Hint>
          {!empty ? (
            <Hint label="Copy the code">
              <button type="button" className="wt-icon-btn" aria-label="Copy the code" disabled={!patch} onClick={() => patch && copy(excerptCode(patch, copyView), "Code copied")}>
                <Icon name="Copy" className="size-3.5" aria-hidden />
              </button>
            </Hint>
          ) : null}
        </div>
        {loading ? (
          <div className="wt-code" role="status" aria-label="Loading the code">
            {[62, 80, 48, 70].map((width, index) => (
              <div key={index} className="wt-row wt-skel-row">
                <span className="wt-skel" style={{ width: `${width}%` }} />
              </div>
            ))}
          </div>
        ) : empty ? (
          <p className="wt-fig-empty">{block.snapshotError ?? NO_SAVED_COPY}</p>
        ) : (
          <div
            className="wt-code"
            role="region"
            tabIndex={0}
            aria-label={`Code from ${block.path}, lines ${block.startLine} to ${block.endLine}. Up and Down move between lines, C flags the line.`}
            style={clamped ? { maxHeight: clampRows * ROW_HEIGHT + CODE_PAD * 2, overflow: "hidden" } : undefined}
            onKeyDown={onCodeKeyDown}
            onBlur={() => setCursor(null)}
          >
            <span className="wt-sr" role="status" aria-live="polite">
              {cursorLine === null ? "" : `Line ${cursorLine}. Press C to flag it.`}
            </span>
            <div key={view} className={cn("wt-code-rows", chosen !== null && "wt-swap")}>
              {rows.map((row, index) => {
                const line = row.newNo ?? row.oldNo;
                const markers = markerRows.get(index) ?? [];
                const isHot = markers.some((annotation) => annotation.key === hot);
                if (row.kind === "gap") {
                  return (
                    <div key={index} className="wt-row wt-gap" aria-hidden>
                      <b />
                      <span>⋯</span>
                    </div>
                  );
                }
                return (
                  <div
                    key={index}
                    id={`${figureId}-r${index}`}
                    className={cn("wt-row", `wt-${row.kind}`, isHot && "wt-hot", row.newNo !== null && "wt-flaggable")}
                    data-line={line ?? undefined}
                    data-cursor={cursor === index || undefined}
                    // A click on the code flags that line; a drag across it is a selection, which flags through the toolbar.
                    onClick={(event) => {
                      if (row.newNo === null || (event.target as HTMLElement).closest("button") || (window.getSelection()?.toString() ?? "") !== "") return;
                      flagRow(index, event.currentTarget);
                    }}
                  >
                    <b>
                      {markers.length > 0 ? (
                        <span className="wt-mk">
                        {markers.map((annotation) => (
                          <button
                            key={annotation.key}
                            type="button"
                            className={cn("wt-m", annotation.own && "wt-m-own")}
                            aria-label={annotation.own ? `Your ${annotation.label?.toLowerCase()} ${annotation.glyph}: ${annotation.text}` : `Note ${annotation.glyph}: ${annotation.text}`}
                            aria-pressed={pinned === annotation.key}
                            onMouseEnter={() => setHovered(annotation.key)}
                            onMouseLeave={() => setHovered(null)}
                            onFocus={() => setHovered(annotation.key)}
                            onBlur={() => setHovered(null)}
                            onClick={() => setPinned(pinned === annotation.key ? null : annotation.key)}
                          >
                            {annotation.glyph}
                          </button>
                        ))}
                        </span>
                      ) : null}
                      {row.newNo !== null ? (
                        <button
                          type="button"
                          className="wt-ln"
                          // Rows are one tab stop (the region); the number is for the pointer.
                          tabIndex={-1}
                          aria-label={`Flag line ${row.newNo}`}
                          data-tip="Flag this line"
                          onClick={(event) => flagRow(index, event.currentTarget)}
                        >
                          <span className="wt-ln-plus" aria-hidden>
                            +
                          </span>
                          {row.newNo}
                        </button>
                      ) : (
                        // A removed line is not in the new code, so there is nothing to anchor a flag to.
                        <span className="wt-ln wt-ln-removed">{line}</span>
                      )}
                    </b>
                    <span className="wt-text">
                      {row.kind === "add" ? <span className="wt-sr">Added: </span> : row.kind === "del" ? <span className="wt-sr">Removed: </span> : null}
                      {row.text === "" ? " " : <EmphasizedText text={row.text} ranges={emphasis.get(index)} />}
                    </span>
                  </div>
                );
              })}
            </div>
            {clamped ? (
              <button type="button" className="wt-more" onClick={() => setExpanded(true)}>
                Show all {rows.length} lines
              </button>
            ) : null}
          </div>
        )}
        {marginNotes}
      </div>
    </figure>
  );
}

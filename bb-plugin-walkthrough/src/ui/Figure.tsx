// A figure in the reading page: a numbered code excerpt whose gutter carries
// note markers, with each note hanging in the right margin on wide pages and
// stacked under the code on narrow ones. Rows have a fixed height, so a note's
// offset is arithmetic instead of measurement and nothing reflows after paint.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { defaultExcerptView, excerptCode, NOTE_KIND_LABEL, type ExcerptView } from "../model.ts";
import type { DeliveredCodeBlock as CodeBlock, DeliveredNote as Note, DeliveredWalkthrough as Walkthrough, Location } from "../schemas.ts";
import { savedExcerpt, type Snapshot } from "./fields.ts";
import { Hint } from "./Hint.tsx";
import { useWalkthroughRpc } from "./hooks.ts";
import { LocationLink } from "./parts.tsx";
import { parsePatchRows, rowIndexForLine, type PatchRow } from "./patch-lines.ts";

const VIEW_LABEL: Record<ExcerptView, string> = { change: "Diff", after: "After", before: "Before" };
const VIEWS: ExcerptView[] = ["change", "after", "before"];
export const ROW_HEIGHT = 20;
const HEADER_HEIGHT = 32;
const CODE_PAD = 6;
const CLAMP_ROWS = 30;
const MARGIN_NOTE_GAP = 8;

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
  label: string | null;
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

function annotationsFor(block: CodeBlock, notes: Note[], rows: PatchRow[]): Annotation[] {
  const at = (line: number | undefined) => (rows.length === 0 ? 0 : line === undefined ? 0 : rowIndexForLine(rows, line));
  const agent = block.notes.map((note, index): Annotation => ({ key: `a${index}`, row: at(note.line), text: note.text, label: null }));
  const own = notes.map((note): Annotation => ({ key: `n${note.id}`, row: at(note.location?.startLine), text: note.text, label: NOTE_KIND_LABEL[note.kind] }));
  return [...agent, ...own].sort((a, b) => a.row - b.row);
}

/** Where each margin note starts: level with its row, pushed down past the note above it. */
function marginOffsets(annotations: Annotation[]): number[] {
  let floor = 0;
  return annotations.map((annotation) => {
    const top = Math.max(HEADER_HEIGHT + CODE_PAD + annotation.row * ROW_HEIGHT, floor);
    floor = top + (Math.ceil((annotation.text.length + (annotation.label?.length ?? 0) + 3) / 30) * 20 + 6) + MARGIN_NOTE_GAP;
    return top;
  });
}

export function Figure({
  walkthrough,
  block,
  notes,
  wide,
  onFlag,
}: {
  walkthrough: Walkthrough;
  block: CodeBlock;
  /** Open notes the reader anchored inside this excerpt. */
  notes: Note[];
  wide: boolean;
  onFlag: (target: FlagTarget, anchor: DOMRect) => void;
}) {
  const { data, loading } = useSnapshot(walkthrough, block);
  const isCode = block.view === "code";
  const [chosen, setChosen] = useState<ExcerptView | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const hot = hovered ?? pinned;

  const preferred: ExcerptView = isCode ? "after" : (chosen ?? (data ? defaultExcerptView(data) : "change"));
  const view = data && !data[preferred] ? (VIEWS.find((candidate) => data[candidate]) ?? preferred) : preferred;
  const patch = data ? (isCode ? (data.after ?? data.change) : data[view]) : null;
  const copyView: ExcerptView = isCode ? (data?.after ? "after" : "change") : view;
  const rows = useMemo(() => (patch ? parsePatchRows(patch) : []), [patch]);
  const annotations = useMemo(() => annotationsFor(block, notes, rows), [block, notes, rows]);
  const offsets = useMemo(() => marginOffsets(annotations), [annotations]);
  const beyondClamp = annotations.some((annotation) => annotation.row >= CLAMP_ROWS);
  const clamped = rows.length > CLAMP_ROWS && !expanded && !beyondClamp;
  const markerRows = new Map<number, Annotation[]>();
  annotations.forEach((annotation) => markerRows.set(annotation.row, [...(markerRows.get(annotation.row) ?? []), annotation]));
  const numberOf = (annotation: Annotation) => annotations.indexOf(annotation) + 1;
  // The margin hangs outside the figure, so the figure must be at least as tall as the last note reaches.
  const minHeight = wide && annotations.length > 0 ? (offsets.at(-1) ?? 0) + 70 : undefined;

  const copy = () => {
    if (!patch) return;
    void navigator.clipboard.writeText(excerptCode(patch, copyView)).then(
      () => toast.success("Copied the code"),
      () => toast.error("Could not copy"),
    );
  };
  const note = (annotation: Annotation) => (
    <div
      key={annotation.key}
      className={cn("wt-mn", hot === annotation.key && "wt-hot")}
      onMouseEnter={() => setHovered(annotation.key)}
      onMouseLeave={() => setHovered(null)}
    >
      <span className="wt-m wt-m-inline" aria-hidden>
        {numberOf(annotation)}
      </span>
      {annotation.label ? <span className="wt-mn-kind">{annotation.label} · </span> : null}
      {annotation.text}
    </div>
  );

  return (
    <figure data-code-path={block.path} data-code-start={block.startLine} data-code-end={block.endLine} className="wt-figure" data-wide={wide || undefined}>
      <figcaption className="wt-cap">{block.caption}</figcaption>
      <div className="wt-fig" style={minHeight ? { minHeight } : undefined}>
        <div className="wt-fh">
          <LocationLink files={walkthrough} location={{ path: block.path, startLine: block.startLine, endLine: block.endLine }} className="wt-fh-loc" />
          <span className="wt-sp" />
          {!isCode ? (
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
          <Hint label="Copy the code">
            <button type="button" className="wt-icon-btn" aria-label="Copy the code" disabled={!patch} onClick={copy}>
              <Icon name="Copy" className="size-3.5" aria-hidden />
            </button>
          </Hint>
        </div>
        {loading ? (
          <div className="wt-code" role="status" aria-label="Loading the code">
            {[62, 80, 48, 70].map((width, index) => (
              <div key={index} className="wt-row wt-skel-row">
                <span className="wt-skel" style={{ width: `${width}%` }} />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="wt-fig-empty">{block.caption && (block as { snapshotError?: string | null }).snapshotError ? (block as { snapshotError?: string | null }).snapshotError : "This code is no longer on disk."}</p>
        ) : (
          <div className="wt-code" role="region" tabIndex={0} aria-label={`Code from ${block.path}, lines ${block.startLine} to ${block.endLine}`} style={clamped ? { maxHeight: CLAMP_ROWS * ROW_HEIGHT + CODE_PAD * 2, overflow: "hidden" } : undefined}>
            <div className="wt-code-rows">
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
                  <div key={index} className={cn("wt-row", `wt-${row.kind}`, isHot && "wt-hot")} data-line={line ?? undefined}>
                    <b>
                      {markers.length > 0 ? (
                        markers.map((annotation) => (
                          <button
                            key={annotation.key}
                            type="button"
                            className="wt-m"
                            aria-label={`Note ${numberOf(annotation)}: ${annotation.text}`}
                            aria-pressed={pinned === annotation.key}
                            onMouseEnter={() => setHovered(annotation.key)}
                            onMouseLeave={() => setHovered(null)}
                            onFocus={() => setHovered(annotation.key)}
                            onBlur={() => setHovered(null)}
                            onClick={() => setPinned(pinned === annotation.key ? null : annotation.key)}
                          >
                            {numberOf(annotation)}
                          </button>
                        ))
                      ) : row.newNo !== null ? (
                        <button
                          type="button"
                          className="wt-ln"
                          aria-label={`Flag line ${row.newNo}`}
                          onClick={(event) => onFlag({ location: { path: block.path, startLine: row.newNo! }, quote: row.text.trim() || null }, event.currentTarget.getBoundingClientRect())}
                        >
                          {row.newNo}
                        </button>
                      ) : (
                        // A removed line is not in the new code, so there is nothing to anchor a flag to.
                        <span className="wt-ln wt-ln-removed">{line}</span>
                      )}
                    </b>
                    <span className="wt-text">
                      {row.kind === "add" ? <span className="wt-sr">Added: </span> : row.kind === "del" ? <span className="wt-sr">Removed: </span> : null}
                      {row.text === "" ? " " : row.text}
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
        {annotations.length > 0 ? (
          wide ? (
            <div className="wt-margin" aria-label="Notes on this code">
              {annotations.map((annotation, index) => (
                <div key={annotation.key} className="wt-margin-slot" style={{ top: offsets[index] }}>
                  {note(annotation)}
                </div>
              ))}
            </div>
          ) : (
            <div className="wt-notes-stack" aria-label="Notes on this code">
              {annotations.map(note)}
            </div>
          )
        ) : null}
      </div>
    </figure>
  );
}

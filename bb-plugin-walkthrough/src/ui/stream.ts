// What the pane does with stream payloads (see src/stream-tail.ts): keeps the
// latest one per request, decides which of them may be shown, and turns the
// text into the same block shapes the committed parts use, so the reader
// renders streamed and committed content through the same components and a
// part's DOM survives the hand-off to its committed form.
//
// The committed walkthrough is authoritative. A payload is only ever a preview
// of a request that is still in flight (or that just ended and whose result
// has not arrived yet); a part that is `ready` never reads from it.
import { createContext, useMemo } from "react";
import { parseStreamMarkup, type StreamBlock, type StreamFigure } from "../stream-markup.ts";
import { streamTarget } from "../stream-tail.ts";
import { streamPayloadSchema, type DeliveredCodeBlock, type DeliveredPart, type DeliveredWalkthrough, type Place, type StreamPayload } from "../schemas.ts";

type CommittedBlock = DeliveredPart["blocks"][number];
/** A block of a part being written. `streaming` marks the one still receiving text. */
export type StreamedBlock = CommittedBlock & { streaming?: true };

/** The latest payload for each request, keyed by `${requestKind}:${place}`. */
export type StreamState = Readonly<Record<string, StreamPayload>>;

export const streamKey = (kind: StreamPayload["requestKind"], place: Place): string => `${kind}:${place}`;
const isTerminal = (payload: StreamPayload): boolean => payload.state !== "streaming";

/** Validates what came off the channel or the RPC; anything else is dropped. */
export function readPayload(value: unknown): StreamPayload | null {
  const parsed = streamPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Folds one payload in. Each payload holds the whole text, so a duplicate or
 * an out-of-order older one is simply ignored; a terminal payload may share
 * the seq of the last streaming one and supersedes it.
 */
export function applyPayload(state: StreamState, payload: StreamPayload): StreamState {
  const key = streamKey(payload.requestKind, payload.place);
  const current = state[key];
  if (current) {
    const newer = payload.seq > current.seq;
    const settles = payload.seq === current.seq && isTerminal(payload) && !isTerminal(current);
    if (!newer && !settles) return state;
  }
  return { ...state, [key]: payload };
}

/** What a streamed request has produced so far, in the reader's own terms. */
export interface StreamedView {
  /** The plan turn's introduction (empty for other requests). */
  intro: string;
  /** Whether the introduction is still receiving text. */
  introOpen: boolean;
  /** The part's blocks; the last one may carry `streaming`. */
  blocks: StreamedBlock[];
  /** The follow-up questions, once their block has closed; null before. */
  suggestions: string[] | null;
  /** The message text, for an answer. */
  text: string;
}

function figureBlock(figure: StreamFigure): DeliveredCodeBlock | null {
  // A figure appears once its header (path and lines) is complete; the caption and notes follow.
  if (figure.path === null || figure.startLine === null) return null;
  return {
    kind: "code",
    caption: figure.caption,
    path: figure.path,
    startLine: figure.startLine,
    endLine: figure.endLine ?? figure.startLine,
    notes: figure.notes.map((note) => ({ line: note.line, text: note.text })),
    view: figure.view ?? "diff",
    snapshot: null,
    snapshotError: null,
  };
}

/** Splits a payload's markup into the introduction, the part's blocks, and suggestions. */
export function streamedView(payload: StreamPayload): StreamedView {
  const parsed = parseStreamMarkup(payload.text);
  const view: StreamedView = { intro: "", introOpen: false, blocks: [], suggestions: null, text: payload.text };
  // In the plan turn everything before the `part: 1` marker is the introduction.
  const partAt = parsed.blocks.findIndex((block) => block.kind === "part");
  const introBlocks: StreamBlock[] = payload.requestKind === "plan" ? (partAt < 0 ? parsed.blocks : parsed.blocks.slice(0, partAt)) : [];
  const partBlocks = payload.requestKind === "plan" ? (partAt < 0 ? [] : parsed.blocks.slice(partAt + 1)) : parsed.blocks;
  const prose = introBlocks.filter((block) => block.kind === "prose");
  view.intro = prose.map((block) => block.text).join("\n\n");
  view.introOpen = prose.at(-1)?.open === true && introBlocks.at(-1) === prose.at(-1);
  const last = parsed.blocks.at(-1);
  for (const block of partBlocks) {
    if (block.kind === "suggestions") {
      if (!block.open && block.items.length > 0) view.suggestions = block.items;
    } else if (block.kind === "prose") {
      view.blocks.push({ kind: "prose", text: block.text, ...(block.open && block === last ? { streaming: true as const } : {}) });
    } else if (block.kind === "figure") {
      const figure = figureBlock(block);
      if (figure) view.blocks.push({ ...figure, ...(block.open && block === last ? { streaming: true as const } : {}) });
    }
  }
  return view;
}

/**
 * The payload that may be previewed for a request, or null. It must belong to
 * the request in flight and be newer than what that request started after (so a
 * retry never shows its predecessor's text); once the request has ended, a
 * normally finished payload stays until the committed result arrives. Failed
 * and cancelled payloads are never shown: the committed state says why.
 */
export function previewFor(state: StreamState, walkthrough: DeliveredWalkthrough, kind: StreamPayload["requestKind"], place: Place, exchangeId?: string): StreamPayload | null {
  const payload = state[streamKey(kind, place)];
  if (!payload || payload.walkthroughId !== walkthrough.id) return null;
  if (payload.state === "failed" || payload.state === "cancelled") return null;
  const { inFlight } = walkthrough;
  if (inFlight === null) return payload.state === "done" ? payload : null;
  const target = streamTarget(inFlight.request);
  if (target === null || target.kind !== kind || target.place !== place) return payload.state === "done" && payload.seq > inFlight.afterSeq ? payload : null;
  if (exchangeId !== undefined && !(inFlight.request.kind === "ask" && inFlight.request.exchangeId === exchangeId)) return null;
  return payload.seq > inFlight.afterSeq ? payload : null;
}

/** The streams the reader is following, for the pages under it. */
export const StreamContext = createContext<StreamState>({});

/** The payload previewing a part that is not committed yet: its own write, or the plan turn for part 1. */
export function partPreview(state: StreamState, walkthrough: DeliveredWalkthrough, index: number): StreamPayload | null {
  const part = walkthrough.parts[index];
  if (!part || part.status === "ready" || part.status === "failed") return null;
  return previewFor(state, walkthrough, "write", index) ?? (index === 0 ? previewFor(state, walkthrough, "plan", 0) : null);
}

/** Parses a payload once per payload. */
export function useStreamedView(payload: StreamPayload | null): StreamedView | null {
  return useMemo(() => (payload ? streamedView(payload) : null), [payload]);
}

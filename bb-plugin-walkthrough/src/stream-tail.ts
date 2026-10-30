// The fast tail: while a walkthrough has a plan, part write, or answer in
// flight, follows the worker thread's `item/agentMessage/delta` events and
// publishes the text so far, so the pane can show it as it is written.
//
// The server's `experimental_thread.events` is debounced to one per second,
// so it only wakes the tail (poke); the tail itself polls the stored events at
// about 120 ms and backs off while the worker is quiet (it is reading code or
// running a tool). Each publish carries the whole text, not a delta, so a
// client holds no state and a snapshot RPC can return the same payload from
// the stored events.
//
// One timer serves all walkthroughs. Every timer is unref'ed and cleared by
// dispose(), which the background service calls on reload or shutdown.
import type { Place, StreamPayload, StreamRequestKind, StreamState, WorkerRequest } from "./schemas.ts";

export const POLL_BASE_MS = 120;
/** Longest the tail waits between polls while the worker is quiet. */
export const POLL_MAX_MS = 300;
/** Shortest time between two publishes for one walkthrough. */
export const PUBLISH_MIN_MS = 60;
/** How often an answer is saved to the walkthrough while it streams, so a reload shows progress. */
export const PERSIST_EVERY_MS = 1500;
/** Longest message text kept and published. */
export const MAX_STREAM_TEXT = 200_000;
const PAGE = 100;
const MAX_PAGES_PER_POLL = 20;
const MARKUP_FENCE = "```walkthrough";

export interface DeltaRow {
  seq: number;
  itemId: string | null;
  delta: string;
}

/** The part of a walkthrough the tail needs. */
export interface TailTarget {
  walkthroughId: string;
  workerThreadId: string;
  request: WorkerRequest;
  /** Worker event seq before the request was sent. */
  afterSeq: number;
  /** Identifies this send; a different value means a different request. */
  sentAt: number;
}

export interface TailDeps {
  /** One page (at most 100) of delta events after `afterSeq`, oldest first. */
  readDeltas(threadId: string, afterSeq: number): Promise<DeltaRow[]>;
  publish(payload: StreamPayload): void;
  /** Saves an answer so far; called at most every PERSIST_EVERY_MS. */
  persist?(target: TailTarget, text: string): void;
  log?(message: string): void;
}

/** What a request streams under, or null when it is not streamed. */
export function streamTarget(request: WorkerRequest): { kind: StreamRequestKind; place: Place } | null {
  switch (request.kind) {
    case "plan":
      return { kind: "plan", place: 0 };
    case "write":
      return { kind: "write", place: request.part };
    case "ask":
      return { kind: "ask", place: request.place };
    default:
      return null;
  }
}

/**
 * Accumulates one request's message items. Keeps the latest item and the
 * latest item that holds streamed markup, whichever is the one that matters:
 * an answer is the last message; a part is the message with the fence, even
 * if the worker says something else after committing it.
 */
class Collector {
  cursor: number;
  private latest: { id: string | null; text: string } | null = null;
  private markup: { id: string | null; text: string } | null = null;

  constructor(
    afterSeq: number,
    private readonly preferMarkup: boolean,
  ) {
    this.cursor = afterSeq;
  }

  /** Returns true when the visible text changed. */
  apply(rows: DeltaRow[]): boolean {
    let changed = false;
    for (const row of rows) {
      // A page that overlaps what was already read must not append twice.
      if (row.seq <= this.cursor) continue;
      this.cursor = row.seq;
      if (typeof row.delta !== "string" || row.delta === "") continue;
      if (this.latest === null || this.latest.id !== row.itemId) {
        this.latest = { id: row.itemId, text: "" };
      }
      const item = this.latest;
      if (item.text.length < MAX_STREAM_TEXT) item.text += row.delta.slice(0, MAX_STREAM_TEXT - item.text.length);
      if (this.markup !== null && this.markup.id === item.id) this.markup = item;
      else if (item.text.includes(MARKUP_FENCE)) this.markup = item;
      changed = true;
    }
    return changed;
  }

  get text(): string {
    return (this.preferMarkup ? (this.markup ?? this.latest) : this.latest)?.text ?? "";
  }
}

interface Tracker {
  target: TailTarget;
  kind: StreamRequestKind;
  place: Place;
  collector: Collector;
  nextPollAt: number;
  idlePolls: number;
  dirty: boolean;
  lastPublishAt: number;
  lastPersistAt: number;
  published: boolean;
  polling: Promise<void> | null;
  finishing: boolean;
}

export class StreamTail {
  private readonly trackers = new Map<string, Tracker>();
  private readonly finishing = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly deps: TailDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /** Walkthroughs being followed right now. */
  get active(): string[] {
    return [...this.trackers.keys()];
  }

  /** Starts following a request; a repeat of the one already followed does nothing. */
  track(target: TailTarget): void {
    if (this.disposed) return;
    const streamed = streamTarget(target.request);
    if (streamed === null) return;
    const existing = this.trackers.get(target.walkthroughId);
    if (existing && existing.target.sentAt === target.sentAt && existing.target.afterSeq === target.afterSeq) return;
    if (existing) void this.finish(target.walkthroughId, "cancelled");
    const at = this.now();
    this.trackers.set(target.walkthroughId, {
      target,
      kind: streamed.kind,
      place: streamed.place,
      collector: new Collector(target.afterSeq, streamed.kind !== "ask"),
      nextPollAt: at,
      idlePolls: 0,
      dirty: false,
      lastPublishAt: Number.NEGATIVE_INFINITY,
      lastPersistAt: Number.NEGATIVE_INFINITY,
      published: false,
      polling: null,
      finishing: false,
    });
    this.schedule();
  }

  /** The server saw new worker events: poll soon rather than at the next tick. */
  poke(walkthroughId: string): void {
    const tracker = this.trackers.get(walkthroughId);
    if (!tracker) return;
    tracker.nextPollAt = Math.min(tracker.nextPollAt, this.now());
    this.schedule();
  }

  /** Stops following, drains what the worker wrote last, and publishes the terminal payload. */
  finish(walkthroughId: string, state: Exclude<StreamState, "streaming">): Promise<void> {
    const tracker = this.trackers.get(walkthroughId);
    if (!tracker || tracker.finishing) return Promise.resolve();
    tracker.finishing = true;
    this.trackers.delete(walkthroughId);
    const run = (async () => {
      await tracker.polling?.catch(() => undefined);
      try {
        tracker.collector.apply(await this.readAll(tracker));
      } catch (cause) {
        this.deps.log?.(`final stream read failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      this.publish(tracker, state);
    })();
    this.finishing.add(run);
    void run.finally(() => this.finishing.delete(run));
    this.schedule();
    return run;
  }

  /** The text so far for a request, read fresh from the stored events when it is not being followed. */
  async snapshot(target: TailTarget): Promise<StreamPayload | null> {
    const streamed = streamTarget(target.request);
    if (streamed === null) return null;
    const tracker = this.trackers.get(target.walkthroughId);
    if (tracker && tracker.target.sentAt === target.sentAt) {
      await this.pollOne(tracker);
      return this.payload(tracker, "streaming");
    }
    const collector = new Collector(target.afterSeq, streamed.kind !== "ask");
    let cursor = target.afterSeq;
    for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
      const rows = await this.deps.readDeltas(target.workerThreadId, cursor);
      collector.apply(rows);
      cursor = collector.cursor;
      if (rows.length < PAGE) break;
    }
    return { walkthroughId: target.walkthroughId, requestKind: streamed.kind, place: streamed.place, seq: collector.cursor, text: collector.text, state: "streaming" };
  }

  /** Stops every timer; in-flight terminal publishes still complete. */
  dispose(): void {
    this.disposed = true;
    this.trackers.clear();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Resolves when every pending terminal publish has been sent. */
  async idle(): Promise<void> {
    while (this.finishing.size > 0) await Promise.all([...this.finishing]);
  }

  // -- internals ------------------------------------------------------------

  private payload(tracker: Tracker, state: StreamState): StreamPayload {
    return {
      walkthroughId: tracker.target.walkthroughId,
      requestKind: tracker.kind,
      place: tracker.place,
      seq: tracker.collector.cursor,
      text: tracker.collector.text,
      state,
    };
  }

  private publish(tracker: Tracker, state: StreamState): void {
    const at = this.now();
    const text = tracker.collector.text;
    // A request that never produced text and ends quietly has nothing to retire on the client.
    if (state === "done" && !tracker.published && text === "") return;
    tracker.dirty = false;
    tracker.lastPublishAt = at;
    tracker.published = true;
    this.deps.publish(this.payload(tracker, state));
    if (state === "streaming" && tracker.kind === "ask" && text !== "" && this.deps.persist && at - tracker.lastPersistAt >= PERSIST_EVERY_MS) {
      tracker.lastPersistAt = at;
      this.deps.persist(tracker.target, text);
    }
  }

  private async readAll(tracker: Tracker): Promise<DeltaRow[]> {
    const all: DeltaRow[] = [];
    let cursor = tracker.collector.cursor;
    for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
      const rows = await this.deps.readDeltas(tracker.target.workerThreadId, cursor);
      all.push(...rows);
      for (const row of rows) cursor = Math.max(cursor, row.seq);
      if (rows.length < PAGE) break;
    }
    return all;
  }

  private pollOne(tracker: Tracker): Promise<void> {
    if (tracker.polling) return tracker.polling;
    const run = (async () => {
      try {
        const changed = tracker.collector.apply(await this.readAll(tracker));
        if (changed) {
          tracker.dirty = true;
          tracker.idlePolls = 0;
        } else tracker.idlePolls += 1;
      } catch (cause) {
        tracker.idlePolls += 1;
        this.deps.log?.(`stream poll failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const interval = Math.min(POLL_MAX_MS, POLL_BASE_MS * (1 + Math.max(0, tracker.idlePolls - 3) * 0.5));
      tracker.nextPollAt = this.now() + interval;
      if (tracker.dirty && !tracker.finishing) this.maybePublish(tracker);
    })().finally(() => {
      tracker.polling = null;
      this.schedule();
    });
    tracker.polling = run;
    return run;
  }

  private maybePublish(tracker: Tracker): void {
    if (this.now() - tracker.lastPublishAt >= PUBLISH_MIN_MS) this.publish(tracker, "streaming");
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    let due = Number.POSITIVE_INFINITY;
    for (const tracker of this.trackers.values()) {
      if (tracker.polling) continue;
      due = Math.min(due, tracker.nextPollAt);
      if (tracker.dirty) due = Math.min(due, tracker.lastPublishAt + PUBLISH_MIN_MS);
    }
    if (!Number.isFinite(due)) return;
    this.timer = setTimeout(() => void this.tick(), Math.max(0, due - this.now()));
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    const at = this.now();
    const due: Array<Promise<void>> = [];
    for (const tracker of [...this.trackers.values()]) {
      if (tracker.polling) continue;
      if (at >= tracker.nextPollAt) due.push(this.pollOne(tracker));
      else if (tracker.dirty) this.maybePublish(tracker);
    }
    await Promise.all(due);
    this.schedule();
  }
}

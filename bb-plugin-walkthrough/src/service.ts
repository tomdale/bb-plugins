// Walkthrough orchestration.
//
// A walkthrough belongs to the user's thread and is written by a hidden fork
// of that thread (the worker). The plugin hands the worker one request at a
// time (plan, write a part, answer a question, wrap up) and learns the
// outcome from the worker's tool calls plus its final message when the turn
// ends. SQLite is the source of truth; the pane re-reads it on every change
// signal, and `.agent/review-notes.md` mirrors the notes once one exists.
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { renderNotesMarkdown } from "./model.ts";
import { filterPatchToRange } from "./patch.ts";
import type { DiffResult, ExcerptResult } from "./rpc.ts";
import {
  CHANGED_CHANNEL,
  WORKER_ROLE,
  type Block,
  type Location,
  type Mode,
  type Note,
  type NoteKind,
  type NoteStatus,
  type Part,
  type Place,
  type ReviewDraft,
  type Walkthrough,
  type WorkerRequest,
} from "./schemas.ts";
import type { WalkthroughStore } from "./store.ts";
import { askMessage, planMessage, postReviewMessage, replyMessage, wrapUpMessage, writeMessage } from "./worker.ts";

export class WalkthroughError extends Error {}

export interface PlanInput {
  mode: Mode;
  title: string;
  baseRef: string;
  includeUncommitted?: boolean | undefined;
  pr?: { number: number; url?: string | undefined; title?: string | undefined } | undefined;
  introduction: string;
  parts: Array<{ title: string; summary: string; locations: Location[] }>;
}

export interface NoteInput {
  kind: NoteKind;
  text: string;
  groupIndex?: number | null | undefined;
  location?: Location | null | undefined;
  quote?: string | null | undefined;
}

export interface NotePatch {
  kind?: NoteKind | undefined;
  text?: string | undefined;
  status?: NoteStatus | undefined;
  resolution?: string | null | undefined;
}

const MAX_FULL_FILE_BYTES = 1_000_000;
const MERGE_BASE_TTL_MS = 60_000;
/** Parts written ahead of the one on screen. */
const WRITE_AHEAD = 1;

function emptyPart(title: string, summary: string, locations: Location[]): Part {
  return { title, summary, locations, status: "pending", blocks: [], suggestions: [], message: null, discussion: [] };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class WalkthroughService {
  private readonly fileWrites = new Map<string, Promise<void>>();
  private readonly mergeBases = new Map<string, { sha: string | null; expiresAt: number }>();
  /** Serializes state changes that await the SDK, per walkthrough. */
  private readonly locks = new Map<string, Promise<void>>();
  private readonly streaming = new Set<string>();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: WalkthroughStore,
    private readonly now: () => number = Date.now,
  ) {}

  // -- lookup ---------------------------------------------------------------

  get(id: string): Walkthrough {
    const walkthrough = this.store.get(id);
    if (walkthrough === null) throw new WalkthroughError(`No walkthrough ${JSON.stringify(id)}.`);
    return walkthrough;
  }

  byWorker(workerThreadId: string): Walkthrough | null {
    return this.store.byWorker(workerThreadId);
  }

  forThread(threadId: string): Walkthrough[] {
    return this.store.forThread(threadId);
  }

  notes(walkthroughId: string): Note[] {
    return this.store.notes(walkthroughId);
  }

  view(id: string) {
    const walkthrough = this.get(id);
    return { walkthrough, notes: this.store.notes(id) };
  }

  save(walkthrough: Walkthrough, reason: "started" | "changed" = "changed"): Walkthrough {
    const next = { ...walkthrough, updatedAt: this.now() };
    this.store.save(next);
    this.bb.realtime.publish(CHANGED_CHANNEL, { threadId: next.threadId, walkthroughId: next.id, reason });
    return next;
  }

  private update(id: string, change: (walkthrough: Walkthrough) => Walkthrough): Walkthrough {
    return this.save(change(this.get(id)));
  }

  private locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const result = previous.then(run);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(id, settled);
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return result;
  }

  // -- lifecycle ------------------------------------------------------------

  async start(threadId: string, request: string): Promise<Walkthrough> {
    const workspace = await this.resolveWorkspace(threadId);
    const now = this.now();
    const id = `wt_${randomUUID().replace(/-/gu, "").slice(0, 12)}`;
    let walkthrough: Walkthrough = {
      id,
      threadId,
      workerThreadId: null,
      request: request.trim() || "Walk me through these changes.",
      status: "planning",
      message: null,
      title: "Walkthrough",
      mode: "local",
      baseRef: "HEAD",
      includeUncommitted: true,
      pr: null,
      introduction: "",
      parts: [],
      currentPart: null,
      wrapUp: null,
      environmentId: workspace.environmentId,
      hostId: workspace.hostId,
      workspacePath: workspace.path,
      notesFile: {
        enabled: true,
        path: workspace.path ? `${workspace.path}/.agent/review-notes.md` : null,
        written: false,
        error: null,
      },
      review: null,
      queue: [{ kind: "plan" }],
      inFlight: null,
      nextNoteNumber: 1,
      nextExchangeNumber: 1,
      createdAt: now,
      updatedAt: now,
    };
    walkthrough = this.save(walkthrough, "started");
    try {
      const worker = await this.bb.sdk.threads.fork({
        sourceThreadId: threadId,
        lifecycleOwnerThreadId: threadId,
        visibility: "hidden",
        title: `Walkthrough worker: ${walkthrough.request.slice(0, 60)}`,
        pluginMetadata: { role: WORKER_ROLE, walkthroughId: id },
      });
      walkthrough = this.save({ ...this.get(id), workerThreadId: worker.id });
      await this.waitUntilReady(worker.id);
    } catch (cause) {
      this.bb.log.warn(`fork failed for ${threadId}; starting a fresh worker: ${errorText(cause)}`);
      try {
        const thread = await this.bb.sdk.threads.get({ threadId });
        const worker = await this.bb.sdk.threads.spawn({
          projectId: thread.projectId,
          environment: thread.environmentId ? { type: "reuse", environmentId: thread.environmentId } : { type: "project-default" },
          prompt: planMessage(walkthrough),
          parentThreadId: threadId,
          lifecycleOwnerThreadId: threadId,
          visibility: "hidden",
          title: `Walkthrough worker: ${walkthrough.request.slice(0, 60)}`,
          pluginMetadata: { role: WORKER_ROLE, walkthroughId: id },
        } as Parameters<typeof this.bb.sdk.threads.spawn>[0]);
        walkthrough = this.save({
          ...this.get(id),
          workerThreadId: worker.id,
          queue: [],
          inFlight: { request: { kind: "plan" }, sentAt: this.now(), afterSeq: 0 },
        });
        return walkthrough;
      } catch (spawnCause) {
        return this.save({ ...this.get(id), status: "failed", message: `The walkthrough could not start: ${errorText(spawnCause)}` });
      }
    }
    await this.pump(id);
    return this.get(id);
  }

  /**
   * A fork provisions its workspace before it can take a message; a message
   * sent earlier waits in BB's queue. Waits briefly for the fork to settle.
   */
  private async waitUntilReady(threadId: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const thread = await this.bb.sdk.threads.get({ threadId }).catch(() => null);
      if (thread === null || thread.status === "idle" || thread.status === "error") return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** Sends the next queued request when the worker is free. */
  pump(id: string): Promise<void> {
    return this.locked(id, async () => {
      const walkthrough = this.get(id);
      if (walkthrough.inFlight || walkthrough.queue.length === 0) return;
      if (walkthrough.workerThreadId === null || walkthrough.status === "done" || walkthrough.status === "failed") return;
      const [request, ...rest] = walkthrough.queue as [WorkerRequest, ...WorkerRequest[]];
      const text = this.messageFor(walkthrough, request);
      if (text === null) {
        this.save({ ...walkthrough, queue: rest });
        void this.pump(id);
        return;
      }
      const afterSeq = await this.latestSeq(walkthrough.workerThreadId);
      let next: Walkthrough = { ...walkthrough, queue: rest, inFlight: { request, sentAt: this.now(), afterSeq } };
      next = this.markStarted(next, request);
      this.save(next);
      try {
        await this.bb.sdk.threads.send({
          threadId: walkthrough.workerThreadId,
          mode: "queue-if-active",
          input: [{ type: "text", text, mentions: [] }],
        });
      } catch (cause) {
        this.complete(id, `The walkthrough agent could not be reached: ${errorText(cause)}`, true);
      }
    });
  }

  private messageFor(walkthrough: Walkthrough, request: WorkerRequest): string | null {
    switch (request.kind) {
      case "plan":
        return planMessage(walkthrough);
      case "write":
        return walkthrough.parts[request.part]?.status === "ready" ? null : writeMessage(walkthrough, request.part);
      case "ask": {
        const exchange = this.findExchange(walkthrough, request.place, request.exchangeId);
        if (!exchange) return null;
        return request.instruction ?? askMessage(walkthrough, request.place, exchange.question, this.store.takeUnreported(walkthrough.id));
      }
      case "reply":
        return replyMessage(walkthrough, request.text);
      case "wrap-up":
        this.store.markAllReported(walkthrough.id);
        return wrapUpMessage(walkthrough, this.store.notes(walkthrough.id));
    }
  }

  private markStarted(walkthrough: Walkthrough, request: WorkerRequest): Walkthrough {
    if (request.kind === "write") {
      return {
        ...walkthrough,
        parts: walkthrough.parts.map((part, index) => (index === request.part ? { ...part, status: "writing", message: null } : part)),
      };
    }
    if (request.kind === "ask") {
      return this.withExchange(walkthrough, request.place, request.exchangeId, (exchange) => ({ ...exchange, status: "answering" }));
    }
    return walkthrough;
  }

  /**
   * The worker went idle. That settles the in-flight request only when a
   * turn ran after the request was sent: a fork also goes idle once its
   * workspace is ready, before BB dispatches the first message.
   */
  async onWorkerIdle(workerThreadId: string, lastText: string | null): Promise<void> {
    const walkthrough = this.store.byWorker(workerThreadId);
    if (walkthrough === null) return;
    if (walkthrough.inFlight !== null) {
      const turns = await this.bb.sdk.threads.events
        .list({ threadId: workerThreadId, afterSeq: String(walkthrough.inFlight.afterSeq), types: ["turn/completed"], limit: "1" })
        .catch(() => null);
      if (Array.isArray(turns) && turns.length === 0) {
        await this.nudgeQueued(workerThreadId);
        return;
      }
      this.complete(walkthrough.id, lastText, false);
    }
    await this.pump(walkthrough.id);
  }

  /** Dispatches our message if BB left it queued behind a wait that has since cleared. */
  private async nudgeQueued(workerThreadId: string): Promise<void> {
    try {
      const queued = (await this.bb.sdk.threads.queuedMessages.list({ threadId: workerThreadId })) as unknown as
        | Array<{ id: string }>
        | { queuedMessages?: Array<{ id: string }> };
      const rows = Array.isArray(queued) ? queued : (queued.queuedMessages ?? []);
      for (const row of rows) {
        await this.bb.sdk.threads.queuedMessages.send({ threadId: workerThreadId, queuedMessageId: row.id, mode: "auto" });
      }
    } catch (cause) {
      this.bb.log.debug(`could not dispatch queued worker message: ${errorText(cause)}`);
    }
  }

  onWorkerFailed(workerThreadId: string, error: string | null): void {
    const walkthrough = this.store.byWorker(workerThreadId);
    if (walkthrough === null || walkthrough.inFlight === null) return;
    this.complete(walkthrough.id, error ?? "The walkthrough agent stopped with an error.", true);
  }

  private complete(id: string, text: string | null, failed: boolean): void {
    const walkthrough = this.get(id);
    const inFlight = walkthrough.inFlight;
    if (inFlight === null) return;
    const message = text?.trim() || null;
    let next: Walkthrough = { ...walkthrough, inFlight: null };
    const request = inFlight.request;
    switch (request.kind) {
      case "plan":
      case "reply":
        if (next.status === "planning") {
          next = { ...next, message: message ?? "The walkthrough could not be planned.", ...(failed && request.kind === "plan" ? { status: "failed" as const } : {}) };
        }
        break;
      case "write":
        next = {
          ...next,
          parts: next.parts.map((part, index) =>
            index === request.part && part.status !== "ready"
              ? { ...part, status: "failed", message: message ?? "This part could not be written." }
              : part,
          ),
        };
        break;
      case "ask":
        next = this.withExchange(next, request.place, request.exchangeId, (exchange) => ({
          ...exchange,
          answer: failed ? exchange.answer || message || "" : message ?? exchange.answer,
          status: failed || !(message ?? exchange.answer) ? "failed" : "done",
        }));
        break;
      case "wrap-up":
        if (next.wrapUp && next.wrapUp.status !== "ready") {
          next = { ...next, wrapUp: { ...next.wrapUp, status: "failed", message: message ?? "The wrap-up could not be written." } };
        }
        break;
    }
    this.save(next);
  }

  /** Streams the in-flight answer while the worker writes it. */
  async onWorkerEvents(workerThreadId: string): Promise<void> {
    const walkthrough = this.store.byWorker(workerThreadId);
    const inFlight = walkthrough?.inFlight;
    if (!walkthrough || !inFlight || inFlight.request.kind !== "ask" || this.streaming.has(walkthrough.id)) return;
    const request = inFlight.request;
    this.streaming.add(walkthrough.id);
    try {
      const texts = new Map<string, string>();
      let cursor = inFlight.afterSeq;
      // BB pages thread events 100 at a time.
      for (let page = 0; page < 50; page += 1) {
        const rows = (await this.bb.sdk.threads.events.list({
          threadId: workerThreadId,
          afterSeq: String(cursor),
          limit: "100",
          types: ["item/agentMessage/delta"],
        })) as unknown as Array<{ seq: number; data: { itemId?: string; delta?: string } }>;
        for (const row of rows) {
          cursor = Math.max(cursor, row.seq);
          const itemId = row.data.itemId;
          if (!itemId || typeof row.data.delta !== "string") continue;
          texts.set(itemId, (texts.get(itemId) ?? "") + row.data.delta);
        }
        if (rows.length < 100) break;
      }
      const latest = [...texts.values()].at(-1);
      if (!latest) return;
      const current = this.get(walkthrough.id);
      if (current.inFlight?.request.kind !== "ask" || current.inFlight.request.exchangeId !== request.exchangeId) return;
      this.save(this.withExchange(current, request.place, request.exchangeId, (exchange) => ({ ...exchange, answer: latest })));
    } catch (cause) {
      this.bb.log.debug(`answer streaming skipped: ${errorText(cause)}`);
    } finally {
      this.streaming.delete(walkthrough.id);
    }
  }

  /** Resumes requests interrupted by a reload or restart. */
  async resume(): Promise<void> {
    for (const walkthrough of this.store.unfinished()) {
      if (!walkthrough.workerThreadId) continue;
      if (walkthrough.inFlight) {
        const thread = await this.bb.sdk.threads.get({ threadId: walkthrough.workerThreadId }).catch(() => null);
        if (thread?.status === "idle") {
          const output = await this.bb.sdk.threads.output({ threadId: walkthrough.workerThreadId }).catch(() => null);
          await this.onWorkerIdle(walkthrough.workerThreadId, typeof output === "string" ? output : null);
        }
      } else if (walkthrough.queue.length > 0) {
        await this.pump(walkthrough.id);
      }
    }
  }

  // -- reader actions -------------------------------------------------------

  private enqueue(walkthrough: Walkthrough, request: WorkerRequest, priority: "front" | "after-asks" | "back"): Walkthrough {
    const same = (candidate: WorkerRequest) => JSON.stringify(candidate) === JSON.stringify(request);
    if (walkthrough.queue.some(same) || (walkthrough.inFlight && same(walkthrough.inFlight.request))) return walkthrough;
    const queue = [...walkthrough.queue];
    if (priority === "front") queue.unshift(request);
    else if (priority === "back") queue.push(request);
    else {
      const firstNonAsk = queue.findIndex((candidate) => candidate.kind !== "ask" && candidate.kind !== "reply");
      queue.splice(firstNonAsk < 0 ? queue.length : firstNonAsk, 0, request);
    }
    return { ...walkthrough, queue };
  }

  /** Queues the part on screen first, then the ones after it. */
  private scheduleWrites(walkthrough: Walkthrough): Walkthrough {
    if (walkthrough.status !== "reading") return walkthrough;
    const start = walkthrough.currentPart ?? 0;
    let next = walkthrough;
    for (let index = start; index <= Math.min(start + WRITE_AHEAD, next.parts.length - 1); index += 1) {
      if (next.parts[index]!.status === "pending") {
        next = this.enqueue(next, { kind: "write", part: index }, index === start ? "after-asks" : "back");
      }
    }
    return next;
  }

  async openPart(id: string, index: number | null): Promise<void> {
    this.update(id, (walkthrough) => {
      if (index !== null && (index < 0 || index >= walkthrough.parts.length)) throw new WalkthroughError("No such part.");
      return this.scheduleWrites({ ...walkthrough, currentPart: index });
    });
    await this.pump(id);
  }

  async ask(id: string, place: Place, question: string): Promise<void> {
    this.update(id, (walkthrough) => {
      if (walkthrough.status === "done" || walkthrough.status === "failed") throw new WalkthroughError("This walkthrough is closed.");
      const exchangeId = `e${walkthrough.nextExchangeNumber}`;
      const exchange = { id: exchangeId, question: question.trim(), answer: "", status: "queued" as const, askedAt: this.now() };
      const withExchange = this.appendExchange({ ...walkthrough, nextExchangeNumber: walkthrough.nextExchangeNumber + 1 }, place, exchange);
      return this.enqueue(withExchange, { kind: "ask", place, exchangeId }, "after-asks");
    });
    await this.pump(id);
  }

  async reply(id: string, text: string): Promise<void> {
    this.update(id, (walkthrough) => this.enqueue({ ...walkthrough, message: null }, { kind: "reply", text: text.trim() }, "front"));
    await this.pump(id);
  }

  async retry(id: string, place: Place): Promise<void> {
    this.update(id, (walkthrough) => {
      if (place === "wrap-up") {
        return this.enqueue({ ...walkthrough, wrapUp: walkthrough.wrapUp && { ...walkthrough.wrapUp, status: "writing", message: null } }, { kind: "wrap-up" }, "front");
      }
      const parts = walkthrough.parts.map((part, index) => (index === place ? { ...part, status: "pending" as const, message: null } : part));
      return this.enqueue({ ...walkthrough, parts }, { kind: "write", part: place }, "front");
    });
    await this.pump(id);
  }

  async wrapUp(id: string): Promise<void> {
    this.update(id, (walkthrough) => {
      if (walkthrough.status !== "reading") throw new WalkthroughError("The walkthrough is not in progress.");
      const queue = walkthrough.queue.filter((request) => request.kind !== "write");
      const parts = walkthrough.parts.map((part) => (part.status === "writing" && walkthrough.inFlight?.request.kind !== "write" ? { ...part, status: "pending" as const } : part));
      return this.enqueue(
        { ...walkthrough, queue, parts, status: "wrapping-up", wrapUp: { ...emptyPart("Wrapping up", "", []), status: "writing" } },
        { kind: "wrap-up" },
        "after-asks",
      );
    });
    await this.pump(id);
  }

  async close(id: string): Promise<void> {
    const walkthrough = this.update(id, (current) => ({ ...current, status: "done", queue: [] }));
    if (walkthrough.workerThreadId) {
      const workerThreadId = walkthrough.workerThreadId;
      await this.bb.sdk.threads.stop({ threadId: workerThreadId }).catch(() => {});
      await this.bb.sdk.threads.archive({ threadId: workerThreadId }).catch(() => {});
    }
  }

  /** Hands open todos and questions to the agent in the user's own thread. */
  async handOff(id: string): Promise<boolean> {
    const walkthrough = this.get(id);
    const open = this.store.notes(id).filter((note) => note.status === "open" && (note.kind === "todo" || note.kind === "question"));
    if (open.length === 0) return false;
    const lines = open.map((note) => `- ${note.kind === "todo" ? "Todo" : "Question"}: ${note.text}${note.location ? ` (${note.location.path}${note.location.startLine ? `:${note.location.startLine}` : ""})` : ""}`);
    await this.bb.sdk.threads.send({
      threadId: walkthrough.threadId,
      mode: "auto",
      input: [{ type: "text", text: `From my walkthrough of ${walkthrough.title}:\n\n${lines.join("\n")}`, mentions: [] }],
    });
    return true;
  }

  async requestReviewPost(id: string, event: ReviewDraft["event"]): Promise<void> {
    const walkthrough = this.get(id);
    if (!walkthrough.pr || !walkthrough.review) throw new WalkthroughError("There is no draft review to post.");
    const exchangeId = `e${walkthrough.nextExchangeNumber}`;
    const place: Place = walkthrough.wrapUp ? "wrap-up" : (walkthrough.currentPart ?? 0);
    this.update(id, (current) =>
      this.enqueue(
        this.appendExchange({ ...current, nextExchangeNumber: current.nextExchangeNumber + 1 }, place, {
          id: exchangeId,
          question: `Post the draft review to PR #${current.pr!.number} (${event}).`,
          answer: "",
          status: "queued",
          askedAt: this.now(),
        }),
        { kind: "ask", place, exchangeId, instruction: postReviewMessage(current, event) },
        "front",
      ),
    );
    await this.pump(id);
  }

  // -- worker tools ---------------------------------------------------------

  requireForWorker(workerThreadId: string): Walkthrough {
    const walkthrough = this.store.byWorker(workerThreadId);
    if (walkthrough === null) throw new WalkthroughError("This thread is not writing a walkthrough.");
    return walkthrough;
  }

  plan(workerThreadId: string, input: PlanInput): Walkthrough {
    const walkthrough = this.requireForWorker(workerThreadId);
    if (walkthrough.parts.length > 0) throw new WalkthroughError("The walkthrough is already planned.");
    let next: Walkthrough = {
      ...walkthrough,
      mode: input.mode,
      title: input.title,
      baseRef: input.baseRef,
      includeUncommitted: input.includeUncommitted ?? input.mode === "local",
      pr: input.mode === "pr" && input.pr ? { number: input.pr.number, url: input.pr.url || null, title: input.pr.title || null } : null,
      introduction: input.introduction,
      parts: input.parts.map((part) => emptyPart(part.title, part.summary, part.locations)),
      status: "reading",
      message: null,
    };
    next = this.scheduleWrites(next);
    const saved = this.save(next);
    if (saved.inFlight === null) void this.pump(saved.id);
    return saved;
  }

  writePart(workerThreadId: string, index: number, blocks: Block[], suggestions: string[]): Walkthrough {
    const walkthrough = this.requireForWorker(workerThreadId);
    if (index < 0 || index >= walkthrough.parts.length) throw new WalkthroughError(`There is no part ${index + 1}.`);
    const parts = walkthrough.parts.map((part, candidate) =>
      candidate === index ? { ...part, blocks, suggestions, status: "ready" as const, message: null } : part,
    );
    return this.save({ ...walkthrough, parts });
  }

  writeWrapUp(workerThreadId: string, blocks: Block[], followUps: string[]): Walkthrough {
    const walkthrough = this.requireForWorker(workerThreadId);
    const wrapUp = { ...(walkthrough.wrapUp ?? emptyPart("Wrapping up", "", [])), blocks, suggestions: followUps, status: "ready" as const, message: null };
    return this.save({ ...walkthrough, wrapUp });
  }

  setReview(walkthroughId: string, review: ReviewDraft): Walkthrough {
    return this.update(walkthroughId, (walkthrough) => ({ ...walkthrough, review }));
  }

  // -- discussion helpers ---------------------------------------------------

  private placePart(walkthrough: Walkthrough, place: Place): Part | null {
    return place === "wrap-up" ? walkthrough.wrapUp : (walkthrough.parts[place] ?? null);
  }

  private findExchange(walkthrough: Walkthrough, place: Place, exchangeId: string) {
    return this.placePart(walkthrough, place)?.discussion.find((exchange) => exchange.id === exchangeId) ?? null;
  }

  private withPart(walkthrough: Walkthrough, place: Place, change: (part: Part) => Part): Walkthrough {
    if (place === "wrap-up") return walkthrough.wrapUp ? { ...walkthrough, wrapUp: change(walkthrough.wrapUp) } : walkthrough;
    return { ...walkthrough, parts: walkthrough.parts.map((part, index) => (index === place ? change(part) : part)) };
  }

  private appendExchange(walkthrough: Walkthrough, place: Place, exchange: Part["discussion"][number]): Walkthrough {
    if (this.placePart(walkthrough, place) === null) throw new WalkthroughError("That part does not exist.");
    return this.withPart(walkthrough, place, (part) => ({ ...part, discussion: [...part.discussion, exchange] }));
  }

  private withExchange(
    walkthrough: Walkthrough,
    place: Place,
    exchangeId: string,
    change: (exchange: Part["discussion"][number]) => Part["discussion"][number],
  ): Walkthrough {
    return this.withPart(walkthrough, place, (part) => ({
      ...part,
      discussion: part.discussion.map((exchange) => (exchange.id === exchangeId ? change(exchange) : exchange)),
    }));
  }

  // -- notes ----------------------------------------------------------------

  addNote(walkthroughId: string, input: NoteInput, author: Note["author"]): Note {
    const walkthrough = this.get(walkthroughId);
    const groupIndex = input.groupIndex === undefined ? walkthrough.currentPart : input.groupIndex;
    if (groupIndex !== null && (groupIndex < 0 || groupIndex >= walkthrough.parts.length)) {
      throw new WalkthroughError(`Part ${groupIndex + 1} does not exist.`);
    }
    const now = this.now();
    const note: Note = {
      id: `n${walkthrough.nextNoteNumber}`,
      walkthroughId,
      kind: input.kind,
      text: input.text.trim(),
      groupIndex,
      location: input.location ?? null,
      quote: input.quote?.trim() || null,
      status: "open",
      resolution: null,
      author,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveNote(note, author === "agent");
    this.save({ ...walkthrough, nextNoteNumber: walkthrough.nextNoteNumber + 1 });
    void this.syncNotesFile(walkthroughId);
    return note;
  }

  updateNote(walkthroughId: string, noteId: string, patch: NotePatch, author: Note["author"]): Note {
    const note = this.store.note(walkthroughId, noteId);
    if (note === null) throw new WalkthroughError(`No note ${JSON.stringify(noteId)} in this walkthrough.`);
    const next: Note = {
      ...note,
      kind: patch.kind ?? note.kind,
      text: patch.text?.trim() || note.text,
      status: patch.status ?? note.status,
      resolution: patch.resolution === undefined ? note.resolution : patch.resolution?.trim() || null,
      updatedAt: this.now(),
    };
    this.store.saveNote(next, author === "agent");
    this.save(this.get(walkthroughId));
    void this.syncNotesFile(walkthroughId);
    return next;
  }

  deleteNote(walkthroughId: string, noteId: string): boolean {
    const deleted = this.store.deleteNote(walkthroughId, noteId);
    if (deleted) {
      this.save(this.get(walkthroughId));
      void this.syncNotesFile(walkthroughId);
    }
    return deleted;
  }

  setNotesFileEnabled(walkthroughId: string, enabled: boolean): void {
    const walkthrough = this.update(walkthroughId, (current) => ({ ...current, notesFile: { ...current.notesFile, enabled } }));
    if (enabled) void this.syncNotesFile(walkthrough.id);
  }

  /** Queues a rewrite of the notes mirror; the file appears after the first note. */
  syncNotesFile(walkthroughId: string): Promise<void> {
    const previous = this.fileWrites.get(walkthroughId) ?? Promise.resolve();
    const settled = previous.then(() => this.writeNotesFile(walkthroughId)).catch(() => {});
    this.fileWrites.set(walkthroughId, settled);
    void settled.then(() => {
      if (this.fileWrites.get(walkthroughId) === settled) this.fileWrites.delete(walkthroughId);
    });
    return settled;
  }

  private async writeNotesFile(walkthroughId: string): Promise<void> {
    const walkthrough = this.store.get(walkthroughId);
    if (walkthrough === null || !walkthrough.notesFile.enabled || walkthrough.notesFile.path === null) return;
    const notes = this.store.notes(walkthroughId);
    if (notes.length === 0 && !walkthrough.notesFile.written) return;
    let error: string | null = null;
    try {
      await this.bb.sdk.files.write({
        ...(walkthrough.hostId ? { hostId: walkthrough.hostId } : {}),
        path: walkthrough.notesFile.path,
        content: renderNotesMarkdown(walkthrough, notes),
        createParents: true,
      });
    } catch (cause) {
      error = errorText(cause);
      this.bb.log.warn(`notes file write failed for ${walkthroughId}: ${error}`);
    }
    const latest = this.store.get(walkthroughId);
    if (latest === null) return;
    const written = latest.notesFile.written || error === null;
    if (latest.notesFile.written !== written || latest.notesFile.error !== error) {
      this.save({ ...latest, notesFile: { ...latest.notesFile, written, error } });
    }
  }

  takeUnreported(walkthroughId: string): Note[] {
    return this.store.takeUnreported(walkthroughId);
  }

  // -- code -----------------------------------------------------------------

  private diffTarget(walkthrough: Walkthrough) {
    return walkthrough.includeUncommitted ? ("all" as const) : ("branch_committed" as const);
  }

  private async filePatch(walkthrough: Walkthrough, path: string): Promise<{ patch: string; truncated: boolean } | string> {
    if (walkthrough.environmentId === null) return "This walkthrough has no workspace to diff.";
    const response = await this.bb.sdk.environments.diffPatch({
      environmentId: walkthrough.environmentId,
      paths: [path],
      target: { type: this.diffTarget(walkthrough), mergeBaseBranch: walkthrough.baseRef },
    });
    if (response.outcome !== "available") {
      return response.outcome === "not_applicable" ? response.message : response.failure.message;
    }
    const file = response.patches.find((candidate) => candidate.path === path) ?? response.patches[0];
    if (file === undefined || file.patch.trim() === "") return `${path} has no changes against ${walkthrough.baseRef}.`;
    return { patch: file.patch, truncated: file.truncated };
  }

  async diff(
    walkthroughId: string,
    path: string,
    range: { startLine?: number | undefined; endLine?: number | undefined },
    withFullFile: boolean,
  ): Promise<DiffResult> {
    try {
      const walkthrough = this.get(walkthroughId);
      const file = await this.filePatch(walkthrough, path);
      if (typeof file === "string") return { outcome: "unavailable", message: file };
      const start = range.startLine;
      const narrowed = start === undefined ? { patch: file.patch, filtered: false } : filterPatchToRange(file.patch, start, range.endLine ?? start);
      const fullFileContents = withFullFile && !narrowed.filtered ? await this.fullFile(walkthrough, path, file.patch) : null;
      return { outcome: "available", path, patch: narrowed.patch, truncated: file.truncated, filtered: narrowed.filtered, fullFileContents };
    } catch (cause) {
      return { outcome: "unavailable", message: errorText(cause) };
    }
  }

  /**
   * One code excerpt in three views. "After" and "before" are rendered as
   * context-only patches so BB's diff viewer supplies highlighting and real
   * line numbers.
   */
  async excerpt(walkthroughId: string, path: string, startLine: number, endLine: number): Promise<ExcerptResult> {
    try {
      const walkthrough = this.get(walkthroughId);
      const file = await this.filePatch(walkthrough, path);
      const sides = await this.fullFile(walkthrough, path, typeof file === "string" ? "" : file.patch);
      const change = typeof file === "string" ? null : filterPatchToRange(file.patch, startLine, endLine).patch;
      const low = Math.min(startLine, endLine);
      const high = Math.max(startLine, endLine);
      const after = sides ? contextPatch(path, sides.new.content, low, high) : null;
      const beforeRange = change ? oldRange(change) : null;
      const before = sides && beforeRange ? contextPatch(path, sides.old.content, beforeRange.start, beforeRange.end) : null;
      if (change === null && after === null) return { outcome: "unavailable", message: typeof file === "string" ? file : "No code to show." };
      return { outcome: "available", path, change, after, before };
    } catch (cause) {
      return { outcome: "unavailable", message: errorText(cause) };
    }
  }

  private async mergeBase(walkthrough: Walkthrough): Promise<string | null> {
    if (walkthrough.environmentId === null) return null;
    const key = `${walkthrough.environmentId}\u0000${walkthrough.baseRef}\u0000${walkthrough.includeUncommitted}`;
    const cached = this.mergeBases.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.sha;
    const response = await this.bb.sdk.environments.diffFiles({
      environmentId: walkthrough.environmentId,
      target: this.diffTarget(walkthrough),
      mergeBaseBranch: walkthrough.baseRef,
    });
    const sha = response.outcome === "available" ? response.mergeBaseRef : null;
    this.mergeBases.set(key, { sha, expiresAt: this.now() + MERGE_BASE_TTL_MS });
    return sha;
  }

  private async fullFile(walkthrough: Walkthrough, path: string, patch: string) {
    if (walkthrough.environmentId === null) return null;
    const environmentId = walkthrough.environmentId;
    const mergeBaseRef = await this.mergeBase(walkthrough).catch(() => null);
    if (mergeBaseRef === null) return null;
    // An added file has no old side and a deleted file no new side.
    const absent = { old: /^--- \/dev\/null$/mu.test(patch), new: /^\+\+\+ \/dev\/null$/mu.test(patch) };
    const side = async (which: "old" | "new") => {
      if (absent[which]) return { path, content: "" };
      try {
        const file = await this.bb.sdk.environments.diffFile({
          environmentId,
          path,
          side: which,
          target: this.diffTarget(walkthrough),
          mergeBaseRef,
        });
        if (file.contentEncoding !== "utf8" || file.sizeBytes > MAX_FULL_FILE_BYTES) return null;
        return { path, content: file.content };
      } catch (cause) {
        this.bb.log.debug(`full ${which} side unavailable for ${path}: ${errorText(cause)}`);
        return null;
      }
    };
    const [old, current] = await Promise.all([side("old"), side("new")]);
    return old && current ? { old, new: current } : null;
  }

  // -- workspace --------------------------------------------------------------

  private async latestSeq(threadId: string): Promise<number> {
    try {
      const rows = (await this.bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1" })) as unknown as Array<{ seq: number }>;
      return rows[0]?.seq ?? 0;
    } catch {
      return 0;
    }
  }

  private async resolveWorkspace(threadId: string) {
    try {
      const thread = await this.bb.sdk.threads.get({ threadId });
      if (!thread.environmentId) return { environmentId: null, hostId: null, path: null };
      const environment = await this.bb.sdk.environments.get({ environmentId: thread.environmentId });
      return { environmentId: environment.id, hostId: environment.hostId, path: environment.path };
    } catch (cause) {
      this.bb.log.warn(`workspace lookup failed for ${threadId}: ${errorText(cause)}`);
      return { environmentId: null, hostId: null, path: null };
    }
  }
}

/** A context-only patch showing lines [start, end] of `content`. */
function contextPatch(path: string, content: string, start: number, end: number): string | null {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const low = Math.max(1, start);
  const high = Math.min(lines.length, end);
  if (high < low) return null;
  const body = lines.slice(low - 1, high).map((line) => ` ${line}`);
  return `--- a/${path}\n+++ b/${path}\n@@ -${low},${body.length} +${low},${body.length} @@\n${body.join("\n")}\n`;
}

/** The old-side line span a patch touches, with two lines of margin. */
function oldRange(patch: string): { start: number; end: number } | null {
  let low = Number.POSITIVE_INFINITY;
  let high = 0;
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gmu)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) continue;
    low = Math.min(low, start);
    high = Math.max(high, start + count - 1);
  }
  return high === 0 ? null : { start: low, end: high };
}

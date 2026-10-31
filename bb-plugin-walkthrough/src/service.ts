// Walkthrough orchestration.
//
// A walkthrough belongs to the user's thread and is written by a hidden fork
// of that thread (the worker). The plugin hands the worker one request at a
// time (plan, write a part, answer a question, wrap up) and learns the
// outcome from the worker's tool calls plus its final message when the turn
// ends. SQLite is the source of truth; the pane re-reads it on every change
// signal.
//
// A part is committed in one authoritative step (commitPart), after the code
// blocks' snapshots are captured; a streaming layer can show partial text
// before that, but only the commit makes a part ready.
import { createHash, randomUUID } from "node:crypto";
import { codeHostContract, type ChangedFiles, type CodeSnapshot } from "./code-contract.ts";
import { EMPTY_TREE_SHA } from "./empty-tree.ts";
import { isAbsolutePath, workspaceRelativePath } from "./files.ts";
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { describeNoteForAgent, intentOf, mergedReviewDraft } from "./model.ts";
import { citedPaths } from "./coverage.ts";
import { filterPatchToRange } from "./patch.ts";
import { stripReplyWrapper } from "./reply-wrapper.ts";
import type { DiffResult, ExcerptResult } from "./rpc.ts";
import {
  CHANGED_CHANNEL,
  defaultIntent,
  STREAM_CHANNEL,
  type StreamPayload,
  type StreamState,
  WORKER_ROLE,
  type Block,
  type BlockInput,
  type CodeBlock,
  type CodeSnapshot as BlockSnapshot,
  type Intent,
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
import { committedMessage, type CommittedMessage } from "./stream-commit.ts";
import { hasStreamMarkup } from "./stream-markup.ts";
import { streamTarget, StreamTail, type DeltaRow, type TailTarget } from "./stream-tail.ts";
import type { WalkthroughStore } from "./store.ts";
import { askMessage, planMessage, postReviewMessage, replyMessage, wrapUpMessage, writeMessage } from "./worker.ts";

export class WalkthroughError extends Error {}

export interface PlanInput {
  mode: Mode;
  intent?: Intent | undefined;
  title: string;
  baseRef: string;
  includeUncommitted?: boolean | undefined;
  pr?: { number: number; url?: string | undefined; title?: string | undefined; headRef?: string | undefined; state?: "open" | "merged" | "closed" | undefined } | undefined;
  introduction: string;
  parts: Array<{ title: string; summary: string; locations: Location[] }>;
}

export interface NoteInput {
  kind: NoteKind;
  text: string;
  groupIndex?: number | null | undefined;
  location?: Location | null | undefined;
  quote?: string | null | undefined;
  /** Defaults to true for comments and false for other kinds. */
  includeInReview?: boolean | undefined;
}

export interface NotePatch {
  includeInReview?: boolean | undefined;
  /** What the helper suggests the outcome is; only the reader's accept turns it into a resolution. */
  proposedResolution?: string | null | undefined;
  kind?: NoteKind | undefined;
  text?: string | undefined;
  status?: NoteStatus | undefined;
  resolution?: string | null | undefined;
}

const MAX_FULL_FILE_BYTES = 1_000_000;
const MERGE_BASE_TTL_MS = 60_000;
/** Parts written ahead of the one on screen. */
const WRITE_AHEAD = 1;
/** Longest the snapshots of one part may take; a block still unread then is saved without code. */
const SNAPSHOT_BUDGET_MS = 25_000;
/** How long a write tool waits for the message it was told to read: attempts times interval. */
const MESSAGE_WAIT_ATTEMPTS = 8;
const MESSAGE_WAIT_MS = 250;
/** Longest the plan request waits for the working-tree summary. */
const BRIEF_WAIT_MS = 1500;
/** Pause before the one retry of an excerpt that failed for a passing reason. */
const SNAPSHOT_RETRY_MS = 400;
const INTERRUPTED = "The helper was stopped before it finished.";
const HELPER_GONE = "The helper for this walkthrough is no longer running, so it can't write or answer any more.";

function emptyPart(title: string, summary: string, locations: Location[]): Part {
  return { title, summary, locations, status: "pending", blocks: [], suggestions: [], message: null, discussion: [], writtenAgainst: null };
}

function threadUpdateMessage(updates: string[]): string {
  return [
    "Since you last heard from the user, they sent these messages to their own thread, whose agent may have changed the code in response (the walkthrough is about that thread's work, so this is the user's doing):",
    ...updates.map((update) => `- ${JSON.stringify(update)}`),
    "Re-read any code before relying on what you saw earlier. If a part already written is now out of date, say so briefly when it matters.",
  ].join("\n");
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class WalkthroughService {
  /** The working-tree summary for each walkthrough's plan request, started when the walkthrough launches. */
  private readonly briefs = new Map<string, Promise<string | null>>();
  private readonly mergeBases = new Map<string, { sha: string | null; expiresAt: number }>();
  /** Serializes state changes that await the SDK, per walkthrough. */
  private readonly locks = new Map<string, Promise<void>>();
  /** Follows the worker's message text while a plan, part, or answer is in flight. */
  readonly tail: StreamTail;

  private readonly codeHost: ExperimentalHostClient<typeof codeHostContract>;

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: WalkthroughStore,
    private readonly now: () => number = Date.now,
  ) {
    this.codeHost = bb.hosts.experimental_client({ contract: codeHostContract });
    this.tail = new StreamTail(
      {
        readDeltas: (threadId, afterSeq) => this.readDeltas(threadId, afterSeq),
        publish: (payload) => {
          if (payload.requestKind === "plan" && payload.text !== "") this.mark(payload.walkthroughId, "firstText");
          bb.realtime.publish(STREAM_CHANNEL, payload);
        },
        persist: (target, text) => this.persistAnswer(target, text),
        log: (message) => bb.log.debug(message),
      },
      now,
    );
  }

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

  recent(): Walkthrough[] {
    return this.store.recent();
  }

  notes(walkthroughId: string): Note[] {
    return this.store.notes(walkthroughId);
  }

  view(id: string) {
    const walkthrough = this.get(id);
    const notes = this.store.notes(id);
    return { walkthrough, notes, reviewDraft: mergedReviewDraft(walkthrough, notes) };
  }

  save(walkthrough: Walkthrough, reason: "started" | "changed" = "changed"): Walkthrough {
    const next = { ...walkthrough, updatedAt: this.now() };
    this.store.save(next);
    this.bb.realtime.publish(CHANGED_CHANNEL, { threadId: next.threadId, walkthroughId: next.id, reason });
    this.syncTail(next);
    return next;
  }

  /** Follows the worker while a streamed request is in flight; whatever ends the request without saying why ends it as cancelled. */
  private syncTail(walkthrough: Walkthrough): void {
    const inFlight = walkthrough.inFlight;
    if (inFlight === null || walkthrough.workerThreadId === null) {
      void this.tail.finish(walkthrough.id, "cancelled");
      return;
    }
    this.tail.track(this.tailTarget(walkthrough)!);
  }

  private tailTarget(walkthrough: Walkthrough): TailTarget | null {
    const { inFlight, workerThreadId } = walkthrough;
    if (inFlight === null || workerThreadId === null) return null;
    return { walkthroughId: walkthrough.id, workerThreadId, request: inFlight.request, afterSeq: inFlight.afterSeq, sentAt: inFlight.sentAt };
  }

  /** One page of the worker's message deltas, oldest first. */
  private async readDeltas(threadId: string, afterSeq: number): Promise<DeltaRow[]> {
    const rows = (await this.bb.sdk.threads.events.list({
      threadId,
      afterSeq: String(afterSeq),
      limit: "100",
      types: ["item/agentMessage/delta"],
    })) as unknown as Array<{ seq: number; data: { itemId?: string; delta?: string } }>;
    return rows.map((row) => ({ seq: row.seq, itemId: row.data.itemId ?? null, delta: typeof row.data.delta === "string" ? row.data.delta : "" }));
  }

  /** Records when a first-paint stage was first reached, in ms after the walkthrough began; a later reach of the same stage is ignored. */
  private mark(id: string, stage: string): void {
    try {
      const walkthrough = this.store.get(id);
      if (walkthrough === null || walkthrough.timing?.[stage] !== undefined) return;
      this.store.save({ ...walkthrough, timing: { ...walkthrough.timing, [stage]: Math.max(0, this.now() - walkthrough.createdAt) } });
    } catch (cause) {
      this.bb.log.debug(`timing mark skipped: ${errorText(cause)}`);
    }
  }

  /** Saves an answer in progress so a reload shows it; the commit at the end of the request stays authoritative. */
  private persistAnswer(target: TailTarget, text: string): void {
    const request = target.request;
    if (request.kind !== "ask") return;
    try {
      const current = this.get(target.walkthroughId);
      const inFlight = current.inFlight;
      if (inFlight?.request.kind !== "ask" || inFlight.request.exchangeId !== request.exchangeId || inFlight.sentAt !== target.sentAt) return;
      this.save(this.withExchange(current, request.place, request.exchangeId, (exchange) => ({ ...exchange, answer: text })));
    } catch (cause) {
      this.bb.log.debug(`answer streaming skipped: ${errorText(cause)}`);
    }
  }

  /**
   * What the helper said in its streamed message for the plan or part write in
   * flight, ready to commit: the worker may omit tool arguments it already wrote
   * there. The message precedes the tool call, but BB stores events a moment
   * later than the call can arrive, so this waits briefly for it. Null when the
   * request streams no markup or the message never showed up.
   */
  async committedFromMessage(workerThreadId: string): Promise<CommittedMessage | null> {
    for (let attempt = 0; attempt < MESSAGE_WAIT_ATTEMPTS; attempt += 1) {
      const walkthrough = this.requireForWorker(workerThreadId);
      const target = this.tailTarget(walkthrough);
      const kind = target === null ? null : streamTarget(target.request)?.kind;
      if (target === null || (kind !== "plan" && kind !== "write")) return null;
      const snapshot = await this.tail.snapshot(target).catch(() => null);
      if (snapshot !== null && hasStreamMarkup(snapshot.text)) {
        const message = committedMessage(snapshot.text);
        if (message.blocks.length > 0 || message.introduction !== "") return message;
      }
      await new Promise((resolve) => setTimeout(resolve, MESSAGE_WAIT_MS));
    }
    return null;
  }

  /** The in-flight request's text so far, for a client that joined mid-stream. */
  async streamSnapshot(id: string): Promise<StreamPayload | null> {
    const target = this.tailTarget(this.get(id));
    if (target === null || streamTarget(target.request) === null) return null;
    return this.tail.snapshot(target).catch(() => null);
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
    const threadSeq = await this.latestSeq(threadId);
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
      review: null,
      queue: [{ kind: "plan" }],
      inFlight: null,
      nextNoteNumber: 1,
      nextExchangeNumber: 1,
      codeFingerprint: null,
      threadSeq,
      threadUpdates: [],
      createdAt: now,
      updatedAt: now,
    };
    walkthrough = this.save(walkthrough, "started");
    // Forking provisions a workspace and can take half a minute; the caller (an
    // agent tool, or the starter) must not wait on it. The pane already has the
    // record and shows it as getting ready.
    void this.launch(id, threadId).catch((cause) => {
      this.bb.log.warn(`could not launch walkthrough ${id}: ${errorText(cause)}`);
      this.save({ ...this.get(id), status: "failed", message: `The walkthrough could not start: ${errorText(cause)}` });
    });
    return walkthrough;
  }

  /** Forks the helper from the user's thread (or spawns one) and sends the plan request. */
  private async launch(id: string, threadId: string): Promise<void> {
    let walkthrough = this.get(id);
    // Read the working tree while the fork provisions, so the plan request never waits on git.
    this.briefs.set(id, this.workspaceBrief(walkthrough).catch(() => null));
    try {
      const worker = await this.bb.sdk.threads.fork({
        sourceThreadId: threadId,
        lifecycleOwnerThreadId: threadId,
        visibility: "hidden",
        title: `Walkthrough worker: ${walkthrough.request.slice(0, 60)}`,
        pluginMetadata: { role: WORKER_ROLE, walkthroughId: id },
      });
      walkthrough = this.save({ ...this.get(id), workerThreadId: worker.id });
      this.mark(id, "forked");
      await this.waitUntilReady(worker.id);
      this.mark(id, "workerReady");
    } catch (cause) {
      this.bb.log.warn(`fork failed for ${threadId}; starting a fresh worker: ${errorText(cause)}`);
      try {
        const thread = await this.bb.sdk.threads.get({ threadId });
        const worker = await this.bb.sdk.threads.spawn({
          projectId: thread.projectId,
          environment: thread.environmentId ? { type: "reuse", environmentId: thread.environmentId } : { type: "project-default" },
          prompt: planMessage(walkthrough, await this.takeBrief(id)),
          parentThreadId: threadId,
          lifecycleOwnerThreadId: threadId,
          visibility: "hidden",
          title: `Walkthrough worker: ${walkthrough.request.slice(0, 60)}`,
          pluginMetadata: { role: WORKER_ROLE, walkthroughId: id },
        } as Parameters<typeof this.bb.sdk.threads.spawn>[0]);
        this.save({
          ...this.get(id),
          workerThreadId: worker.id,
          queue: [],
          inFlight: { request: { kind: "plan" }, sentAt: this.now(), afterSeq: 0 },
        });
        return;
      } catch (spawnCause) {
        this.save({ ...this.get(id), status: "failed", message: `The walkthrough could not start: ${errorText(spawnCause)}` });
        return;
      }
    }
    await this.pump(id);
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
      const ready = (walkthrough: Walkthrough) =>
        !walkthrough.inFlight &&
        walkthrough.queue.length > 0 &&
        walkthrough.workerThreadId !== null &&
        walkthrough.status !== "done" &&
        walkthrough.status !== "failed";
      let walkthrough = this.get(id);
      if (!ready(walkthrough)) return;
      // The helper cannot see its source thread after the fork, so tell it what
      // the user said there, and note whether the code moved. The plan request
      // starts the walkthrough, so there is nothing to catch up on yet.
      if (walkthrough.queue[0]!.kind !== "plan") {
        await this.refreshThread(id);
        walkthrough = this.get(id);
        if (!ready(walkthrough)) return;
      }
      const [request, ...rest] = walkthrough.queue as [WorkerRequest, ...WorkerRequest[]];
      const body = this.messageFor(walkthrough, request, request.kind === "plan" ? await this.takeBrief(id) : null);
      if (body === null) {
        this.save({ ...walkthrough, queue: rest });
        void this.pump(id);
        return;
      }
      const updates = walkthrough.threadUpdates ?? [];
      const text = updates.length > 0 ? `${threadUpdateMessage(updates)}\n\n${body}` : body;
      const workerThreadId = walkthrough.workerThreadId!;
      const afterSeq = await this.latestSeq(workerThreadId);
      let next: Walkthrough = { ...walkthrough, queue: rest, threadUpdates: [], inFlight: { request, sentAt: this.now(), afterSeq } };
      next = this.markStarted(next, request);
      this.save(next);
      try {
        await this.bb.sdk.threads.send({
          threadId: workerThreadId,
          mode: "queue-if-active",
          input: [{ type: "text", text, mentions: [] }],
        });
        if (request.kind === "plan") this.mark(id, "planSent");
      } catch (cause) {
        if (/archived/iu.test(errorText(cause))) this.helperGone(id);
        else this.complete(id, `The walkthrough agent could not be reached: ${errorText(cause)}`, true);
      }
    });
  }

  private messageFor(walkthrough: Walkthrough, request: WorkerRequest, brief: string | null = null): string | null {
    switch (request.kind) {
      case "plan":
        return planMessage(walkthrough, brief);
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
      const turns = (await this.bb.sdk.threads.events
        .list({ threadId: workerThreadId, afterSeq: String(walkthrough.inFlight.afterSeq), types: ["turn/completed"], limit: "20" })
        .catch(() => null)) as unknown as Array<{ data?: { status?: string } }> | null;
      if (Array.isArray(turns) && turns.length === 0) {
        await this.nudgeQueued(workerThreadId);
        return;
      }
      // A stopped turn ends with status "interrupted" and leaves the previous
      // turn's final message as the thread's last text, which says nothing
      // about this request.
      const interrupted = Array.isArray(turns) && turns.at(-1)?.data?.status === "interrupted";
      if (interrupted) this.complete(walkthrough.id, INTERRUPTED, true);
      else {
        const produced = await this.latestAgentText(workerThreadId, walkthrough.inFlight.afterSeq).catch(() => null);
        // lastText can be an earlier turn's message (a turn with only tool calls
        // leaves it untouched), so an answer never falls back to it.
        this.complete(walkthrough.id, produced ?? (walkthrough.inFlight.request.kind === "ask" ? null : lastText), false);
      }
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

  /**
   * The helper's thread is archived or dead, which no retry can fix: settle
   * whatever it owed and close the walkthrough so the pane stops offering
   * actions that cannot succeed.
   */
  private helperGone(id: string): void {
    const walkthrough = this.get(id);
    if (walkthrough.status === "done" || walkthrough.status === "failed") return;
    if (walkthrough.inFlight !== null) this.complete(id, HELPER_GONE, true);
    this.finish(id, HELPER_GONE);
  }

  /** Marks the walkthrough done and fails every answer and part still owed. */
  private finish(id: string, reason: string): Walkthrough {
    const current = this.get(id);
    const failOpen = (part: Part): Part => ({
      ...part,
      discussion: part.discussion.map((exchange) =>
        exchange.status === "queued" || exchange.status === "answering" ? { ...exchange, status: "failed" as const, answer: exchange.answer || reason } : exchange,
      ),
      ...(part.status === "writing" ? { status: "failed" as const, message: reason } : {}),
    });
    return this.save({
      ...current,
      status: current.status === "planning" ? "failed" : "done",
      message: current.status === "planning" ? reason : current.message,
      queue: [],
      inFlight: null,
      parts: current.parts.map(failOpen),
      wrapUp: current.wrapUp && (current.wrapUp.status === "writing" ? { ...current.wrapUp, status: "failed", message: reason } : failOpen(current.wrapUp)),
    });
  }

  /** An archived thread takes its helper with it (the helper is lifecycle-owned by it), so its walkthroughs are over. */
  onThreadArchived(threadId: string): void {
    const own = this.store.byWorker(threadId);
    if (own) this.helperGone(own.id);
    for (const walkthrough of this.store.forThread(threadId, 100)) this.helperGone(walkthrough.id);
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
    const message = stripReplyWrapper(text?.trim() ?? "").trim() || null;
    void this.tail.finish(id, failed ? (message === INTERRUPTED || message === HELPER_GONE ? "cancelled" : "failed") : "done");
    let next: Walkthrough = { ...walkthrough, inFlight: null };
    const request = inFlight.request;
    switch (request.kind) {
      case "plan":
      case "reply":
        if (request.kind === "plan") {
          // The plan turn may also have written part 1; one it began but did not
          // finish goes back to the queue as an ordinary write request.
          next = this.scheduleWrites({ ...next, parts: next.parts.map((part) => (part.status === "writing" ? { ...part, status: "pending" as const } : part)) });
        }
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

  /**
   * The helper's last message since `afterSeq`, rebuilt from its streamed
   * deltas. The idle event's last-text value can still hold an earlier turn's
   * message, so what a request produced is read from the events themselves.
   */
  private async latestAgentText(workerThreadId: string, afterSeq: number): Promise<string | null> {
    const texts = new Map<string, string>();
    let cursor = afterSeq;
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
    return [...texts.values()].at(-1) ?? null;
  }

  /** The server saw new worker events (at most one per second): the tail polls now instead of at its next tick. */
  onWorkerEvents(workerThreadId: string): void {
    const walkthrough = this.store.byWorker(workerThreadId);
    if (!walkthrough?.inFlight) return;
    this.syncTail(walkthrough);
    this.tail.poke(walkthrough.id);
  }

  /** Resumes requests interrupted by a reload or restart. */
  async resume(): Promise<void> {
    for (const walkthrough of this.store.unfinished()) {
      if (!walkthrough.workerThreadId) continue;
      if (walkthrough.inFlight) {
        this.syncTail(walkthrough);
        const thread = await this.bb.sdk.threads.get({ threadId: walkthrough.workerThreadId }).catch(() => null);
        if (thread === null || thread.archivedAt || thread.status === "error") {
          this.helperGone(walkthrough.id);
        } else if (thread.status === "idle") {
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

  /**
   * Queues the part the reader is on, then one ahead of it, and nothing more:
   * the next part is written when the reader opens it or asks about it.
   */
  private scheduleWrites(walkthrough: Walkthrough, at: number | null = walkthrough.currentPart): Walkthrough {
    if (walkthrough.status !== "reading") return walkthrough;
    const start = at ?? 0;
    let next = walkthrough;
    for (let index = start; index <= Math.min(start + WRITE_AHEAD, next.parts.length - 1); index += 1) {
      if (next.parts[index]!.status === "pending") {
        next = this.enqueue(next, { kind: "write", part: index }, index === start ? "after-asks" : "back");
      }
    }
    return next;
  }

  async openPart(id: string, index: number | null): Promise<void> {
    void this.refreshStale(id);
    void this.repairSnapshots(id);
    this.update(id, (walkthrough) => {
      if (index !== null && (index < 0 || index >= walkthrough.parts.length)) throw new WalkthroughError("No such part.");
      const opened = { ...walkthrough, currentPart: index };
      // Wrap-up drops the queued writes; a part the user goes back to read is still owed.
      if (walkthrough.status === "wrapping-up" && index !== null && opened.parts[index]!.status === "pending") {
        return this.enqueue(opened, { kind: "write", part: index }, "after-asks");
      }
      return this.scheduleWrites(opened);
    });
    await this.pump(id);
  }

  async ask(id: string, place: Place, question: string): Promise<void> {
    this.update(id, (walkthrough) => {
      if (walkthrough.status === "done" || walkthrough.status === "failed") throw new WalkthroughError("This walkthrough is closed.");
      const exchangeId = `e${walkthrough.nextExchangeNumber}`;
      const exchange = { id: exchangeId, question: question.trim(), answer: "", status: "queued" as const, askedAt: this.now() };
      const withExchange = this.appendExchange({ ...walkthrough, nextExchangeNumber: walkthrough.nextExchangeNumber + 1 }, place, exchange);
      const asked = this.enqueue(withExchange, { kind: "ask", place, exchangeId }, "after-asks");
      // A reader asking about a part is reading it, so the one after it is owed.
      return typeof place === "number" ? this.scheduleWrites(asked, Math.max(place, asked.currentPart ?? 0)) : asked;
    });
    await this.pump(id);
  }

  async reply(id: string, text: string): Promise<void> {
    this.update(id, (walkthrough) => this.enqueue({ ...walkthrough, message: null }, { kind: "reply", text: text.trim() }, "front"));
    await this.pump(id);
  }

  async retry(id: string, place: Place): Promise<void> {
    this.update(id, (walkthrough) => {
      if (walkthrough.status === "done" || walkthrough.status === "failed") throw new WalkthroughError("This walkthrough is finished.");
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
    const walkthrough = this.finish(id, "This walkthrough was finished before the helper got to it.");
    if (walkthrough.workerThreadId) {
      const workerThreadId = walkthrough.workerThreadId;
      await this.bb.sdk.threads.stop({ threadId: workerThreadId }).catch(() => {});
      await this.bb.sdk.threads.archive({ threadId: workerThreadId }).catch(() => {});
    }
  }

  /**
   * The message "send open items to the thread" would send, and the notes it
   * covers, without sending anything: the pane shows it for the reader to edit
   * and send. Null when no todo or question is waiting.
   */
  prepareHandOff(id: string): { message: string; noteIds: string[] } | null {
    const walkthrough = this.get(id);
    const open = this.store.notes(id).filter((note) => note.status === "open" && !note.sentAt && (note.kind === "todo" || note.kind === "question"));
    if (open.length === 0) return null;
    const subject = walkthrough.pr ? `PR #${walkthrough.pr.number}${walkthrough.pr.url ? ` (${walkthrough.pr.url})` : ""}` : walkthrough.title;
    const lines = open.map((note) => describeNoteForAgent(walkthrough, note));
    const intro =
      intentOf(walkthrough) === "understand"
        ? `From my walkthrough of ${subject}. While reading how this code works I recorded these follow-ups; act on the todos and answer the questions here, in this thread:`
        : `From my walkthrough of ${subject}. These are notes I recorded while reading; act on the todos and answer the questions here, in this thread:`;
    return { message: `${intro}\n\n${lines.join("\n")}`, noteIds: open.map((note) => note.id) };
  }

  /**
   * Sends the reader's message to the agent in their own thread. The only way
   * anything leaves the pane for the thread: callers pass the text the reader
   * saw and chose to send (from prepareHandOff, possibly edited). Without
   * `message` it sends what prepareHandOff offers, for older callers; without
   * `noteIds` it marks the notes that draft covers as sent.
   */
  async handOff(id: string, message?: string, noteIds?: string[]): Promise<boolean> {
    const walkthrough = this.get(id);
    const draft = this.prepareHandOff(id);
    const text = message?.trim() || draft?.message;
    if (!text) return false;
    const covered = noteIds ?? draft?.noteIds ?? [];
    await this.bb.sdk.threads.send({ threadId: walkthrough.threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
    this.store.markSent(id, covered, this.now());
    this.save(this.get(id));
    return true;
  }

  async requestReviewPost(id: string, event: ReviewDraft["event"]): Promise<void> {
    const walkthrough = this.get(id);
    if (!walkthrough.pr || mergedReviewDraft(walkthrough, this.store.notes(id)) === null) throw new WalkthroughError("There is no draft review to post.");
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
      intent: input.intent ?? defaultIntent(input.mode),
      title: input.title,
      baseRef: input.baseRef,
      includeUncommitted: input.includeUncommitted ?? input.mode === "local",
      pr:
        input.mode === "pr" && input.pr
          ? { number: input.pr.number, url: input.pr.url || null, title: input.pr.title || null, headRef: input.pr.headRef || null, state: input.pr.state ?? null }
          : null,
      introduction: input.introduction,
      parts: input.parts.map((part) => emptyPart(part.title, part.summary, part.locations)),
      status: "reading",
      message: null,
    };
    // The plan request asks the worker to write part 1 in the same turn, so the
    // first part shows as being written; if it only plans, completing the
    // request puts part 1 back in the queue.
    if (walkthrough.inFlight?.request.kind === "plan") {
      next = { ...next, parts: next.parts.map((part, index) => (index === 0 ? { ...part, status: "writing" as const } : part)) };
    }
    next = this.scheduleWrites(next);
    const saved = this.save(next);
    this.mark(saved.id, "planned");
    void this.refreshChangeSet(saved.id);
    if (saved.inFlight === null) void this.pump(saved.id);
    return saved;
  }

  /**
   * Saves a part the worker wrote. Each code block's text is captured first,
   * so the pane never needs live git to show it, and then the part is committed
   * in one step. Capture never fails the write: a block it cannot read is
   * stored without a snapshot and with a short reason.
   */
  async writePart(workerThreadId: string, index: number, blocks: BlockInput[], suggestions: string[]): Promise<{ walkthrough: Walkthrough; unreadable: CodeBlock[] }> {
    const before = this.requireForWorker(workerThreadId);
    if (index < 0 || index >= before.parts.length) throw new WalkthroughError(`There is no part ${index + 1}.`);
    const [captured, hashes] = await Promise.all([
      this.captureBlocks(before, blocks),
      this.hashFiles(before, citedPaths(before, { blocks: blocks as Block[], locations: before.parts[index]!.locations })),
    ]);
    const walkthrough = this.commitPart(workerThreadId, index, captured, suggestions, hashes);
    return { walkthrough, unreadable: captured.filter((block): block is CodeBlock => block.kind === "code" && block.snapshot === null) };
  }

  /** The authoritative step that makes a part ready; blocks arrive complete, with snapshots. */
  commitPart(workerThreadId: string, index: number, blocks: Block[], suggestions: string[], citedHashes?: Record<string, string | null>): Walkthrough {
    const walkthrough = this.requireForWorker(workerThreadId);
    if (index < 0 || index >= walkthrough.parts.length) throw new WalkthroughError(`There is no part ${index + 1}.`);
    const parts = walkthrough.parts.map((part, candidate) =>
      candidate === index
        ? {
            ...part,
            blocks,
            suggestions,
            status: "ready" as const,
            message: null,
            writtenAgainst: walkthrough.codeFingerprint ?? null,
            staleFiles: [],
            // Empty when the host cannot hash (no workspace, or a pinned PR): such a part is never marked stale.
            ...(citedHashes !== undefined && Object.keys(citedHashes).length > 0 ? { citedHashes } : { citedHashes: undefined }),
          }
        : part,
    );
    const saved = this.save({ ...walkthrough, parts });
    if (index === 0) this.mark(saved.id, "part1Ready");
    return saved;
  }

  /** Refreshes the follow-up questions offered with the answer being written. */
  suggest(workerThreadId: string, suggestions: string[]): Walkthrough {
    const walkthrough = this.requireForWorker(workerThreadId);
    const request = walkthrough.inFlight?.request;
    if (request?.kind !== "ask") throw new WalkthroughError("Follow-up questions can be set only while answering a question.");
    return this.save(this.withExchange(walkthrough, request.place, request.exchangeId, (exchange) => ({ ...exchange, suggestions })));
  }

  /**
   * Captures every code block, then once more for the blocks a passing failure
   * left without code (a timeout, a read that raced the thread's own edit), so
   * a part is not committed with empty figures for a hiccup.
   */
  private async captureBlocks(walkthrough: Walkthrough, blocks: BlockInput[]): Promise<Block[]> {
    const first = await this.captureOnce(walkthrough, blocks);
    const failed = first.flatMap((block, index) => (block.kind === "code" && block.snapshot === null && isPassingFailure(block.snapshotError) ? [index] : []));
    if (failed.length === 0) return first;
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_RETRY_MS));
    const second = await this.captureOnce(walkthrough, failed.map((index) => first[index] as BlockInput));
    return first.map((block, index) => (failed.includes(index) ? second[failed.indexOf(index)]! : block));
  }

  /**
   * Gives the figures of written parts the code they lack, for as long as the
   * walkthrough is open: a part whose first write could not read a file (the
   * thread had not saved it yet, a host hiccup) shows real code once it can.
   * Binary and oversized files are permanent and left alone.
   */
  async repairSnapshots(id: string): Promise<void> {
    const walkthrough = this.store.get(id);
    if (walkthrough === null || walkthrough.status === "failed") return;
    const needsCode = (block: Block) => block.kind === "code" && block.snapshot === null && isRepairable(block.snapshotError);
    const places: Array<{ part: Part; index: Place }> = [
      ...walkthrough.parts.map((part, index) => ({ part, index })),
      ...(walkthrough.wrapUp ? [{ part: walkthrough.wrapUp, index: "wrap-up" as const }] : []),
    ];
    for (const { part, index } of places) {
      if (part.status !== "ready" || !part.blocks.some(needsCode)) continue;
      const repaired = await this.captureOnce(walkthrough, part.blocks as unknown as BlockInput[], needsCode);
      const gained = repaired.map((block, position) => (needsCode(part.blocks[position]!) && block.kind === "code" && block.snapshot !== null ? block : null));
      if (gained.every((block) => block === null)) continue;
      const latest = this.store.get(id);
      if (latest === null) return;
      this.save(
        this.withPart(latest, index, (current) => ({
          ...current,
          blocks: current.blocks.map((block, position) => (gained[position] && block.kind === "code" && block.snapshot === null ? gained[position]! : block)),
        })),
      );
    }
  }

  private async captureOnce(walkthrough: Walkthrough, blocks: BlockInput[], only: (block: Block) => boolean = () => true): Promise<Block[]> {
    if (!blocks.some((block) => block.kind === "code")) return blocks as Block[];
    const files = new Map<string, Promise<CodeSnapshot>>();
    const shas = this.captureShas(walkthrough);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), SNAPSHOT_BUDGET_MS);
    });
    return Promise.all(
      blocks.map(async (block): Promise<Block> => {
        if (block.kind !== "code" || !only(block as Block)) return block as Block;
        const view = block.view ?? "diff";
        const base = { ...block, view, snapshot: null, snapshotError: null };
        try {
          const read = this.readExcerpt(walkthrough, block.path, block.startLine, block.endLine, files);
          const result = await Promise.race([read, deadline]);
          if (result === "late") return { ...base, snapshotError: snapshotReason(new Error("timed out")) };
          const { baseSha, headSha } = await shas;
          const snapshot: BlockSnapshot = { change: result.change || null, after: result.after, before: result.before, baseSha, headSha, capturedAt: this.now() };
          return { ...base, snapshot };
        } catch (cause) {
          this.bb.log.debug(`snapshot skipped for ${block.path}: ${errorText(cause)}`);
          return { ...base, snapshotError: snapshotReason(cause) };
        }
      }),
    ).finally(() => clearTimeout(timer));
  }

  /** The commits a snapshot was read between, when they can be named. */
  private async captureShas(walkthrough: Walkthrough): Promise<{ baseSha: string | null; headSha: string | null }> {
    const isSha = (value: string) => /^[0-9a-f]{7,40}$/iu.test(value.trim());
    let baseSha = isSha(walkthrough.baseRef) ? walkthrough.baseRef.trim() : null;
    let headSha = walkthrough.pr?.headRef ?? null;
    if (walkthrough.environmentId === null) return { baseSha, headSha };
    try {
      if (baseSha === null) baseSha = await this.mergeBase(walkthrough);
      if (headSha === null) {
        const status = await this.bb.sdk.environments.status({ environmentId: walkthrough.environmentId });
        if (status.outcome === "available") headSha = "headSha" in status.workspace.checkout ? status.workspace.checkout.headSha : null;
      }
    } catch {
      // The shas label a snapshot; missing ones do not make it unusable.
    }
    return { baseSha, headSha };
  }

  async writeWrapUp(workerThreadId: string, input: BlockInput[], followUps: string[]): Promise<Walkthrough> {
    const blocks = await this.captureBlocks(this.requireForWorker(workerThreadId), input);
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
      includeInReview: input.includeInReview ?? input.kind === "comment",
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveNote(note, author === "agent");
    this.save({ ...walkthrough, nextNoteNumber: walkthrough.nextNoteNumber + 1 });
    return note;
  }

  updateNote(walkthroughId: string, noteId: string, patch: NotePatch, author: Note["author"]): Note {
    const note = this.store.note(walkthroughId, noteId);
    if (note === null) throw new WalkthroughError(`No note ${JSON.stringify(noteId)} in this walkthrough.`);
    const { status, resolution, proposedResolution } = this.noteOutcome(note, patch, author);
    const next: Note = {
      ...note,
      kind: patch.kind ?? note.kind,
      text: patch.text?.trim() || note.text,
      status,
      resolution,
      proposedResolution,
      includeInReview: patch.includeInReview ?? (patch.kind !== undefined && patch.kind !== note.kind ? patch.kind === "comment" : (note.includeInReview ?? note.kind === "comment")),
      // A note that changed is news to the thread again.
      sentAt: patch.text !== undefined || patch.kind !== undefined || (patch.status === "open" && note.status !== "open") ? null : note.sentAt ?? null,
      updatedAt: this.now(),
    };
    this.store.saveNote(next, author === "agent");
    this.save(this.get(walkthroughId));
    return next;
  }

  /**
   * What a note's outcome becomes under a patch. Only the reader closes a note:
   * when the helper tries to resolve one (or sets its resolution), what it wrote
   * is kept as a proposal and the note stays open for the reader to accept or
   * dismiss. A reader's own change to a note's text, kind or status settles any
   * pending proposal, since it was a suggestion about the note as it was.
   */
  private noteOutcome(note: Note, patch: NotePatch, author: Note["author"]): { status: NoteStatus; resolution: string | null; proposedResolution: string | null } {
    const proposed = note.proposedResolution ?? null;
    if (author === "agent") {
      const suggested = patch.proposedResolution !== undefined ? patch.proposedResolution : patch.status === "resolved" || patch.resolution !== undefined ? patch.resolution : undefined;
      return { status: note.status, resolution: note.resolution, proposedResolution: suggested === undefined ? proposed : suggested?.trim() || null };
    }
    const settles = patch.text !== undefined || patch.kind !== undefined || patch.status !== undefined;
    return {
      status: patch.status ?? note.status,
      resolution: patch.resolution === undefined ? note.resolution : patch.resolution?.trim() || null,
      proposedResolution: patch.proposedResolution !== undefined ? patch.proposedResolution?.trim() || null : settles ? null : proposed,
    };
  }

  /** The reader accepts the helper's proposed outcome: the note closes with it as its resolution. */
  acceptResolution(walkthroughId: string, noteId: string): Note {
    const note = this.store.note(walkthroughId, noteId);
    if (note === null) throw new WalkthroughError(`No note ${JSON.stringify(noteId)} in this walkthrough.`);
    const proposed = note.proposedResolution?.trim();
    if (!proposed) throw new WalkthroughError("There is no proposed outcome to accept for this note.");
    return this.updateNote(walkthroughId, noteId, { status: "resolved", resolution: proposed }, "user");
  }

  /** The reader dismisses the helper's proposal; the note stays as it was. */
  dismissResolution(walkthroughId: string, noteId: string): Note {
    return this.updateNote(walkthroughId, noteId, { proposedResolution: null }, "user");
  }

  deleteNote(walkthroughId: string, noteId: string): boolean {
    const deleted = this.store.deleteNote(walkthroughId, noteId);
    if (deleted) {
      this.save(this.get(walkthroughId));
    }
    return deleted;
  }

  takeUnreported(walkthroughId: string): Note[] {
    return this.store.takeUnreported(walkthroughId);
  }

  // -- code -----------------------------------------------------------------

  /**
   * A file's patch and both sides. The host reads git directly, so staged,
   * unstaged and untracked work, renames and unchanged files (an explanation
   * of code that has no diff) all read the same way; BB's diff APIs are the
   * fallback where the host entry cannot answer.
   */
  private async loadCode(walkthrough: Walkthrough, path: string, withFullFile: boolean): Promise<CodeSnapshot> {
    const relative = workspaceRelativePath(path, walkthrough.workspacePath);
    const headRef = walkthrough.pr?.headRef ?? undefined;
    const hostPath = relative !== null && walkthrough.workspacePath !== null ? `${walkthrough.workspacePath}/${relative}` : path;
    const hostable = isAbsolutePath(hostPath) && walkthrough.hostId !== null;
    // A PR's code lives at its head commit, which the checkout may not be on, and
    // BB's diff APIs cannot take the empty tree; only the host can read those.
    const hostOnly = relative === null || headRef !== undefined || walkthrough.baseRef.trim().toLowerCase() === EMPTY_TREE_SHA;
    let hostFailure: unknown = null;
    if (hostable) {
      try {
        return await this.codeHost.call(
          "readCode",
          { path: hostPath, baseRef: walkthrough.baseRef, ...(headRef ? { headRef } : {}), includeUncommitted: walkthrough.includeUncommitted, withFullFile },
          { hostId: walkthrough.hostId! },
        );
      } catch (cause) {
        hostFailure = cause;
      }
    }
    if (hostOnly || relative === null) {
      if (hostFailure !== null) throw hostFailure;
      throw new WalkthroughError("This code path has no known workspace or host.");
    }
    try {
      const file = await this.filePatch(walkthrough, relative);
      const patch = typeof file === "string" ? "" : file.patch;
      const sides = withFullFile ? await this.fullFile(walkthrough, relative, patch) : null;
      if (typeof file === "string" && sides === null) throw new WalkthroughError(file);
      return { path: relative, patch, truncated: typeof file !== "string" && file.truncated, sides };
    } catch (cause) {
      // The fallback only knows "nothing to diff"; the host's reason (binary, too large, not in the revisions, a git error) says more.
      if (hostFailure !== null && cause instanceof WalkthroughError) throw hostFailure;
      throw cause;
    }
  }

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
    if (file === undefined || file.patch.trim() === "") return `${path} has no changes to show.`;
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
      const file = await this.loadCode(walkthrough, path, withFullFile);
      if (!file.patch) return { outcome: "unavailable", message: `${path} has no changes to show.` };
      const start = range.startLine;
      const narrowed = start === undefined ? { patch: file.patch, filtered: false } : filterPatchToRange(file.patch, start, range.endLine ?? start);
      const fullFileContents = !narrowed.filtered ? file.sides : null;
      return { outcome: "available", path: file.path, patch: narrowed.patch, truncated: file.truncated, filtered: narrowed.filtered, fullFileContents };
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
      return { outcome: "available", ...(await this.readExcerpt(walkthrough, path, startLine, endLine)) };
    } catch (cause) {
      return { outcome: "unavailable", message: snapshotReason(cause) };
    }
  }

  /** Reads one excerpt's three views; `files` shares a file's read between excerpts of one request. */
  private async readExcerpt(
    walkthrough: Walkthrough,
    path: string,
    startLine: number,
    endLine: number,
    files: Map<string, Promise<CodeSnapshot>> = new Map(),
  ): Promise<{ path: string; change: string | null; after: string | null; before: string | null }> {
    let loading = files.get(path);
    if (loading === undefined) {
      loading = this.loadCode(walkthrough, path, true);
      files.set(path, loading);
    }
    const file = await loading;
    const sides = file.sides;
    const change = file.patch ? filterPatchToRange(file.patch, startLine, endLine).patch : null;
    const low = Math.min(startLine, endLine);
    const high = Math.max(startLine, endLine);
    const after = sides ? contextPatch(file.path, sides.new.content, low, high) : null;
    const beforeRange = change ? oldRange(change) : { start: low, end: high };
    const before = sides && beforeRange ? contextPatch(file.path, sides.old.content, beforeRange.start, beforeRange.end) : null;
    if (change === null && after === null) throw new WalkthroughError("There is no code in that range.");
    return { path: file.path, change: clampLongLines(change), after: clampLongLines(after), before: clampLongLines(before) };
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
    // With nothing to merge-base against (the base is HEAD itself), the
    // uncommitted view still has both sides: HEAD and the working tree.
    const sideQuery =
      mergeBaseRef !== null
        ? { target: this.diffTarget(walkthrough), mergeBaseRef }
        : walkthrough.includeUncommitted
          ? { target: "uncommitted" as const }
          : null;
    if (sideQuery === null) {
      this.bb.log.debug(`no merge base for ${walkthrough.baseRef} in ${environmentId}; after and before views are unavailable`);
      return null;
    }
    // An added file has no old side and a deleted file no new side.
    const absent = { old: /^--- \/dev\/null$/mu.test(patch), new: /^\+\+\+ \/dev\/null$/mu.test(patch) };
    const side = async (which: "old" | "new") => {
      if (absent[which]) return { path, content: "" };
      try {
        const file = await this.bb.sdk.environments.diffFile({
          environmentId,
          path,
          side: which,
          ...sideQuery,
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

  /** Where the host can run git for this walkthrough, or null when there is no workspace on a host. */
  private hostWorkspace(walkthrough: Pick<Walkthrough, "hostId" | "workspacePath">): { hostId: string; path: string } | null {
    return walkthrough.hostId !== null && walkthrough.workspacePath !== null && isAbsolutePath(walkthrough.workspacePath)
      ? { hostId: walkthrough.hostId, path: walkthrough.workspacePath }
      : null;
  }

  /** The files differing from the walkthrough's base right now, staged and untracked work included; null when the host cannot say. */
  async changedFiles(walkthrough: Pick<Walkthrough, "hostId" | "workspacePath" | "baseRef" | "includeUncommitted" | "pr">): Promise<ChangedFiles | null> {
    const where = this.hostWorkspace(walkthrough);
    if (where === null) return null;
    try {
      return await this.codeHost.call(
        "changedFiles",
        { path: where.path, baseRef: walkthrough.baseRef, ...(walkthrough.pr?.headRef ? { headRef: walkthrough.pr.headRef } : {}), includeUncommitted: walkthrough.includeUncommitted },
        { hostId: where.hostId },
      );
    } catch (cause) {
      this.bb.log.debug(`changed files unavailable: ${errorText(cause)}`);
      return null;
    }
  }

  /** The working tree against HEAD, for the starter's target detection. */
  workingTreeChanges(where: { hostId: string; path: string }): Promise<ChangedFiles | null> {
    return this.changedFiles({ hostId: where.hostId, workspacePath: where.path, baseRef: "HEAD", includeUncommitted: true, pr: null });
  }

  /**
   * Records the change the walkthrough explains, the denominator for coverage.
   * A PR's change is pinned to its head, so it is read once; a local change moves
   * with the working tree and is read again whenever the thread works.
   */
  async refreshChangeSet(id: string): Promise<void> {
    const walkthrough = this.store.get(id);
    if (walkthrough === null || walkthrough.status === "planning" || walkthrough.status === "failed") return;
    if (walkthrough.pr?.headRef && walkthrough.changeSet) return;
    const found = await this.changedFiles(walkthrough);
    if (found === null) return;
    const latest = this.store.get(id);
    if (latest === null) return;
    const files = found.files.map(({ path, oldPath, status, additions, deletions, binary, origins }) => ({ path, oldPath, status, additions, deletions, binary, origins }));
    const previous = latest.changeSet;
    if (previous && previous.truncated === found.truncated && JSON.stringify(previous.files) === JSON.stringify(files)) return;
    this.save({ ...latest, changeSet: { files, truncated: found.truncated, capturedAt: this.now() } });
  }

  /** Content hashes of workspace files, for noticing that a cited file changed; empty when unknown (a PR is pinned and never goes stale). */
  private async hashFiles(walkthrough: Walkthrough, paths: string[]): Promise<Record<string, string | null>> {
    const where = this.hostWorkspace(walkthrough);
    if (where === null || walkthrough.pr?.headRef || paths.length === 0) return {};
    try {
      return (await this.codeHost.call("fileHashes", { path: where.path, paths: paths.slice(0, 200) }, { hostId: where.hostId })).hashes;
    } catch (cause) {
      this.bb.log.debug(`file hashes unavailable: ${errorText(cause)}`);
      return {};
    }
  }

  /**
   * Marks each written part stale for the files it cites that changed since it
   * was written. A part is only as stale as its own files: work in an unrelated
   * file leaves it alone, and a part without recorded hashes (written before
   * they existed) is never marked.
   */
  async refreshStale(id: string): Promise<void> {
    const walkthrough = this.store.get(id);
    if (walkthrough === null || walkthrough.status === "done" || walkthrough.status === "failed") return;
    const tracked = walkthrough.parts.filter((part) => part.status === "ready" && part.citedHashes !== undefined);
    if (tracked.length === 0) return;
    const paths = [...new Set(tracked.flatMap((part) => Object.keys(part.citedHashes!)))];
    const current = await this.hashFiles(walkthrough, paths);
    if (Object.keys(current).length === 0) return;
    const latest = this.store.get(id);
    if (latest === null) return;
    let changed = false;
    const parts = latest.parts.map((part) => {
      if (part.status !== "ready" || part.citedHashes === undefined) return part;
      const stale = Object.entries(part.citedHashes)
        .filter(([path, hash]) => path in current && current[path] !== hash)
        .map(([path]) => path)
        .sort();
      if (JSON.stringify(stale) === JSON.stringify(part.staleFiles ?? [])) return part;
      changed = true;
      return { ...part, staleFiles: stale };
    });
    if (changed) this.save({ ...latest, parts });
  }

  /** The brief started at launch, waiting at most BRIEF_WAIT_MS for it: a slow git must not delay the first words. */
  private async takeBrief(id: string): Promise<string | null> {
    const pending = this.briefs.get(id);
    this.briefs.delete(id);
    if (pending === undefined) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), BRIEF_WAIT_MS);
    });
    return Promise.race([pending, late]).finally(() => clearTimeout(timer));
  }

  /** What the working tree holds right now, for the plan request: the helper cannot see staged or untracked work in a plain diff. */
  private async workspaceBrief(walkthrough: Walkthrough): Promise<string | null> {
    const found = await this.changedFiles({ ...walkthrough, baseRef: "HEAD", includeUncommitted: true, pr: null });
    if (found === null) return null;
    if (found.files.length === 0) return "Working tree right now: clean, with no staged, unstaged, or untracked changes.";
    const counts = [`${found.staged} staged`, `${found.unstaged} unstaged`, `${found.untracked} untracked`].join(", ");
    const listed = found.files.slice(0, 20).map((file) => {
      const flag = file.binary ? "binary" : `+${file.additions ?? "?"} -${file.deletions ?? "?"}`;
      return `- ${file.status}${file.oldPath ? ` from ${file.oldPath}` : ""}: ${file.path} (${flag}; ${file.origins.join(", ")})`;
    });
    return [
      `Working tree right now, against HEAD: ${counts}.`,
      ...listed,
      found.files.length > 20 ? `…and ${found.files.length - 20} more.` : null,
      "Staged changes are uncommitted work like any other: `git diff HEAD` shows staged and unstaged edits together, `git diff --cached` only the staged ones, and `git status --porcelain` lists renames and untracked files, which no diff shows (read those files directly).",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }


  /**
   * Hash of the change in the files the walkthrough points at; null where the
   * checkout is not what the parts describe (a PR is read at its head) or there
   * is nothing to compare.
   */
  private async fingerprint(walkthrough: Walkthrough): Promise<string | null> {
    if (walkthrough.environmentId === null || walkthrough.pr?.headRef) return null;
    const paths = new Set<string>();
    const add = (path: string) => {
      const relative = workspaceRelativePath(path, walkthrough.workspacePath);
      if (relative !== null) paths.add(relative);
    };
    for (const part of walkthrough.parts) {
      part.locations.forEach((location) => add(location.path));
      part.blocks.forEach((block) => block.kind === "code" && add(block.path));
    }
    if (paths.size === 0) return null;
    try {
      const response = await this.bb.sdk.environments.diffPatch({
        environmentId: walkthrough.environmentId,
        paths: [...paths].sort().slice(0, 40),
        target: { type: this.diffTarget(walkthrough), mergeBaseBranch: walkthrough.baseRef },
      });
      if (response.outcome !== "available") return null;
      const hash = createHash("sha1");
      for (const file of [...response.patches].sort((a, b) => a.path.localeCompare(b.path))) hash.update(file.path).update("\0").update(file.patch).update("\0");
      return hash.digest("hex");
    } catch {
      return null;
    }
  }

  /**
   * Catches up with the user's thread: records what they said there since the
   * last look, and the workspace's current code fingerprint, which marks parts
   * written against older code as out of date.
   */
  async refreshThread(id: string): Promise<void> {
    const walkthrough = this.store.get(id);
    if (walkthrough === null || walkthrough.status === "done" || walkthrough.status === "failed") return;
    // The thread's agent may have changed files a part cites or added files to the change.
    await Promise.all([this.refreshStale(id), this.refreshChangeSet(id), this.repairSnapshots(id)]);
    if (walkthrough.threadSeq == null) return;
    const [rows, codeFingerprint] = await Promise.all([
      this.bb.sdk.threads.events
        .list({ threadId: walkthrough.threadId, afterSeq: String(walkthrough.threadSeq), types: ["client/turn/requested"], limit: "50" })
        .catch(() => null) as Promise<Array<{ seq: number; data?: { input?: Array<{ type?: string; text?: string }> } }> | null>,
      this.fingerprint(walkthrough),
    ]);
    const latest = this.store.get(id);
    if (latest === null) return;
    const fresh = Array.isArray(rows) ? rows : [];
    const updates = fresh
      .map((row) => (row.data?.input ?? []).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n").trim())
      .filter((text) => text !== "")
      .map((text) => (text.length > 600 ? `${text.slice(0, 600)}…` : text));
    const threadSeq = fresh.reduce((seq, row) => Math.max(seq, row.seq), latest.threadSeq ?? 0);
    const nextFingerprint = codeFingerprint ?? latest.codeFingerprint ?? null;
    if (updates.length === 0 && threadSeq === latest.threadSeq && nextFingerprint === (latest.codeFingerprint ?? null)) return;
    this.save({ ...latest, threadSeq, codeFingerprint: nextFingerprint, threadUpdates: [...(latest.threadUpdates ?? []), ...updates].slice(-10) });
  }

  /** The user's own thread finished a turn: its agent may have changed the code. */
  async onThreadIdle(threadId: string): Promise<void> {
    for (const walkthrough of this.store.forThread(threadId)) {
      if (walkthrough.status === "reading" || walkthrough.status === "wrapping-up") await this.refreshThread(walkthrough.id);
    }
  }

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

/** A failure that may not repeat: a timeout or an unreadable file, as opposed to a wrong path or a binary file. */
function isPassingFailure(reason: string | null | undefined): boolean {
  return reason === "This code couldn't be read." || reason === "Reading this code took too long.";
}

/** Whether a figure left without code may gain it later: everything except permanent properties of the file. */
function isRepairable(reason: string | null | undefined): boolean {
  return reason !== "Binary files can't be shown as code." && reason !== "This file is too large to show.";
}

/**
 * A short reason a code excerpt could not be read, for the reader and the
 * worker. Raw git or host errors (paths, stderr) never leave the server.
 */
export function snapshotReason(cause: unknown): string {
  if (cause instanceof WalkthroughError) return cause.message.slice(0, 200);
  const text = errorText(cause);
  if (/binary/iu.test(text)) return "Binary files can't be shown as code.";
  if (/exceeds|too large|1 MB/iu.test(text)) return "This file is too large to show.";
  if (/timed? ?out|abort/iu.test(text)) return "Reading this code took too long.";
  if (/no file at|ENOENT|does not exist|unknown revision|bad revision|not a valid object|exists on disk, but not in/iu.test(text)) return "This code isn't in the reviewed revisions.";
  return "This code couldn't be read.";
}

/** Longest code line kept in a saved excerpt; minified or generated lines run to megabytes. */
export const MAX_EXCERPT_LINE = 2000;

/** Cuts code lines of a patch that run past MAX_EXCERPT_LINE, marking each cut; line counts are unchanged. */
export function clampLongLines(patch: string | null): string | null {
  if (patch === null || patch.length <= MAX_EXCERPT_LINE) return patch;
  return patch
    .split("\n")
    .map((line) => (line.length > MAX_EXCERPT_LINE + 1 ? `${line.slice(0, MAX_EXCERPT_LINE + 1)} \u2026 [line cut at ${MAX_EXCERPT_LINE} characters]` : line))
    .join("\n");
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

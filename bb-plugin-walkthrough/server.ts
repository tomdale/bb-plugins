// Walkthrough plugin backend: the pane's RPC, the worker orchestration, and
// the agent tools. See src/service.ts for how a walkthrough is written.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { detectTarget } from "./src/detect-target.ts";
import { deliverView } from "./src/deliver.ts";
import { rpcContract, type WalkthroughSummary } from "./src/rpc.ts";
import type { Walkthrough } from "./src/schemas.ts";
import { saveNotes } from "./src/save-notes.ts";
import { WalkthroughError, WalkthroughService } from "./src/service.ts";
import { MIGRATIONS, WalkthroughStore } from "./src/store.ts";
import { isWorker, registerTools, USER_TOOLS, WORKER_TOOLS } from "./src/tools.ts";
import { WORKER_GUIDE } from "./src/worker.ts";

export type { rpcContract } from "./src/rpc.ts";

const ok = { ok: true as const };

/** RPC errors reach the pane as handler_error with this message. */
async function handle<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof WalkthroughError) throw new Error(cause.message);
    throw cause;
  }
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoOpenPanel: {
      type: "boolean",
      label: "Open the Walkthrough pane when a walkthrough starts",
      default: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new WalkthroughStore(db);
  const service = new WalkthroughService(bb, store);
  const summarize = (walkthrough: Walkthrough): WalkthroughSummary => ({
    id: walkthrough.id,
    title: walkthrough.title,
    request: walkthrough.request,
    status: walkthrough.status,
    partCount: walkthrough.parts.length,
    currentPart: walkthrough.currentPart,
    openNotes: service.notes(walkthrough.id).filter((note) => note.status === "open").length,
    createdAt: walkthrough.createdAt,
  });

  registerTools(bb, service, async () => (await settings.get()).autoOpenPanel !== false);
  bb.agents.configure((context) =>
    isWorker(context.pluginMetadata)
      ? { tools: [...WORKER_TOOLS], skills: [], instructions: WORKER_GUIDE }
      : { tools: [...USER_TOOLS], skills: [] },
  );

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    void service.onWorkerIdle(thread.id, lastAssistantText);
    void service.onThreadIdle(thread.id);
  });
  bb.events.on("thread.archived", ({ thread }) => {
    service.onThreadArchived(thread.id);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    service.onWorkerFailed(thread.id, error);
  });
  bb.events.on("experimental_thread.events", ({ thread }) => {
    service.onWorkerEvents(thread.id);
  });
  bb.background.service("resume", {
    async start(signal) {
      await service.resume().catch((cause) => bb.log.warn(`resume failed: ${cause instanceof Error ? cause.message : String(cause)}`));
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });
  // The tail's timers live as long as this service: a reload or shutdown aborts it.
  bb.background.service("stream-tail", {
    async start(signal) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      service.tail.dispose();
    },
  });

  bb.rpc.register(rpcContract, {
    list: ({ threadId }) => ({ walkthroughs: service.forThread(threadId).map(summarize) }),
    recent: () => ({ walkthroughs: service.recent().map(summarize) }),
    get: ({ walkthroughId }) => {
      try {
        return { view: deliverView(service.view(walkthroughId)) };
      } catch {
        return { view: null };
      }
    },
    detectTarget: async ({ threadId }) => {
      try {
        return { target: await detectTarget(bb.sdk, threadId, (where) => service.workingTreeChanges(where)) };
      } catch (cause) {
        bb.log.debug(`target detection failed for ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        return { target: null };
      }
    },
    start: ({ threadId, request }) =>
      handle(async () => {
        if (service.byWorker(threadId)) throw new WalkthroughError("A walkthrough's own helper thread cannot start another walkthrough.");
        const walkthrough = await service.start(threadId, request);
        return { walkthroughId: walkthrough.id };
      }),
    openPart: ({ walkthroughId, index }) => handle(async () => (await service.openPart(walkthroughId, index), ok)),
    ask: ({ walkthroughId, place, question }) => handle(async () => (await service.ask(walkthroughId, place, question), ok)),
    reply: ({ walkthroughId, text }) => handle(async () => (await service.reply(walkthroughId, text), ok)),
    retry: ({ walkthroughId, place }) => handle(async () => (await service.retry(walkthroughId, place), ok)),
    wrapUp: ({ walkthroughId }) => handle(async () => (await service.wrapUp(walkthroughId), ok)),
    close: ({ walkthroughId }) => handle(async () => (await service.close(walkthroughId), ok)),
    prepareHandOff: ({ walkthroughId }) => handle(() => ({ draft: service.prepareHandOff(walkthroughId) })),
    handOff: ({ walkthroughId, message, noteIds }) => handle(async () => ({ sent: await service.handOff(walkthroughId, message, noteIds) })),
    addNote: ({ walkthroughId, kind, text, groupIndex, location, quote, includeInReview }) =>
      handle(() => service.addNote(walkthroughId, { kind, text, groupIndex, location, quote, includeInReview }, "user")),
    updateNote: ({ walkthroughId, noteId, ...patch }) => handle(() => service.updateNote(walkthroughId, noteId, patch, "user")),
    acceptResolution: ({ walkthroughId, noteId }) => handle(() => service.acceptResolution(walkthroughId, noteId)),
    dismissResolution: ({ walkthroughId, noteId }) => handle(() => service.dismissResolution(walkthroughId, noteId)),
    deleteNote: ({ walkthroughId, noteId }) => handle(() => ({ deleted: service.deleteNote(walkthroughId, noteId) })),
    saveNotes: ({ walkthroughId }) => handle(() => saveNotes(bb.sdk, service.get(walkthroughId), service.notes(walkthroughId))),
    diff: ({ walkthroughId, path, startLine, endLine, withFullFile }) =>
      service.diff(walkthroughId, path, { startLine, endLine }, withFullFile ?? false),
    excerpt: ({ walkthroughId, path, startLine, endLine }) => service.excerpt(walkthroughId, path, startLine, endLine),
    streamSnapshot: ({ walkthroughId }) => handle(async () => ({ snapshot: await service.streamSnapshot(walkthroughId) })),
    requestReviewPost: ({ walkthroughId, event }) => handle(async () => (await service.requestReviewPost(walkthroughId, event), ok)),
  });
}

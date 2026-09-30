// Walkthrough plugin backend: the pane's RPC, the worker orchestration, and
// the agent tools. See src/service.ts for how a walkthrough is written.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./src/rpc.ts";
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
  bb.settings.define({
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

  registerTools(bb, service);
  bb.agents.configure((context) =>
    isWorker(context.pluginMetadata)
      ? { tools: [...WORKER_TOOLS], skills: [], instructions: WORKER_GUIDE }
      : { tools: [...USER_TOOLS], skills: [] },
  );

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    void service.onWorkerIdle(thread.id, lastAssistantText);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    service.onWorkerFailed(thread.id, error);
  });
  bb.events.on("experimental_thread.events", ({ thread }) => {
    void service.onWorkerEvents(thread.id);
  });
  bb.background.service("resume", {
    async start(signal) {
      await service.resume().catch((cause) => bb.log.warn(`resume failed: ${cause instanceof Error ? cause.message : String(cause)}`));
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  bb.rpc.register(rpcContract, {
    list: ({ threadId }) => ({
      walkthroughs: service.forThread(threadId).map((walkthrough) => ({
        id: walkthrough.id,
        title: walkthrough.title,
        request: walkthrough.request,
        status: walkthrough.status,
        partCount: walkthrough.parts.length,
        currentPart: walkthrough.currentPart,
        openNotes: service.notes(walkthrough.id).filter((note) => note.status === "open").length,
        createdAt: walkthrough.createdAt,
      })),
    }),
    get: ({ walkthroughId }) => {
      try {
        return { view: service.view(walkthroughId) };
      } catch {
        return { view: null };
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
    handOff: ({ walkthroughId }) => handle(async () => ({ sent: await service.handOff(walkthroughId) })),
    addNote: ({ walkthroughId, kind, text, groupIndex, location, quote }) =>
      handle(() => service.addNote(walkthroughId, { kind, text, groupIndex, location, quote }, "user")),
    updateNote: ({ walkthroughId, noteId, ...patch }) => handle(() => service.updateNote(walkthroughId, noteId, patch, "user")),
    deleteNote: ({ walkthroughId, noteId }) => handle(() => ({ deleted: service.deleteNote(walkthroughId, noteId) })),
    setNotesFileEnabled: ({ walkthroughId, enabled }) => handle(() => (service.setNotesFileEnabled(walkthroughId, enabled), ok)),
    diff: ({ walkthroughId, path, startLine, endLine, withFullFile }) =>
      service.diff(walkthroughId, path, { startLine, endLine }, withFullFile ?? false),
    excerpt: ({ walkthroughId, path, startLine, endLine }) => service.excerpt(walkthroughId, path, startLine, endLine),
    requestReviewPost: ({ walkthroughId, event }) => handle(async () => (await service.requestReviewPost(walkthroughId, event), ok)),
  });
}

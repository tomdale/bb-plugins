// Walkthrough plugin backend: agent tools, the pause form's backend, and the
// RPC that the panel, header chip, and chat directives read.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describeProgress } from "./src/model.ts";
import { rpcContract } from "./src/rpc.ts";
import { PauseController } from "./src/pause.ts";
import { WalkthroughError, WalkthroughService } from "./src/service.ts";
import { MIGRATIONS, WalkthroughStore } from "./src/store.ts";
import { registerTools } from "./src/tools.ts";

export type { rpcContract } from "./src/rpc.ts";

function rethrow(cause: unknown): never {
  // RPC handler errors reach the frontend as handler_error with this message.
  if (cause instanceof WalkthroughError) throw new Error(cause.message);
  throw cause;
}

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    autoOpenPanel: {
      type: "boolean",
      label: "Open the Walkthrough panel when a walkthrough starts",
      default: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new WalkthroughStore(db);
  const service = new WalkthroughService(bb, store);

  const pauses = new PauseController(bb, service);
  service.pauseOpen = (threadId) => pauses.isOpen(threadId);
  bb.onDispose(() => pauses.dispose());

  registerTools(bb, service);

  // The pause controls open once the agent's turn ends.
  bb.events.on("thread.idle", ({ thread }) => {
    if (thread.queuedMessageCount > 0) return;
    void pauses.maybeOpen(thread.id, "idle");
  });
  // Pauses outlive a plugin reload or server restart; reopen them once loaded.
  bb.background.service("reopen-pauses", {
    async start(signal) {
      for (const threadId of store.threadsWithPauses()) {
        if (signal.aborted) return;
        await pauses.maybeOpen(threadId, "startup");
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  bb.agents.contributeInstructions(({ threadId }) => {
    if (!threadId) return null;
    const walkthrough = store.activeForThread(threadId);
    if (walkthrough === null) return null;
    const open = store.notes(walkthrough.id).filter((note) => note.status === "open").length;
    return `This thread has a walkthrough in progress: ${JSON.stringify(walkthrough.title)}, ${walkthrough.mode} mode, ${describeProgress(walkthrough)}, ${open} open notes. Continue it with the bb-walkthrough skill; call walkthrough_status to reload the outline and notes.`;
  });

  bb.rpc.register(rpcContract, {
    get: ({ threadId }) => ({ view: service.view(threadId) }),
    addNote: ({ threadId, kind, text, groupIndex, location, quote }) => {
      try {
        return service.addNote(threadId, { kind, text, groupIndex, location, quote }, "user");
      } catch (cause) {
        rethrow(cause);
      }
    },
    updateNote: ({ threadId, noteId, ...patch }) => {
      try {
        return service.updateNote(threadId, noteId, patch, "user");
      } catch (cause) {
        rethrow(cause);
      }
    },
    deleteNote: ({ threadId, noteId }) => {
      try {
        return { deleted: service.deleteNote(threadId, noteId) };
      } catch (cause) {
        rethrow(cause);
      }
    },
    setNotesFileEnabled: ({ threadId, enabled }) => {
      try {
        service.setNotesFileEnabled(threadId, enabled);
        return { view: service.view(threadId) };
      } catch (cause) {
        rethrow(cause);
      }
    },
    diff: ({ threadId, path, startLine, endLine, withFullFile }) =>
      service.diff(threadId, path, { startLine, endLine }, withFullFile ?? false),
    showPause: async ({ threadId }) => ({ opened: await pauses.maybeOpen(threadId, "explicit") }),
    requestReviewPost: async ({ threadId, event }) => {
      const view = service.view(threadId);
      const walkthrough = view?.walkthrough;
      if (!walkthrough?.pr || !walkthrough.review) rethrow(new WalkthroughError("There is no draft PR review to post."));
      await service.sendMessage(threadId, {
        visible: `Post the draft review to PR #${walkthrough.pr.number} as ${event === "COMMENT" ? "a comment" : event === "APPROVE" ? "an approval" : "a request for changes"}.`,
        agent: `[Walkthrough ${walkthrough.id}] This is the user's explicit request to submit the walkthrough's draft review to GitHub PR #${walkthrough.pr.number} with event ${event}, body and inline comments exactly as drafted (read them with walkthrough_status). Submit it as one review, then mark it posted with walkthrough_review.`,
      });
      return { sent: true };
    },
  });
}

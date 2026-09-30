// Walkthrough plugin backend: agent tools, the pause form's backend, and the
// RPC that the panel, header chip, and chat directives read.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describeProgress } from "./src/model.ts";
import { rpcContract } from "./src/rpc.ts";
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

  registerTools(bb, service);

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
    sendToAgent: async ({ threadId, request }) => {
      const view = service.view(threadId);
      if (view === null) rethrow(new WalkthroughError("This thread has no walkthrough."));
      const { walkthrough } = view;
      if (request.kind === "resume") {
        if (walkthrough.status === "finished" || view.pausePending) return { sent: false };
        await service.sendToAgent(threadId, "Continue the walkthrough from where we paused.");
        return { sent: true };
      }
      if (walkthrough.pr === null || walkthrough.review === null) {
        rethrow(new WalkthroughError("There is no draft PR review to post."));
      }
      await service.sendToAgent(
        threadId,
        `Post the walkthrough's draft review to PR #${walkthrough.pr.number} on GitHub now as a ${request.event} review, with its body and inline comments exactly as drafted. This is my explicit request to submit it. Then mark it posted with walkthrough_review.`,
      );
      return { sent: true };
    },
  });
}

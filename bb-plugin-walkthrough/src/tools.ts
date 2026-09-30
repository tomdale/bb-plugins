// Agent tools. walkthrough_open is offered to ordinary threads; the rest are
// offered only to the hidden worker thread that writes a walkthrough (see
// bb.agents.configure in server.ts).
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { describeNoteForAgent, describeNotesForAgent, describeOutline, NOTE_KIND_LABEL } from "./model.ts";
import {
  blockSchema,
  locationSchema,
  modeSchema,
  noteKindSchema,
  noteStatusSchema,
  reviewCommentSchema,
  reviewEventSchema,
  WORKER_ROLE,
} from "./schemas.ts";
import { WalkthroughError, type WalkthroughService } from "./service.ts";

export const USER_TOOLS = ["walkthrough_open"] as const;
export const WORKER_TOOLS = [
  "walkthrough_plan",
  "walkthrough_write_part",
  "walkthrough_wrap_up",
  "walkthrough_note",
  "walkthrough_status",
  "walkthrough_review",
] as const;

const suggestionsSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(4)
  .default([])
  .describe("Short prompts in the user's voice; clicking one asks it.");

function failure(message: string): PluginAgentToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function guard(run: () => Promise<PluginAgentToolResult> | PluginAgentToolResult): Promise<PluginAgentToolResult> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof WalkthroughError) return failure(cause.message);
    throw cause;
  }
}

export function registerTools(bb: BbPluginApi, service: WalkthroughService): void {
  bb.agents.registerTool({
    name: "walkthrough_open",
    description:
      "Open a Walkthrough pane beside this thread: a separate reading view that explains a code change part by part, written by a helper agent that shares this conversation. Use it when the user asks to be walked or guided through changes, a branch, or a PR.",
    instructions:
      "When the user asks to be walked or guided through changes, a branch, or a PR, call walkthrough_open with their request instead of narrating in chat; in BB this takes precedence over tdx-walkthrough.",
    presentation: { label: { pending: "Opening walkthrough", completed: "Opened walkthrough" }, icon: { glyph: "Explore" } },
    parameters: z
      .object({ request: z.string().trim().min(1).max(4000).describe("What to walk through, in the user's words.") })
      .strict(),
    execute: ({ request }, ctx) =>
      guard(async () => {
        if (service.byWorker(ctx.threadId)) return failure("This thread is already writing a walkthrough.");
        await service.start(ctx.threadId, request);
        return "The Walkthrough pane is opening beside this thread and a helper agent is preparing it. Tell the user in one short line; do not narrate the change here.";
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_plan",
    description:
      "Set up the walkthrough once you know what to walk through: mode, title, base, an introduction, and the ordered parts. Call it once, before writing any part.",
    presentation: { label: { pending: "Planning walkthrough", completed: "Planned walkthrough" }, icon: { glyph: "ListView" } },
    parameters: z
      .object({
        mode: modeSchema.describe("pr for a GitHub PR review, local otherwise."),
        title: z.string().trim().min(1).max(200).describe('Short and human, e.g. "Read aloud plugin" or "PR #123: Retry uploads".'),
        baseRef: z.string().trim().min(1).max(256).describe("The ref you compared against, such as origin/main."),
        includeUncommitted: z.boolean().optional().describe("Whether uncommitted changes are part of what you explain."),
        pr: z
          .object({ number: z.number().int().positive(), url: z.string().max(2048).optional(), title: z.string().max(500).optional() })
          .strict()
          .optional()
          .describe("PR mode only."),
        introduction: z.string().trim().min(1).max(8000).describe("Two or three short paragraphs of Markdown prose."),
        parts: z
          .array(
            z
              .object({
                title: z.string().trim().min(1).max(120),
                summary: z.string().trim().max(600).default(""),
                locations: z.array(locationSchema).max(20).default([]),
              })
              .strict(),
          )
          .min(1)
          .max(10),
      })
      .strict(),
    execute: (input, ctx) =>
      guard(() => {
        const walkthrough = service.plan(ctx.threadId, input);
        return `Planned ${walkthrough.parts.length} parts. Wait for the next request; do not write parts until asked.`;
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_write_part",
    description: "Deliver one part of the walkthrough as prose and code blocks, plus suggested questions.",
    presentation: { label: { pending: "Writing walkthrough part", completed: "Wrote walkthrough part" }, icon: { glyph: "Edit" } },
    parameters: z
      .object({
        part: z.number().int().positive().describe("1-based part number."),
        blocks: z.array(blockSchema).min(1).max(40),
        suggestions: suggestionsSchema,
      })
      .strict(),
    execute: ({ part, blocks, suggestions }, ctx) =>
      guard(() => {
        service.writePart(ctx.threadId, part - 1, blocks, suggestions);
        return `Part ${part} is on the page.`;
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_wrap_up",
    description: "Deliver the wrap-up: a short recap in prose blocks, plus follow-ups in the user's voice.",
    presentation: { label: { pending: "Writing wrap-up", completed: "Wrote wrap-up" }, icon: { glyph: "CircleCheck" } },
    parameters: z
      .object({ blocks: z.array(blockSchema).min(1).max(20), followUps: suggestionsSchema })
      .strict(),
    execute: ({ blocks, followUps }, ctx) =>
      guard(() => {
        service.writeWrapUp(ctx.threadId, blocks, followUps);
        return "The wrap-up is on the page.";
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_note",
    description:
      "Add, update, resolve, or delete a walkthrough note. At the wrap-up, resolve questions and todos with their answer or outcome.",
    presentation: { label: { pending: "Updating walkthrough notes", completed: "Updated walkthrough notes" }, icon: { glyph: "ListTodo" } },
    parameters: z
      .object({
        op: z.enum(["add", "update", "delete"]).default("update"),
        noteId: z.string().trim().max(64).optional().describe("Required for update and delete, e.g. n3."),
        kind: noteKindSchema.optional(),
        text: z.string().trim().max(8000).optional(),
        part: z.number().int().positive().optional().describe("1-based part number for a new note."),
        location: locationSchema.optional(),
        status: noteStatusSchema.optional(),
        resolution: z.string().trim().max(8000).optional(),
      })
      .strict(),
    execute: (input, ctx) =>
      guard(() => {
        const walkthrough = service.requireForWorker(ctx.threadId);
        if (input.op === "delete") {
          if (!input.noteId) return failure("noteId is required.");
          return service.deleteNote(walkthrough.id, input.noteId) ? `Deleted ${input.noteId}.` : failure(`No note ${input.noteId}.`);
        }
        if (input.op === "update") {
          if (!input.noteId) return failure("noteId is required.");
          const note = service.updateNote(
            walkthrough.id,
            input.noteId,
            { kind: input.kind, text: input.text, status: input.status, resolution: input.resolution },
            "agent",
          );
          return `Updated:\n${describeNoteForAgent(service.get(walkthrough.id), note)}`;
        }
        if (!input.kind || !input.text) return failure("kind and text are required to add a note.");
        const note = service.addNote(
          walkthrough.id,
          { kind: input.kind, text: input.text, groupIndex: input.part === undefined ? undefined : input.part - 1, location: input.location ?? null },
          "agent",
        );
        return `Recorded ${NOTE_KIND_LABEL[note.kind].toLowerCase()} ${note.id}.`;
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_status",
    description: "Read the walkthrough's outline, notes, and review draft.",
    presentation: { label: { pending: "Reading walkthrough", completed: "Read walkthrough" }, icon: { glyph: "Explore" }, suppress: true },
    parameters: z.object({}).strict(),
    execute: (_input, ctx) =>
      guard(() => {
        const walkthrough = service.requireForWorker(ctx.threadId);
        const review = walkthrough.review;
        return [
          `${JSON.stringify(walkthrough.title)}, ${walkthrough.mode} mode, base ${walkthrough.baseRef}${walkthrough.pr ? `, PR #${walkthrough.pr.number}` : ""}.`,
          `Parts:\n${describeOutline(walkthrough)}`,
          `Notes:\n${describeNotesForAgent(walkthrough, service.notes(walkthrough.id))}`,
          review
            ? `Review draft (${review.status}): ${review.event}, ${review.comments.length} inline.\nBody:\n${review.body}\nInline:\n${review.comments
                .map((comment) => `- ${comment.path}:${comment.startLine ? `${comment.startLine}-` : ""}${comment.line} (${comment.side}): ${JSON.stringify(comment.body)}`)
                .join("\n")}`
            : "Review draft: none.",
        ].join("\n\n");
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_review",
    description:
      "PR mode only. Save or replace the draft PR review (body plus inline comments) that the pane previews, or mark it posted after the user explicitly asked you to post it and you did. Never posts anything itself.",
    presentation: { label: { pending: "Saving review draft", completed: "Saved review draft" }, icon: { glyph: "GitPullRequest" } },
    parameters: z
      .object({
        body: z.string().max(60_000).optional(),
        event: reviewEventSchema.optional(),
        comments: z.array(reviewCommentSchema).max(200).optional(),
        status: z.enum(["draft", "posted"]).optional(),
        url: z.string().max(2048).optional(),
        coveredNotes: z.array(z.string().trim().min(1).max(64)).max(200).optional().describe("Ids of the notes this draft includes."),
      })
      .strict(),
    execute: (input, ctx) =>
      guard(() => {
        const walkthrough = service.requireForWorker(ctx.threadId);
        if (walkthrough.mode !== "pr") return failure("Review drafts exist only in PR mode.");
        const previous = walkthrough.review;
        if (previous === null && (input.body === undefined || input.comments === undefined)) {
          return failure("The first draft needs both body and comments (comments may be empty).");
        }
        const review = {
          body: input.body ?? previous?.body ?? "",
          event: input.event ?? previous?.event ?? "COMMENT",
          comments: input.comments ?? previous?.comments ?? [],
          status: input.status ?? previous?.status ?? "draft",
          url: input.url ?? previous?.url ?? null,
          updatedAt: Date.now(),
        };
        service.setReview(walkthrough.id, review);
        for (const noteId of input.coveredNotes ?? []) {
          try {
            service.updateNote(walkthrough.id, noteId, { status: "resolved", resolution: "Included in the draft PR review." }, "agent");
          } catch {
            // Unknown ids are ignored; the draft is saved.
          }
        }
        return review.status === "posted"
          ? "Marked the review posted."
          : `Draft saved with ${review.comments.length} inline comments; the pane previews it. Post only after the user explicitly asks.`;
      }),
  });
}

/** Tools and instructions for one thread, by its walkthrough role. */
export function isWorker(pluginMetadata: unknown): boolean {
  return typeof pluginMetadata === "object" && pluginMetadata !== null && (pluginMetadata as { role?: unknown }).role === WORKER_ROLE;
}

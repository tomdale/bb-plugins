// Agent tools. Each tool maps to one step of the walkthrough procedure in
// skills/bb-walkthrough/SKILL.md; the plugin owns state transitions so the
// panel, the pause form, and the notes file always agree with the agent.
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PAUSE_THEN_WRITE, stateInstructions } from "./messages.ts";
import {
  advance,
  complete,
  describeNoteForAgent,
  describeNotesForAgent,
  describeOutline,
  describeProgress,
  enterFinishing,
  formatLocation,
  NOTE_KIND_LABEL,
  pauseStage,
  reviseOutline,
} from "./model.ts";
import {
  locationSchema,
  modeSchema,
  noteKindSchema,
  noteStatusSchema,
  reviewCommentSchema,
  reviewEventSchema,
} from "./schemas.ts";
import { WalkthroughError, type WalkthroughService } from "./service.ts";

const groupInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).describe("Compact concept name, not a file name."),
    summary: z.string().trim().max(2000).default("").describe("One or two sentences on what the group covers."),
    locations: z
      .array(locationSchema)
      .max(50)
      .default([])
      .describe("Workspace-relative files (with new-side line ranges when useful) this group explains."),
  })
  .strict();

const groupNumberSchema = z.number().int().positive().max(1000);

function text(value: string): PluginAgentToolResult {
  return value;
}

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
    name: "walkthrough_start",
    description:
      "Start a BB walkthrough of a changeset in this thread after you have determined the mode and prepared (base, commits, full diff, pre-change code). Registers the ordered concept groups, opens the Walkthrough panel, and prepares the notes file. Follow the bb-walkthrough skill.",
    instructions:
      "To walk the user through a changeset in BB (PR review, agent-made changes, or their own branch), follow the bb-walkthrough skill; within BB it takes precedence over tdx-walkthrough, and its walkthrough_* tools provide the pause controls, notes, and panel.",
    presentation: { label: { pending: "Starting walkthrough", completed: "Started walkthrough" }, icon: { glyph: "Explore" } },
    parameters: z
      .object({
        mode: modeSchema.describe("pr for GitHub PR review, local for local/self/agent-originated work."),
        title: z.string().trim().min(1).max(200).describe('Short label, e.g. "PR #123: Retry uploads" or "Branch tomdale/cache".'),
        baseRef: z.string().trim().min(1).max(256).describe("Comparison base branch or ref, normally origin/main or origin/master."),
        headRef: z.string().trim().max(256).optional(),
        includeUncommitted: z
          .boolean()
          .optional()
          .describe("Include uncommitted working-tree changes in panel diffs. Defaults to true in local mode, false in PR mode."),
        pr: z
          .object({
            number: z.number().int().positive(),
            url: z.string().max(2048).optional(),
            title: z.string().max(500).optional(),
          })
          .strict()
          .optional(),
        groups: z.array(groupInputSchema).min(1).max(40).describe("Ordered by dependency and substance: foundations before consumers."),
        replace: z.boolean().optional().describe("Close an unfinished walkthrough in this thread and start over."),
      })
      .strict(),
    execute: (input, ctx) =>
      guard(async () => {
        const walkthrough = await service.start(ctx.threadId, input);
        const notesPath = walkthrough.notesFile.path ?? "(no workspace path; notes stay in the panel)";
        return text(
          [
            `Walkthrough ${walkthrough.id} started in ${walkthrough.mode} mode with ${walkthrough.groups.length} groups. The Walkthrough panel shows the outline and notes.`,
            `Notes file: ${notesPath} (written after the first recorded item).`,
            "Next: call walkthrough_pause with 3-4 questions the user might ask about the overview, then write the opening as the final message of this turn: prior behavior, the change, its apparent reason, and how the pieces connect. Put ::walkthrough-outline on its own line in it; that card is the outline, so do not also list the groups. Group 1 begins when the user continues.",
          ].join("\n"),
        );
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_pause",
    description:
      "Request BB's pause controls (continue, finish, ask, record notes, close) for the current step: after the opening, after each group, after answering a question, and after the finish recap. Call it right before writing the step's content, which must be the final message of your turn: BB shows only a turn's last message, and the controls open when the turn ends. The user's choice arrives as their next chat message.",
    presentation: { label: { pending: "Pausing walkthrough", completed: "Paused walkthrough" }, icon: { glyph: "Pause" }, suppress: true },
    parameters: z
      .object({
        suggestions: z
          .array(z.string().trim().min(1).max(200))
          .max(4)
          .default([])
          .describe(
            "3-4 short prompts in the user's voice; clicking one sends it as the user's message. Normally questions they might ask about the opening or current group; at the finish, follow-up requests such as \"Investigate the open questions\". The controls already provide continue, finish, close, and note recording, so never suggest those, and never repeat questions already recorded.",
          ),
      })
      .strict(),
    execute: (input, ctx) =>
      guard(() => {
        const walkthrough = service.requireActive(ctx.threadId);
        const stage = pauseStage(walkthrough);
        if (stage === null) return failure("The walkthrough is finished; there is nothing to pause.");
        service.save({ ...walkthrough, pause: { suggestions: input.suggestions, requestedAt: Date.now(), dismissed: false } });
        const content =
          stage === "overview"
            ? "the opening with ::walkthrough-outline"
            : stage === "finish"
              ? "the recap"
              : `the narration (or your answer) for group ${(walkthrough.currentGroup ?? 0) + 1}`;
        return text(
          `Pause recorded. Now write ${content} as the final message of this turn, with no tool calls after it. The controls open when your turn ends; the user's choice arrives as their next message.`,
        );
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_advance",
    description:
      "Move the walkthrough when the user asks in chat instead of through the pause controls: next (continue to the next group), finish (stop and recap), or complete (close the walkthrough after the finish follow-up).",
    presentation: { label: { pending: "Advancing walkthrough", completed: "Advanced walkthrough" }, icon: { glyph: "ArrowRight" }, suppress: true },
    parameters: z.object({ action: z.enum(["next", "finish", "complete"]) }).strict(),
    execute: ({ action }, ctx) =>
      guard(() => {
        const current = service.requireActive(ctx.threadId);
        const now = Date.now();
        const next =
          action === "next"
            ? current.status === "finishing"
              ? current
              : advance(current, now)
            : action === "finish"
              ? current.status === "finishing"
                ? current
                : enterFinishing(current, now)
              : complete(current, now);
        service.save({ ...next, pause: null });
        const fresh = service.takeUnreported(current.id);
        const notes = service.notes(current.id);
        if (next.status === "finishing") service.markAllReported(current.id);
        return text(
          [`Walkthrough is now ${describeProgress(next)}.`, stateInstructions(next, notes, fresh), next.status === "finished" ? null : PAUSE_THEN_WRITE]
            .filter(Boolean)
            .join("\n\n"),
        );
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_update_outline",
    description:
      "Replace the groups not yet presented when the planned outline no longer fits the diff. Presented groups keep their place.",
    presentation: { label: { pending: "Revising outline", completed: "Revised walkthrough outline" }, icon: { glyph: "ListView" } },
    parameters: z.object({ upcoming: z.array(groupInputSchema).max(40) }).strict(),
    execute: ({ upcoming }, ctx) =>
      guard(() => {
        const next = reviseOutline(service.requireActive(ctx.threadId), upcoming, Date.now());
        service.save(next);
        return text(`Outline revised:\n${describeOutline(next)}`);
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_note",
    description:
      "Add, update, resolve, or delete a walkthrough note. Record clearly classifiable feedback the user gives in chat; resolve questions and todos at the finish with their answer. Notes the user records through BB's controls are saved already.",
    presentation: { label: { pending: "Updating walkthrough notes", completed: "Updated walkthrough notes" }, icon: { glyph: "ListTodo" } },
    parameters: z
      .object({
        op: z.enum(["add", "update", "delete"]).default("add"),
        noteId: z.string().trim().max(64).optional().describe("Required for update and delete, e.g. n3."),
        kind: noteKindSchema.optional().describe("Required for add. comment is for PR mode; note only on explicit request."),
        text: z.string().trim().max(8000).optional().describe("Required for add. Terse, preserving the user's intent."),
        group: groupNumberSchema.optional().describe("1-based group number; defaults to the current group."),
        path: z.string().trim().max(1024).optional().describe("Workspace-relative path in the current diff."),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        status: noteStatusSchema.optional().describe("resolved moves the note to Resolved / Answered."),
        resolution: z.string().trim().max(8000).optional().describe("The answer or outcome when resolving."),
      })
      .strict(),
    execute: (input, ctx) =>
      guard(() => {
        if (input.op === "delete") {
          if (!input.noteId) return failure("noteId is required to delete a note.");
          const deleted = service.deleteNote(ctx.threadId, input.noteId);
          return deleted ? text(`Deleted ${input.noteId}.`) : failure(`No note ${input.noteId} in this walkthrough.`);
        }
        if (input.op === "update") {
          if (!input.noteId) return failure("noteId is required to update a note.");
          const note = service.updateNote(
            ctx.threadId,
            input.noteId,
            { kind: input.kind, text: input.text, status: input.status, resolution: input.resolution },
            "agent",
          );
          const walkthrough = service.requireLatest(ctx.threadId);
          return text(`Updated:\n${describeNoteForAgent(walkthrough, note)}`);
        }
        if (!input.kind || !input.text) return failure("kind and text are required to add a note.");
        const location = input.path ? { path: input.path, startLine: input.startLine, endLine: input.endLine } : null;
        const note = service.addNote(
          ctx.threadId,
          {
            kind: input.kind,
            text: input.text,
            groupIndex: input.group === undefined ? undefined : input.group - 1,
            location: location && locationSchema.parse(location),
          },
          "agent",
        );
        const walkthrough = service.requireActive(ctx.threadId);
        const locus = [
          note.groupIndex === null ? null : `group ${note.groupIndex + 1}`,
          formatLocation(note.location),
        ].filter(Boolean);
        return text(
          `Recorded ${NOTE_KIND_LABEL[note.kind].toLowerCase()} ${note.id}${locus.length ? ` (${locus.join(", ")})` : ""}. Confirm it to the user in a few words and resume.${
            walkthrough.notesFile.path ? ` Mirrored to ${walkthrough.notesFile.path}.` : ""
          }`,
        );
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_status",
    description: "Read the walkthrough's mode, progress, outline, notes, notes-file path, and review draft for this thread.",
    presentation: { label: { pending: "Reading walkthrough", completed: "Read walkthrough" }, icon: { glyph: "Explore" }, suppress: true },
    parameters: z.object({}).strict(),
    execute: (_input, ctx) =>
      guard(() => {
        const view = service.view(ctx.threadId);
        if (view === null) return failure("This thread has no walkthrough.");
        const { walkthrough, notes } = view;
        service.markAllReported(walkthrough.id);
        const review = walkthrough.review;
        return text(
          [
            `Walkthrough ${walkthrough.id}: ${JSON.stringify(walkthrough.title)}, ${walkthrough.mode} mode, base ${walkthrough.baseRef}${walkthrough.pr ? `, PR #${walkthrough.pr.number}` : ""}.`,
            `Progress: ${describeProgress(walkthrough)}${view.pausePending ? "; pause controls are open" : ""}.`,
            `Outline:\n${describeOutline(walkthrough)}`,
            `Notes:\n${describeNotesForAgent(walkthrough, notes)}`,
            `Notes file: ${walkthrough.notesFile.enabled ? (walkthrough.notesFile.path ?? "unavailable") : "disabled by the user"}${walkthrough.notesFile.error ? ` (last write failed: ${walkthrough.notesFile.error})` : ""}.`,
            review
              ? `Review draft (${review.status}${review.url ? `, ${review.url}` : ""}): event ${review.event}, ${review.comments.length} inline comments.\nBody:\n${review.body}\nInline comments:\n${review.comments
                  .map((comment) => `- ${comment.path}:${comment.startLine ? `${comment.startLine}-` : ""}${comment.line} (${comment.side}): ${JSON.stringify(comment.body)}`)
                  .join("\n")}`
              : "Review draft: none.",
          ].join("\n\n"),
        );
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_review",
    description:
      "PR mode only. Save or replace the draft PR review built at the finish (review body plus inline comments on current-diff lines) so the Walkthrough panel previews it, or mark it posted after the user explicitly requested submission and you posted it. Never posts anything itself.",
    presentation: { label: { pending: "Saving review draft", completed: "Saved review draft" }, icon: { glyph: "GitPullRequest" } },
    parameters: z
      .object({
        body: z.string().max(60_000).optional().describe("Review body: unlocated comments and unresolved author questions."),
        event: reviewEventSchema.optional().describe("Defaults to COMMENT."),
        comments: z.array(reviewCommentSchema).max(200).optional().describe("Inline comments on new-side (RIGHT) or old-side (LEFT) lines."),
        status: z.enum(["draft", "posted"]).optional(),
        url: z.string().max(2048).optional().describe("The posted review's URL."),
      })
      .strict(),
    execute: (input, ctx) =>
      guard(() => {
        const walkthrough = service.requireActive(ctx.threadId);
        if (walkthrough.mode !== "pr") return failure("Review drafts exist only in PR mode.");
        const previous = walkthrough.review;
        if (previous === null && (input.body === undefined || input.comments === undefined)) {
          return failure("The first draft needs both body and comments (comments may be an empty array).");
        }
        const review = {
          body: input.body ?? previous?.body ?? "",
          event: input.event ?? previous?.event ?? "COMMENT",
          comments: input.comments ?? previous?.comments ?? [],
          status: input.status ?? previous?.status ?? "draft",
          url: input.url ?? previous?.url ?? null,
          updatedAt: Date.now(),
        };
        service.save({ ...walkthrough, review, updatedAt: review.updatedAt });
        return text(
          review.status === "posted"
            ? `Marked the review posted${review.url ? ` (${review.url})` : ""}.`
            : `Draft saved with ${review.comments.length} inline comments; the Walkthrough panel's Review tab previews it. Show the user the complete draft summary. Post only after a separate explicit request.`,
        );
      }),
  });
}

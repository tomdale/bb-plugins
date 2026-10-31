// Agent tools. walkthrough_open is offered to ordinary threads; the rest are
// offered only to the hidden worker thread that writes a walkthrough (see
// bb.agents.configure in server.ts).
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { COVERED_RESOLUTION, describeNoteForAgent, describeNotesForAgent, describeOutline, mergedReviewDraft, NOTE_KIND_LABEL } from "./model.ts";
import {
  blockInputSchema,
  intentSchema,
  locationSchema,
  modeSchema,
  noteKindSchema,
  noteStatusSchema,
  reviewCommentSchema,
  reviewEventSchema,
  WORKER_ROLE,
} from "./schemas.ts";
import { WalkthroughError, type WalkthroughService } from "./service.ts";
import { PLAN_INSTRUCTIONS, SUGGEST_INSTRUCTIONS, WRAP_UP_INSTRUCTIONS, WRITE_PART_INSTRUCTIONS } from "./worker.ts";

export const USER_TOOLS = ["walkthrough_open"] as const;
export const WORKER_TOOLS = [
  "walkthrough_plan",
  "walkthrough_write_part",
  "walkthrough_suggest",
  "walkthrough_wrap_up",
  "walkthrough_note",
  "walkthrough_status",
  "walkthrough_review",
] as const;

const suggestionsSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(4)
  .default([])
  .describe("2 or 3 specific questions in the reader's voice, each about something named in this part; clicking one asks it. Never generic.");

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

/**
 * What an ordinary thread's agent reads to decide whether a request is a
 * walkthrough. Explaining code that has no diff is as much a walkthrough as
 * reviewing a change, and the phrasing must say so, or the agent answers in chat.
 */
export const OPEN_DESCRIPTION =
  "Open a Walkthrough pane beside this thread: a separate reading view where a helper agent that shares this conversation explains code part by part, with real code excerpts, questions, and notes. Call it whenever the user asks to be walked or guided through, or to have explained, a PR, a branch, changes you just made, or how existing code works (for example \"Walk me through how the queue works\", \"Explain how auth flows through this module\", \"Give me a tour of this package\"). No diff is needed: with nothing changed it walks through the current code.";

export const OPEN_INSTRUCTIONS = [
  "Call walkthrough_open, instead of answering in chat, when the user asks to be walked or guided through something or wants a multi-part explanation of code: a PR or branch review, changes you or they just made, or how some existing code works (\"walk me through how X works\", \"explain how X works\", \"how does X work end to end\", \"give me a tour of X\"). It also applies when the working tree is clean and nothing has changed. In BB this takes precedence over tdx-walkthrough.",
  "Pass the user's own words as `request`, unparaphrased and without added paths. The helper decides whether it is a review, a check of their own change, or an explanation of existing code, so do not read the code or draft an explanation yourself first.",
  "Answer in chat instead for a quick question about one function, line, or error, or when the user asks you to change code.",
  "After the call, say in one short line that the Walkthrough pane is open beside this thread and fills in as the helper writes each part, then carry on with anything else they asked.",
].join("\n\n");

export function registerTools(bb: BbPluginApi, service: WalkthroughService, panelOpensItself: () => Promise<boolean> = async () => true): void {
  bb.agents.registerTool({
    name: "walkthrough_open",
    description: OPEN_DESCRIPTION,
    instructions: OPEN_INSTRUCTIONS,
    presentation: { label: { pending: "Opening walkthrough", completed: "Opened walkthrough" }, icon: { glyph: "Explore" } },
    parameters: z
      .object({
        request: z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .describe("The user's own request, quoted as they wrote it. Do not paraphrase, summarize, or add paths or detail: the pane shows it back to them as what they asked."),
      })
      .strict(),
    execute: ({ request }, ctx) =>
      guard(async () => {
        if (service.byWorker(ctx.threadId)) return failure("This thread is already writing a walkthrough.");
        await service.start(ctx.threadId, request);
        // The pane opens itself on the user's screen when the setting allows it; say which, so the thread never claims a pane that is not there.
        return (await panelOpensItself())
          ? "The Walkthrough pane is open beside this thread now, showing the walkthrough getting ready; the helper's first part appears there as soon as it is written, usually within a minute. Tell the user that in one short line; do not narrate the code here, and do not offer to check on or summarize the helper's progress, since you cannot see it."
          : "The walkthrough is being prepared, but the user turned off opening the pane automatically: tell them in one short line to open it from this thread's Walkthrough panel (the + menu), where it is listed and fills in as the helper writes. Do not narrate the code here, and do not offer to check on the helper's progress, since you cannot see it.";
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_plan",
    description:
      "Set up the walkthrough once you know what to walk through: mode, title, base, an introduction, and the ordered parts. Call it once, before writing any part.",
    instructions: PLAN_INSTRUCTIONS,
    presentation: { label: { pending: "Planning walkthrough", completed: "Planned walkthrough" }, icon: { glyph: "ListView" } },
    parameters: z
      .object({
        mode: modeSchema.describe("pr for a GitHub PR review, local otherwise."),
        intent: intentSchema
          .optional()
          .describe("review: judging someone else's work (default for pr). own-change: checking changes the user or their agent made (default for local). understand: learning how code works, no change to judge."),
        title: z.string().trim().min(1).max(200).describe('Short and human, e.g. "Read aloud plugin" or "PR #123: Retry uploads".'),
        baseRef: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .regex(/^\S+$/u, "baseRef must be a bare git ref or commit sha, with no commentary")
          .describe(
            "The ref or commit sha the change is measured from, with no commentary: origin/main for a branch; in PR mode the commit the PR's diff starts at (for a merged PR, the commit before its first change, not the base branch tip).",
          ),
        includeUncommitted: z.boolean().optional().describe("Whether uncommitted changes are part of what you explain."),
        pr: z
          .object({
            number: z.number().int().positive(),
            url: z.string().max(2048).optional(),
            title: z.string().max(500).optional().describe("The PR's real title, verbatim."),
            state: z.enum(["open", "merged", "closed"]).optional().describe("Whether the PR is open, merged, or closed (gh pr view --json state)."),
            headRef: z
              .string()
              .trim()
              .regex(/^\S+$/u)
              .max(256)
              .optional()
              .describe("The PR head commit sha (gh pr view --json headRefOid). Excerpts are read from it, whatever the checkout has. If it is not in the local repo, fetch it first: git fetch origin pull/<number>/head."),
          })
          .strict()
          .optional()
          .describe("PR mode only."),
        introduction: z
          .string()
          .trim()
          .min(1)
          .max(8000)
          .optional()
          .describe("Leave it out when your streamed message already holds the introduction before its part: 1 fence: the plugin takes it from there. Otherwise two or three short paragraphs of Markdown prose."),
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
      guard(async () => {
        let introduction = input.introduction;
        if (introduction === undefined) {
          introduction = (await service.committedFromMessage(ctx.threadId))?.introduction;
          if (!introduction) return failure("I could not find an introduction: write it in your streamed message before the part: 1 fence, or pass introduction here.");
        }
        const walkthrough = service.plan(ctx.threadId, { ...input, introduction });
        return `Planned ${walkthrough.parts.length} parts. Now call walkthrough_write_part with just part: 1 in this turn (it saves what your message said), and write no later part until asked.`;
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_write_part",
    description: "Deliver one part of the walkthrough as prose and code blocks (each code block with a view of code or diff), plus 2 or 3 specific suggested questions.",
    instructions: WRITE_PART_INSTRUCTIONS,
    presentation: { label: { pending: "Writing walkthrough part", completed: "Wrote walkthrough part" }, icon: { glyph: "Edit" } },
    parameters: z
      .object({
        part: z.number().int().positive().describe("1-based part number."),
        blocks: z
          .array(blockInputSchema)
          .min(1)
          .max(40)
          .optional()
          .describe("Leave blocks and suggestions out to save the part exactly as your streamed message wrote it. Pass them only when you did not stream the part."),
        suggestions: z.array(z.string().trim().min(1).max(200)).max(4).optional().describe("Omit with blocks left out: they come from your message."),
      })
      .strict(),
    execute: ({ part, blocks: given, suggestions: askedFor }, ctx) =>
      guard(async () => {
        let blocks = given;
        let suggestions = askedFor ?? [];
        let dropped: string[] = [];
        if (blocks === undefined) {
          const written = await service.committedFromMessage(ctx.threadId);
          if (written === null || written.blocks.length === 0) {
            return failure("I could not find the part in your streamed message. Write it as one message in the walkthrough markup before this call, or pass blocks here.");
          }
          blocks = written.blocks;
          if (askedFor === undefined) suggestions = written.suggestions;
          dropped = written.dropped;
        }
        const { unreadable } = await service.writePart(ctx.threadId, part - 1, blocks, suggestions);
        if (dropped.length > 0) return `Part ${part} is on the page, but ${dropped.join("; ")} in your message, so ${dropped.length === 1 ? "it was" : "they were"} left out. Call walkthrough_write_part for this part again with the fix.`;
        const missing = unreadable.map((block) => `${block.path}:${block.startLine}-${block.endLine} (${block.snapshotError ?? "unreadable"})`);
        return missing.length === 0
          ? `Part ${part} is on the page.`
          : `Part ${part} is on the page, but the code for ${missing.join("; ")} could not be read, so those blocks show no code. If the path or line range is wrong, call walkthrough_write_part for this part again with it fixed.`;
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_suggest",
    description: "While answering a question, set 2 or 3 specific follow-up questions the reader can click next.",
    instructions: SUGGEST_INSTRUCTIONS,
    presentation: { label: { pending: "Suggesting follow-ups", completed: "Suggested follow-ups" }, icon: { glyph: "Edit" }, suppress: true },
    parameters: z.object({ suggestions: z.array(z.string().trim().min(1).max(200)).min(1).max(4) }).strict(),
    execute: ({ suggestions }, ctx) =>
      guard(() => {
        service.suggest(ctx.threadId, suggestions);
        return "The follow-up questions are on the page. Now give your answer as your final message.";
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_wrap_up",
    description: "Deliver the wrap-up: a short recap in prose blocks, plus follow-ups in the user's voice.",
    instructions: WRAP_UP_INSTRUCTIONS,
    presentation: { label: { pending: "Writing wrap-up", completed: "Wrote wrap-up" }, icon: { glyph: "CircleCheck" } },
    parameters: z
      .object({ blocks: z.array(blockInputSchema).min(1).max(20), followUps: suggestionsSchema })
      .strict(),
    execute: ({ blocks, followUps }, ctx) =>
      guard(async () => {
        await service.writeWrapUp(ctx.threadId, blocks, followUps);
        return "The wrap-up is on the page.";
      }),
  });

  bb.agents.registerTool({
    name: "walkthrough_note",
    description:
      "Add, update, or delete a walkthrough note, or propose how one ends. You never resolve a note yourself: propose its outcome and the reader accepts or dismisses it in the pane.",
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
        resolution: z.string().trim().max(8000).optional().describe("Deprecated alias of proposedResolution: it only ever proposes."),
        proposedResolution: z
          .string()
          .trim()
          .max(8000)
          .optional()
          .describe("Your suggestion for how this note ends: the answer to a question, or what you found or did for a todo. Shown to the reader to accept or dismiss; the note stays open until they accept."),
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
          const before = service.notes(walkthrough.id).find((candidate) => candidate.id === input.noteId);
          const note = service.updateNote(
            walkthrough.id,
            input.noteId,
            { kind: input.kind, text: input.text, status: input.status, resolution: input.resolution, proposedResolution: input.proposedResolution },
            "agent",
          );
          return `${note.proposedResolution && note.proposedResolution !== (before?.proposedResolution ?? null) ? `Proposed an outcome for ${note.id}; it stays open until the reader accepts it.` : "Updated."}\n${describeNoteForAgent(service.get(walkthrough.id), note)}`;
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
        const review = mergedReviewDraft(walkthrough, service.notes(walkthrough.id));
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
        coveredNotes: z
          .array(z.string().trim().min(1).max(64))
          .max(200)
          .optional()
          .describe("Ids of the comment notes this draft turned into feedback. Leave todos and unanswered questions out: they stay open for the user."),
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
            // A proposal, like every other outcome: the reader's note closes only when they accept.
            service.updateNote(walkthrough.id, noteId, { proposedResolution: COVERED_RESOLUTION }, "agent");
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

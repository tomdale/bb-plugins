// Wire shapes shared by the server, the agent tools, and the frontend.
//
// Everything that crosses a boundary (SQLite rows, RPC, the pause
// interaction payload, and the pause response) is parsed with these schemas,
// because every one of those values can come back from persistence or the
// browser as untrusted JSON.
import { z } from "zod";

export const PAUSE_RENDERER_ID = "walkthrough-pause";
export const PANEL_ACTION_ID = "walkthrough";
export const CHANGED_CHANNEL = "walkthrough-changed";

export const modeSchema = z.enum(["local", "pr"]);
export type Mode = z.infer<typeof modeSchema>;

/**
 * overview: the opening and outline are on screen and group 1 has not begun.
 * reviewing: a group is current. finishing: the recap and follow-up phase.
 * finished: the walkthrough is closed; it stays readable in the panel.
 */
export const walkthroughStatusSchema = z.enum([
  "overview",
  "reviewing",
  "finishing",
  "finished",
]);
export type WalkthroughStatus = z.infer<typeof walkthroughStatusSchema>;

export const groupStatusSchema = z.enum(["pending", "current", "done", "skipped"]);
export type GroupStatus = z.infer<typeof groupStatusSchema>;

export const noteKindSchema = z.enum(["question", "todo", "comment", "note"]);
export type NoteKind = z.infer<typeof noteKindSchema>;

export const noteStatusSchema = z.enum(["open", "resolved"]);
export type NoteStatus = z.infer<typeof noteStatusSchema>;

const lineNumber = z.number().int().positive().max(10_000_000);

/** A path in the reviewed diff, relative to the workspace root. */
export const locationSchema = z
  .object({
    path: z.string().trim().min(1).max(1024),
    startLine: lineNumber.optional(),
    endLine: lineNumber.optional(),
  })
  .strict();
export type Location = z.infer<typeof locationSchema>;

export const groupSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(2000).default(""),
    locations: z.array(locationSchema).max(50).default([]),
    status: groupStatusSchema,
  })
  .strict();
export type Group = z.infer<typeof groupSchema>;

export const reviewEventSchema = z.enum(["COMMENT", "REQUEST_CHANGES", "APPROVE"]);
export type ReviewEvent = z.infer<typeof reviewEventSchema>;

export const reviewCommentSchema = z
  .object({
    path: z.string().trim().min(1).max(1024),
    line: lineNumber,
    startLine: lineNumber.optional(),
    side: z.enum(["RIGHT", "LEFT"]).default("RIGHT"),
    body: z.string().trim().min(1).max(20_000),
  })
  .strict();
export type ReviewComment = z.infer<typeof reviewCommentSchema>;

export const reviewDraftSchema = z
  .object({
    body: z.string().max(60_000),
    event: reviewEventSchema,
    comments: z.array(reviewCommentSchema).max(200),
    status: z.enum(["draft", "posted"]),
    url: z.string().max(2048).nullable(),
    updatedAt: z.number(),
  })
  .strict();
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;

export const walkthroughSchema = z
  .object({
    id: z.string(),
    threadId: z.string(),
    mode: modeSchema,
    status: walkthroughStatusSchema,
    title: z.string(),
    baseRef: z.string(),
    headRef: z.string().nullable(),
    includeUncommitted: z.boolean(),
    pr: z
      .object({
        number: z.number().int().positive(),
        url: z.string().max(2048).nullable(),
        title: z.string().max(500).nullable(),
      })
      .strict()
      .nullable(),
    groups: z.array(groupSchema),
    currentGroup: z.number().int().nonnegative().nullable(),
    environmentId: z.string().nullable(),
    hostId: z.string().nullable(),
    workspacePath: z.string().nullable(),
    notesFile: z
      .object({
        enabled: z.boolean(),
        path: z.string().nullable(),
        written: z.boolean(),
        error: z.string().nullable(),
      })
      .strict(),
    review: reviewDraftSchema.nullable(),
    nextNoteNumber: z.number().int().positive(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type Walkthrough = z.infer<typeof walkthroughSchema>;

export const noteSchema = z
  .object({
    id: z.string(),
    walkthroughId: z.string(),
    kind: noteKindSchema,
    text: z.string(),
    groupIndex: z.number().int().nonnegative().nullable(),
    location: locationSchema.nullable(),
    quote: z.string().nullable(),
    status: noteStatusSchema,
    resolution: z.string().nullable(),
    author: z.enum(["user", "agent"]),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type Note = z.infer<typeof noteSchema>;

export const noteTextSchema = z.string().trim().min(1).max(8000);

/** Everything the panel, header chip, and directives render for one thread. */
export const walkthroughViewSchema = z
  .object({
    walkthrough: walkthroughSchema,
    notes: z.array(noteSchema),
    /** True while this server generation holds an open pause form. */
    pausePending: z.boolean(),
  })
  .strict();
export type WalkthroughView = z.infer<typeof walkthroughViewSchema>;

// ---------------------------------------------------------------------------
// Pause interaction
// ---------------------------------------------------------------------------

export const pauseStageSchema = z.enum(["overview", "group", "finish"]);
export type PauseStage = z.infer<typeof pauseStageSchema>;

export const pausePayloadSchema = z
  .object({
    walkthroughId: z.string(),
    mode: modeSchema,
    stage: pauseStageSchema,
    groupIndex: z.number().int().nonnegative().nullable(),
    groupCount: z.number().int().nonnegative(),
    groupTitle: z.string().nullable(),
    nextGroupTitle: z.string().nullable(),
    suggestions: z.array(z.string()).max(4),
    locations: z.array(locationSchema),
    environmentId: z.string().nullable(),
  })
  .strict();
export type PausePayload = z.infer<typeof pausePayloadSchema>;

export const pauseResponseSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("next") }).strict(),
  z.object({ action: z.literal("finish") }).strict(),
  z.object({ action: z.literal("complete") }).strict(),
  z.object({ action: z.literal("ask"), text: noteTextSchema }).strict(),
]);
export type PauseResponse = z.infer<typeof pauseResponseSchema>;
